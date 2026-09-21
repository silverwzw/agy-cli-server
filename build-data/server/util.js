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

module.exports = {
  isPrefetchOrPrerender,
  noCache,
};
