const http = require("http");
const pty = require("node-pty");
const os = require("os");
const socket = require("socket.io");
const path = require("path");
const fs = require("fs");

// TODO: auto-sizing
// TODO: multi-session
// TODO: voice

const shell = "/bin/bash";
const agy = "agy --dangerously-skip-permissions";
const ROOT_DIR = path.join(__dirname, "..");

const server = http.createServer((req, res) => {
  // Let Socket.IO handle /socket.io requests
  if (req.url.startsWith("/socket.io")) {
    return;
  }

  const urlPath = req.url.split("?")[0];
  let filePath;
  let mime;

  if (urlPath === "/" || urlPath === "/index.html") {
    filePath = path.join(ROOT_DIR, "app", "index.html");
    mime = "text/html";
  } else if (urlPath === "/static/app.js") {
    filePath = path.join(ROOT_DIR, "app", "app.js");
    mime = "application/javascript";
  } else if (urlPath.startsWith("/static/xterm.js")) {
    filePath = path.join(ROOT_DIR, "node_modules/@xterm/xterm/lib/xterm.js");
    mime = "application/javascript";
  } else if (urlPath.startsWith("/static/xterm.css")) {
    filePath = path.join(ROOT_DIR, "node_modules/@xterm/xterm/css/xterm.css");
    mime = "text/css";
  } else {
    res.writeHead(404, { "Content-Type": "text/plain" });
    return res.end("Not Found");
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      return res.end("File not found.");
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": mime || "application/octet-stream" });
    fs.createReadStream(filePath).pipe(res);
  });
});

const ws = socket(server, {
  cors: { origin: "*" },
});

ws.on("connection", (socket) => {
  var ptyProcess = pty.spawn(shell, [], {
    name: "xterm-color",
    cols: 80,
    rows: 30,
    cwd: "/agy",
    env: process.env,
  });

  ptyProcess.on("data", function (data) {
    ws.emit("t.incomingData", data);
  });

  socket.on("t.keystroke", (data) => {
    ptyProcess.write(data);
  });
});

server.listen(8443, () => console.log("listening on http://localhost:8443"));
