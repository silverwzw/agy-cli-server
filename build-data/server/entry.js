const express = require("express");
const http = require("http");
const path = require("path");
const pty = require("node-pty");
const socket = require("socket.io");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const { exec } = require("child_process");
const { createUploadRouter } = require("./upload");
const { createDownloadRouter } = require("./download");
const { isPrefetchOrPrerender } = require("./util");

// TODO: voice input
// TODO: overlay
// TODO: mobile adapt

// =======================================================
//                    Global Constants
// =======================================================

const ROOT_DIR = path.join(__dirname, "..");
const WORK_DIR = "/agy";

const SHELL_CMD = "/bin/bash";
const SHELL_ARGS = [];

const AGY_BIN = "/root/.local/bin/agy";
const AGY_ARGS = ["--dangerously-skip-permissions"];

const MAX_ALIGNMENT_SEARCH_WINDOW = 4096;

const ENV = {
  ...process.env,
  PATH: `/root/.gemini/antigravity-cli/bin:/root/.local/bin:${process.env.PATH || ""}`,
  TERM: "xterm-256color",
  COLORTERM: "truecolor",
  LANG: process.env.LANG || "C.UTF-8",
};

const ROUTING_TABLE = {
  "/static/main.js": "client/main.js",
  "/static/upload.js": "client/upload.js",
  "/static/download.js": "client/download.js",
  "/static/xterm.js": "node_modules/@xterm/xterm/lib/xterm.js",
  "/static/xterm-clipboard.js": "node_modules/@xterm/addon-clipboard/lib/addon-clipboard.js",
  "/static/xterm-fit.js": "node_modules/@xterm/addon-fit/lib/addon-fit.js",
  "/static/xterm-weblinks.js": "node_modules/@xterm/addon-web-links/lib/addon-web-links.js",
  "/static/xterm-image.js": "node_modules/@xterm/addon-image/lib/addon-image.js",
  "/static/xterm-progress.js": "node_modules/@xterm/addon-progress/lib/addon-progress.js",
  "/static/xterm-search.js": "node_modules/@xterm/addon-search/lib/addon-search.js",
  "/static/xterm.css": "node_modules/@xterm/xterm/css/xterm.css",
};

// =======================================================
//                     HTTP & WS Setup
// =======================================================

const handler = express();
handler.set("trust proxy", true);

const server = http.createServer(handler);
const ws = socket(server, {
  pingInterval: 25000,
  pingTimeout: 20000,
});

// =======================================================
//                    Session Manager
// =======================================================

const sessions = new Map();
const cleanedSessions = new Set();

function extractSocketIp(socket) {
  let ip =
    socket.handshake?.headers?.["x-real-ip"] ||
    socket.handshake?.headers?.["x-forwarded-for"] ||
    socket.handshake?.address ||
    "unknown";
  if (typeof ip === "string") {
    ip = ip.split(",")[0].trim();
    if (ip.startsWith("::ffff:")) {
      ip = ip.substring(7);
    }
  }
  return ip;
}

function extractSocketUrl(socket) {
  const referer = socket.handshake?.headers?.referer;
  if (referer) {
    try {
      const parsed = new URL(referer);
      return parsed.pathname + parsed.search;
    } catch (_) {
      return referer;
    }
  }
  return socket.handshake?.url || undefined;
}

function killProcessTree(pid) {
  if (!pid || pid <= 1 || pid === process.pid) return;

  exec(
    `pkill -TERM -s ${pid} 2>/dev/null ; pkill -HUP -s ${pid} 2>/dev/null ; pkill -TERM -P ${pid} 2>/dev/null ; kill -HUP ${pid} 2>/dev/null ; kill -TERM ${pid} 2>/dev/null`,
    () => {}
  );

  setTimeout(() => {
    exec(
      `pgrep -s ${pid} >/dev/null 2>&1 && pkill -9 -s ${pid} 2>/dev/null ; ` +
      `pgrep -P ${pid} >/dev/null 2>&1 && pkill -9 -P ${pid} 2>/dev/null ; ` +
      `kill -0 ${pid} 2>/dev/null && kill -9 ${pid} 2>/dev/null`,
      () => {}
    );
  }, 1000).unref();
}

