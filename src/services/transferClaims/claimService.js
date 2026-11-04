"use strict";

/**
 * ============================================================================
 * RÉCLAMATION D'UN TRANSFERT PAR SON DESTINATAIRE — SERVICE (2026-11-04)
 * ============================================================================
 *
 * Règles : `claimRules.js`. Ici, ce qui touche la base et le prestataire.
 *
 * L'ARGENT NE BOUGE QU'À UN SEUL ENDROIT : `release()`, après les deux preuves
 * (code SMS + réponse), et seulement si la transaction est encore `pending`.
 * Il appelle `submitExternalExecution`, le chemin unique vers le prestataire —
 * aucune seconde façon de verser n'est créée ici.
 *
 * Défenses :
 *   - le lien est à usage unique : le passage `open → claimed` est une mise à
 *     jour CONDITIONNELLE ; deux soumissions simultanées n'en gagnent qu'une ;
 *   - chaque échec (réponse OU code faux) est compté par un `$inc` atomique,
 *     HORS de toute transaction (un échec ne s'annule pas avec elle), et le
 *     cinquième bloque le lien et prévient l'expéditeur ;
 *   - un code SMS expire en 10 minutes, ne sert qu'une fois, et ses envois sont
 *     bornés (cinq, une minute d'écart) ;
 *   - le jeton, le code et la réponse ne sont jamais journalisés ni renvoyés ;
 *   - le destinataire ne voit que le prénom de l'expéditeur, le montant reçu et
 *     les quatre derniers chiffres de la destination.
 */

const mongoose = require("mongoose");
const createError = require("http-errors");

const runtime = require("../transactions/shared/runtime");
const { hashSecurityAnswer, verifySecurityAnswerHash } = require("../transactions/shared/helpers");
const logger = require("../../utils/logger");
const rules = require("./claimRules");
const sms = require("./claimSms");

const { CLAIM_STATUSES, CLAIM_MESSAGES, CLAIM_HTTP_STATUS } = rules;

function ClaimModel() {
  return require("../../models/TransferClaim")(runtime.txConn);
}

function claimError(code, extra = {}) {
  return createError(CLAIM_HTTP_STATUS[code] || 400, CLAIM_MESSAGES[code] || code, { code, ...extra });
}

const TX_FIELDS =
  "+securityAnswerHash +securityCode status flow mode sender senderName amount amountTarget currencyTarget " +
  "localCurrencySymbol senderCurrencySymbol securityQuestion meta reference autoCancelAt";

function decToNumber(value) {
  if (value === null || value === undefined) return null;
  const n = Number(value?.toString?.() ?? value);
  return Number.isFinite(n) ? n : null;
}

/** Le lien, d'après son jeton. Jeton mal formé : comme un lien inconnu. */
async function loadClaim(token, { withSecrets = false } = {}) {
  if (!rules.isWellFormedToken(token)) return null;
  const query = ClaimModel().findOne({ tokenHash: rules.hashClaimToken(token) });
  if (withSecrets) query.select("+otpHash +sandboxOtp +recipientPhoneE164");
  return query.lean();
}

async function loadTx(claim) {
  return runtime.Transaction.findById(claim.transaction).select(TX_FIELDS).lean();
}

/** Destination, réduite à ce qui permet au destinataire de la reconnaître. */
function describeDestination(tx, claim) {
  const recipient = tx?.meta?.externalRecipient || {};
  if (tx.flow === "PAYNOVAL_TO_CARD_PAYOUT") {
    const last4 = String(recipient.maskedCardNumber || "").replace(/\D/g, "").slice(-4);
    return { kind: "card", last4: last4 || null };
  }
  return {
    kind: "mobilemoney",
    operator: recipient.operator ? String(recipient.operator).toLowerCase() : null,
    last4: claim.recipientPhoneLast4 || null,
  };
}

/* ------------------------------------------------------------- création */

/**
 * Crée le lien d'un transfert vers un tiers, DANS la transaction Mongo qui
 * réserve les fonds : pas de lien sans réserve, pas de réserve sans lien.
 * Rend le jeton en clair — à envoyer, jamais à stocker.
 */
async function createClaim({ tx, recipientPhoneE164, session = null }) {
  const phone = String(recipientPhoneE164 || "");
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) {
    throw createError(400, "Numéro du destinataire invalide.", { code: "RECIPIENT_PHONE_INVALID" });
  }
  if (!tx?.autoCancelAt) {
    throw createError(500, "Échéance du transfert absente : aucun lien sans expiration.");
  }

  const token = rules.newClaimToken();
  await ClaimModel().create(
    [
      {
        transaction: tx._id,
        mode: tx.mode,
        sender: tx.sender,
        tokenHash: rules.hashClaimToken(token),
        recipientPhoneE164: phone,
        recipientPhoneLast4: rules.phoneLast4(phone),
        expiresAt: tx.autoCancelAt,
      },
    ],
    session ? { session } : undefined
  );
  return token;
}

/** Envoie le lien après le commit. Un échec est journalisé : l'expéditeur peut le renvoyer. */
async function sendLinkAfterCommit({ tx, token, recipientPhoneE164, senderName }) {
  try {
    const out = await sms.sendClaimLink({
      mode: tx.mode,
      phoneE164: recipientPhoneE164,
      token,
      senderFirstName: rules.firstNameOf(senderName),
      amountLabel: `${decToNumber(tx.amountTarget) ?? ""} ${tx.currencyTarget || tx.localCurrencySymbol || ""}`.trim(),
    });
    if (out?.sent) {
      await ClaimModel().updateOne({ transaction: tx._id }, { $set: { linkSmsSentAt: new Date() } });
    }
    return out;
  } catch (err) {
    logger.error("[claim] lien NON envoyé au destinataire", {
      transactionId: String(tx._id),
      errorCode: err?.code,
      consequence: "le destinataire ne peut pas réclamer tant que le lien n'est pas renvoyé",
    });
    return { sent: false, reason: err?.code || "SMS_FAILED" };
  }
}

/* ------------------------------------------------------- côté destinataire */

/** Ce que voit le destinataire en ouvrant le lien. */
async function inspect(token, { now = Date.now() } = {}) {
  const claim = await loadClaim(token);
  if (!claim) throw claimError("CLAIM_NOT_FOUND");
  const tx = await loadTx(claim);
  const blocker = rules.claimBlocker({ claim, txStatus: tx?.status, now });

  return {
    status: blocker ? "closed" : "open",
    reason: blocker || null,
    message: blocker ? CLAIM_MESSAGES[blocker] : null,
    senderFirstName: rules.firstNameOf(tx?.senderName || tx?.meta?.senderName),
    amount: decToNumber(tx?.amountTarget),
    currency: tx?.currencyTarget || tx?.localCurrencySymbol || null,
    destination: tx ? describeDestination(tx, claim) : null,
    // La question n'est montrée que tant que le lien est utilisable.
    securityQuestion: blocker ? null : tx?.securityQuestion || null,
    phoneLast4: claim.recipientPhoneLast4 || null,
    expiresAt: claim.expiresAt,
    attemptsLeft: Math.max(0, rules.MAX_FAILED_ATTEMPTS - Number(claim.failedAttempts || 0)),
    sandbox: claim.mode === "sandbox",
  };
}

/** Envoie un code SMS au numéro du destinataire (et à lui seul). */
async function requestCode(token, { now = Date.now() } = {}) {
  const claim = await loadClaim(token, { withSecrets: true });
  if (!claim) throw claimError("CLAIM_NOT_FOUND");
  const tx = await loadTx(claim);

  const blocker = rules.claimBlocker({ claim, txStatus: tx?.status, now }) || rules.otpSendBlocker({ claim, now });
  if (blocker) throw claimError(blocker);

  const code = rules.newOtp();
  const sandbox = claim.mode === "sandbox";

  /**
   * Compteur et délai posés AVANT l'envoi, par une mise à jour conditionnelle
   * sur l'état lu : deux demandes simultanées ne partent pas toutes les deux.
   */
  const updated = await ClaimModel().updateOne(
    { _id: claim._id, status: CLAIM_STATUSES.OPEN, otpSendCount: Number(claim.otpSendCount || 0) },
    {
      $set: {
        otpHash: hashSecurityAnswer(code),
        otpExpiresAt: new Date(now + rules.OTP_TTL_MS),
        otpLastSentAt: new Date(now),
        sandboxOtp: sandbox ? code : null,
      },
      $inc: { otpSendCount: 1 },
    }
  );
  if (!updated.modifiedCount) throw claimError("OTP_COOLDOWN");

  await sms.sendClaimCode({ mode: claim.mode, phoneE164: claim.recipientPhoneE164, code });

  return {
    sent: !sandbox,
    phoneLast4: claim.recipientPhoneLast4 || null,
    expiresInSeconds: rules.OTP_TTL_MS / 1000,
    // SIMULATION SEULEMENT : aucun SMS ne part, le code est montré à l'écran.
    ...(sandbox ? { sandboxCode: code } : {}),
  };
}

/**
 * Un échec de plus, compté atomiquement. Au dernier permis
 * (`MAX_FAILED_ATTEMPTS`, trois), le lien se bloque et l'expéditeur est
 * prévenu. Rend les essais restants.
 */
