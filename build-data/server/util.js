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

module.exports = {
  isPrefetchOrPrerender,
};
