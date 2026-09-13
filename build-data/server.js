const express = require("express");
const http = require("http");
const path = require("path");
const pty = require("node-pty");
const socket = require("socket.io");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const { exec } = require("child_process");

// TODO: voice input
// TODO: overlay
// TODO: mobile adapt
// TODO: directory download
// multifile upload is handled via client-side batch queue to /control/upload PUT

// =======================================================
//                    Global Constants
// =======================================================

const ROOT_DIR = path.join(__dirname, "..");
const WORK_DIR = fs.existsSync("/agy") ? "/agy" : (process.env.HOME || os.homedir());

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
  "/static/upload.js": {
    path: "client/upload.js",
    cache: false,
  },
  "/static/download.js": {
    path: "client/download.js",
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
  "/static/xterm-image.js": {
    path: "node_modules/@xterm/addon-image/lib/addon-image.js",
    cache: true,
  },
  "/static/xterm-progress.js": {
    path: "node_modules/@xterm/addon-progress/lib/addon-progress.js",
    cache: true,
  },
  "/static/xterm-search.js": {
    path: "node_modules/@xterm/addon-search/lib/addon-search.js",
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
const cleanedSessions = new Set();

function resolveStaticPath(relPath) {
  const p1 = path.join(ROOT_DIR, relPath);
  if (fs.existsSync(p1)) return p1;
  if (relPath === "client/index.html") return path.join(__dirname, "index.html");
  if (relPath === "client/main.js") return path.join(__dirname, "client.js");
  if (relPath === "client/upload.js") return path.join(__dirname, "upload.js");
  if (relPath === "client/download.js") return path.join(__dirname, "download.js");
  if (relPath === "client/upload.html") return path.join(__dirname, "upload.html");
  if (relPath === "client/download.html") return path.join(__dirname, "download.html");
  return p1;
}

function isBuildDataFile(filePath) {
  if (!filePath) return false;
  const abs = path.resolve(filePath);
  const buildDataDir = path.resolve(__dirname);
  const clientDir = path.resolve(ROOT_DIR, "client");
  return abs.startsWith(buildDataDir) || abs.startsWith(clientDir) || abs.includes("/build-data/");
}

function handleFileDownload(req, res, targetFile, displayPath) {
  if (req.method !== "GET") {
    return res.status(405).type("text/plain").send(`Unsupported method ${req.method}\n`);
  }

  if (!fs.existsSync(targetFile)) {
    return res.status(404).type("text/plain").send(`File not found: ${displayPath}\n`);
  }

  let stat;
  try {
    stat = fs.statSync(targetFile);
    if (stat.isDirectory()) {
      return res.status(400).type("text/plain").send(`Target path is a directory, not a file: ${displayPath}\n`);
    }
  } catch (err) {
    return res.status(500).type("text/plain").send(`Error reading file status: ${err.message}\n`);
  }

  const isHtmlClient = req.headers["accept"]?.includes("text/html");
  const ua = (req.headers["user-agent"] || "").toLowerCase();
  const isCli = ua.includes("curl") || ua.includes("wget");
  const isRaw = req.query.raw !== undefined;
  const wantsHtml = isHtmlClient && !isCli && !isRaw;

  if (wantsHtml) {
    return res.type("html").send(getDownloadHtml(targetFile, stat, req.originalUrl || req.url));
  }

  const filename = path.basename(targetFile);
  res.download(targetFile, filename, (err) => {
    if (err && !res.headersSent) {
      console.error(`Error downloading file [${targetFile}]:`, err);
      res.status(500).type("text/plain").send(`Error downloading file: ${err.message}\n`);
    }
  });
}

function getUserAndGroup(uid, gid) {
  let userName = String(uid);
  let groupName = String(gid);
  try {
    const passwd = fs.readFileSync("/etc/passwd", "utf-8");
    for (const line of passwd.split("\n")) {
      const parts = line.split(":");
      if (parts.length >= 3 && parseInt(parts[2], 10) === uid) {
        userName = parts[0];
        break;
      }
    }
  } catch (e) {}
  try {
    const group = fs.readFileSync("/etc/group", "utf-8");
    for (const line of group.split("\n")) {
      const parts = line.split(":");
      if (parts.length >= 3 && parseInt(parts[2], 10) === gid) {
        groupName = parts[0];
        break;
      }
    }
  } catch (e) {}
  return { userName, groupName, uid, gid };
}

function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return (bytes / Math.pow(k, i)).toFixed(2) + " " + sizes[i];
}

function getDownloadHtml(targetFile, stat, rawUrl) {
  const filename = path.basename(targetFile);
  const safeName = /^[a-zA-Z0-9_\\-\\.]+$/.test(filename) ? filename : JSON.stringify(filename);
  const modeOctal = (stat.mode & 0o7777).toString(8);
  const { userName, groupName, uid, gid } = getUserAndGroup(stat.uid, stat.gid);

  const chmodCmd = `chmod ${modeOctal} ${safeName}`;
  const chownNameCmd = `chown ${userName}:${groupName} ${safeName}`;
  const chownIdCmd = `chown ${uid}:${gid} ${safeName}`;

  const cleanUrl = rawUrl.split("?")[0];
  const directDownloadUrl = `${cleanUrl}?raw`;

  const templatePath = resolveStaticPath("client/download.html");
  let template = fs.readFileSync(templatePath, "utf-8");

  return template
    .replaceAll("{{FILENAME}}", filename)
    .replaceAll("{{TARGET_FILE}}", targetFile)
    .replaceAll("{{FORMATTED_SIZE}}", formatBytes(stat.size))
    .replaceAll("{{RAW_SIZE}}", String(stat.size))
    .replaceAll("{{MODE_OCTAL}}", modeOctal)
    .replaceAll("{{USER_NAME}}", userName)
    .replaceAll("{{GROUP_NAME}}", groupName)
    .replaceAll("{{UID}}", String(uid))
    .replaceAll("{{GID}}", String(gid))
    .replaceAll("{{DIRECT_DOWNLOAD_URL}}", directDownloadUrl)
    .replaceAll("{{CHMOD_CMD}}", chmodCmd)
    .replaceAll("{{CHOWN_NAME_CMD}}", chownNameCmd)
    .replaceAll("{{CHOWN_ID_CMD}}", chownIdCmd);
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
    this.maxBufferLength = 256 * 1024;
    this.ptyProcess = null;
    this.aborted = false;
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
        if (this.aborted || this.cleanedUp) {
          return;
        }
        this.cleanup("\r\n\x1b[31m[Session exited]\x1b[0m\r\n");
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
    sessions.delete(this.name);
    cleanedSessions.add(this.name);
  }

  abort() {
    if (this.cleanedUp) return;
    this.aborted = true;
    this.cleanup("\r\n\x1b[31m[Session aborted]\x1b[0m\r\n");
    ws.to(`session:${this.name}`).emit("s.aborted", { name: this.name });
  }
}

