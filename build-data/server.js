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
// TODO: multifile upload

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
  return p1;
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

  const isHtmlClient = req.headers["accept"] && req.headers["accept"].includes("text/html");
  const ua = (req.headers["user-agent"] || "").toLowerCase();
  const isCli = ua.includes("curl") || ua.includes("wget");
  const isRaw = req.query.raw !== undefined;
  const wantsHtml = isHtmlClient && !isCli && !isRaw;

  if (wantsHtml) {
    res.set("Cache-Control", "no-cache");
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

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Download ${filename} - Web Terminal</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: #0f172a;
      color: #e2e8f0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, monospace;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 40px 20px;
    }
    .header {
      width: 100%;
      max-width: 680px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 24px;
    }
    .title {
      font-size: 20px;
      font-weight: 600;
      color: #f8fafc;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .nav-links a {
      color: #38bdf8;
      text-decoration: none;
      font-size: 14px;
      margin-left: 12px;
      padding: 4px 8px;
      border-radius: 4px;
      background: #1e293b;
      transition: background 0.2s;
    }
    .nav-links a:hover {
      background: #334155;
    }
    .card {
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 8px;
      width: 100%;
      max-width: 680px;
      padding: 24px;
      box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5);
    }
    .file-header {
      display: flex;
      align-items: flex-start;
      gap: 16px;
      margin-bottom: 20px;
      padding-bottom: 20px;
      border-bottom: 1px solid #334155;
    }
    .file-icon {
      font-size: 40px;
      line-height: 1;
      color: #38bdf8;
    }
    .file-main {
      flex: 1;
      overflow: hidden;
    }
    .file-name {
      font-size: 18px;
      font-weight: 600;
      color: #f8fafc;
      word-break: break-all;
      margin-bottom: 4px;
    }
    .file-path {
      font-size: 13px;
      color: #94a3b8;
      font-family: monospace;
      word-break: break-all;
    }
    .metadata-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 12px;
      margin-bottom: 24px;
    }
    .meta-item {
      background: #0f172a;
      border: 1px solid #334155;
      border-radius: 6px;
      padding: 10px 14px;
    }
    .meta-label {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: #64748b;
      margin-bottom: 4px;
    }
    .meta-value {
      font-size: 13px;
      color: #e2e8f0;
      font-family: monospace;
      font-weight: 500;
    }
    .download-status {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 10px 14px;
      background: rgba(56, 189, 248, 0.1);
      border: 1px solid rgba(56, 189, 248, 0.25);
      border-radius: 6px;
      font-size: 13px;
      color: #7dd3fc;
      margin-bottom: 24px;
    }
    .retry-link {
      color: #38bdf8;
      text-decoration: underline;
    }
    .commands-section {
      background: #0f172a;
      border: 1px solid #334155;
      border-radius: 8px;
      padding: 18px;
    }
    .commands-title {
      font-size: 14px;
      font-weight: 600;
      color: #f8fafc;
      margin-bottom: 6px;
    }
    .commands-desc {
      font-size: 12px;
      color: #94a3b8;
      margin-bottom: 16px;
      line-height: 1.5;
    }
    .command-group {
      margin-bottom: 14px;
    }
    .command-group:last-child {
      margin-bottom: 0;
    }
    .command-label {
      font-size: 12px;
      font-weight: 500;
      color: #cbd5e1;
      margin-bottom: 6px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .command-box {
      display: flex;
      align-items: center;
      background: #182234;
      border: 1px solid #334155;
      border-radius: 6px;
      overflow: hidden;
    }
    .command-code {
      flex: 1;
      padding: 10px 14px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 13px;
      color: #38bdf8;
      overflow-x: auto;
      white-space: nowrap;
    }
    .btn-copy {
      background: #1e293b;
      border: none;
      border-left: 1px solid #334155;
      color: #94a3b8;
      padding: 10px 14px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s;
      white-space: nowrap;
    }
    .btn-copy:hover {
      background: #334155;
      color: #f8fafc;
    }
    .btn-copy.copied {
      background: #065f46;
      color: #6ee7b7;
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="title">📥 File Download</div>
    <div class="nav-links">
      <a href="/a">Terminal (agy)</a>
      <a href="/s">Shell (bash)</a>
      <a href="/control/upload">Upload</a>
    </div>
  </div>

  <div class="card">
    <div class="file-header">
      <div class="file-icon">📄</div>
      <div class="file-main">
        <div class="file-name">${filename}</div>
        <div class="file-path">${targetFile}</div>
      </div>
    </div>

    <div class="metadata-grid">
      <div class="meta-item">
        <div class="meta-label">File Size</div>
        <div class="meta-value">${formatBytes(stat.size)} (${stat.size} bytes)</div>
      </div>
      <div class="meta-item">
        <div class="meta-label">Permissions (Mode)</div>
        <div class="meta-value">${modeOctal}</div>
      </div>
      <div class="meta-item">
        <div class="meta-label">Owner (Name)</div>
        <div class="meta-value">${userName}:${groupName}</div>
      </div>
      <div class="meta-item">
        <div class="meta-label">Owner (ID)</div>
        <div class="meta-value">UID ${uid} : GID ${gid}</div>
      </div>
    </div>

    <div class="download-status">
      <span>⬇ Direct download triggered automatically...</span>
      <span style="font-size: 12px; color: #94a3b8;">(<a href="${directDownloadUrl}" class="retry-link">click here</a> if download didn't start)</span>
    </div>
    <iframe src="${directDownloadUrl}" style="display: none;"></iframe>

    <div class="commands-section">
      <div class="commands-title">⚙️ Restore Permissions & Ownership</div>
      <div class="commands-desc">
        Run these commands after downloading to restore original permissions and ownership on your target system:
      </div>

      <div class="command-group">
        <div class="command-label">
          <span>1. Permissions (chmod)</span>
        </div>
        <div class="command-box">
          <code class="command-code" id="cmd-chmod">${chmodCmd}</code>
          <button class="btn-copy" onclick="copyText('${chmodCmd}', this)">Copy</button>
        </div>
      </div>

      <div class="command-group">
        <div class="command-label">
          <span>2. Ownership — Username & Group Name Version</span>
        </div>
        <div class="command-box">
          <code class="command-code" id="cmd-chown-name">${chownNameCmd}</code>
          <button class="btn-copy" onclick="copyText('${chownNameCmd}', this)">Copy</button>
        </div>
      </div>

      <div class="command-group">
        <div class="command-label">
          <span>3. Ownership — UID & GID Version</span>
        </div>
        <div class="command-box">
          <code class="command-code" id="cmd-chown-id">${chownIdCmd}</code>
          <button class="btn-copy" onclick="copyText('${chownIdCmd}', this)">Copy</button>
        </div>
      </div>
    </div>
  </div>

  <script>
    function copyText(text, btn) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => {
          showCopied(btn);
        }).catch(() => fallbackCopy(text, btn));
      } else {
        fallbackCopy(text, btn);
      }
    }

    function fallbackCopy(text, btn) {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        showCopied(btn);
      } catch (e) {
        console.error("Copy failed", e);
      }
      document.body.removeChild(ta);
    }

    function showCopied(btn) {
      const orig = btn.innerText;
      btn.innerText = "✓ Copied!";
      btn.classList.add("copied");
      setTimeout(() => {
        btn.innerText = orig;
        btn.classList.remove("copied");
      }, 2000);
    }

    window.addEventListener("DOMContentLoaded", () => {
      const a = document.createElement("a");
      a.href = "${directDownloadUrl}";
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        try { document.body.removeChild(a); } catch(e) {}
      }, 1000);
    });
  </script>
