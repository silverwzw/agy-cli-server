const express = require("express");
const http = require("http");
const path = require("path");
const pty = require("node-pty");
const socket = require("socket.io");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");

// TODO: process.on('SIGTERM') / process.on('SIGINT')
// TODO: upload / download
// TODO: voice input
// TODO: overlay
// TODO: mobile adapt

// =======================================================
//                    Global Constants
// =======================================================

const ROOT_DIR = path.join(__dirname, "..");

const SHELL_CMD = "/bin/bash";
const SHELL_ARGS = [];

const AGY_BIN = fs.existsSync("/root/.local/bin/agy") ? "/root/.local/bin/agy" : "agy";
const AGY_ARGS = ["--dangerously-skip-permissions"];

const ENV = {
  ...process.env,
  PATH: `/root/.gemini/antigravity-cli/bin:/root/.local/bin:${process.env.PATH || ""}`,
  TERM: "xterm-256color",
  COLORTERM: "truecolor",
  LANG: process.env.LANG || "C.UTF-8",
};

const ROUTING_TABLE = {
  "/static/main.js": {
    path: "client/main.js",
    cache: false,
  },
  "/static/xterm.js": {
    path: "node_modules/@xterm/xterm/lib/xterm.js",
    cache: true,
  },
  "/static/xterm-clipboard.js": {
    path: "node_modules/@xterm/addon-clipboard/lib/addon-clipboard.js",
    cache: true,
  },
  "/static/xterm-fit.js": {
    path: "node_modules/@xterm/addon-fit/lib/addon-fit.js",
    cache: true,
  },
  "/static/xterm-weblinks.js": {
    path: "node_modules/@xterm/addon-web-links/lib/addon-web-links.js",
    cache: true,
  },
  "/static/xterm.css": {
    path: "node_modules/@xterm/xterm/css/xterm.css",
    cache: true,
  },
};

// =======================================================
//                     HTTP & WS Setup
// =======================================================

const handler = express();
const server = http.createServer(handler);
const ws = socket(server);

// =======================================================
//                    Session Manager
// =======================================================

const sessions = new Map();

function resolveStaticPath(relPath) {
  const p1 = path.join(ROOT_DIR, relPath);
  if (fs.existsSync(p1)) return p1;
  if (relPath === "client/index.html") return path.join(__dirname, "index.html");
  if (relPath === "client/main.js") return path.join(__dirname, "client.js");
  return p1;
}

class Session {
  static lastResizeErrorLogTime = 0;

  constructor(name, mode) {
    this.name = name;
    this.mode = mode === "s" ? "s" : "a";
    this.type = this.mode === "s" ? "bash" : "agy";
    this.command = this.mode === "s" ? SHELL_CMD : AGY_BIN;
    this.args = this.mode === "s" ? SHELL_ARGS : AGY_ARGS;
    this.createdAt = new Date();
    this.clients = new Set();
    this.buffer = "";
    this.maxBufferLength = 64 * 1024;
    this.ptyProcess = null;
    this.exited = false;
    this.exitCode = null;

    this.spawnPty();
  }

  spawnPty() {
    try {
      this.ptyProcess = pty.spawn(this.command, this.args, {
        name: "xterm-color",
        cols: 80,
        rows: 30,
        cwd: fs.existsSync("/agy") ? "/agy" : (process.env.HOME || os.homedir()),
        env: ENV,
      });

      this.ptyProcess.on("data", (data) => {
        this.appendBuffer(data);
        ws.to(`session:${this.name}`).emit("t.s2c", data);
      });

      this.ptyProcess.on("error", (err) => {
        console.error(`Session [${this.name}] pty error:`, err);
      });

      this.ptyProcess.on("exit", (code, signal) => {
        console.log(`Session [${this.name}] exited (code: ${code}, signal: ${signal})`);
        this.exited = true;
        this.exitCode = code;
      });
    } catch (err) {
      console.error(`Failed to spawn pty for session [${this.name}]:`, err);
    }
  }

