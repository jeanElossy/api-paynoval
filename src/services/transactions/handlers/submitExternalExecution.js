"use strict";

const createError = require("http-errors");

const runtime = require("../shared/runtime");
const { canTransition } = require("../../transactionStateMachine");
const { resolveExecutor } = require("../providers/providerExecutorRegistry");

const {
  isSandboxUser,
  resolveUserId,
} = require("../../../utils/sandboxUser");

const {
  assertProviderAllowedForUser,
  normalizeProvider,
} = require("../../../utils/sandboxProviderGuard");

const {
  startTxSession,
  maybeSessionOpts,
  runInTransaction,
} = runtime;

/**
 * `Transaction` est lié PARESSEUSEMENT : le déstructurer ici résolvait la
 * connexion Mongo au chargement du fichier. Les sites d'appel sont inchangés.
 */
const { Transaction } = runtime.lazyModels(["Transaction"]);

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * RÈGLE B.4 — ON NE PERSISTE JAMAIS LE CORPS BRUT D'UN PRESTATAIRE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `tx.metadata.execution.providerResponse` recevait `result.raw`, c'est-à-dire
 * le corps de réponse HTTP de l'opérateur, tel quel :
 *
 *     providerResponse: result?.raw || null,   // ← la faute
 *
 * `raw` porte ce que l'opérateur veut bien y mettre. Sur un rail mobile money :
 * numéro de téléphone et nom du bénéficiaire. Sur un rail carte : les quatre
 * derniers chiffres, parfois l'empreinte du moyen de paiement.
 *
 * Deux aggravations rendaient ce site pire que celui du registre de webhooks,
 * déjà corrigé (`services/webhooks/webhookEventStore.js`) :
 *
 *   1. `provider_webhook_events` a un TTL de 90 jours. **Une transaction ne
 *      s'efface jamais.** La donnée était donc conservée sans limite de durée ;
 *   2. `tx.metadata` est un champ de premier niveau du document de transaction,
 *      rendu par les routes d'administration et repris dans les exports.
 *
 * Ce que fait le correctif — c'est la pratique des plateformes de paiement, et
 * elle tient en une phrase : **on conserve le VERDICT, jamais la RÉPONSE.**
 * Rien de ce qui est gardé ici ne vient de `raw` ; tout vient des champs que
 * l'adapter a déjà normalisés, et qui sont les seuls dont un diagnostic a
 * besoin — « qu'a répondu le prestataire », pas « qu'a-t-il dit de mon client ».
 *
 * ⚠️ NE PAS RAJOUTER `raw` À CETTE LISTE, sous aucun prétexte de diagnostic.
 * Le besoin de déboguer se couvre par un journal éphémère, pas par un champ
 * persistant sans TTL. C'est exactement le raisonnement tenu en
 * `models/ProviderWebhookEvent.js` : « rien de tout cela n'est nécessaire pour
 * rejouer une décision ».
 */
/**
 * ⚠️ CETTE LISTE EST CALIBRÉE SUR CE QUE REND UN **EXÉCUTEUR**, pas un adapter.
 *
 * Première version : `["ok","provider","providerReference","externalStatus",
 * "status","errorCode"]` — la forme d'un *adapter*. Or l'objet qui arrive ici
 * vient d'un *exécuteur* (`providers/cardExecutor.js`,
 * `providers/mobilemoneyExecutor.js`), qui rend `{ok, mock, errorCode,
 * errorMessage, providerStatus, providerReference, raw}`. Cinq des six champs
 * retenus étaient donc TOUJOURS `undefined` : la fuite était bien fermée, mais
 * le « verdict » conservé se réduisait à `providerReference`.
 *
 * Une liste blanche qui ne retient rien protège parfaitement et n'apprend rien.
 * Corrigé le 2026-09-09 en la reposant sur la forme réelle.
 *
 * `mock` y figure délibérément : c'est le seul champ qui distingue une
 * référence prestataire FABRIQUÉE en mode simulé d'une référence réelle. C'est
 * un booléen normalisé — aucune donnée personnelle — et son absence rendait un
 * règlement fictif indiscernable d'un vrai sur le document de transaction.
 */
