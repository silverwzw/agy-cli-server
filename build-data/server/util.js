function isPrefetchOrPrerender(req) {
  const headers = req?.headers;
  if (!headers) return false;
  const purpose = (
    headers["sec-purpose"] ||
    headers["purpose"] ||
    headers["x-purpose"] ||
    headers["x-moz"] ||
    ""
  ).toLowerCase();
  return purpose.includes("prefetch") || purpose.includes("prerender");
}

function noCache(req, res, next) {
  res.set({
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
    "Pragma": "no-cache",
    "Expires": "0",
    "Surrogate-Control": "no-store",
  });
  delete req.headers["if-none-match"];
  delete req.headers["if-modified-since"];

  const origSetHeader = res.setHeader;
  res.setHeader = function (field, val) {
    if (typeof field === "string") {
      const lower = field.toLowerCase();
      if (lower === "etag" || lower === "last-modified") {
        return;
      }
    }
    return origSetHeader.apply(this, arguments);
  };

  const origWriteHead = res.writeHead;
  res.writeHead = function (statusCode, reason, headers) {
    let headerObj = typeof reason === "object" ? reason : headers;
    if (headerObj) {
      for (const k of Object.keys(headerObj)) {
        const lower = k.toLowerCase();
        if (lower === "etag" || lower === "last-modified") {
          delete headerObj[k];
        }
      }
    }
    return origWriteHead.apply(this, arguments);
  };

  if (typeof next === "function") {
    next();
  }
}

const posix = require("posix");

function getUserAndGroup(uid, gid) {
  let userName = String(uid);
  let groupName = String(gid);
  try {
    userName = posix.getpwnam(uid).name;
  } catch (_) {}
  try {
    groupName = posix.getgrnam(gid).name;
  } catch (_) {}
  return { userName, groupName, uid, gid };
}

function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return (bytes / Math.pow(k, i)).toFixed(2) + " " + sizes[i];
}

function isTextBuffer(buf) {
  if (!buf || buf.length === 0) return true;

  const sampleLen = Math.min(buf.length, 8192);
  let controlChars = 0;

  for (let i = 0; i < sampleLen; i++) {
    const byte = buf[i];
    // Immediate binary indicator: null byte
    if (byte === 0) {
      return false;
    }
    // Allowed whitespace and control characters:
    // 8: \b, 9: \t, 10: \n, 12: \f, 13: \r, 27: \x1b (ANSI escape)
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13 && byte !== 8 && byte !== 12 && byte !== 27) {
      controlChars++;
    }
  }

  // If suspicious control characters exceed 5%, treat as binary
  if (controlChars / sampleLen > 0.05) {
    return false;
  }

  // Validate UTF-8 decoding
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    decoder.decode(buf.slice(0, sampleLen));
  } catch (_) {
    const looseStr = buf.slice(0, sampleLen).toString("utf-8");
    const replacementCount = (looseStr.match(/\uFFFD/g) || []).length;
    if (replacementCount / sampleLen > 0.05) {
      return false;
    }
  }

  return true;
}

module.exports = {
  isPrefetchOrPrerender,
  noCache,
  getUserAndGroup,
  formatBytes,
  isTextBuffer,
};