function findBufferCutIndex(buffer, maxLength) {
  const rawCutIndex = buffer.length - maxLength;

  // 1. Try to align cutIndex to the start of a line to avoid partial lines
  const nextNewline = buffer.indexOf("\n", rawCutIndex);
  if (nextNewline !== -1 && nextNewline < rawCutIndex + MAX_ALIGNMENT_SEARCH_WINDOW) {
    return nextNewline + 1;
  }

  // Fallback: window did not contain a newline, proceed with rawCutIndex and guard against splits
  let cutIndex = rawCutIndex;

  // 2. Ensure we do not split a UTF-16 surrogate pair
  if (cutIndex > 0 && cutIndex < buffer.length) {
    const prevCode = buffer.charCodeAt(cutIndex - 1);
    const currCode = buffer.charCodeAt(cutIndex);
    if (prevCode >= 0xd800 && prevCode <= 0xdbff && currCode >= 0xdc00 && currCode <= 0xdfff) {
      cutIndex++;
    }
  }

  // 3. Ensure we do not cut inside an ANSI escape sequence
  const checkStart = Math.max(0, cutIndex - 256);
  const lastEsc = buffer.lastIndexOf("\x1b", cutIndex - 1);
  if (lastEsc >= checkStart) {
    const escSlice = buffer.slice(lastEsc, cutIndex);
    let isClosed = false;
    if (escSlice.length === 1) {
      isClosed = false;
    } else if (escSlice[1] === "[") {
      isClosed = /[\x40-\x7E]/.test(escSlice.slice(2));
    } else if (escSlice[1] === "]") {
      isClosed = /\x07|\x1b\\/.test(escSlice.slice(2));
    } else {
      isClosed = escSlice.length >= 3;
    }

    if (!isClosed) {
      cutIndex = lastEsc;
    }
  }

  // Safety fallback: ensure cutIndex advances so buffer does not grow indefinitely
  if (cutIndex <= 0) {
    cutIndex = rawCutIndex;
  }

  return cutIndex;
}

class Session {
  static STILL_ACTIVE = 0;
  static ABORTED_BY_CLIENT = 1;
  static ABORTED_BY_SERVER = 2;

  static lastResizeErrorLogTime = 0;

  constructor(name, mode, creator = {}) {
    this.name = name;
    this.mode = mode === "s" ? "s" : "a";
    this.creatorIp = creator.ip || "unknown";
    this.creatorUrl = creator.url || "unknown";
    this.command = this.mode === "s" ? SHELL_CMD : AGY_BIN;
    this.args = this.mode === "s" ? SHELL_ARGS : AGY_ARGS;
    this.createdAt = new Date();
    this.clients = new Set();
    this.buffer = "";
    this.maxBufferLength = 256 * 1024;
    this.ptyProcess = null;
    this.aborted = Session.STILL_ACTIVE;
    this.cleanedUp = false;
    this.exitCode = null;

    this.spawnPty();
  }

  get exited() {
    return this.exitCode !== null;
  }

  spawnPty() {
    try {
      this.ptyProcess = pty.spawn(this.command, this.args, {
        name: "xterm-color",
        cols: 80,
        rows: 30,
        cwd: WORK_DIR,
        env: ENV,
      });

      console.log(
        `New PTY created: IP ${this.creatorIp} accessed URL ${this.creatorUrl} to create session [${this.name}]`
      );

      this.ptyProcess.on("data", (data) => {
        this.appendBuffer(data);
        ws.to(`session:${this.name}`).emit("t.s2c", data);
      });

      this.ptyProcess.on("error", (err) => {
        // On Linux, reading from the master PTY returns EIO when the slave PTY closes (process exits).
        if (err && (err.code === "EIO" || err.errno === -5)) {
          return;
        }
        console.error(`Session [${this.name}] pty error:`, err);
      });

      this.ptyProcess.on("exit", (code, signal) => {
        console.log(`Session [${this.name}] exited (code: ${code}, signal: ${signal})`);
        this.exitCode = code;
        if (this.aborted !== Session.STILL_ACTIVE || this.cleanedUp) {
          return;
        }
        this.aborted = Session.ABORTED_BY_CLIENT;
        this.cleanup("\r\n\x1b[31m[Session exited]\x1b[0m\r\n");
      });
    } catch (err) {
      console.error(`Failed to spawn pty for session [${this.name}]:`, err);
    }
  }

