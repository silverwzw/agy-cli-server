const express = require("express");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const posix = require("posix");
const escapeHtml = require("escape-html");

const CLI_UA_KEYWORDS = ["curl", "wget", "aria", "axel", "httpie", "fetch/"];

function getUserAndGroup(uid, gid) {
  let userName = String(uid);
  let groupName = String(gid);
  try {
    userName = posix.getpwnam(uid).name;
  } catch (e) {}
  try {
    groupName = posix.getgrnam(gid).name;
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

function getDownloadHtml(targetFile, stat, rawUrl, template) {
  const isDirectory = stat.isDirectory();
  const baseName = path.basename(targetFile);
  const filename = isDirectory ? `${baseName}.tar.gz` : baseName;
  const safeName = /^[a-zA-Z0-9_\-\.]+$/.test(filename) ? filename : JSON.stringify(filename);
  const modeOctal = (stat.mode & 0o7777).toString(8);
  const { userName, groupName, uid, gid } = getUserAndGroup(stat.uid, stat.gid);

  const chmodCmd = isDirectory ? "" : `chmod ${modeOctal} ${safeName}`;
  const chownNameCmd = isDirectory ? "" : `chown ${userName}:${groupName} ${safeName}`;
  const chownIdCmd = isDirectory ? "" : `chown ${uid}:${gid} ${safeName}`;
  const commandsStyle = isDirectory ? "display: none;" : "";

  const cleanUrl = rawUrl.split("?")[0];
  const directDownloadUrl = `${cleanUrl}?raw`;

  const displayTarget = isDirectory ? `${targetFile} (directory archive)` : targetFile;
  const formattedSize = isDirectory ? `${formatBytes(stat.size)} (directory entry)` : formatBytes(stat.size);
  const replacements = {
    FILENAME: escapeHtml(filename),
    TARGET_FILE: escapeHtml(displayTarget),
    FORMATTED_SIZE: escapeHtml(formattedSize),
    RAW_SIZE: escapeHtml(String(stat.size)),
    MODE_OCTAL: escapeHtml(modeOctal),
    USER_NAME: escapeHtml(userName),
    GROUP_NAME: escapeHtml(groupName),
    UID: escapeHtml(String(uid)),
    GID: escapeHtml(String(gid)),
    DIRECT_DOWNLOAD_URL: escapeHtml(directDownloadUrl),
    COMMANDS_STYLE: commandsStyle,
    CHMOD_CMD: escapeHtml(chmodCmd),
    CHOWN_NAME_CMD: escapeHtml(chownNameCmd),
    CHOWN_ID_CMD: escapeHtml(chownIdCmd),
  };

  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => replacements[key] ?? "");
}

function streamDirectoryArchive(req, res, targetDir) {
  if (targetDir === "/") {
    return res.status(400).type("text/plain").send("Downloading root directory is not supported\n");
  }

  const baseName = path.basename(targetDir);
  const archiveName = `${baseName}.tar.gz`;
  const parentDir = path.dirname(targetDir);

  res.setHeader("Content-Type", "application/gzip");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${encodeURIComponent(archiveName)}"; filename*=UTF-8''${encodeURIComponent(archiveName)}`
  );

  const tarProcess = spawn("tar", ["-czf", "-", "-C", parentDir, baseName]);

  tarProcess.stdout.pipe(res, { end: false });

  tarProcess.stderr.on("data", (data) => {
    console.error(`tar error for ${targetDir}: ${data}`);
  });

  tarProcess.on("error", (err) => {
    console.error(`Failed to spawn tar process for [${targetDir}]:`, err);
    if (!res.headersSent) {
      res.status(500).type("text/plain").send(`Error creating archive: ${err.message}\n`);
    } else {
      res.destroy(err);
    }
  });

  tarProcess.on("close", (code, signal) => {
    if (code === 0) {
      res.end();
      return;
    }

    console.error(`tar process exited with code ${code}, signal ${signal} for [${targetDir}]`);
    if (!res.headersSent) {
      res.status(500).type("text/plain").send("Error creating archive\n");
    } else {
      res.destroy(new Error(`tar process failed with code ${code}`));
    }
  });

  req.on("close", () => {
    if (!tarProcess.killed) {
      tarProcess.kill();
    }
  });
}

