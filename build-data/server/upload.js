const express = require("express");
const fs = require("fs");
const path = require("path");

const MAX_AUTORENAME_ATTEMPTS = 10000;

function tryLstat(targetPath) {
  try {
    return fs.lstatSync(targetPath);
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") {
      return null;
    }
    throw err;
  }
}

function tryStat(targetPath) {
  try {
    return fs.statSync(targetPath);
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") {
      return null;
    }
    throw err;
  }
}

function splitFilenameParts(filename) {
  // Keep leading dot for dotfiles (e.g. ".env") and preserve compound extensions
  // from the first dot onward (e.g. "filename.extA.extB" -> "filename" + ".extA.extB").
  const dotIdx = filename.indexOf(".", 1);
  if (dotIdx > 0 && dotIdx < filename.length - 1) {
    return {
      stem: filename.slice(0, dotIdx),
      ext: filename.slice(dotIdx),
    };
  }
  return {
    stem: filename,
    ext: "",
  };
}

function buildRenamedPath(targetPath, index) {
  if (index === 0) {
    return targetPath;
  }
  const dir = path.dirname(targetPath);
  const base = path.basename(targetPath);
  const { stem, ext } = splitFilenameParts(base);
  return path.join(dir, `${stem}_${index}${ext}`);
}

function findAvailableCandidateIndex(targetPath) {
  for (let i = 0; i <= MAX_AUTORENAME_ATTEMPTS; i++) {
    const candidate = buildRenamedPath(targetPath, i);
    if (tryLstat(candidate) === null) {
      return { index: i, path: candidate };
    }
  }
  return null;
}

function moveExclusive(src, dest, cb) {
  // Use hard link + unlink for atomic non-overwriting placement when supported.
  fs.link(src, dest, (linkErr) => {
    if (!linkErr) {
      return fs.unlink(src, () => cb(null));
    }
    if (linkErr.code === "EEXIST") {
      return cb(linkErr);
    }
    // Fallback for filesystems that do not support hard links (e.g. EPERM / ENOTSUP / EXDEV).
    try {
      if (tryLstat(dest) !== null) {
        const existsErr = new Error(`File already exists: ${dest}`);
        existsErr.code = "EEXIST";
        return cb(existsErr);
      }
    } catch (statErr) {
      return cb(statErr);
    }
    fs.rename(src, dest, cb);
  });
}

function commitWithAutoRename(tempPath, targetPath, startIndex, cb) {
  let idx = startIndex;

  function attemptNext() {
    while (idx <= MAX_AUTORENAME_ATTEMPTS) {
      const candidate = buildRenamedPath(targetPath, idx);
      let existing = null;
      try {
        existing = tryLstat(candidate);
      } catch (err) {
        return cb(err);
      }
      if (existing !== null) {
        idx++;
        continue;
      }

      return moveExclusive(tempPath, candidate, (err) => {
        if (!err) {
          return cb(null, candidate, idx > 0);
        }
        if (err.code === "EEXIST") {
          idx++;
          return attemptNext();
        }
        return cb(err);
      });
    }

    const limitErr = new Error(`Too many filename conflicts for ${targetPath}`);
    limitErr.code = "EEXIST";
    cb(limitErr);
  }

  attemptNext();
}

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

    const rawOverwrite = req.query?.overwrite;
    const allowOverwrite = rawOverwrite !== undefined && rawOverwrite !== "false" && rawOverwrite !== "0";
    const rawAutoRename = req.query?.autorename;
    const autoRename = !allowOverwrite && rawAutoRename !== undefined && rawAutoRename !== "false" && rawAutoRename !== "0";

    let targetPath = path.isAbsolute(rawPath) ? path.normalize(rawPath) : path.resolve(WORK_DIR, rawPath);
    try {
      const existingStat = tryStat(targetPath);
      if (rawPath.endsWith("/") || (!autoRename && existingStat?.isDirectory())) {
        const queryFilename = typeof req.query.filename === "string" ? req.query.filename.trim() : "";
        const defaultFilename = headerFilename || queryFilename || `upload_${Date.now()}`;
        if (defaultFilename === "." || defaultFilename === ".." || defaultFilename.includes("/")) {
          req.resume();
          return res.status(400).json({ ok: false, error: "Invalid target filename" });
        }
        targetPath = path.join(targetPath, defaultFilename);
      }
    } catch (err) {
      req.resume();
      return res.status(500).json({ ok: false, error: `Failed to inspect target path: ${err.message}` });
    }

    let initialCandidateIndex = 0;
    try {
      // Use lstat-based check so broken symlinks are treated as existing entries.
      const existingEntry = tryLstat(targetPath);
      if (!allowOverwrite && !autoRename && existingEntry !== null) {
        req.resume();
        return res.status(409).json({
          ok: false,
          error: `File already exists: ${targetPath}`,
        });
      }
      if (allowOverwrite && existingEntry?.isDirectory()) {
        req.resume();
        return res.status(409).json({
          ok: false,
          error: `Target path is a directory: ${targetPath}`,
        });
      }
      if (autoRename) {
        const available = findAvailableCandidateIndex(targetPath);
        if (!available) {
          req.resume();
          return res.status(409).json({
            ok: false,
            error: `Too many filename conflicts for ${targetPath}`,
          });
        }
        initialCandidateIndex = available.index;
      }
    } catch (err) {
      req.resume();
      return res.status(500).json({ ok: false, error: `Failed to check target path: ${err.message}` });
    }

    const targetDir = path.dirname(targetPath);
    try {
      fs.mkdirSync(targetDir, { recursive: true });
    } catch (err) {
      req.resume();
      return res.status(500).json({ ok: false, error: `Failed to create directory: ${err.message}` });
    }

    // Write to a short temporary file in the same directory first for atomic upload and clean aborts.
    const tempPath = path.join(targetDir, `.upload.tmp.${Date.now()}_${Math.random().toString(36).slice(2, 10)}`);
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

      const onCommitted = (err, finalPath, renamed) => {
        if (err) {
          cleanupTempFile();
          if (err.code === "EEXIST") {
            if (!res.headersSent) {
              res.status(409).json({ ok: false, error: err.message || `File already exists: ${targetPath}` });
            }
            return;
          }
          console.error(`Error saving uploaded file to [${targetPath}]:`, err);
          if (!res.headersSent) {
            res.status(500).json({ ok: false, error: `Failed to save file: ${err.message}` });
          }
          return;
        }

        isFinished = true;
        res.status(200).json({
          ok: true,
          path: finalPath,
          renamed: Boolean(renamed),
          size: writeStream.bytesWritten,
          message: `File successfully uploaded to ${finalPath}`,
        });
      };

      if (autoRename) {
        commitWithAutoRename(tempPath, targetPath, initialCandidateIndex, onCommitted);
      } else if (!allowOverwrite) {
        moveExclusive(tempPath, targetPath, (err) => onCommitted(err, targetPath, false));
      } else {
        fs.rename(tempPath, targetPath, (err) => onCommitted(err, targetPath, false));
      }
    });

    writeStream.on("error", (err) => {
      cleanupTempFile();
      req.unpipe(writeStream);
      req.resume();
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
