const express = require("express");
const fs = require("fs");
const path = require("path");

function createUploadRouter({ ROOT_DIR, WORK_DIR }) {
  const router = express.Router();
  const uploadHtmlPath = path.join(ROOT_DIR, "client/upload.html");

  // File Upload: GET (Web UI)
  router.get(["/control/upload", "/control/upload/"], (req, res) => {
    return res.sendFile(uploadHtmlPath, { dotfiles: "allow" });
  });

  // File Upload: PUT (Upload handler)
  router.put(["/control/upload", "/control/upload/"], (req, res) => {
    let headerPath = "";
    let headerFilename = "";
    try {
      if (req.headers["x-file-path"]) {
        headerPath = decodeURIComponent(req.headers["x-file-path"]).trim();
      }
      if (req.headers["x-file-name"]) {
        headerFilename = decodeURIComponent(req.headers["x-file-name"]).trim();
      }
    } catch (_) {
      req.resume();
      return res.status(400).type("text/plain").send("Malformed URL encoding in headers\n");
    }

    const queryPath = typeof req.query.path === "string" ? req.query.path.trim() : "";
    let rawPath = queryPath || headerPath;
    if (!rawPath && headerFilename) {
      rawPath = path.join(WORK_DIR, headerFilename);
    }

    if (!rawPath) {
      req.resume();
      return res.status(400).type("text/plain").send("Missing target file path. Specify via query '?path=...' or 'x-file-path' header\n");
    }

    let targetPath = path.isAbsolute(rawPath) ? path.normalize(rawPath) : path.resolve(WORK_DIR, rawPath);
    if (rawPath.endsWith("/") || (fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory())) {
      const queryFilename = typeof req.query.filename === "string" ? req.query.filename.trim() : "";
      const defaultFilename = headerFilename || queryFilename || `upload_${Date.now()}`;
      targetPath = path.join(targetPath, defaultFilename);
    }

    const rawOverwrite = req.query?.overwrite;
    const allowOverwrite = rawOverwrite !== undefined && rawOverwrite !== "false" && rawOverwrite !== "0";

    // Return 409 Conflict if target file already exists and overwrite is not permitted
    if (!allowOverwrite && fs.existsSync(targetPath)) {
      req.resume();
      return res.status(409).json({
        ok: false,
        error: `File already exists: ${targetPath}`,
      });
    }

    try {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    } catch (err) {
      req.resume();
      return res.status(500).json({ ok: false, error: `Failed to create directory: ${err.message}` });
    }

    // Write to a temporary file in the same directory first for atomic upload and clean aborts
    const tempPath = `${targetPath}.tmp.${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const writeStream = fs.createWriteStream(tempPath);
    let isFinished = false;

    const cleanupTempFile = () => {
      if (!isFinished) {
        writeStream.destroy();
        fs.unlink(tempPath, () => {});
      }
    };

    req.pipe(writeStream);

    writeStream.on("finish", () => {
      // If the client aborted before sending all data, discard partial file
      if (!req.readableEnded) {
        cleanupTempFile();
        return;
      }

      if (!allowOverwrite && fs.existsSync(targetPath)) {
        cleanupTempFile();
        if (!res.headersSent) {
          res.status(409).json({ ok: false, error: `File already exists: ${targetPath}` });
        }
        return;
      }

      // Atomically move temporary file to target path
      fs.rename(tempPath, targetPath, (err) => {
        if (err) {
          cleanupTempFile();
          console.error(`Error renaming temp upload file to [${targetPath}]:`, err);
          if (!res.headersSent) {
            res.status(500).json({ ok: false, error: `Failed to save file: ${err.message}` });
          }
          return;
        }

        isFinished = true;
        res.status(200).json({
          ok: true,
          path: targetPath,
          size: writeStream.bytesWritten,
          message: `File successfully uploaded to ${targetPath}`,
        });
      });
    });

    writeStream.on("error", (err) => {
      cleanupTempFile();
      console.error(`Error saving uploaded file [${targetPath}]:`, err);
      if (!res.headersSent) {
        res.status(500).json({ ok: false, error: err.message });
      }
    });

    req.on("error", (err) => {
      cleanupTempFile();
      console.error("Upload request stream error:", err);
      if (!res.headersSent) {
        res.status(500).json({ ok: false, error: err.message });
      }
    });

    req.on("close", () => {
      if (!req.readableEnded) {
        cleanupTempFile();
      }
    });
  });

  return router;
}

module.exports = { createUploadRouter };