</body>
</html>`;
}

function getUploadHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>File Upload - Web Terminal</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: #0f172a;
      color: #e2e8f0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, monospace;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 40px 20px;
    }
    .header {
      width: 100%;
      max-width: 640px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 24px;
    }
    .title {
      font-size: 20px;
      font-weight: 600;
      color: #f8fafc;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .nav-links a {
      color: #38bdf8;
      text-decoration: none;
      font-size: 14px;
      margin-left: 12px;
      padding: 4px 8px;
      border-radius: 4px;
      background: #1e293b;
      transition: background 0.2s;
    }
    .nav-links a:hover {
      background: #334155;
    }
    .card {
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 8px;
      width: 100%;
      max-width: 640px;
      padding: 24px;
      box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5);
    }
    .form-group {
      margin-bottom: 20px;
    }
    .form-group label {
      display: block;
      font-size: 13px;
      font-weight: 500;
      color: #94a3b8;
      margin-bottom: 6px;
    }
    .form-group input[type="text"] {
      width: 100%;
      padding: 10px 12px;
      background: #0f172a;
      border: 1px solid #334155;
      border-radius: 6px;
      color: #f8fafc;
      font-family: monospace;
      font-size: 14px;
      outline: none;
      transition: border-color 0.2s;
    }
    .form-group input[type="text"]:focus {
      border-color: #38bdf8;
    }
    .drop-zone {
      border: 2px dashed #475569;
      border-radius: 8px;
      padding: 32px 20px;
      text-align: center;
      cursor: pointer;
      background: #0f172a;
      transition: all 0.2s ease;
      margin-bottom: 20px;
    }
    .drop-zone.dragover {
      border-color: #38bdf8;
      background: #1e293b;
    }
    .drop-zone-icon {
      font-size: 36px;
      margin-bottom: 8px;
      color: #94a3b8;
    }
    .drop-zone-text {
      font-size: 14px;
      color: #cbd5e1;
    }
    .drop-zone-subtext {
      font-size: 12px;
      color: #64748b;
      margin-top: 4px;
    }
    .file-info {
      background: #0f172a;
      border: 1px solid #334155;
      border-radius: 6px;
      padding: 12px;
      margin-bottom: 20px;
      display: none;
    }
    .file-info-row {
      display: flex;
      justify-content: space-between;
      font-size: 13px;
      margin-bottom: 4px;
    }
    .file-info-row:last-child { margin-bottom: 0; }
    .file-info-label { color: #94a3b8; }
    .file-info-val { color: #f8fafc; font-family: monospace; }
    .btn-upload {
      width: 100%;
      padding: 12px;
      background: #0284c7;
      color: #ffffff;
      border: none;
      border-radius: 6px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.2s;
    }
    .btn-upload:hover:not(:disabled) {
      background: #0369a1;
    }
    .btn-upload:disabled {
      background: #475569;
      cursor: not-allowed;
      opacity: 0.6;
    }
    .progress-container {
      margin-top: 20px;
      display: none;
    }
    .progress-header {
      display: flex;
      justify-content: space-between;
      font-size: 12px;
      margin-bottom: 6px;
      color: #94a3b8;
    }
    .progress-bar-bg {
      width: 100%;
      height: 8px;
      background: #0f172a;
      border-radius: 4px;
      overflow: hidden;
    }
    .progress-bar-fill {
      height: 100%;
      width: 0%;
      background: #38bdf8;
      transition: width 0.1s ease;
    }
    .result-box {
      margin-top: 20px;
      padding: 14px;
      border-radius: 6px;
      font-size: 13px;
      display: none;
    }
    .result-box.success {
      background: rgba(34, 197, 94, 0.15);
      border: 1px solid #22c55e;
      color: #86efac;
    }
    .result-box.error {
      background: rgba(239, 68, 68, 0.15);
      border: 1px solid #ef4444;
      color: #fca5a5;
    }
    .result-link {
      display: inline-block;
      margin-top: 8px;
      color: #38bdf8;
      text-decoration: underline;
      word-break: break-all;
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="title">📁 File Upload</div>
    <div class="nav-links">
      <a href="/a">Terminal (agy)</a>
      <a href="/s">Shell (bash)</a>
    </div>
  </div>

  <div class="card">
    <div class="form-group">
      <label for="dest-path">Target Directory or Full File Path</label>
      <input type="text" id="dest-path" value="/agy" placeholder="/agy or /agy/subfolder" />
    </div>

    <input type="file" id="file-input" style="display: none;" />

    <div class="drop-zone" id="drop-zone">
      <div class="drop-zone-icon">⇪</div>
      <div class="drop-zone-text">Click or drag & drop files here to upload</div>
      <div class="drop-zone-subtext">Uses HTTP PUT to stream files directly into the container</div>
    </div>

    <div class="file-info" id="file-info">
      <div class="file-info-row">
        <span class="file-info-label">Selected File:</span>
        <span class="file-info-val" id="info-name">-</span>
      </div>
      <div class="file-info-row">
        <span class="file-info-label">Size:</span>
        <span class="file-info-val" id="info-size">-</span>
      </div>
      <div class="file-info-row">
        <span class="file-info-label">Target Destination:</span>
        <span class="file-info-val" id="info-dest">-</span>
      </div>
    </div>

    <button type="button" class="btn-upload" id="btn-upload" disabled>Upload File (PUT)</button>

    <div class="progress-container" id="progress-container">
      <div class="progress-header">
        <span id="progress-status">Uploading...</span>
        <span id="progress-pct">0%</span>
      </div>
      <div class="progress-bar-bg">
        <div class="progress-bar-fill" id="progress-fill"></div>
      </div>
    </div>

    <div class="result-box" id="result-box"></div>
  </div>

  <script>
    const dropZone = document.getElementById("drop-zone");
    const fileInput = document.getElementById("file-input");
    const destPathInput = document.getElementById("dest-path");
    const fileInfo = document.getElementById("file-info");
    const infoName = document.getElementById("info-name");
    const infoSize = document.getElementById("info-size");
    const infoDest = document.getElementById("info-dest");
    const btnUpload = document.getElementById("btn-upload");
    const progressContainer = document.getElementById("progress-container");
    const progressFill = document.getElementById("progress-fill");
    const progressPct = document.getElementById("progress-pct");
    const progressStatus = document.getElementById("progress-status");
    const resultBox = document.getElementById("result-box");

    let currentFile = null;

    function formatBytes(bytes) {
      if (bytes === 0) return "0 B";
      const k = 1024;
      const sizes = ["B", "KB", "MB", "GB", "TB"];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return (bytes / Math.pow(k, i)).toFixed(2) + " " + sizes[i];
    }

    function computeTargetPath() {
      if (!currentFile) return "";
      let dest = destPathInput.value.trim() || "/agy";
      if (dest.endsWith("/") || !dest.includes(".")) {
        return (dest.replace(/\\/+$/, "") + "/" + currentFile.name).replace(/\\/+/g, "/");
      }
      return dest;
    }

    function updatePreview() {
      if (!currentFile) {
        fileInfo.style.display = "none";
        btnUpload.disabled = true;
        return;
      }
      infoName.innerText = currentFile.name;
      infoSize.innerText = formatBytes(currentFile.size);
      infoDest.innerText = computeTargetPath();
      fileInfo.style.display = "block";
      btnUpload.disabled = false;
    }

    dropZone.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", (e) => {
      if (e.target.files && e.target.files.length > 0) {
        currentFile = e.target.files[0];
        updatePreview();
      }
    });

    destPathInput.addEventListener("input", updatePreview);

    ["dragenter", "dragover"].forEach(event => {
      dropZone.addEventListener(event, (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropZone.classList.add("dragover");
      });
    });

    ["dragleave", "drop"].forEach(event => {
      dropZone.addEventListener(event, (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropZone.classList.remove("dragover");
      });
    });

    dropZone.addEventListener("drop", (e) => {
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        currentFile = e.dataTransfer.files[0];
        updatePreview();
      }
    });

    btnUpload.addEventListener("click", () => {
      if (!currentFile) return;
      const target = computeTargetPath();
      btnUpload.disabled = true;
      progressContainer.style.display = "block";
      resultBox.style.display = "none";
      progressFill.style.width = "0%";
      progressPct.innerText = "0%";
      progressStatus.innerText = "Uploading " + currentFile.name + "...";

      const xhr = new XMLHttpRequest();
      xhr.open("PUT", "/control/upload?path=" + encodeURIComponent(target));
      xhr.setRequestHeader("X-File-Path", target);
      xhr.setRequestHeader("X-File-Name", currentFile.name);

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          const pct = ((e.loaded / e.total) * 100).toFixed(1);
          progressFill.style.width = pct + "%";
          progressPct.innerText = pct + "% (" + formatBytes(e.loaded) + " / " + formatBytes(e.total) + ")";
        }
      };

      xhr.onload = () => {
        btnUpload.disabled = false;
        if (xhr.status >= 200 && xhr.status < 300) {
          progressFill.style.width = "100%";
          progressPct.innerText = "100%";
          progressStatus.innerText = "Upload Complete!";
          let resData = {};
          try { resData = JSON.parse(xhr.responseText); } catch(err) {}
          resultBox.className = "result-box success";
          resultBox.innerHTML = "<strong>✓ Success!</strong> File uploaded to <code>" + (resData.path || target) + "</code> (" + formatBytes(currentFile.size) + ")";
          resultBox.style.display = "block";
        } else {
          resultBox.className = "result-box error";
          resultBox.innerText = "Upload failed (" + xhr.status + "): " + (xhr.responseText || "Unknown error");
          resultBox.style.display = "block";
        }
      };

      xhr.onerror = () => {
        btnUpload.disabled = false;
        resultBox.className = "result-box error";
        resultBox.innerText = "Network error occurred during upload.";
        resultBox.style.display = "block";
      };

      xhr.send(currentFile);
    });
  </script>
</body>
</html>`;
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

    if (this.ptyProcess && this.ptyProcess.pid) {
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
    return res.type("html").send(getUploadHtml());
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
  if (cleanedSessions.has(sessionName)) {
    return next(new Error(`Session "${sessionName}" has been cleaned up`));
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