  appendBuffer(data) {
    this.buffer += data;
    if (this.buffer.length > this.maxBufferLength) {
      this.buffer = this.buffer.slice(this.buffer.length - this.maxBufferLength);
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
}

function generateSessionName() {
  let name;
  do {
    name = crypto.randomBytes(4).toString("hex");
  } while (sessions.has(name));
  return name;
}

function getOrCreateSession(name, mode) {
  if (sessions.has(name)) {
    return sessions.get(name);
  }
  const session = new Session(name, mode);
  sessions.set(name, session);
  return session;
}

// =======================================================
//                     HTTP Routes
// =======================================================

// Static routes
for (const request_path in ROUTING_TABLE) {
  const { path: resource_path, cache } = ROUTING_TABLE[request_path];
  handler.get(request_path, (req, res) => {
    if (req.method !== "GET") {
      return res.status(405).type("text/plain").send(`Unsupported method ${req.method}`);
    }
    const resolvedPath = resolveStaticPath(resource_path);
    if (!cache) {
      res.set("Cache-Control", "no-cache");
      res.sendFile(resolvedPath);
    } else {
      res.sendFile(resolvedPath, {
        maxAge: 10 * 3600 * 1000,
        immutable: false,
      });
    }
  });
}

// 8. List all sessions
handler.all(["/control/list", "/control/list/"], (req, res) => {
  if (req.method !== "GET") {
    return res.status(405).type("text/plain").send(`Unsupported method ${req.method}`);
  }

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

  res.set("Cache-Control", "no-cache");
  res.type("json").send(JSON.stringify(sessionList, null, 2) + "\n");
});

// Redirect /, /a, /s
handler.get(["/", "/a", "/a/", "/s", "/s/"], (req, res) => {
  const mode = req.path.startsWith("/s") ? "s" : "a";
  res.redirect(`/${mode}/${generateSessionName()}`);
});

// 1. /a/<name> & 2. /s/<name> -> create/connect session
handler.get(["/a/:name", "/s/:name"], (req, res) => {
  const mode = req.path.startsWith("/s") ? "s" : "a";
  const name = String(req.params.name || "").trim();
  if (!name) {
    return res.redirect(`/${mode}/${generateSessionName()}`);
  }
  getOrCreateSession(name, mode);
  res.set("Cache-Control", "no-cache");
  res.sendFile(resolveStaticPath("client/index.html"));
});

handler.use((req, res) => {
  res.status(404).type("text/plain").send("Not Found");
});

// =======================================================
//                   WebSocket Setup
// =======================================================

ws.use((socket, next) => {
  const sessionName = socket.handshake.query && socket.handshake.query.name;
  const sessionMode = socket.handshake.query && socket.handshake.query.mode;

  if (!sessionName || !sessionMode) {
    return next(new Error("Missing session name or mode in socket query"));
  }
  next();
});

ws.on("connection", (socket) => {
  const sessionName = socket.handshake.query && socket.handshake.query.name;
  const sessionMode = socket.handshake.query && socket.handshake.query.mode;

  if (!sessionName || !sessionMode) {
    socket.emit("error", "Missing session name or mode in socket query");
    socket.disconnect(true);
    return;
  }

  const session = getOrCreateSession(sessionName, sessionMode);
  if (!session || !session.ptyProcess) {
    return;
  }

  socket.join(`session:${session.name}`);
  session.clients.add(socket.id);
  socket.emit("s.joinSuccess", { name: session.name, mode: session.mode });

  if (session.buffer && session.buffer.length > 0) {
    socket.emit("t.s2c", session.buffer);
  }

  socket.on("t.c2s", (data) => {
    session.write(data);
  });

  socket.on("t.resize", ({ cols, rows } = {}) => {
    if (cols && rows) {
      session.resize(cols, rows);
    }
  });

  socket.on("disconnect", () => {
    session.clients.delete(socket.id);
  });
});

// =======================================================
//                     Start Server
// =======================================================

server.listen(8443, () => console.log("listening on http://0.0.0.0:8443"));

// vim: set nu list listchars=trail\:· sw=4 ts=4 expandtab:
