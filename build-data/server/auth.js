const crypto = require("crypto");
const shacrypt = require("@vlasky/shacrypt");

const AUTH_CACHE_TTL_MS = 60 * 1000;
const AUTH_CACHE_MAX_ENTRIES = 64;
const MAX_CRYPT_ROUNDS = 1000000;

/**
 * Parse and validate an HTTP Basic Auth credential spec formatted as
 * "<username>:<sha256-crypt-hash>". Returns null if unset/empty,
 * or throws a non-sensitive Error if invalid.
 */
function parseBasicAuthEnv(rawValue) {
  if (rawValue === undefined || rawValue === null) {
    return null;
  }
  const spec = String(rawValue).trim();
  if (!spec) {
    return null;
  }

  const sepIndex = spec.indexOf(":");
  if (sepIndex <= 0 || sepIndex === spec.length - 1) {
    throw new Error("Invalid HTTP_BASIC_AUTH format (expected '<username>:<sha256-crypt-hash>')");
  }

  const username = spec.slice(0, sepIndex);
  const passwordHash = spec.slice(sepIndex + 1);

  if (/[\r\n\0]/.test(username)) {
    throw new Error("Invalid HTTP_BASIC_AUTH username");
  }
  if (!passwordHash.startsWith("$5$")) {
    throw new Error("Invalid HTTP_BASIC_AUTH hash format (expected SHA-256 crypt starting with '$5$')");
  }

  try {
    shacrypt.verify("", passwordHash, { maxRounds: MAX_CRYPT_ROUNDS });
  } catch (_) {
    throw new Error("Invalid HTTP_BASIC_AUTH SHA-256 crypt hash");
  }

  const usernameDigest = crypto.createHash("sha256").update(username, "utf8").digest();
  return {
    usernameDigest,
    passwordHash,
  };
}

function createBasicAuthVerifier(config) {
  if (!config) {
    return null;
  }

  // Per-process ephemeral key so cache keys never store plaintext credentials or raw headers.
  const cacheHmacKey = crypto.randomBytes(32);
  const verifiedCache = new Map();
  const inFlight = new Map();

  function getCached(cacheKey) {
    const expiresAt = verifiedCache.get(cacheKey);
    if (expiresAt === undefined) {
      return false;
    }
    if (Date.now() >= expiresAt) {
      verifiedCache.delete(cacheKey);
      return false;
    }
    return true;
  }

  function setCached(cacheKey) {
    if (verifiedCache.size >= AUTH_CACHE_MAX_ENTRIES) {
      const oldestKey = verifiedCache.keys().next().value;
      if (oldestKey !== undefined) {
        verifiedCache.delete(oldestKey);
      }
    }
    verifiedCache.set(cacheKey, Date.now() + AUTH_CACHE_TTL_MS);
  }

  async function verifyHeader(authHeader) {
    if (typeof authHeader !== "string") {
      return false;
    }
    const match = authHeader.trim().match(/^Basic\s+([A-Za-z0-9+/]+={0,2})$/i);
    if (!match) {
      return false;
    }

    const cacheKey = crypto.createHmac("sha256", cacheHmacKey).update(authHeader.trim()).digest("hex");
    if (getCached(cacheKey)) {
      return true;
    }

    if (inFlight.has(cacheKey)) {
      return inFlight.get(cacheKey);
    }

    const verifyPromise = (async () => {
      let decoded;
      try {
        decoded = Buffer.from(match[1], "base64").toString("utf8");
      } catch (_) {
        return false;
      }

      const colonIdx = decoded.indexOf(":");
      if (colonIdx === -1) {
        return false;
      }

      const reqUser = decoded.slice(0, colonIdx);
      const reqPass = decoded.slice(colonIdx + 1);
      const reqUserDigest = crypto.createHash("sha256").update(reqUser, "utf8").digest();
      const userMatches = crypto.timingSafeEqual(reqUserDigest, config.usernameDigest);

      // Always execute hash verification even on username mismatch to avoid timing side channels.
      let passMatches = false;
      try {
        passMatches = await shacrypt.verifyAsync(reqPass, config.passwordHash, {
          maxRounds: MAX_CRYPT_ROUNDS,
        });
      } catch (_) {
        passMatches = false;
      }

      const ok = userMatches && passMatches;
      if (ok) {
        setCached(cacheKey);
      }
      return ok;
    })();

    inFlight.set(cacheKey, verifyPromise);
    try {
      return await verifyPromise;
    } finally {
      inFlight.delete(cacheKey);
    }
  }

  return {
    verifyHeader,
  };
}

function createBasicAuthMiddleware(verifier) {
  return async (req, res, next) => {
    if (!verifier) {
      return next();
    }
    try {
      if (await verifier.verifyHeader(req.headers?.authorization)) {
        return next();
      }
    } catch (err) {
      console.error("HTTP Basic Auth verification error:", err?.message || err);
    }

    res.set({
      "WWW-Authenticate": 'Basic realm="Web Terminal", charset="UTF-8"',
      "Cache-Control": "no-store",
    });
    return res.status(401).type("text/plain").send("Unauthorized\n");
  };
}

module.exports = {
  parseBasicAuthEnv,
  createBasicAuthVerifier,
  createBasicAuthMiddleware,
};
