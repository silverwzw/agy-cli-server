const express = require("express");
const fs = require("fs");
const path = require("path");

function createUploadRouter({ ROOT_DIR, WORK_DIR }) {
  const router = express.Router();

  // File Upload: GET (Web UI)
  router.get(["/control/upload", "/control/upload/"], (req, res) => {
    res.set("Cache-Control", "no-cache");
    return res.sendFile(path.join(ROOT_DIR, "client/upload.html"), { dotfiles: "allow" });
  });

  // File Upload: PUT (Upload handler)
  router.put(["/control/upload", "/control/upload/"], (req, res) => {
    let rawPath = String(req.query.path || req.headers["x-file-path"] || "").trim();
    if (!rawPath && req.headers["x-file-name"]) {
      rawPath = path.join(WORK_DIR, req.headers["x-file-name"]);
    }

    if (!rawPath) {
      return res.status(400).type("text/plain").send("Missing target file path. Specify via query '?path=...' or 'x-file-path' header\n");
    }

    let targetPath = path.isAbsolute(rawPath) ? path.normalize(rawPath) : path.resolve(WORK_DIR, rawPath);
    if (rawPath.endsWith("/") || (fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory())) {
      const defaultFilename = req.headers["x-file-name"] || req.query.filename || `upload_${Date.now()}`;
      targetPath = path.join(targetPath, defaultFilename);
    }

    // Return 409 Conflict if target file already exists
    if (fs.existsSync(targetPath)) {
      req.resume();
      return res.status(409).json({
        ok: false,
        error: `File already exists: ${targetPath}`,
      });
    }

    try {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    } catch (err) {
      return res.status(500).json({ ok: false, error: `Failed to create directory: ${err.message}` });
    }

    const writeStream = fs.createWriteStream(targetPath, { flags: "wx" });
    req.pipe(writeStream);

    writeStream.on("finish", () => {
      res.status(200).json({
        ok: true,
        path: targetPath,
        size: writeStream.bytesWritten,
        message: `File successfully uploaded to ${targetPath}`,
      });
    });

    writeStream.on("error", (err) => {
      console.error(`Error saving uploaded file [${targetPath}]:`, err);
      if (!res.headersSent) {
        if (err.code === "EEXIST") {
          res.status(409).json({ ok: false, error: `File already exists: ${targetPath}` });
        } else {
          res.status(500).json({ ok: false, error: err.message });
        }
      }
    });

    req.on("error", (err) => {
      console.error("Upload request stream error:", err);
      writeStream.destroy();
      if (!res.headersSent) {
        res.status(500).json({ ok: false, error: err.message });
      }
    });
  });

  return router;
}

module.exports = { createUploadRouter };