function handleFileDownload(req, res, targetFile, displayPath, template) {
  if (targetFile === "/") {
    return res.status(400).type("text/plain").send("Downloading root directory is not supported\n");
  }

  let stat;
  try {
    stat = fs.statSync(targetFile);
  } catch (err) {
    if (err.code === "ENOENT") {
      return res.status(404).type("text/plain").send(`File not found: ${displayPath}\n`);
    }
    return res.status(500).type("text/plain").send(`Error reading file status: ${err.message}\n`);
  }

  // Only allow regular files and directories; reject special files (FIFOs, character/block devices, sockets)
  // to avoid hanging, resource exhaustion, or infinite streaming.
  if (!stat.isFile() && !stat.isDirectory()) {
    return res.status(400).type("text/plain").send(`Unsupported file type: ${displayPath}\n`);
  }

  const isHtmlClient = req.headers["accept"]?.includes("text/html");
  const ua = (req.headers["user-agent"] || "").toLowerCase();
  const isCli = CLI_UA_KEYWORDS.some((kw) => ua.includes(kw));
  const isRaw = req.query.raw !== undefined;
  const wantsHtml = isHtmlClient && !isCli && !isRaw;

  if (wantsHtml) {
    return res.type("html").send(getDownloadHtml(targetFile, stat, req.originalUrl, template));
  }

  if (stat.isDirectory()) {
    return streamDirectoryArchive(req, res, targetFile);
  }

  const filename = path.basename(targetFile);
  res.download(targetFile, filename, { dotfiles: "allow" }, (err) => {
    if (err && !res.headersSent) {
      console.error(`Error downloading file [${targetFile}]:`, err);
      res.status(500).type("text/plain").send(`Error downloading file: ${err.message}\n`);
    }
  });
}

function createDownloadRouter({ ROOT_DIR, WORK_DIR }) {
  const router = express.Router();
  const templatePath = path.join(ROOT_DIR, "client/download.html");
  const template = fs.readFileSync(templatePath, "utf-8");

  // Note: This handler is registered via `handler.bind(undefined, pathIsRel)`.
  // Be cautious when adding parameters: Express distinguishes error-handling middleware
  // by checking `fn.length === 4`. Ensure the resulting bound function's arity does not become 4.
  function handler(pathIsRel, req, res) {
    const purpose = (req.headers?.["sec-purpose"] || req.headers?.["x-purpose"] || req.headers?.["x-moz"] || "").toLowerCase();
    if (purpose.includes("prefetch") || purpose.includes("prerender")) {
		return res.status(400).type("text/plain").send("Prefetch / prerender request not supported for download url.");
	}
    let inputPath = Array.isArray(req.params.path) ? req.params.path.join("/") : (req.params.path || "");
    try {
      inputPath = decodeURIComponent(inputPath).trim();
    } catch (_) {
      return res.status(400).type("text/plain").send("Malformed URL encoding in path\n");
    }
    if (!inputPath) {
      return res.status(400).type("text/plain")
	            .send(`Missing path. Usage: /control/download/${pathIsRel ? "rel" : "abs"}/<path>\n`);
    }
    const targetFile = path.resolve(pathIsRel ? WORK_DIR : "/", inputPath);
	const displayPath = pathIsRel ? inputPath : "/" + inputPath.replace(/^\/+/, "");
    handleFileDownload(req, res, targetFile, displayPath, template);
  }

  // Relative path: GET /control/download/rel/<relative_path>
  router.get(["/control/download/rel/{*path}"], handler.bind(undefined, true));

  // Absolute path: GET /control/download/abs/<absolute_path>
  router.get(["/control/download/abs/{*path}"], handler.bind(undefined, false));

  // Fallback for missing path or invalid format
  router.all(["/control/download", "/control/download/{*path}"], (req, res) => {
    if (req.method !== "GET") {
      return res.status(405).type("text/plain").send(`Unsupported method ${req.method}\n`);
    }
    return res.status(400).type("text/plain").send("Invalid download path format. Usage: /control/download/rel/<relative_path> or /control/download/abs/<absolute_path>\n");
  });

  return router;
}

module.exports = {
  createDownloadRouter,
};