const EXECUTION_RESULT_FIELDS = Object.freeze([
  "ok",
  "mock",
  "provider",
  "providerReference",
  "providerStatus",
  "externalStatus",
  "status",
  "errorCode",
]);

/** Bornes identiques à celles du registre de webhooks (`lastError`, 300). */
const MAX_MESSAGE_LENGTH = 300;

function truncateMessage(value) {
  if (value === undefined || value === null) return null;

  const text = String(value).trim();
  if (!text) return null;

  return text.length > MAX_MESSAGE_LENGTH
    ? text.slice(0, MAX_MESSAGE_LENGTH)
    : text;
}

/**
 * @param {object|null|undefined} result résultat rendu par l'adapter.
 * @returns {object|null} le verdict normalisé, sans aucun champ issu de `raw`.
 */
function sanitizeExecutionResult(result) {
  if (!result || typeof result !== "object") return null;

  const kept = {};

  for (const field of EXECUTION_RESULT_FIELDS) {
    const value = result[field];
    if (value !== undefined) kept[field] = value;
  }

  const message = truncateMessage(result.message ?? result.errorMessage);
  if (message) kept.message = message;

  return kept;
}

function canUseSession() {
  if (typeof runtime.canUseSharedSession === "function") {
    return runtime.canUseSharedSession();
  }

  return Boolean(runtime.CAN_USE_SHARED_SESSION);
}

function safeEndSession(session) {
  try {
    if (session && typeof session.endSession === "function") {
      session.endSession();
    }
  } catch (_) {}
}

function safeObject(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}

function normalizeId(v) {
  return String(v || "").trim();
}

function buildSandboxCheckUser({ req, tx }) {
  const reqUser = safeObject(req?.user);

  return {
    ...reqUser,

    _id:
      reqUser._id ||
      reqUser.id ||
      tx?.sender ||
      tx?.userId ||
      tx?.user ||
      tx?.createdBy ||
      tx?.ownerUserId ||
      null,

    id:
      reqUser.id ||
      reqUser._id ||
      tx?.sender ||
      tx?.userId ||
      tx?.user ||
      tx?.createdBy ||
      tx?.ownerUserId ||
      null,

    email:
      reqUser.email ||
      tx?.senderEmail ||
      tx?.recipientEmail ||
      tx?.metadata?.requesterEmail ||
      tx?.meta?.requesterEmail ||
      null,

    isSandbox:
      reqUser.isSandbox === true ||
      tx?.isSandbox === true ||
      tx?.metadata?.sandbox === true ||
      tx?.meta?.sandbox === true,

    isReviewerAccount:
      reqUser.isReviewerAccount === true ||
      tx?.metadata?.isReviewerAccount === true ||
      tx?.meta?.isReviewerAccount === true,
  };
}

function isSandboxTransaction({ req, tx }) {
  const user = buildSandboxCheckUser({ req, tx });

  return Boolean(
    tx?.isSandbox === true ||
      tx?.provider === "sandbox" ||
      tx?.channel === "sandbox" ||
      tx?.metadata?.source === "apple_review_sandbox" ||
      tx?.meta?.source === "apple_review_sandbox" ||
      isSandboxUser(user)
  );
}

function buildSandboxProviderReference(tx) {
  if (tx?.providerReference) return tx.providerReference;

  const txId = tx?._id ? String(tx._id).slice(-8).toUpperCase() : "NOID";
  return `SBX-PROVIDER-SKIPPED-${txId}`;
}