  appendBuffer(data) {
    this.buffer += data;
    if (this.buffer.length > this.maxBufferLength) {
      const cutIndex = findBufferCutIndex(this.buffer, this.maxBufferLength);
      this.buffer = this.buffer.slice(cutIndex);
    }
  }

  write(data) {
    if (this.ptyProcess && !this.exited) {
      try {
        this.ptyProcess.write(data);
      } catch (err) {
        console.error(`Error writing to session [${this.name}]:`, err);
      }
    }
  }

  resize(cols, rows) {
    const c = parseInt(cols, 10);
    const r = parseInt(rows, 10);
    if (this.ptyProcess && !this.exited && c > 0 && r > 0) {
      try {
        this.ptyProcess.resize(c, r);
      } catch (err) {
        const now = Date.now();
        if (now - Session.lastResizeErrorLogTime >= 10000) {
          Session.lastResizeErrorLogTime = now;
          console.error(`Session [${this.name}] pty resize error:`, err);
        }
      }
    }
  }

  cleanup(msg) {
    if (this.cleanedUp) return;
    this.cleanedUp = true;
    if (this.exitCode === null) {
      this.exitCode = -1;
    }

    if (this.ptyProcess?.pid) {
      killProcessTree(this.ptyProcess.pid);
    }
    if (msg) {
      this.appendBuffer(msg);
      ws.to(`session:${this.name}`).emit("t.s2c", msg);
    }
    ws.to(`session:${this.name}`).emit("s.aborted", { name: this.name, reason: this.aborted });
    sessions.delete(this.name);
    cleanedSessions.add(this.name);

    let abortLabel;
    switch (this.aborted) {
      case Session.ABORTED_BY_CLIENT:
        abortLabel = "ABORTED_BY_CLIENT";
        break;
      case Session.ABORTED_BY_SERVER:
        abortLabel = "ABORTED_BY_SERVER";
        break;
      case Session.STILL_ACTIVE:
        abortLabel = "STILL_ACTIVE";
        break;
      default:
        abortLabel = "UNKNOWN";
        break;
    }
    console.log(
      `Session [${this.name}] cleaned up (mode: ${this.mode}, aborted: ${this.aborted} [${abortLabel}], exitCode: ${this.exitCode})`
    );
  }

  abort(reason) {
    if (this.cleanedUp) return;
    this.aborted = reason;
    this.cleanup("\r\n\x1b[31m[Session aborted]\x1b[0m\r\n");
  }
}

function generateSessionName() {
  let name;
  do {
    name = crypto.randomBytes(4).toString("hex");
  } while (sessions.has(name) || cleanedSessions.has(name));
  return name;
}

function getOrCreateSession(name, mode, creator = {}) {
  if (cleanedSessions.has(name)) {
    return null;
  }
  if (sessions.has(name)) {
    return sessions.get(name);
  }
  const session = new Session(name, mode, creator);
  sessions.set(name, session);
  return session;
}

// =======================================================
//                     HTTP Routes
// =======================================================

// Log incoming HTTP requests
handler.use((req, res, next) => {
  try {
    const time = new Date().toISOString();
    const requestUrl = req.originalUrl;
    const userIp = extractRequestIp(req);
    const headers = { ...req.headers };
    delete headers.cookie;
    console.log(`[${time}] HTTP ${req.method} ${requestUrl} from IP ${userIp} | Headers:`, headers);
  } catch (err) {
    console.error("Error logging HTTP request:", err);
  }
  next();

  function extractRequestIp(r) {
    let ip =
      r.headers?.["x-real-ip"] ||
      r.headers?.["x-forwarded-for"] ||
      r.ip ||
      r.socket?.remoteAddress ||
      "unknown";
    if (typeof ip === "string") {
      ip = ip.split(",")[0].trim();
      if (ip.startsWith("::ffff:")) {
        ip = ip.substring(7);
      }
    }
    return ip;
  }
});

// Static routes
for (const [request_path, resource_path] of Object.entries(ROUTING_TABLE)) {
  const filePath = path.join(ROOT_DIR, resource_path);
  handler.get(request_path, (req, res) => {
    res.sendFile(filePath);
  });
}

// 8. List all sessions
handler.get(["/control/list", "/control/list/"], (req, res) => {
  const sessionList = [];
  for (const [name, session] of sessions.entries()) {
    sessionList.push({
      name: session.name,
      mode: session.mode, // "a" | "s"
      command: session.command,
      args: session.args,
      createdAt: session.createdAt,
      clients: session.clients.size,
      pid: session.ptyProcess ? session.ptyProcess.pid : null,
    });
  }

  res.type("json").send(JSON.stringify(sessionList, null, 2) + "\n");
});

