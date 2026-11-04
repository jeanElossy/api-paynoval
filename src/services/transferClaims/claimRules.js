"use strict";

/**
 * ============================================================================
 * RÉCLAMATION D'UN TRANSFERT PAR SON DESTINATAIRE — RÈGLES PURES (2026-11-04)
 * ============================================================================
 *
 * Décision de l'utilisateur : tout transfert vers un tiers passe par la
 * question de sécurité. Pour un destinataire SANS compte PayNoval (portefeuille
 * mobile money, carte), il la reçoit comme PayPal le fait pour un paiement à
 * un non-client : l'argent reste RÉSERVÉ chez l'expéditeur, le destinataire
 * reçoit par SMS un lien à usage unique, et il doit fournir DEUX preuves :
 *
 *   1. la POSSESSION du numéro : un code à usage unique envoyé par SMS ;
 *   2. la CONNAISSANCE : la réponse à la question fixée par l'expéditeur.
 *
 * Connaître la réponse ne suffit plus (la faiblesse de la question seule de
 * Western Union : l'escroc se la fait dicter) ; posséder le téléphone non
 * plus. Le versement ne part chez le prestataire qu'après les deux.
 *
 * Module PUR : aucune base, aucun réseau, horloge et aléa injectables.
 */

const crypto = require("crypto");

/** Essais (réponse ou code faux) avant blocage du lien. */
const MAX_FAILED_ATTEMPTS = 5;

/** Durée de vie d'un code SMS. */
const OTP_TTL_MS = 10 * 60 * 1000;

/** Délai minimal entre deux envois de code au même numéro. */
const OTP_RESEND_COOLDOWN_MS = 60 * 1000;

/** Envois de code au plus, pour un lien. */
const MAX_OTP_SENDS = 5;

const OTP_LENGTH = 6;

const CLAIM_STATUSES = Object.freeze({
  OPEN: "open",
  CLAIMED: "claimed",
  REFUSED: "refused",
  LOCKED: "locked",
});

/** Jeton du lien : 32 octets d'aléa, en base64url (43 caractères). */
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

function newClaimToken(randomBytes = crypto.randomBytes) {
  return randomBytes(32).toString("base64url");
}

/**
 * Empreinte stockée du jeton. Seule l'empreinte est en base : une lecture de
 * la collection ne donne aucun lien utilisable. SHA-256 suffit ici, le jeton
 * portant 256 bits d'aléa (rien à deviner, contrairement à un mot de passe).
 */
function hashClaimToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

function isWellFormedToken(token) {
  return TOKEN_RE.test(String(token || ""));
}

/** Code SMS à six chiffres, tiré par un générateur cryptographique. */
function newOtp(randomInt = crypto.randomInt) {
  return String(randomInt(0, 10 ** OTP_LENGTH)).padStart(OTP_LENGTH, "0");
}

function isWellFormedOtp(otp) {
  return new RegExp(`^\\d{${OTP_LENGTH}}$`).test(String(otp || ""));
}

/**
 * E.164 générique : `+`, indicatif, 8 à 15 chiffres en tout. Sert au numéro
 * du destinataire d'une CARTE (Europe, Amérique), que la table africaine de
 * `utils/phone.js` ne couvre pas.
 */
function normalizeE164(raw) {
  const compact = String(raw || "").replace(/[\s().-]/g, "");
  return /^\+[1-9]\d{7,14}$/.test(compact) ? compact : null;
}

function phoneLast4(e164) {
  const digits = String(e164 || "").replace(/\D/g, "");
  return digits.length >= 4 ? digits.slice(-4) : "";
}

/**
 * Ce qui empêche d'agir sur un lien, ou `null`. Une transaction qui n'est plus
 * en attente (annulée, expirée, déjà versée) ferme le lien quel que soit son
 * état propre : la réclamation n'a jamais le dernier mot sur l'argent.
 */
function claimBlocker({ claim, txStatus, now = Date.now() }) {
  if (!claim) return "CLAIM_NOT_FOUND";
  if (claim.status === CLAIM_STATUSES.CLAIMED) return "CLAIM_ALREADY_USED";
  if (claim.status === CLAIM_STATUSES.REFUSED) return "CLAIM_REFUSED";
  if (claim.status === CLAIM_STATUSES.LOCKED) return "CLAIM_LOCKED";
  if (claim.expiresAt && new Date(claim.expiresAt).getTime() <= now) return "CLAIM_EXPIRED";
  if (txStatus === "pending_review") return "CLAIM_UNDER_REVIEW";
  if (txStatus !== "pending") return "CLAIM_CLOSED";
  return null;
}

/** Un nouvel envoi de code est-il permis maintenant ? */
function otpSendBlocker({ claim, now = Date.now() }) {
  if (Number(claim?.otpSendCount || 0) >= MAX_OTP_SENDS) return "OTP_SEND_LIMIT";
  const last = claim?.otpLastSentAt ? new Date(claim.otpLastSentAt).getTime() : 0;
  if (last && now - last < OTP_RESEND_COOLDOWN_MS) return "OTP_COOLDOWN";
  return null;
}

/** Le code fourni est-il encore valable (sans le comparer) ? */
function otpExpired({ claim, now = Date.now() }) {
  if (!claim?.otpHash || !claim?.otpExpiresAt) return true;
  return new Date(claim.otpExpiresAt).getTime() <= now;
}

/** Essais restants après un échec de plus. */
function remainingAfterFailure(failedAttempts) {
  return Math.max(0, MAX_FAILED_ATTEMPTS - (Number(failedAttempts || 0) + 1));
}

/** Prénom seul de l'expéditeur : assez pour reconnaître, rien de plus. */
function firstNameOf(fullName) {
  const first = String(fullName || "").trim().split(/\s+/)[0] || "";
  return first.slice(0, 40);
}

/** Messages présentés au destinataire, un par refus. */
const CLAIM_MESSAGES = Object.freeze({
  CLAIM_NOT_FOUND: "Ce lien n’est pas valide.",
  CLAIM_ALREADY_USED: "Ce transfert a déjà été reçu.",
  CLAIM_REFUSED: "Ce transfert a été refusé.",
  CLAIM_LOCKED: "Trop d’essais : ce lien est bloqué. L’expéditeur a été prévenu.",
  CLAIM_EXPIRED: "Ce lien a expiré.",
  CLAIM_UNDER_REVIEW: "Ce transfert est en cours de vérification. Réessayez plus tard.",
  CLAIM_CLOSED: "Ce transfert n’est plus disponible.",
  OTP_SEND_LIMIT: "Trop de codes envoyés pour ce lien.",
  OTP_COOLDOWN: "Patientez une minute avant de demander un nouveau code.",
  OTP_REQUIRED: "Demandez d’abord le code reçu par SMS.",
  CLAIM_PROOF_INVALID: "Réponse ou code incorrect.",
});

const CLAIM_HTTP_STATUS = Object.freeze({
  CLAIM_NOT_FOUND: 404,
  CLAIM_ALREADY_USED: 409,
  CLAIM_REFUSED: 409,
  CLAIM_LOCKED: 423,
  CLAIM_EXPIRED: 410,
  CLAIM_UNDER_REVIEW: 409,
  CLAIM_CLOSED: 410,
  OTP_SEND_LIMIT: 429,
  OTP_COOLDOWN: 429,
  OTP_REQUIRED: 400,
  CLAIM_PROOF_INVALID: 401,
});

module.exports = {
  MAX_FAILED_ATTEMPTS,
  OTP_TTL_MS,
  OTP_RESEND_COOLDOWN_MS,
  MAX_OTP_SENDS,
  OTP_LENGTH,
  CLAIM_STATUSES,
  CLAIM_MESSAGES,
  CLAIM_HTTP_STATUS,
  newClaimToken,
  hashClaimToken,
  isWellFormedToken,
  newOtp,
  isWellFormedOtp,
  normalizeE164,
  phoneLast4,
  claimBlocker,
  otpSendBlocker,
  otpExpired,
  remainingAfterFailure,
  firstNameOf,
};