async function markSandboxExecutionSkipped({ tx, sessOpts }) {
  const now = new Date();

  tx.provider = "sandbox";
  tx.channel = "sandbox";
  tx.providerStatus = "sandbox_completed";
  tx.providerReference = buildSandboxProviderReference(tx);

  /**
   * ⚠️ CORRECTIF — même défaut que dans `confirmTransaction.js`.
   *
   * `"completed"` n'appartient pas à `STATUSES` (`models/Transaction.js:47-58`) :
   * le `tx.save()` plus bas levait une erreur de validation Mongoose, et la
   * barrière sandbox de la revue App Store échouait en 500.
   *
   * Le statut de succès déclaré est `"confirmed"`. Voir le commentaire détaillé
   * dans `confirmTransaction.js` (`applySandboxConfirm`) pour la raison de ne
   * PAS élargir l'énumération à la place.
   */
  if (!tx.status || ["pending", "processing", "initiated"].includes(String(tx.status))) {
    tx.status = "confirmed";
  }

  tx.isSandbox = true;
  tx.fundsCaptured = tx.fundsCaptured === true ? true : true;

  tx.metadata = {
    ...(tx.metadata || {}),
    sandbox: true,
    execution: {
      ...(tx.metadata?.execution || {}),
      skippedProviderExecution: true,
      skippedReason: "APPLE_REVIEW_SANDBOX",
      submittedAt: now.toISOString(),
      resolvedProvider: "sandbox",
      providerResponse: {
        ok: true,
        sandbox: true,
        message: "Aucun provider réel appelé pour Apple Review.",
      },
    },
  };

  tx.meta = {
    ...(tx.meta || {}),
    sandbox: true,
    providerExecutionSkipped: true,
  };

  tx.completedAt = tx.completedAt || now;
  tx.updatedAt = now;

  await tx.save(sessOpts);

  return {
    success: true,
    sandbox: true,
    providerSkipped: true,
    transactionId: tx._id.toString(),
    status: tx.status,
    providerStatus: tx.providerStatus,
    providerReference: tx.providerReference,
    provider: "sandbox",
  };
}

function resolveProviderCandidate({ tx, resolved }) {
  return normalizeProvider(
    tx?.provider ||
      resolved?.provider ||
      tx?.channel ||
      tx?.metadata?.provider ||
      tx?.meta?.provider ||
      ""
  );
}

/**
 * ============================================================================
 * SOUMISSION AU PRESTATAIRE — L'APPEL RÉSEAU EST HORS TRANSACTION
 * ============================================================================
 *
 * CORRECTIF. Cette fonction ouvrait une transaction Mongo puis appelait
 * `resolved.execute()` A L'INTERIEUR — c'est-a-dire un `axios.post` vers Wave,
 * Orange, Stripe ou une banque, transaction ouverte.
 *
 * Tant que les transactions etaient inactives (deux clients Mongo distincts),
 * c'etait sans consequence. Depuis qu'elles sont reelles, c'est un risque de
 * perte d'argent : MongoDB tue toute transaction depassant
 * `transactionLifetimeLimitSeconds` (60 s par defaut). Un prestataire lent, et
 * le virement part chez lui pendant que la base annule tout — argent sorti,
 * aucune trace en base.
 *
 * Ni Stripe ni Wise ne placent un appel reseau dans une transaction. La forme
 * correcte est en trois temps, et c'est celle appliquee ici :
 *
 *   1. lecture et verifications — aucune transaction, ce sont des lectures ;
 *   2. APPEL PRESTATAIRE — hors transaction, donc sans verrou tenu ;
 *   3. persistance du resultat — transaction courte, purement locale.
 *
 * Corollaire assume : l'etape 2 n'est jamais rejouee automatiquement. Un rejeu,
 * ici, voudrait dire payer deux fois.
 */