function generateSessionName() {
  let name;
  do {
    name = crypto.randomBytes(4).toString("hex");
  } while (sessions.has(name) || cleanedSessions.has(name));
  return name;
}

function getOrCreateSession(name, mode) {
  if (cleanedSessions.has(name)) {
    return null;
  }
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
    if (!cache || isBuildDataFile(resolvedPath)) {
      res.set("Cache-Control", "no-cache");
      res.sendFile(resolvedPath, { cacheControl: false });
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

// 9. Abort session: kill pty and its child processes
handler.all(["/control/abort/:name", "/control/abort/:name/"], (req, res) => {
  if (req.method !== "DELETE" && req.method !== "GET") {
    return res.status(405).type("text/plain").send(`Unsupported method ${req.method}`);
  }

  const name = String(req.params.name || "").trim();
  const session = sessions.get(name);
  if (!session) {
    if (cleanedSessions.has(name)) {
      return res.status(410).type("text/plain").send(`Session "${name}" has been cleaned up\n`);
    }
    return res.status(404).type("text/plain").send(`Session "${name}" not found\n`);
  }

  session.abort();
  sessions.delete(name);
  cleanedSessions.add(name);

  res.set("Cache-Control", "no-cache");
  res.status(200).type("json").send(JSON.stringify({ ok: true, name }, null, 2) + "\n");
});

// 10. File Upload: GET (Web UI), PUT (Upload handler)
handler.all(["/control/upload", "/control/upload/"], (req, res) => {
  if (req.method === "GET") {
    res.set("Cache-Control", "no-cache");
    return res.sendFile(resolveStaticPath("client/upload.html"), { cacheControl: false });
  }

  if (req.method === "PUT") {
    let rawPath = req.query.path || req.query.dest || req.headers["x-file-path"] || "";
    if (!rawPath && req.query.filename) {
      const dir = req.query.dir || WORK_DIR;
      rawPath = path.join(dir, req.query.filename);
    }
    if (!rawPath && req.headers["x-file-name"]) {
      rawPath = path.join(WORK_DIR, req.headers["x-file-name"]);
    }
    rawPath = String(rawPath).trim();

    if (!rawPath) {
      return res.status(400).type("text/plain").send("Missing target file path. Specify via query '?path=...' or 'x-file-path' header\n");
    }

    let targetPath = path.isAbsolute(rawPath) ? path.normalize(rawPath) : path.resolve(WORK_DIR, rawPath);
    if (rawPath.endsWith("/") || (fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory())) {
      const defaultFilename = req.headers["x-file-name"] || req.query.filename || `upload_${Date.now()}`;
      targetPath = path.join(targetPath, defaultFilename);
    }

    try {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    } catch (err) {
      return res.status(500).json({ ok: false, error: `Failed to create directory: ${err.message}` });
    }

    const writeStream = fs.createWriteStream(targetPath);
    let totalBytes = 0;

    req.on("data", (chunk) => {
      totalBytes += chunk.length;
    });

    req.pipe(writeStream);

    writeStream.on("finish", () => {
      res.status(200).json({
        ok: true,
        path: targetPath,
        size: totalBytes,
        message: `File successfully uploaded to ${targetPath}`,
      });
    });

    writeStream.on("error", (err) => {
      console.error(`Error saving uploaded file [${targetPath}]:`, err);
      if (!res.headersSent) {
        res.status(500).json({ ok: false, error: err.message });
      }
    });

    req.on("error", (err) => {
      console.error("Upload request stream error:", err);
      writeStream.destroy();
      if (!res.headersSent) {
        res.status(500).json({ ok: false, error: err.message });
      }
    });

    return;
  }

  return res.status(405).type("text/plain").send(`Unsupported method ${req.method}\n`);
});

// 11. File Download:
// Relative path: GET /control/download/rel/<relative_path>
handler.all(["/control/download/rel/{*path}"], (req, res) => {
  let relPath = Array.isArray(req.params.path) ? req.params.path.join("/") : (req.params.path || "");
  relPath = decodeURIComponent(relPath).trim();
  if (!relPath) {
    return res.status(400).type("text/plain").send("Missing relative path. Usage: /control/download/rel/<relative_path>\n");
  }
  const targetFile = path.resolve(WORK_DIR, relPath);
  handleFileDownload(req, res, targetFile, relPath);
});

// Absolute path: GET /control/download/abs/<absolute_path>
handler.all(["/control/download/abs/{*path}"], (req, res) => {
  let absPath = Array.isArray(req.params.path) ? req.params.path.join("/") : (req.params.path || "");
  absPath = decodeURIComponent(absPath).trim();
  if (!absPath) {
    return res.status(400).type("text/plain").send("Missing absolute path. Usage: /control/download/abs/<absolute_path>\n");
  }
  const targetFile = path.resolve("/", absPath);
  handleFileDownload(req, res, targetFile, "/" + absPath.replace(/^\/+/, ""));
});

// Fallback for missing path or invalid format
handler.all(["/control/download", "/control/download/{*path}"], (req, res) => {
  if (req.method !== "GET") {
    return res.status(405).type("text/plain").send(`Unsupported method ${req.method}\n`);
  }
  return res.status(400).type("text/plain").send("Invalid download path format. Usage: /control/download/rel/<relative_path> or /control/download/abs/<absolute_path>\n");
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
  if (cleanedSessions.has(name)) {
    return res.status(410).type("text/plain").send(`Session "${name}" has been cleaned up\n`);
  }
  getOrCreateSession(name, mode);
  res.set("Cache-Control", "no-cache");
  res.sendFile(resolveStaticPath("client/index.html"), { cacheControl: false });
});

handler.use((req, res) => {
  res.status(404).type("text/plain").send("Not Found");
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
  const sessionName = socket.handshake.query?.name;
  const sessionMode = socket.handshake.query?.mode;

  if (!sessionName || !sessionMode) {
    socket.emit("error", "Missing session name or mode in socket query");
    socket.disconnect(true);
    return;
  }

  if (cleanedSessions.has(sessionName)) {
    socket.emit("error", `Session "${sessionName}" has been cleaned up`);
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

  if (session.buffer?.length > 0) {
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
