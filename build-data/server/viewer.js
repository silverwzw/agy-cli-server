const express = require("express");
const fs = require("fs");
const path = require("path");
const escapeHtml = require("escape-html");
const { noCache, formatBytes, isTextBuffer } = require("./util");

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

  let sampleBuffer;
  try {
    const fd = fs.openSync(targetFile, "r");
    try {
      const readLen = Math.min(stat.size, 8192);
      sampleBuffer = Buffer.alloc(readLen);
      if (readLen > 0) {
        fs.readSync(fd, sampleBuffer, 0, readLen, 0);
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    if (err.code === "EACCES") {
      return res.status(403).type("text/plain").send(`Permission denied: ${displayPath}\n`);
    }
    return res.status(500).type("text/plain").send(`Error reading file: ${err.message}\n`);
  }

  if (!isTextBuffer(sampleBuffer)) {
    return res.status(400).type("text/plain").send(`Cannot view binary file: ${displayPath} is not a text file\n`);
  }

  const filename = path.basename(targetFile);
  const modeOctal = (stat.mode & 0o7777).toString(8);
  const encodedPath = inputPath.split("/").map(encodeURIComponent).join("/");
  const downloadUrl = `/control/download/${pathIsRel ? "rel" : "abs"}/${encodedPath}`;

  const replacements = {
    FILENAME: escapeHtml(filename),
    DISPLAY_PATH: escapeHtml(displayPath),
    FORMATTED_SIZE: escapeHtml(formatBytes(stat.size)),
    MODE_OCTAL: escapeHtml(modeOctal),
    DOWNLOAD_URL: escapeHtml(downloadUrl),
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
