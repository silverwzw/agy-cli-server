const express = require("express");
const fs = require("fs");
const path = require("path");
const escapeHtml = require("escape-html");
const { noCache, getUserAndGroup, formatBytes, isTextBuffer } = require("./util");

const MAX_VIEW_SIZE = 2 * 1024 * 1024; // 2 MB maximum supported size for browser rendering

function handleFileView(req, res, targetFile, displayPath, inputPath, pathIsRel, template) {
  let stat;
  try {
    stat = fs.statSync(targetFile);
  } catch (err) {
    if (err.code === "ENOENT") {
      return res.status(404).type("text/plain").send(`File not found: ${displayPath}\n`);
    }
    if (err.code === "EACCES") {
      return res.status(403).type("text/plain").send(`Permission denied: ${displayPath}\n`);
    }
    return res.status(500).type("text/plain").send(`Error reading file status: ${err.message}\n`);
  }

  if (stat.isDirectory()) {
    return res.status(400).type("text/plain").send(`Cannot view directory as a text file: ${displayPath}\n`);
  }

  if (!stat.isFile()) {
    return res.status(400).type("text/plain").send(`Unsupported file type: ${displayPath}\n`);
  }

  if (stat.size > MAX_VIEW_SIZE) {
    return res.status(400).type("text/plain").send(`File is too large to view (${formatBytes(stat.size)} > 2 MB). Use /control/download to download it.\n`);
  }

  let contentBuffer;
  try {
    contentBuffer = fs.readFileSync(targetFile);
  } catch (err) {
    if (err.code === "EACCES") {
      return res.status(403).type("text/plain").send(`Permission denied: ${displayPath}\n`);
    }
    return res.status(500).type("text/plain").send(`Error reading file: ${err.message}\n`);
  }

  if (!isTextBuffer(contentBuffer)) {
    return res.status(400).type("text/plain").send(`Cannot view binary file: ${displayPath} is not a text file\n`);
  }

  const rawContent = contentBuffer.toString("utf-8");
  let rawLines;
  if (rawContent.length === 0) {
    rawLines = [];
  } else {
    rawLines = rawContent.split(/\r?\n/);
    if (rawContent.endsWith("\n") && rawLines[rawLines.length - 1] === "") {
      rawLines.pop();
    }
  }

  const totalLines = rawLines.length;
  const numDigits = Math.max(String(totalLines).length, 1);
  const gutterWidth = Math.max(48, numDigits * 9 + 24);

  let rowsHtml = "";
  if (totalLines === 0) {
    rowsHtml = `<div class="empty-file-row"><span class="empty-file-text">Empty file (0 lines)</span></div>`;
  } else {
    const rows = [];
    for (let i = 0; i < totalLines; i++) {
      const lineNum = i + 1;
      const escapedLine = escapeHtml(rawLines[i]);

      rows.push(
        `<div class="line-row" id="L${lineNum}" data-line="${lineNum}">` +
        `<a class="line-num" href="?line=${lineNum}" data-line="${lineNum}">${lineNum}</a>` +
        `<span class="line-content">${escapedLine}</span>` +
        `</div>`
      );
    }
    rowsHtml = rows.join("\n");
  }

  const filename = path.basename(targetFile);
  const modeOctal = (stat.mode & 0o7777).toString(8);
  const { userName, groupName, uid, gid } = getUserAndGroup(stat.uid, stat.gid);
  const downloadUrl = `/control/download/${pathIsRel ? "rel" : "abs"}/${encodeURI(inputPath)}`;

  const replacements = {
    FILENAME: escapeHtml(filename),
    DISPLAY_PATH: escapeHtml(displayPath),
    TARGET_FILE: escapeHtml(targetFile),
    FORMATTED_SIZE: escapeHtml(formatBytes(stat.size)),
    RAW_SIZE: escapeHtml(String(stat.size)),
    TOTAL_LINES: escapeHtml(String(totalLines)),
    MODE_OCTAL: escapeHtml(modeOctal),
    USER_NAME: escapeHtml(userName),
    GROUP_NAME: escapeHtml(groupName),
    UID: escapeHtml(String(uid)),
    GID: escapeHtml(String(gid)),
    DOWNLOAD_URL: escapeHtml(downloadUrl),
    FILE_CONTENT_ROWS: rowsHtml,
    GUTTER_WIDTH: `${gutterWidth}px`,
  };

  const html = template.replace(/\{\{(\w+)\}\}/g, (_, key) => replacements[key] ?? "");
  res.type("html").send(html);
}

function createViewerRouter({ ROOT_DIR, WORK_DIR }) {
  const router = express.Router();
  const templatePath = path.join(ROOT_DIR, "client/viewer.html");
  const template = fs.readFileSync(templatePath, "utf-8");

  router.use(noCache);

  // Note: This handler is registered via `handler.bind(undefined, pathIsRel)`.
  // Be cautious when adding parameters: Express distinguishes error-handling middleware
  // by checking `fn.length === 4`. Ensure the resulting bound function's arity does not become 4.
  function handler(pathIsRel, req, res) {
    let inputPath = Array.isArray(req.params.path) ? req.params.path.join("/") : (req.params.path || "");
    try {
      inputPath = decodeURIComponent(inputPath).trim();
    } catch (_) {
      return res.status(400).type("text/plain").send("Malformed URL encoding in path\n");
    }
    if (!inputPath) {
      return res.status(400).type("text/plain")
                .send(`Missing path. Usage: /control/viewer/${pathIsRel ? "rel" : "abs"}/<path>\n`);
    }

    const targetFile = path.resolve(pathIsRel ? WORK_DIR : "/", inputPath);
    const displayPath = pathIsRel ? inputPath : "/" + inputPath.replace(/^\/+/, "");
    handleFileView(req, res, targetFile, displayPath, inputPath, pathIsRel, template);
  }

  // Relative path: GET /control/viewer/rel/<relative_path>
  router.get(["/control/viewer/rel/{*path}"], handler.bind(undefined, true));

  // Absolute path: GET /control/viewer/abs/<absolute_path>
  router.get(["/control/viewer/abs/{*path}"], handler.bind(undefined, false));

  // Fallback for missing path or invalid format
  router.all(["/control/viewer", "/control/viewer/{*path}"], (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return res.status(405).type("text/plain").send(`Unsupported method ${req.method}\n`);
    }
    return res.status(400).type("text/plain").send("Invalid viewer path format. Usage: /control/viewer/rel/<relative_path> or /control/viewer/abs/<absolute_path>\n");
  });

  return router;
}

module.exports = {
  createViewerRouter,
};
