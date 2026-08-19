"use strict";

const crypto = require("crypto");

function norm(v) {
  return String(v ?? "").trim();
}

function getHeader(req, names = []) {
  for (const name of names) {
    if (!name) continue;

    const value =
      req?.headers?.[name] ??
      req?.headers?.[String(name).toLowerCase()] ??
      req?.headers?.[String(name).toUpperCase()];

    if (Array.isArray(value) && value.length) {
      const first = value[0];
      if (first !== undefined && first !== null && String(first).trim()) {
        return String(first).trim();
      }
    }

    if (value !== undefined && value !== null && String(value).trim()) {
      return String(value).trim();
    }
  }

  return "";
}

function getRawBody(req) {
  if (typeof req?.rawBody === "string" && req.rawBody.length > 0) {
    return req.rawBody;
  }

  if (Buffer.isBuffer(req?.rawBody) && req.rawBody.length > 0) {
    return req.rawBody.toString("utf8");
  }

  try {
    return JSON.stringify(req?.body || {});
  } catch {
    return "";
  }
}

function timingSafeEqualStr(a, b) {
  const aa = Buffer.from(String(a || ""), "utf8");
  const bb = Buffer.from(String(b || ""), "utf8");

  if (!aa.length || !bb.length || aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

function normalizeSignature(sig = "") {
  return String(sig || "")
    .trim()
    .replace(/^sha256=/i, "")
    .replace(/^sha512=/i, "")
    .replace(/^v1=/i, "")
    .replace(/^hmac\s+/i, "")
    .trim();
}

function parseTimestampMs(rawTs) {
  if (rawTs === undefined || rawTs === null || rawTs === "") return null;

  const n = Number(rawTs);
  if (!Number.isFinite(n)) return null;

  // Si c'est probablement un timestamp en secondes
  if (n < 10_000_000_000) return Math.trunc(n * 1000);

  return Math.trunc(n);
}

function isTimestampFresh(rawTs, toleranceSeconds = 300) {
  const tsMs = parseTimestampMs(rawTs);
  if (!tsMs) return false;

  const tolMs = Math.max(0, Number(toleranceSeconds || 0)) * 1000;
  const now = Date.now();
  const delta = Math.abs(now - tsMs);

  return delta <= tolMs;
}

function normalizeAlgorithm(algorithm = "sha256") {
  const a = norm(algorithm).toLowerCase();
  return ["sha1", "sha256", "sha384", "sha512"].includes(a) ? a : "sha256";
}

function tryHexDigestMatch(signature, expectedHex) {
  return timingSafeEqualStr(
    normalizeSignature(signature).toLowerCase(),
    String(expectedHex || "").toLowerCase()
  );
}

function tryBase64DigestMatch(signature, expectedBase64) {
  return timingSafeEqualStr(
    normalizeSignature(signature),
    String(expectedBase64 || "")
  );
}

/**
 * Vérification HMAC générique.
 *
 * Par défaut :
 * - signature = HMAC(algorithm, secret, rawBody)
 * - si timestampHeader existe :
 *   signature = HMAC(algorithm, secret, `${timestamp}.${rawBody}`)
 *
 * Retourne un objet standardisé :
 * {
 *   enabled,
 *   verified,
 *   reason,
 *   signature,
 *   timestamp,
 *   algorithm
 * }
 */
function verifyHmacWebhook({
  req,
  secret,
  signatureHeaders = [],
  timestampHeaders = [],
  algorithm = "sha256",
  toleranceSeconds = 300,
  payloadBuilder = null,
}) {
  const normalizedSecret = norm(secret);
  const normalizedAlgorithm = normalizeAlgorithm(algorithm);

  const enabled = Boolean(normalizedSecret);

  /**
   * ABSENCE DE SECRET = REFUS. C'est la règle de Stripe, de PayPal et de Wise :
   * un webhook non signé n'est pas un webhook, c'est une requête anonyme qui
   * prétend venir d'un prestataire de paiement.
   *
   * Ce code renvoyait `verified: true` — donc une requête forgée par n'importe
   * qui était traitée comme authentique dès lors que la variable de secret
   * n'était pas renseignée. Un oubli de configuration devenait une porte
   * ouverte, silencieusement : rien dans les journaux ne distinguait un webhook
   * légitime d'un webhook inventé.
   *
   * L'échappatoire de développement local est explicite et NE FONCTIONNE PAS en
   * production : on ne veut pas qu'une variable oubliée sur un poste voyage
   * jusqu'au serveur.
   */
  if (!enabled) {
    const allowUnsigned =
      String(process.env.WEBHOOK_ALLOW_UNSIGNED || "").toLowerCase() === "true" &&
      process.env.NODE_ENV !== "production";

    if (!allowUnsigned) {
      // `console` et non winston : ce module n'a volontairement aucune
      // dépendance hors `crypto`, ce qui le rend testable sans configuration.
      console.error(
        `[WEBHOOK] secret absent — requête refusée (${normalizedAlgorithm})`
      );
    }

    return {
      enabled: false,
      verified: allowUnsigned,
      reason: allowUnsigned
        ? "UNSIGNED_ALLOWED_DEV_ONLY"
        : "NO_SECRET_CONFIGURED",
      signature: "",
      timestamp: "",
      algorithm: normalizedAlgorithm,
    };
  }

  const signature = normalizeSignature(getHeader(req, signatureHeaders));
  const timestamp = getHeader(req, timestampHeaders);
  const rawBody = getRawBody(req);

  if (!signature) {
    return {
      enabled: true,
      verified: false,
      reason: "MISSING_SIGNATURE",
      signature: "",
      timestamp,
      algorithm: normalizedAlgorithm,
    };
  }

  if (timestampHeaders.length > 0) {
    if (!timestamp) {
      return {
        enabled: true,
        verified: false,
        reason: "MISSING_TIMESTAMP",
        signature,
        timestamp: "",
        algorithm: normalizedAlgorithm,
      };
    }

    if (!isTimestampFresh(timestamp, toleranceSeconds)) {
      return {
        enabled: true,
        verified: false,
        reason: "STALE_TIMESTAMP",
        signature,
        timestamp,
        algorithm: normalizedAlgorithm,
      };
    }
  }

  let payloadToSign = "";
  try {
    payloadToSign =
      typeof payloadBuilder === "function"
        ? String(payloadBuilder({ req, rawBody, timestamp }) ?? "")
        : timestamp
        ? `${timestamp}.${rawBody}`
        : rawBody;
  } catch {
    return {
      enabled: true,
      verified: false,
      reason: "PAYLOAD_BUILD_ERROR",
      signature,
      timestamp,
      algorithm: normalizedAlgorithm,
    };
  }

  const hmac = crypto.createHmac(normalizedAlgorithm, normalizedSecret);
  hmac.update(payloadToSign, "utf8");

  const expectedHex = hmac.digest("hex");

  const hmac2 = crypto.createHmac(normalizedAlgorithm, normalizedSecret);
  hmac2.update(payloadToSign, "utf8");
  const expectedBase64 = hmac2.digest("base64");

  const verified =
    tryHexDigestMatch(signature, expectedHex) ||
    tryBase64DigestMatch(signature, expectedBase64);

  return {
    enabled: true,
    verified,
    reason: verified ? "OK" : "BAD_SIGNATURE",
    signature,
    timestamp,
    algorithm: normalizedAlgorithm,
  };
}

module.exports = {
  getHeader,
  getRawBody,
  normalizeSignature,
  verifyHmacWebhook,
  isTimestampFresh,
  parseTimestampMs,
};