async function registerFailure(claim, tx) {
  const after = await ClaimModel().findOneAndUpdate(
    { _id: claim._id, status: CLAIM_STATUSES.OPEN },
    { $inc: { failedAttempts: 1 } },
    { new: true }
  ).lean();

  const failed = Number(after?.failedAttempts || rules.MAX_FAILED_ATTEMPTS);
  if (failed >= rules.MAX_FAILED_ATTEMPTS) {
    const locked = await ClaimModel().updateOne(
      { _id: claim._id, status: CLAIM_STATUSES.OPEN },
      { $set: { status: CLAIM_STATUSES.LOCKED, lockedAt: new Date() } }
    );
    if (locked.modifiedCount) {
      logger.warn("[claim] lien BLOQUÉ après trop d'essais", { transactionId: String(claim.transaction) });
      try {
        const { notifyTransactionEvent } = require("../transactions/transactionNotificationService");
        await notifyTransactionEvent(tx, "claim_locked", null, tx?.senderCurrencySymbol);
      } catch (err) {
        logger.error("[claim] expéditeur NON prévenu du blocage", { transactionId: String(claim.transaction), message: err?.message });
      }
    }
    return 0;
  }
  return Math.max(0, rules.MAX_FAILED_ATTEMPTS - failed);
}

/** Vérifie les deux preuves, sans rien écrire. */
function proofsMatch({ claim, tx, answer, code, now }) {
  const codeOk =
    rules.isWellFormedOtp(code) &&
    !rules.otpExpired({ claim, now }) &&
    verifySecurityAnswerHash(String(code), claim.otpHash);
  const storedAnswer = String(tx?.securityAnswerHash || "") || String(tx?.securityCode || "");
  const answerOk = Boolean(storedAnswer) && verifySecurityAnswerHash(String(answer || ""), storedAnswer);
  // Les deux sont évaluées : la réponse ne révèle pas laquelle des deux est fausse.
  return codeOk && answerOk;
}

/**
 * Libère le versement : le SEUL endroit où l'argent part vers le prestataire.
 * Relit la transaction et exige l'état posé par le verrou de `claim` : une
 * annulation passée entre-temps arrête tout ici.
 */
async function release(transactionId) {
  const current = await runtime.Transaction.findById(transactionId).select("status providerStatus").lean();
  if (current?.status !== "processing" || current?.providerStatus !== "CLAIMED_BY_RECIPIENT") {
    logger.error("[claim] versement NON lancé : la transaction a changé depuis la réclamation", {
      transactionId: String(transactionId),
      status: current?.status || null,
    });
    throw claimError("CLAIM_CLOSED");
  }
  const { submitExternalExecution } = require("../transactions/handlers/submitExternalExecution");
  return submitExternalExecution({
    req: { headers: {}, body: {}, user: null },
    transactionId: String(transactionId),
  });
}

/**
 * Réclamation : code SMS + réponse. Bonne paire ⇒ lien consommé, versement
 * lancé. Mauvaise ⇒ un essai de moins, réponse générique.
 *
 * ⚠️ LE VERROU. La transaction passe `pending → processing` par UNE mise à jour
 * conditionnelle (`status: pending` ET `AWAITING_RECIPIENT_CLAIM`) :
 *   - deux réclamations simultanées : une seule gagne ;
 *   - une annulation de l'expéditeur au même instant : la machine à états
 *     interdit `processing → cancelled`, et une annulation déjà passée fait
 *     échouer ce filtre — l'argent ne part jamais après une annulation.
 */
async function claim({ token, answer, code, now = Date.now() }) {
  const doc = await loadClaim(token, { withSecrets: true });
  if (!doc) throw claimError("CLAIM_NOT_FOUND");
  const tx = await loadTx(doc);

  const blocker = rules.claimBlocker({ claim: doc, txStatus: tx?.status, now });
  if (blocker) throw claimError(blocker);
  if (!doc.otpHash) throw claimError("OTP_REQUIRED");

  if (!proofsMatch({ claim: doc, tx, answer, code, now })) {
    const attemptsLeft = await registerFailure(doc, tx);
    throw claimError(attemptsLeft ? "CLAIM_PROOF_INVALID" : "CLAIM_LOCKED", { attemptsLeft });
  }

  const locked = await runtime.Transaction.updateOne(
    {
      _id: doc.transaction,
      status: "pending",
      providerStatus: "AWAITING_RECIPIENT_CLAIM",
      fundsReserved: true,
      reserveReleased: { $ne: true },
    },
    { $set: { status: "processing", providerStatus: "CLAIMED_BY_RECIPIENT", claimedByRecipientAt: new Date(now) } }
  );
  if (!locked.modifiedCount) throw claimError("CLAIM_ALREADY_USED");

  // Usage unique du lien, et le code ne resservira pas.
  await ClaimModel().updateOne(
    { _id: doc._id },
    { $set: { status: CLAIM_STATUSES.CLAIMED, claimedAt: new Date(now), otpHash: null, sandboxOtp: null } }
  );

  const execution = await release(doc.transaction);
  return {
    claimed: true,
    status: execution?.status || "processing",
    amount: decToNumber(tx.amountTarget),
    currency: tx.currencyTarget || tx.localCurrencySymbol || null,
  };
}

/**
 * Le destinataire refuse. Code SMS exigé (seul le titulaire du numéro peut
 * refuser) ; aucune réponse demandée. Gratuit pour l'expéditeur : l'argent lui
 * revient en entier (décision de l'utilisateur, 2026-11-04).
 */
async function refuse({ token, code, now = Date.now() }) {
  const doc = await loadClaim(token, { withSecrets: true });
  if (!doc) throw claimError("CLAIM_NOT_FOUND");
  const tx = await loadTx(doc);

  const blocker = rules.claimBlocker({ claim: doc, txStatus: tx?.status, now });
  if (blocker) throw claimError(blocker);
  if (!doc.otpHash) throw claimError("OTP_REQUIRED");

  const codeOk =
    rules.isWellFormedOtp(code) && !rules.otpExpired({ claim: doc, now }) && verifySecurityAnswerHash(String(code), doc.otpHash);
  if (!codeOk) {
    const attemptsLeft = await registerFailure(doc, tx);
    throw claimError(attemptsLeft ? "CLAIM_PROOF_INVALID" : "CLAIM_LOCKED", { attemptsLeft });
  }

  const won = await ClaimModel().updateOne(
    { _id: doc._id, status: CLAIM_STATUSES.OPEN },
    { $set: { status: CLAIM_STATUSES.REFUSED, refusedAt: new Date(now), otpHash: null, sandboxOtp: null } }
  );
  if (!won.modifiedCount) throw claimError("CLAIM_ALREADY_USED");

  const { cancelWithoutFee } = require("../transactions/handlers/cancelTransaction");
  await cancelWithoutFee({ transactionId: doc.transaction, reason: "Refusé par le destinataire" });
  return { refused: true };
}

/* ------------------------------------------------------- simulation seulement */

/** Le lien de SIMULATION d'un transfert de l'appelant, ou une erreur. */
async function loadSandboxClaim({ transactionId, senderId }) {
  if (!mongoose.isValidObjectId(String(transactionId)) || !mongoose.isValidObjectId(String(senderId))) {
    throw claimError("CLAIM_NOT_FOUND");
  }
  const doc = await ClaimModel()
    .findOne({
      transaction: new mongoose.Types.ObjectId(String(transactionId)),
      sender: new mongoose.Types.ObjectId(String(senderId)),
      mode: "sandbox",
    })
    .select("+otpHash +sandboxOtp")
    .lean();
  if (!doc) throw claimError("CLAIM_NOT_FOUND");
  const tx = await loadTx(doc);
  const blocker = rules.claimBlocker({ claim: doc, txStatus: tx?.status });
  if (blocker) throw claimError(blocker);
  return doc;
}

/** Remplace le jeton : l'ancien lien cesse aussitôt de fonctionner. */
async function rotateToken(doc) {
  const token = rules.newClaimToken();
  const updated = await ClaimModel().updateOne(
    { _id: doc._id, status: CLAIM_STATUSES.OPEN },
    { $set: { tokenHash: rules.hashClaimToken(token) } }
  );
  if (!updated.modifiedCount) throw claimError("CLAIM_CLOSED");
  return token;
}

/**
 * SIMULATION : nouveau lien pour un transfert de l'appelant. Aucun SMS ne part
 * en démonstration : l'expéditeur ouvre lui-même la page du destinataire, qui
 * affiche alors le code (lien de simulation seulement).
 */
async function rotateSandboxLink({ transactionId, senderId }) {
  const doc = await loadSandboxClaim({ transactionId, senderId });
  const token = await rotateToken(doc);
  return { link: sms.buildClaimLink(token) };
}

/**
 * SIMULATION, UN SEUL TÉLÉPHONE : répondre à la place du destinataire. Passe
 * par le MÊME `claim` que la page du destinataire — réponse vérifiée, essais
 * comptés, blocage au cinquième ; seul le code SMS, affiché en démonstration de
 * toute façon, est fourni par le serveur.
 */
async function sandboxAnswerAsRecipient({ transactionId, senderId, answer, now = Date.now() }) {
  const doc = await loadSandboxClaim({ transactionId, senderId });
  const token = await rotateToken(doc);

  let code = doc.sandboxOtp && !rules.otpExpired({ claim: doc, now }) ? doc.sandboxOtp : null;
  if (!code) code = (await requestCode(token, { now })).sandboxCode;

  return claim({ token, answer, code, now });
}

module.exports = {
  createClaim,
  sendLinkAfterCommit,
  inspect,
  requestCode,
  claim,
  refuse,
  rotateSandboxLink,
  sandboxAnswerAsRecipient,
  // pour les tests
  _proofsMatch: proofsMatch,
};
