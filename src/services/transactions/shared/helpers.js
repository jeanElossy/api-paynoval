"use strict";

const crypto = require("crypto");
const mongoose = require("mongoose");

const MAX_CONFIRM_ATTEMPTS = 5;
const LOCK_MINUTES = 10;
const MAX_DESC_LENGTH = 500;

const ZERO_DECIMAL_CURRENCIES = new Set([
  "XOF",
  "XAF",
  "JPY",
  "KRW",
  "GNF",
  "RWF",
  "UGX",
  "BIF",
  "KMF",
  "CLP",
]);

function sanitize(text, maxLen = MAX_DESC_LENGTH) {
  return String(text || "")
    .replace(/[<>\\/{};]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}

function isEmailLike(v) {
  const s = String(v || "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function toFloat(v, fallback = 0) {
  try {
    if (v === null || v === undefined || v === "") return fallback;
    const n = parseFloat(String(v).replace(",", "."));
    return Number.isFinite(n) ? n : fallback;
  } catch {
    return fallback;
  }
}

function normalizeCurrencyCode(v, fallback = "CAD") {
  const code = String(v || "").trim().toUpperCase();
  return code || fallback;
}

function currencyHasDecimals(currency) {
  return !ZERO_DECIMAL_CURRENCIES.has(normalizeCurrencyCode(currency));
}

function round2(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return parseFloat(x.toFixed(2));
}

function roundMoney(n, currency = "CAD") {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  if (!currencyHasDecimals(currency)) return Math.round(x);
  return parseFloat(x.toFixed(2));
}

function dec2(n) {
  return mongoose.Types.Decimal128.fromString(round2(n).toFixed(2));
}

function decMoney(n, currency = "CAD") {
  const value = roundMoney(n, currency);
  if (currencyHasDecimals(currency)) {
    return mongoose.Types.Decimal128.fromString(value.toFixed(2));
  }
  return mongoose.Types.Decimal128.fromString(String(Math.round(value)));
}

function clampMoneyMin0(n, currency = "CAD") {
  return Math.max(0, roundMoney(n, currency));
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(String(value || "").trim()).digest("hex");
}

function looksLikeSha256Hex(v) {
  return typeof v === "string" && /^[a-f0-9]{64}$/i.test(v);
}

function safeEqualHex(a, b) {
  const aa = Buffer.from(String(a || ""), "utf8");
  const bb = Buffer.from(String(b || ""), "utf8");
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

/**
 * ══════════════════════════════════════════════════════════════════════════
 * EMPREINTE DE LA RÉPONSE DE SÉCURITÉ
 * ══════════════════════════════════════════════════════════════════════════
 *
 * La réponse était stockée en `sha256(réponse)` nu — sans sel ni poivre. Deux
 * conséquences, toutes deux hors ligne, donc invisibles au monitoring :
 *
 *  1. Les réponses réelles sont courtes et prévisibles (un prénom, une ville,
 *     quatre chiffres). Une table arc-en-ciel les rend toutes, instantanément,
 *     à qui obtient une lecture de la collection.
 *  2. Deux transactions partageant la même réponse ont la même empreinte. On
 *     peut donc corréler les virements d'un même expéditeur sans jamais casser
 *     un seul hash.
 *
 * Le remède est un HMAC-SHA256 clé par un poivre gardé HORS de la base
 * (`SECURITY_ANSWER_PEPPER`) : une lecture de la collection ne suffit plus, il
 * faut aussi la variable d'environnement.
 *
 * On ne peut pas re-hacher l'existant — la réponse en clair n'est stockée nulle
 * part, ce qui est précisément le comportement voulu. D'où la compatibilité
 * ascendante : `verifySecurityAnswerHash` accepte les deux formats, les
 * nouvelles transactions naissent en HMAC, et le sha256 nu s'éteint de lui-même
 * à mesure que les transactions en attente se confirment ou tombent en
 * auto-cancel.
 *
 * Sans `SECURITY_ANSWER_PEPPER`, le comportement reste rigoureusement celui
 * d'avant : la variable est optionnelle, et son absence ne casse aucun
 * démarrage. Elle est volontairement HORS de `.env.example`, que `dotenv-safe`
 * traite comme une liste d'obligations.
 */
function getSecurityAnswerPepper() {
  return String(process.env.SECURITY_ANSWER_PEPPER || "").trim();
}

function hmacSha256Hex(value, key) {
  return crypto
    .createHmac("sha256", key)
    .update(String(value || "").trim())
    .digest("hex");
}

/** Empreinte à écrire pour toute NOUVELLE transaction. */
function hashSecurityAnswer(value) {
  const pepper = getSecurityAnswerPepper();
  return pepper ? hmacSha256Hex(value, pepper) : sha256Hex(value);
}

/**
 * Vérifie une réponse contre l'empreinte stockée, quel que soit son format.
 *
 * Les deux formats sont du hex sur 64 caractères et donc indiscernables : on
 * essaie les deux, toujours en comparaison à temps constant. `||` court-circuite
 * — la fuite de timing résiduelle indiquerait au mieux *quel format* est
 * stocké, jamais la valeur de la réponse.
 *
 * Le troisième cas couvre l'héritage le plus ancien : un `securityCode` stocké
 * en clair, que l'on hache avant de comparer.
 */
function verifySecurityAnswerHash(provided, storedHash) {
  const stored = String(storedHash || "");
  if (!stored) return false;

  if (!looksLikeSha256Hex(stored)) {
    return safeEqualHex(sha256Hex(provided), sha256Hex(stored));
  }

  const pepper = getSecurityAnswerPepper();

  if (pepper && safeEqualHex(hmacSha256Hex(provided, pepper), stored)) {
    return true;
  }

  return safeEqualHex(sha256Hex(provided), stored);
}

function pickAuthedUserId(req) {
  return (req.user?.id || req.user?._id || req.user?.userId || null)?.toString?.() || null;
}

/**
 * BASE DE LA PASSERELLE — AUCUN REPLI
 * ============================================================================
 *
 * ⚠️ Cette fonction retombait sur `https://api-gateway-8cgy.onrender.com` —
 * l'URL de la passerelle de PRODUCTION — quand `GATEWAY_URL` était absente.
 * Retiré le 2026-09-02.
 *
 * Ce n'était pas un problème de secret : cette URL est déjà en clair dans les
 * bundles distribués (`payNoval-master/app.json`, `web_paynoval/src/tools/api.jsx`).
 * Le problème était le REPLI SILENCIEUX vers la production sur le chemin de
 * l'argent : un poste de développement, un banc de charge ou un environnement
 * mal configuré demandaient leurs devis à la production sans que rien ne le
 * dise. C'est exactement le défaut qui a fait pointer la première campagne de
 * charge sur l'Atlas de production (A1).
 *
 * La règle B.2 demande une FERMETURE : une donnée financière absente arrête
 * l'opération avec une erreur explicite, elle ne prend jamais de valeur par
 * défaut. Un devis est une donnée de tarification — le prix payé par
 * l'utilisateur en dépend.
 *
 * Le 503 dit « service sain, dépendance non configurée », pas « la demande est
 * mauvaise » : la faute est côté déploiement, pas côté appelant.
 *
 * Le défaut de configuration est par ailleurs annoncé AU DÉMARRAGE
 * (`src/server.js`, contrôle `GATEWAY_URL`), pour qu'il se voie au déploiement
 * et non au premier devis demandé par un utilisateur.
 */
function getGatewayBase(GATEWAY_URL) {
  // `trim()` d'abord : une variable d'environnement qui ne contient que des
  // espaces est une variable NON configurée, pas une URL.
  let gatewayBase = String(GATEWAY_URL || process.env.GATEWAY_URL || "")
    .trim()
    .replace(/\/+$/, "");
  if (!gatewayBase) {
    const err = new Error(
      "GATEWAY_URL absente : le devis ne peut pas être demandé. Aucun repli " +
        "n'est appliqué (règle B.2 — le chemin de l'argent échoue en fermeture)."
    );
    err.status = 503;
    err.code = "GATEWAY_URL_MISSING";
    throw err;
  }
  if (!gatewayBase.endsWith("/api/v1")) gatewayBase = `${gatewayBase}/api/v1`;
  return gatewayBase;
}

function normalizeMethodValue(v) {
  const raw = String(v || "").trim().toUpperCase();
  if (!raw) return "INTERNAL";
  if (["INTERNAL", "PAYNOVAL", "WALLET"].includes(raw)) return "INTERNAL";
  if (["MOBILEMONEY", "MOBILE_MONEY", "MM"].includes(raw)) return "MOBILEMONEY";
  if (["BANK", "WIRE", "VIREMENT"].includes(raw)) return "BANK";
  if (["CARD", "STRIPE", "VISA"].includes(raw)) return "CARD";
  return raw;
}

function normalizeTxTypeValue(v) {
  const raw = String(v || "").trim().toUpperCase();
  if (["TRANSFER", "DEPOSIT", "WITHDRAW"].includes(raw)) return raw;
  return "TRANSFER";
}

function inferMethodValue(reqBody = {}) {
  const directMethod = String(reqBody.method || "").trim().toUpperCase();
  if (directMethod) return normalizeMethodValue(directMethod);

  const funds = String(reqBody.funds || "").trim().toLowerCase();
  const destination = String(reqBody.destination || "").trim().toLowerCase();
  const provider = String(reqBody.provider || "").trim().toLowerCase();

  if (funds === "mobilemoney" || destination === "mobilemoney") return "MOBILEMONEY";
  if (funds === "bank" || destination === "bank") return "BANK";
  /**
   * `provider === "stripe"` a été retiré le 2026-09-09 avec le rail Stripe.
   *
   * ⚠️ Ce classificateur reconnaissait le prestataire SUPPRIMÉ et ignorait le
   * prestataire SURVIVANT : un corps portant `provider: "visa_direct"` sans
   * `funds`/`destination` carte tombait dans le repli `INTERNAL` ci-dessous.
   * On nomme donc les prestataires carte réellement servis.
   */
  if (
    funds === "card" ||
    destination === "card" ||
    provider === "visa_direct" ||
    provider === "visadirect"
  ) {
    return "CARD";
  }
  if (destination === "paynoval" || provider === "paynoval" || funds === "wallet") return "INTERNAL";

  return "INTERNAL";
}

function pickCurrency(...values) {
  for (const value of values) {
    const normalized = String(value || "").trim().toUpperCase();
    if (normalized) return normalized;
  }
  return "";
}

module.exports = {
  MAX_CONFIRM_ATTEMPTS,
  LOCK_MINUTES,
  MAX_DESC_LENGTH,
  ZERO_DECIMAL_CURRENCIES,
  sanitize,
  isEmailLike,
  toFloat,
  round2,
  roundMoney,
  dec2,
  decMoney,
  clampMoneyMin0,
  normalizeCurrencyCode,
  currencyHasDecimals,
  sha256Hex,
  looksLikeSha256Hex,
  safeEqualHex,
  hashSecurityAnswer,
  verifySecurityAnswerHash,
  pickAuthedUserId,
  getGatewayBase,
  normalizeMethodValue,
  normalizeTxTypeValue,
  inferMethodValue,
  pickCurrency,
};