// 9. Abort session: kill pty and its child processes
handler.all(["/control/abort/:name", "/control/abort/:name/"], (req, res) => {
  if (isPrefetchOrPrerender(req)) {
    return res.status(400).type("text/plain").send("Prefetch / prerender request not supported for abort url\n");
  }

  if (req.method !== "DELETE" && req.method !== "GET") {
    return res.status(405).type("text/plain").send(`Unsupported method ${req.method}\n`);
  }

  const name = String(req.params.name || "").trim();
  const session = sessions.get(name);
  if (!session) {
    if (cleanedSessions.has(name)) {
      return res.status(410).type("text/plain").send(`Session "${name}" has been cleaned up\n`);
    }
    return res.status(404).type("text/plain").send(`Session "${name}" not found\n`);
  }

  session.abort(Session.ABORTED_BY_SERVER);

  res.status(200).type("json").send(JSON.stringify({ ok: true, name }, null, 2) + "\n");
});

// 10. File Upload routes
handler.use(createUploadRouter({ ROOT_DIR, WORK_DIR }));

// 11. File Download routes
handler.use(createDownloadRouter({ ROOT_DIR, WORK_DIR }));

// Redirect /, /a, /s
handler.get(["/", "/a", "/a/", "/s", "/s/"], (req, res) => {
  const mode = req.path.startsWith("/s") ? "s" : "a";
  res.redirect(`/${mode}/${generateSessionName()}`);
});

// 1. /a/<name> & 2. /s/<name> -> serve terminal page
const indexHtmlPath = path.join(ROOT_DIR, "client/index.html");
handler.get(["/a/:name", "/s/:name"], (req, res) => {
  const mode = req.path.startsWith("/s") ? "s" : "a";
  const name = String(req.params.name || "").trim();
  if (!name) {
    return res.redirect(`/${mode}/${generateSessionName()}`);
  }
  if (cleanedSessions.has(name)) {
    return res.status(410).type("text/plain").send(`Session "${name}" has been cleaned up\n`);
  }
  res.sendFile(indexHtmlPath);
});

handler.use((req, res) => {
  res.status(404).type("text/plain").send("Not Found\n");
});

// Global error-handling middleware
handler.use((err, req, res, next) => {
  console.error("Unhandled server error:", err);
  if (res.headersSent) {
    return next(err);
  }
  const statusCode = typeof err?.status === "number" && err.status >= 400 && err.status < 600 ? err.status : 500;
  const message = statusCode === 500 ? "Internal Server Error\n" : `${err?.message || "Error"}\n`;
  res.status(statusCode).type("text/plain").send(message);
});

// =======================================================
//                   WebSocket Setup
// =======================================================

ws.use((socket, next) => {
  const sessionName = socket.handshake.query?.name;
  const sessionMode = socket.handshake.query?.mode;

  if (!sessionName || !sessionMode) {
    return next(new Error("Missing session name or mode in socket query"));
  }
  if (cleanedSessions.has(sessionName)) {
    return next(new Error(`Session "${sessionName}" has been cleaned up`));
  }
  next();
});

ws.on("connection", (socket) => {
  const ip = extractSocketIp(socket);
  const url = extractSocketUrl(socket);
  const session = getOrCreateSession(socket.handshake.query.name, socket.handshake.query.mode, { ip, url });
  if (!session || !session.ptyProcess) {
    return;
  }

  socket.join(`session:${session.name}`);
  session.clients.add(socket.id);
  socket.emit("s.joinSuccess", { name: session.name, mode: session.mode });

  if (session.buffer.length > 0) {
    socket.emit("t.replay", session.buffer);
  }

  socket.on("t.c2s", (data) => {
    session.write(data);
  });

  socket.on("t.resize", ({ cols, rows } = {}) => {
    session.resize(cols, rows);
  });

  socket.on("disconnect", () => {
    session.clients.delete(socket.id);
  });
});

// =======================================================
//                     Start Server
// =======================================================

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

server.listen(8443, () => console.log("listening on http://0.0.0.0:8443"));

// vim: set nu list listchars=trail\:· sw=4 ts=4 expandtab:
