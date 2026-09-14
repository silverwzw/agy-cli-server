const express = require("express");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

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

function getDownloadHtml(targetFile, stat, rawUrl, ROOT_DIR) {
  const isDirectory = stat.isDirectory();
  const baseName = path.basename(targetFile) || "root";
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

  const templatePath = path.join(ROOT_DIR, "client/download.html");
  let template = fs.readFileSync(templatePath, "utf-8");

  const displayTarget = isDirectory ? `${targetFile} (directory archive)` : targetFile;
  const formattedSize = isDirectory ? `${formatBytes(stat.size)} (directory entry)` : formatBytes(stat.size);
  const replacements = {
    FILENAME: filename,
    TARGET_FILE: displayTarget,
    FORMATTED_SIZE: formattedSize,
    RAW_SIZE: String(stat.size),
    MODE_OCTAL: modeOctal,
    USER_NAME: userName,
    GROUP_NAME: groupName,
    UID: String(uid),
    GID: String(gid),
    DIRECT_DOWNLOAD_URL: directDownloadUrl,
    COMMANDS_STYLE: commandsStyle,
    CHMOD_CMD: chmodCmd,
    CHOWN_NAME_CMD: chownNameCmd,
    CHOWN_ID_CMD: chownIdCmd,
  };

  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => replacements[key] ?? "");
}

function streamDirectoryArchive(req, res, targetDir) {
  const baseName = path.basename(targetDir) || "root";
  const archiveName = `${baseName}.tar.gz`;
  const parentDir = path.dirname(targetDir);
  const cwd = targetDir === "/" ? "/" : parentDir;
  const targetArg = targetDir === "/" ? "." : path.basename(targetDir);

  res.setHeader("Content-Type", "application/gzip");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${encodeURIComponent(archiveName)}"; filename*=UTF-8''${encodeURIComponent(archiveName)}`
  );

  const tarProcess = spawn("tar", ["-czf", "-", "-C", cwd, targetArg]);

  tarProcess.stdout.pipe(res);

  tarProcess.stderr.on("data", (data) => {
    console.error(`tar error for ${targetDir}: ${data}`);
  });

  tarProcess.on("error", (err) => {
    console.error(`Failed to spawn tar process for [${targetDir}]:`, err);
    if (!res.headersSent) {
      res.status(500).type("text/plain").send(`Error creating archive: ${err.message}\n`);
    }
  });

  req.on("close", () => {
    if (!tarProcess.killed) {
      tarProcess.kill();
    }
  });
}

function handleFileDownload(req, res, targetFile, displayPath, ROOT_DIR) {
  let stat;
  try {
    stat = fs.statSync(targetFile);
  } catch (err) {
    if (err.code === "ENOENT") {
      return res.status(404).type("text/plain").send(`File not found: ${displayPath}\n`);
    }
    return res.status(500).type("text/plain").send(`Error reading file status: ${err.message}\n`);
  }

  const isHtmlClient = req.headers["accept"]?.includes("text/html");
  const ua = (req.headers["user-agent"] || "").toLowerCase();
  const isCli = ua.includes("curl") || ua.includes("wget");
  const isRaw = req.query.raw !== undefined;
  const wantsHtml = isHtmlClient && !isCli && !isRaw;

  if (wantsHtml) {
    return res.type("html").send(getDownloadHtml(targetFile, stat, req.originalUrl || req.url, ROOT_DIR));
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

  // Relative path: GET /control/download/rel/<relative_path>
  router.get(["/control/download/rel/{*path}"], (req, res) => {
    let relPath = Array.isArray(req.params.path) ? req.params.path.join("/") : (req.params.path || "");
    relPath = decodeURIComponent(relPath).trim();
    if (!relPath) {
      return res.status(400).type("text/plain").send("Missing relative path. Usage: /control/download/rel/<relative_path>\n");
    }
    const targetFile = path.resolve(WORK_DIR, relPath);
    handleFileDownload(req, res, targetFile, relPath, ROOT_DIR);
  });

  // Absolute path: GET /control/download/abs/<absolute_path>
  router.get(["/control/download/abs/{*path}"], (req, res) => {
    let absPath = Array.isArray(req.params.path) ? req.params.path.join("/") : (req.params.path || "");
    absPath = decodeURIComponent(absPath).trim();
    if (!absPath) {
      return res.status(400).type("text/plain").send("Missing absolute path. Usage: /control/download/abs/<absolute_path>\n");
    }
    const targetFile = path.resolve("/", absPath);
    handleFileDownload(req, res, targetFile, "/" + absPath.replace(/^\/+/, ""), ROOT_DIR);
  });

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
  handleFileDownload,
  streamDirectoryArchive,
  getDownloadHtml,
  getUserAndGroup,
};