async function submitExternalExecution({ req, transactionId }) {
  /* 1. Lecture et verifications ------------------------------------------- */

  const tx = await Transaction.findById(transactionId);

  if (!tx) {
    throw createError(404, "Transaction introuvable");
  }

  /**
   * Barriere de securite Apple Review :
   * Une transaction sandbox ne doit jamais appeler un executor reel.
   */
  if (isSandboxTransaction({ req, tx })) {
    const session = await startTxSession();

    try {
      return await runInTransaction(session, (activeSession) =>
        markSandboxExecutionSkipped({
          tx,
          sessOpts: maybeSessionOpts(activeSession),
        })
      );
    } finally {
      safeEndSession(session);
    }
  }

  const resolved = resolveExecutor({
    flow: tx.flow,
    provider: tx.provider,
  });

  if (!resolved || typeof resolved.execute !== "function") {
    throw createError(400, `Aucun executor trouve pour le flow ${tx.flow}`);
  }

  const sandboxCheckUser = buildSandboxCheckUser({ req, tx });
  const providerCandidate = resolveProviderCandidate({ tx, resolved });

  /**
   * Deuxieme barriere :
   * Meme si la tx n'est pas marquee isSandbox, si le user Apple Review tente un
   * provider reel, on bloque.
   */
  assertProviderAllowedForUser(sandboxCheckUser, providerCandidate);

  if (!tx.provider && resolved.provider) {
    tx.provider = resolved.provider;
  }

  /* 2. Appel prestataire — HORS TRANSACTION -------------------------------- */

  const result = await resolved.execute({
    req,
    transaction: tx,
  });

  /* 3. Persistance du resultat — transaction courte ------------------------ */

  tx.providerStatus =
    result?.providerStatus || tx.providerStatus || "PROVIDER_SUBMITTED";

  tx.providerReference =
    result?.providerReference || tx.providerReference || null;

  /**
   * ═══════════════════════════════════════════════════════════════════════
   * LE VERDICT DU PRESTATAIRE DÉCIDE DU STATUT — RÈGLE B.2, ÉCHEC EN FERMETURE
   * ═══════════════════════════════════════════════════════════════════════
   *
   * Ce bloc écrivait `pending → processing` SANS CONDITION :
   *
   *     if (tx.status === "pending") { tx.status = "processing"; }
   *
   * Un refus explicite du prestataire — `ok: false`, `externalStatus:
   * "FAILED"` — produisait donc une transaction « en cours », fonds
   * immobilisés chez l'expéditeur, jusqu'au `SETTLEMENT_TIMEOUT` de 6 h
   * (`services/reconciliation/providerReconciliationRules.js`). L'information
   * était pourtant disponible immédiatement.
   *
   * Ce n'était pas un cas de bord : `visaDirectAdapter` refuse TOUT
   * encaissement tant que `VISA_DIRECT_COLLECT_ENABLED` n'est pas posée, par
   * `failResult`. Tout dépôt par carte empruntait ce chemin.
   *
   * ⚠️ ON NE DEVINE PAS LE REFUS À PARTIR DU STATUT TEXTUEL. `ok` est le seul
   * champ dont la sémantique est décidée par NOUS (les adapters le posent
   * explicitement) ; `externalStatus` est du vocabulaire prestataire, et
   * chacun a le sien. Se fier au texte serait reconduire la faute sous une
   * autre forme.
   *
   * La transition passe par la machine à états plutôt que d'écrire `status`
   * en direct : `pending → failed` et `pending_review → failed` sont
   * déclarées, les autres ne le sont pas, et un refus sur une transaction
   * déjà confirmée doit rester bruyant plutôt que silencieux.
   */
  const refusParLePrestataire = result?.ok === false;

  if (refusParLePrestataire) {
    tx.providerStatus = result?.providerStatus || "FAILED";

    if (canTransition(tx.status, "failed")) {
      tx.status = "failed";
    } else {
      runtime.logger?.error?.(
        "[submitExternalExecution] refus prestataire sur un statut qui n'admet pas failed",
        {
          txId: String(tx._id),
          reference: tx.reference || null,
          statut: tx.status,
          provider: resolved.provider || tx.provider || null,
          errorCode: result?.errorCode || null,
          consequence:
            "le statut n'a PAS été changé : la transaction reste dans son état " +
            "courant et doit être traitée à la main",
        }
      );
    }

    tx.failureReason =
      result?.errorCode ||
      result?.errorMessage ||
      tx.failureReason ||
      "PROVIDER_REFUSED";
  } else if (tx.status === "pending") {
    tx.status = "processing";
  }

  tx.metadata = {
    ...(tx.metadata || {}),
    execution: {
      ...(tx.metadata?.execution || {}),
      submittedAt: new Date().toISOString(),
      resolvedProvider: resolved.provider || tx.provider || null,
      providerResponse: sanitizeExecutionResult(result),
    },
  };

  const session = await startTxSession();

  try {
    await runInTransaction(session, (activeSession) =>
      tx.save(maybeSessionOpts(activeSession))
    );
  } finally {
    safeEndSession(session);
  }

  return {
    success: true,
    transactionId: tx._id.toString(),
    status: tx.status,
    providerStatus: tx.providerStatus,
    providerReference: tx.providerReference,
    provider: tx.provider || resolved.provider || null,
  };
}

module.exports = {
  submitExternalExecution,
};