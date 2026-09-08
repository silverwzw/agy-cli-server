const http = require("http");
const pty = require("node-pty");
const socket = require("socket.io");
const path = require("path");
const fs = require("fs");

// TODO: multi-session
// TODO: process.on('SIGTERM') / process.on('SIGINT')
// TODO: upload / download
// TODO: voice input
// TODO: overlay
// TODO: use express
// TODO: mobile adapt

const shell = "/bin/bash";
const agy = "agy --dangerously-skip-permissions";
const ROOT_DIR = path.join(__dirname, "..");

const server = http.createServer((req, res) => {
  // Let Socket.IO handle /socket.io requests
  if (req.url.startsWith("/socket.io")) {
    return;
  }

  if (req.method === "DELETE" || req.method === "HEAD") {
    res.writeHead(405, { "Content-Type": "text/plain" });
    return res.end("Unsupported method.");
  }

  const urlPath = req.url.split("?")[0];
  let filePath;
  let mime;
  let cache = false;

  if (urlPath === "/") {
    filePath = path.join(ROOT_DIR, "app", "index.html");
    mime = "text/html";
  } else if (urlPath === "/static/app.js") {
    filePath = path.join(ROOT_DIR, "app", "app.js");
    mime = "application/javascript";
  } else if (urlPath === "/static/xterm.js") {
    filePath = path.join(ROOT_DIR, "node_modules/@xterm/xterm/lib/xterm.js");
    mime = "application/javascript";
	cache = true;
  } else if (urlPath === "/static/xterm-clipboard.js") {
    filePath = path.join(ROOT_DIR, "node_modules/@xterm/addon-clipboard/lib/addon-clipboard.js");
    mime = "application/javascript";
	cache = true;
  } else if (urlPath === "/static/xterm-fit.js") {
    filePath = path.join(ROOT_DIR, "node_modules/@xterm/addon-fit/lib/addon-fit.js");
    mime = "application/javascript";
	cache = true;
  } else if (urlPath === "/static/xterm-weblinks.js") {
    filePath = path.join(ROOT_DIR, "node_modules/@xterm/addon-web-links/lib/addon-web-links.js");
    mime = "application/javascript";
	cache = true;
  } else if (urlPath === "/static/xterm.css") {
    filePath = path.join(ROOT_DIR, "node_modules/@xterm/xterm/css/xterm.css");
    mime = "text/css";
	cache = true;
  } else {
    res.writeHead(404, { "Content-Type": "text/plain" });
    return res.end("Not Found");
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("File not found.");
    }

    res.writeHead(200, {
		"Content-Type": mime,
		"Cache-Control": cache ? "public, max-age=36000" : "no-cache"
    });
    fs.createReadStream(filePath).pipe(res);
  });
});

const ws = socket(server);

ws.on("connection", (socket) => {
  const ptyProcess = pty.spawn(shell, [], {
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

server.listen(8443, () => console.log("listening on http://0.0.0.0:8443"));
