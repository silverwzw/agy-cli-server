const express = require("express");
const http = require("http");
const path = require("path");
const pty = require("node-pty");
const socket = require("socket.io");

// TODO: multi-session
// TODO: process.on('SIGTERM') / process.on('SIGINT')
// TODO: upload / download
// TODO: voice input
// TODO: overlay
// TODO: mobile adapt

// =======================================================
//                    Global Constants
// =======================================================

const SHELL = "/bin/bash";
const AGY = "agy --dangerously-skip-permissions";
const ROOT_DIR = path.join(__dirname, "..");
const ROUTING_TABLE = {
    "/": {
        path: "client/index.html",
        cache: false
    },
    "/static/main.js": {
        path: "client/main.js",
        cache: false
    },
    "/static/xterm.js": {
        path: "node_modules/@xterm/xterm/lib/xterm.js",
        cache: true
    },
    "/static/xterm-clipboard.js": {
        path: "node_modules/@xterm/addon-clipboard/lib/addon-clipboard.js",
        cache: true
    },
    "/static/xterm-fit.js": {
        path: "node_modules/@xterm/addon-fit/lib/addon-fit.js",
        cache: true
    },
    "/static/xterm-weblinks.js": {
        path: "node_modules/@xterm/addon-web-links/lib/addon-web-links.js",
        cache: true
    },
    "/static/xterm.css": {
        path: "node_modules/@xterm/xterm/css/xterm.css",
        cache: true
    },
};

// =======================================================
//                     HTTP Setup
// =======================================================

const handler = express();
const server = http.createServer(handler);

for (const request_path in ROUTING_TABLE) {
  const { path: resource_path, cache } = ROUTING_TABLE[request_path];
  handler.get(request_path, (req, res) => {
    if (req.method !== "GET") {
      return res.status(405).type("text/plain").send(`Unsupported method ${req.method}`);
    }
    if (!cache) {
      res.set("Cache-Control", "no-cache");
      res.sendFile(path.join(ROOT_DIR, resource_path));
    } else {
      res.sendFile(path.join(ROOT_DIR, resource_path), {
        maxAge: 10 * 3600 * 1000,
        immutable: false
      });
    }
  });
}

handler.use((req, res) => {
  res.status(404).type("text/plain").send("Not Found");
});


// =======================================================
//                   WebSocket Setup
// =======================================================

const ws = socket(server);

ws.on("connection", (socket) => {
  const ptyProcess = pty.spawn(SHELL, [], {
    name: "xterm-color",
    cols: 80,
    rows: 30,
    cwd: "/agy",
    env: process.env,
  });

  ptyProcess.on("data", function (data) {
    ws.emit("t.s2c", data);
  });

  socket.on("t.c2s", (data) => {
    ptyProcess.write(data);
  });

  socket.on("t.resize", ({ cols, rows }) => {
    if (cols && rows) {
      try {
        ptyProcess.resize(cols, rows);
      } catch (err) {
        console.error("pty resize error:", err);
      }
    }
  });

});


// =======================================================
//                     Start Server
// =======================================================

server.listen(8443, () => console.log("listening on http://0.0.0.0:8443"));

// vim: set nu list listchars=trail\:· sw=4 ts=4 expandtab:
