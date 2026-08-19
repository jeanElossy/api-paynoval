"use strict";

let logger = console;
try {
  logger = require("../utils/logger");
} catch {}

const mongoose = require("mongoose");

const { getTxConn } = require("../config/db");

const TxWalletBalanceModel = require("../models/TxWalletBalance");
const TxSystemBalanceModel = require("../models/TxSystemBalance");
const TransactionModel = require("../models/Transaction");
const LedgerEntryModel = require("../models/LedgerEntry");
const ReferralPayoutModel = require("../models/ReferralPayout");

/**
 * Primitives d'idempotence — module PUR, testable sans base ni configuration.
 * Elles definissent la garantie « exactement une fois » : les extraire permet
 * de les verifier isolement, ce que ce fichier (qui charge la configuration au
 * require) ne permettrait pas.
 */
const {
  buildPayoutIdempotencyKey,
  computeRequestFingerprint,
  normalizeBeneficiaries,
} = require("./referral/referralKeys");

const crypto = require("crypto");

function safeNumber(v) {
  const n =
    typeof v === "number" ? v : parseFloat(String(v ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

function normalizeCurrency(v, fallback = "XOF") {
  const code = String(v || fallback).trim().toUpperCase();
  return code || fallback;
}

function getCurrencyDecimals(currency) {
  const c = normalizeCurrency(currency);
  return ["XOF", "XAF", "JPY"].includes(c) ? 0 : 2;
}

function roundForCurrency(amount, currency) {
  const n = safeNumber(amount);
  const p = 10 ** getCurrencyDecimals(currency);
  return Math.round(n * p) / p;
}

function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function normalizePath(value, fallback) {
  const raw = String(value || fallback || "").trim();
  if (!raw) return "";
  return raw.startsWith("/") ? raw : `/${raw}`;
}

function pickFirstEnv(...keys) {
  for (const key of keys) {
    const value = process.env[key];
    if (String(value || "").trim()) return String(value).trim();
  }
  return "";
}

function getFxBaseUrl() {
  return normalizeBaseUrl(
    pickFirstEnv(
      "FX_INTERNAL_BASE_URL",
      "BACKEND_PRINCIPAL_URL",
      "PRINCIPAL_BACKEND_URL",
      "PRINCIPAL_URL",
      "PRINCIPAL_BASE_URL",
      "BACKEND_URL"
    )
  );
}

function getFxConvertPath() {
  return normalizePath(
    pickFirstEnv("FX_CONVERT_INTERNAL_PATH", "FX_INTERNAL_CONVERT_PATH"),
    "/internal/fx/convert"
  );
}

function getFxInternalToken() {
  return pickFirstEnv(
    "PRINCIPAL_INTERNAL_TOKEN",
    "INTERNAL_REFERRAL_TOKEN",
    "INTERNAL_TOKEN"
  );
}

function getInternalHttpTimeoutMs() {
  const raw = Number(
    pickFirstEnv("FX_INTERNAL_TIMEOUT_MS", "INTERNAL_HTTP_TIMEOUT_MS") || 10000
  );
  return Number.isFinite(raw) && raw > 0 ? raw : 10000;
}

async function readJsonSafe(response) {
  const text = await response.text();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function postJsonWithTimeout(url, body, headers = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body || {}),
      signal: controller.signal,
    });

    const data = await readJsonSafe(response);

    return {
      ok: response.ok,
      status: response.status,
      data,
    };
  } finally {
    clearTimeout(timer);
  }
}

function getTxWalletBalance() {
  return TxWalletBalanceModel(getTxConn());
}

function getTxSystemBalance() {
  return TxSystemBalanceModel(getTxConn());
}

function getTransactionModel() {
  return TransactionModel(getTxConn());
}

/**
 * Double écriture comptable d'un bonus de parrainage.
 *
 * ⚠️ Jusqu'ici, `transferReferralBonus` débitait la trésorerie et créditait le
 * portefeuille du bénéficiaire **sans jamais écrire au grand livre** : de
 * l'argent bougeait et le registre comptable l'ignorait. Le solde réel de
 * REFERRAL_TREASURY et la somme des écritures divergeaient donc en silence, et
 * l'analytique de trésorerie devait reconstituer la section parrainage depuis
 * les `Transaction` faute d'écritures.
 *
 * Deux entrées par bénéficiaire, dans la session de la transaction Mongo :
 *   - DEBIT  sur `treasury:<SYSTEM_TYPE>:<uid>:<CUR>` (la trésorerie paie) ;
 *   - CREDIT sur `user_wallet:<uid>:<CUR>` (le bénéficiaire reçoit).
 *
 * Les deux montants sont dans des devises potentiellement différentes — le
 * bonus peut être converti — donc on n'écrit jamais un montant pour l'autre :
 * chaque entrée porte sa propre devise, et la conversion est tracée en
 * métadonnée.
 *
 * **Rejeu** : les écritures sont conditionnées à l'absence d'une entrée de même
 * `reference` et même `accountId`. `createLedgerEntry` fait un `create()` sec,
 * sans garde d'unicité ; sans ce contrôle, un rejeu du transfert doublerait la
 * comptabilité.
 */
async function writeReferralLedgerEntries({
  transactionId,
  reference,
  beneficiaryId,
  beneficiaryCurrency,
  creditedAmount,
  treasuryUserId,
  treasurySystemType,
  treasuryCurrency,
  treasuryDebitedAmount,
  session,
  metadata = {},
}) {
  if (!transactionId) {
    // Sans transaction rattachable, une écriture serait orpheline : on préfère
    // ne rien écrire et le signaler plutôt que polluer le grand livre.
    logReferral("ledger:skipped:no-transaction-id", { reference });
    return { written: 0 };
  }

  /* ⚠️ `ledgerService` appelle `getTxConn()` **au chargement du module**
     (ledgerService.js, ligne 21) : l'importer en tête de ce fichier ferait
     échouer le démarrage dès que ce service est chargé avant
     `connectTransactionsDB()`. On le requiert donc ici, à l'usage — c'est le
     piège documenté dans le CLAUDE.md du dépôt. */
  const { createLedgerEntry } = require("./ledgerService");

  const LedgerEntry = LedgerEntryModel(getTxConn());

  const treasuryAccountId = `treasury:${treasurySystemType}:${String(
    treasuryUserId
  )}:${treasuryCurrency}`;
  const walletAccountId = `user_wallet:${String(
    beneficiaryId
  )}:${beneficiaryCurrency}`;

  // Une seule requête pour les deux comptes : on saura lequel manque.
  const existing = await LedgerEntry.find(
    { reference: String(reference), accountId: { $in: [treasuryAccountId, walletAccountId] } },
    { accountId: 1 },
    { session }
  ).lean();

  const already = new Set(existing.map((e) => e.accountId));
  let written = 0;

  const sharedMetadata = {
    ...metadata,
    referralReference: String(reference),
    treasurySystemType,
  };

  if (!already.has(treasuryAccountId) && treasuryDebitedAmount > 0) {
    await createLedgerEntry({
      transactionId,
      reference: String(reference),
      userId: treasuryUserId,
      accountType: "TREASURY",
      accountId: treasuryAccountId,
      direction: "DEBIT",
      entryType: "REFERRAL_PAYOUT",
      amount: treasuryDebitedAmount,
      currency: treasuryCurrency,
      metadata: {
        ...sharedMetadata,
        counterpartyUserId: String(beneficiaryId),
        counterpartyCurrency: beneficiaryCurrency,
        counterpartyAmount: creditedAmount,
      },
      session,
    });
    written += 1;
  }

  if (!already.has(walletAccountId) && creditedAmount > 0) {
    await createLedgerEntry({
      transactionId,
      reference: String(reference),
      userId: beneficiaryId,
      accountType: "USER_WALLET",
      accountId: walletAccountId,
      direction: "CREDIT",
      entryType: "USER_CREDIT",
      amount: creditedAmount,
      currency: beneficiaryCurrency,
      metadata: {
        ...sharedMetadata,
        sourceAmount: treasuryDebitedAmount,
        sourceCurrency: treasuryCurrency,
      },
      session,
    });
    written += 1;
  }

  return { written };
}

function logReferral(label, payload) {
  try {
    logger.info?.(`[REFERRAL][TX-CORE][TRANSFER] ${label}`, payload);
  } catch {
    try {
      console.log(
        `[REFERRAL][TX-CORE][TRANSFER] ${label} =`,
        JSON.stringify(payload, null, 2)
      );
    } catch {
      console.log(`[REFERRAL][TX-CORE][TRANSFER] ${label} =`, payload);
    }
  }
}

async function ensureWallet(userId, currency, session) {
  const TxWalletBalance = getTxWalletBalance();
  const cur = normalizeCurrency(currency);

  if (!userId) {
    throw Object.assign(new Error("WALLET_USER_ID_MISSING"), {
      code: "WALLET_USER_ID_MISSING",
    });
  }

  return TxWalletBalance.ensureWallet(userId, cur, { session });
}

async function convertAmountViaInternalFx({
  amount,
  fromCurrency,
  toCurrency,
  metadata = {},
}) {
  const sourceAmount = safeNumber(amount);
  const from = normalizeCurrency(fromCurrency);
  const to = normalizeCurrency(toCurrency);

  if (!(sourceAmount > 0)) {
    return {
      success: true,
      convertedAmount: 0,
      rate: 1,
      fromCurrency: from,
      toCurrency: to,
    };
  }

  if (from === to) {
    return {
      success: true,
      convertedAmount: roundForCurrency(sourceAmount, to),
      rate: 1,
      fromCurrency: from,
      toCurrency: to,
    };
  }

  const baseUrl = getFxBaseUrl();
  const path = getFxConvertPath();
  const token = getFxInternalToken();
  const timeoutMs = getInternalHttpTimeoutMs();

  if (!baseUrl) {
    throw Object.assign(new Error("FX_INTERNAL_BASE_URL_MISSING"), {
      code: "FX_INTERNAL_BASE_URL_MISSING",
      details: { amount: sourceAmount, fromCurrency: from, toCurrency: to },
    });
  }

  if (!token) {
    throw Object.assign(new Error("FX_INTERNAL_TOKEN_MISSING"), {
      code: "FX_INTERNAL_TOKEN_MISSING",
    });
  }

  const url = `${baseUrl}${path}`;

  const response = await postJsonWithTimeout(
    url,
    {
      amount: sourceAmount,
      fromCurrency: from,
      toCurrency: to,
      metadata,
    },
    {
      "x-internal-token": token,
    },
    timeoutMs
  );

  const converted =
    safeNumber(
      response?.data?.convertedAmount ??
        response?.data?.converted ??
        response?.data?.amount ??
        response?.data?.targetAmount ??
        response?.data?.result?.convertedAmount ??
        response?.data?.result?.converted
    ) || 0;

  const rate =
    safeNumber(
      response?.data?.rate ??
        response?.data?.fxRate ??
        response?.data?.meta?.rate ??
        response?.data?.result?.rate
    ) || null;

  if (!response.ok || response?.data?.success === false) {
    throw Object.assign(new Error("FX_INTERNAL_CONVERSION_FAILED"), {
      code: "FX_INTERNAL_CONVERSION_FAILED",
      details: {
        httpStatus: response?.status,
        url,
        response: response?.data || null,
        amount: sourceAmount,
        fromCurrency: from,
        toCurrency: to,
      },
    });
  }

  return {
    success: true,
    convertedAmount: roundForCurrency(converted, to),
    rate,
    fromCurrency: from,
    toCurrency: to,
    raw: response?.data || null,
  };
}

async function convertMoney({ amount, fromCurrency, toCurrency }) {
  const from = normalizeCurrency(fromCurrency);
  const to = normalizeCurrency(toCurrency);
  const amt = roundForCurrency(amount, from);

  if (!(amt > 0)) {
    return {
      fromCurrency: from,
      toCurrency: to,
      rate: 1,
      sourceAmount: 0,
      convertedAmount: 0,
    };
  }

  if (from === to) {
    return {
      fromCurrency: from,
      toCurrency: to,
      rate: 1,
      sourceAmount: amt,
      convertedAmount: roundForCurrency(amt, to),
    };
  }

  const res = await convertAmountViaInternalFx({
    amount: amt,
    fromCurrency: from,
    toCurrency: to,
    metadata: {
      source: "tx_core_referral_transfer",
    },
  });

  const converted = safeNumber(res?.convertedAmount);

  if (!(converted >= 0)) {
    throw Object.assign(new Error("FX_CONVERSION_FAILED"), {
      code: "FX_CONVERSION_FAILED",
      details: {
        amount: amt,
        fromCurrency: from,
        toCurrency: to,
        fxResponse: res,
      },
    });
  }

  return {
    fromCurrency: from,
    toCurrency: to,
    rate: safeNumber(res?.rate || 0) || null,
    sourceAmount: amt,
    convertedAmount: roundForCurrency(converted, to),
    raw: res || null,
  };
}

async function buildMovement({
  nominalBonusAmount,
  nominalBonusCurrency,
  creditedCurrency,
  treasuryCurrency,
}) {
  const nominalAmount = roundForCurrency(
    nominalBonusAmount,
    nominalBonusCurrency
  );
  const nominalCur = normalizeCurrency(nominalBonusCurrency);
  const creditedCur = normalizeCurrency(creditedCurrency || nominalCur);
  const treasuryCur = normalizeCurrency(treasuryCurrency || "CAD");

  if (!(nominalAmount > 0)) {
    return {
      skipped: true,
      nominalBonusAmount: 0,
      nominalBonusCurrency: nominalCur,
      creditedAmount: 0,
      creditedCurrency: creditedCur,
      treasuryDebitedAmount: 0,
      treasuryCurrency: treasuryCur,
      conversions: {
        nominalToCredited: null,
        creditedToTreasury: null,
      },
    };
  }

  const nominalToCredited = await convertMoney({
    amount: nominalAmount,
    fromCurrency: nominalCur,
    toCurrency: creditedCur,
  });

  const creditedAmount = roundForCurrency(
    nominalToCredited.convertedAmount,
    creditedCur
  );

  const creditedToTreasury = await convertMoney({
    amount: creditedAmount,
    fromCurrency: creditedCur,
    toCurrency: treasuryCur,
  });

  const treasuryDebitedAmount = roundForCurrency(
    creditedToTreasury.convertedAmount,
    treasuryCur
  );

  return {
    skipped: false,
    nominalBonusAmount: nominalAmount,
    nominalBonusCurrency: nominalCur,
    creditedAmount,
    creditedCurrency: creditedCur,
    treasuryDebitedAmount,
    treasuryCurrency: treasuryCur,
    conversions: {
      nominalToCredited,
      creditedToTreasury,
    },
  };
}

async function ensureSystemWalletStrict({
  TxSystemBalance,
  treasuryUserId,
  systemType,
  currency,
  session,
  metadata = {},
}) {
  return TxSystemBalance.ensureSystemWallet(
    treasuryUserId,
    systemType,
    currency,
    {
      session,
      metadata,
    }
  );
}

async function debitSystemWalletStrict({
  TxSystemBalance,
  treasuryUserId,
  systemType,
  currency,
  amount,
  session,
  reason,
  reference,
  metadata = {},
}) {
  return TxSystemBalance.debit(
    treasuryUserId,
    systemType,
    currency,
    amount,
    {
      session,
      reason,
      reference,
      metadata,
      historyMetadata: metadata,
    }
  );
}

async function debitReferralTreasury({
  treasuryUserId,
  treasurySystemType = "REFERRAL_TREASURY",
  treasuryCurrency = "CAD",
  amount,
  session,
  metadata = {},
}) {
  const TxSystemBalance = getTxSystemBalance();
  const treasuryUser = String(treasuryUserId || "").trim();
  const systemType = String(treasurySystemType || "REFERRAL_TREASURY").trim();
  const cur = normalizeCurrency(treasuryCurrency || "CAD");
  const amt = roundForCurrency(amount, cur);

  if (!treasuryUser) {
    throw Object.assign(new Error("TREASURY_USER_ID_REQUIRED"), {
      code: "TREASURY_USER_ID_REQUIRED",
    });
  }

  if (!systemType) {
    throw Object.assign(new Error("SYSTEM_TYPE_REQUIRED"), {
      code: "SYSTEM_TYPE_REQUIRED",
    });
  }

  if (systemType !== "REFERRAL_TREASURY") {
    throw Object.assign(new Error("INVALID_REFERRAL_TREASURY_TYPE"), {
      code: "INVALID_REFERRAL_TREASURY_TYPE",
      details: { treasurySystemType: systemType },
    });
  }

  if (cur !== "CAD") {
    throw Object.assign(new Error("REFERRAL_TREASURY_MUST_BE_CAD"), {
      code: "REFERRAL_TREASURY_MUST_BE_CAD",
      details: { treasuryCurrency: cur },
    });
  }

  if (!(amt > 0)) {
    return {
      skipped: true,
      treasuryUserId: treasuryUser,
      systemType,
      currency: cur,
      amount: 0,
    };
  }

  const wallet = await ensureSystemWalletStrict({
    TxSystemBalance,
    treasuryUserId: treasuryUser,
    systemType,
    currency: cur,
    session,
    metadata: {
      source: "internal_referral_transfer",
      ...metadata,
    },
  });

  if (!wallet) {
    throw Object.assign(new Error("SYSTEM_TREASURY_NOT_FOUND"), {
      code: "SYSTEM_TREASURY_NOT_FOUND",
      details: {
        treasuryUserId: treasuryUser,
        treasurySystemType: systemType,
        treasuryCurrency: cur,
      },
    });
  }

  const availableBefore = Number(wallet?.balances?.[cur] || 0);

  if (availableBefore < amt) {
    throw Object.assign(new Error("REFERRAL_TREASURY_INSUFFICIENT_FUNDS"), {
      code: "REFERRAL_TREASURY_INSUFFICIENT_FUNDS",
      details: {
        treasuryUserId: treasuryUser,
        treasurySystemType: systemType,
        treasuryCurrency: cur,
        availableBefore,
        amount: amt,
      },
    });
  }

  const updated = await debitSystemWalletStrict({
    TxSystemBalance,
    treasuryUserId: treasuryUser,
    systemType,
    currency: cur,
    amount: amt,
    session,
    reason: metadata?.reason || "Referral bonus payout",
    reference:
      metadata?.reference ||
      metadata?.triggerTxId ||
      metadata?.idempotencyKey ||
      null,
    metadata: {
      source: "internal_referral_transfer",
      ...metadata,
    },
  });

  return {
    skipped: false,
    treasuryUserId: treasuryUser,
    systemType,
    currency: cur,
    amount: amt,
    balance: Number(updated?.balances?.[cur] || 0),
    availableBalance: Number(updated?.balances?.[cur] || 0),
  };
}

/**
 * ---------------------------------------------------------------------------
 * REGISTRE D'IDEMPOTENCE
 * ---------------------------------------------------------------------------
 */

function getReferralPayout() {
  return ReferralPayoutModel(getTxConn());
}

/** Reconstitue la réponse d'origine à partir des versements déjà enregistrés. */
function buildReplayResponse(payouts, { fingerprint }) {
  const snapshot = payouts.find((p) => p.responseSnapshot)?.responseSnapshot;

  const mismatch = payouts.some(
    (p) => p.requestFingerprint && p.requestFingerprint !== fingerprint
  );

  return {
    ...(snapshot || {}),
    ok: true,
    alreadyPaid: true,
    code: "ALREADY_PAID",
    fingerprintMismatch: mismatch,
    payouts: payouts.map((p) => ({
      idempotencyKey: p.idempotencyKey,
      beneficiaryId: p.beneficiaryId,
      role: p.beneficiaryRole,
      creditedAmount: p.creditedAmount,
      creditedCurrency: p.creditedCurrency,
      balanceBefore: p.balanceBefore,
      balanceAfter: p.balanceAfter,
      transactionReference: p.transactionReference,
      completedAt: p.completedAt,
    })),
  };
}

/**
 * ---------------------------------------------------------------------------
 * CRÉDIT AVEC CAPTURE DU SOLDE AVANT / APRÈS
 * ---------------------------------------------------------------------------
 */

function decimalToNumber(value) {
  if (value === null || value === undefined) return 0;
  const n = Number(value?.toString?.() ?? value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Crédite un portefeuille et retourne les soldes encadrant le mouvement.
 *
 * La lecture du solde initial se fait DANS la même transaction Mongo que le
 * crédit : l'isolation par instantané garantit que la valeur lue est bien celle
 * qui précède immédiatement l'écriture. Un « solde avant » lu hors transaction
 * serait une approximation, et une approximation dans un relevé financier est
 * une erreur qu'on ne peut pas défendre.
 */
async function creditWalletWithBalances({
  userId,
  currency,
  amount,
  session,
  errorCode,
}) {
  const TxWalletBalance = getTxWalletBalance();
  const cur = normalizeCurrency(currency);
  const amt = roundForCurrency(amount, cur);

  if (!(amt > 0)) {
    return { skipped: true, balanceBefore: null, balanceAfter: null, amount: 0 };
  }

  const before = await ensureWallet(userId, cur, session);
  const balanceBefore = decimalToNumber(before?.amount);

  const updated = await TxWalletBalance.credit(userId, cur, amt, { session });

  if (!updated) {
    throw Object.assign(new Error(errorCode || "WALLET_CREDIT_FAILED"), {
      code: errorCode || "WALLET_CREDIT_FAILED",
      details: { userId: String(userId), currency: cur, amount: amt },
    });
  }

  return {
    skipped: false,
    userId: String(userId),
    currency: cur,
    amount: amt,
    balanceBefore,
    balanceAfter: decimalToNumber(updated.amount),
    availableAfter: decimalToNumber(updated.availableAmount),
  };
}

/**
 * ---------------------------------------------------------------------------
 * TRANSACTION VISIBLE PAR L'UTILISATEUR
 * ---------------------------------------------------------------------------
 */

function buildUserVisibleReferralTx({
  reference,
  idempotencyKey,
  userId,
  senderId,
  receiverId,
  amount,
  currency,
  role,
  triggerTxId,
  payoutRefBase,
  label,
  rewardId,
  correlationId,
  balanceBefore,
  balanceAfter,
  metadata = {},
}) {
  const cur = normalizeCurrency(currency || "XOF");
  const amt = roundForCurrency(amount, cur);
  const now = new Date();

  return {
    reference: String(reference),
    idempotencyKey: String(idempotencyKey),
    internalImported: false,
    flow: "PAYNOVAL_INTERNAL_TRANSFER",
    operationKind: "bonus",
    initiatedBy: "system",
    context: "referral_bonus",
    contextId: String(payoutRefBase || ""),
    provider: "paynoval",
    type: "referral_bonus",
    userId,
    sender: senderId,
    receiver: receiverId,
    senderName: "PayNoval Referral Treasury",
    receiverName: label || null,
    amount: amt,
    localAmount: amt,
    currency: cur,
    localCurrency: cur,
    currencySource: cur,
    currencyTarget: cur,
    localCurrencySymbol: cur,
    status: "confirmed",
    confirmedAt: now,
    completedAt: now,
    requiresSecurityValidation: false,
    securityAttempts: 0,
    securityLockedUntil: null,
    metadata: {
      category: "referral_bonus",
      role,
      rewardId: String(rewardId || ""),
      correlationId: String(correlationId || ""),
      triggerTxId: String(triggerTxId || ""),
      balanceBefore,
      balanceAfter,
      ...metadata,
    },
    meta: {
      category: "referral_bonus",
      role,
      direction: "credit",
      rewardId: String(rewardId || ""),
      correlationId: String(correlationId || ""),
      triggerTxId: String(triggerTxId || ""),
      balanceBefore,
      balanceAfter,
      ...metadata,
    },
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Enregistre la transaction visible par l'utilisateur — EN INSERTION STRICTE.
 *
 * L'`upsert` précédent était un trou dans la coque : rejoué, il mettait
 * simplement le document à jour et laissait le crédit se produire une seconde
 * fois. L'insertion stricte, elle, se heurte à l'index unique
 * `{userId, reference}` et lève un E11000 qui annule TOUTE la transaction Mongo.
 *
 * C'est aussi ce qui protège les récompenses accordées AVANT l'introduction du
 * registre d'idempotence : elles n'ont pas de `ReferralPayout`, mais elles ont
 * leur transaction — et sa référence n'a pas changé de format, précisément pour
 * que cette garde continue de mordre.
 */
async function insertReferralHistoryTransaction(doc, session) {
  const Transaction = getTransactionModel();

  const [created] = await Transaction.create([doc], { session });
  return created;
}

/**
 * ---------------------------------------------------------------------------
 * VERSEMENT
 * ---------------------------------------------------------------------------
 */

/**
 * Verse un bonus de parrainage, exactement une fois.
 *
 * GARANTIE. Pour un `rewardId` et un bénéficiaire donnés, l'argent ne peut
 * partir qu'une seule fois, quel que soit le nombre d'appels, leur simultanéité,
 * ou les redémarrages intercalés. Trois verrous concourants l'assurent :
 *
 *   1. l'index unique de `ReferralPayout`, inséré AVANT tout mouvement ;
 *   2. l'index unique `{userId, reference}` de `Transaction`, qui couvre en
 *      plus les récompenses antérieures à ce dispositif ;
 *   3. le contrôle de rejeu du grand livre, conservé en défense en profondeur.
 *
 * Le tout dans UNE transaction Mongo : si l'un des trois mord, rien n'a bougé —
 * ni le solde du bénéficiaire, ni celui de la trésorerie.
 *
 * @param {object} params
 * @param {string} params.rewardId          récompense de parrainage concernée
 * @param {Array}  params.beneficiaries     [{userId, role, amount, payoutCurrency, label}]
 * @param {string} params.bonusInputCurrency devise dans laquelle les montants sont exprimés
 */
async function transferReferralBonus({
  rewardId,
  correlationId = "",
  programVersion = "",
  triggerTxId = "",
  treasuryUserId,
  treasurySystemType = "REFERRAL_TREASURY",
  treasuryCurrency = "CAD",
  bonusInputCurrency = "CAD",
  beneficiaries: rawBeneficiaries,
  metadata = {},
}) {
  const treasuryUser = String(treasuryUserId || "").trim();
  const systemType = String(treasurySystemType || "REFERRAL_TREASURY").trim();
  const treasuryCur = normalizeCurrency(treasuryCurrency || "CAD");
  const inputBonusCurrency = normalizeCurrency(bonusInputCurrency || "CAD");
  const reward = String(rewardId || "").trim();

  if (!reward) {
    throw Object.assign(new Error("REWARD_ID_REQUIRED"), {
      code: "REWARD_ID_REQUIRED",
    });
  }

  if (!treasuryUser) {
    throw Object.assign(new Error("TREASURY_USER_ID_REQUIRED"), {
      code: "TREASURY_USER_ID_REQUIRED",
    });
  }

  const beneficiaries = normalizeBeneficiaries(
    rawBeneficiaries,
    inputBonusCurrency
  );

  if (!beneficiaries.length) {
    return {
      ok: true,
      skipped: true,
      code: "NO_POSITIVE_BONUS",
      rewardId: reward,
      beneficiaries: [],
    };
  }

  const fingerprint = computeRequestFingerprint({
    rewardId: reward,
    treasuryUserId: treasuryUser,
    treasurySystemType: systemType,
    treasuryCurrency: treasuryCur,
    bonusInputCurrency: inputBonusCurrency,
    beneficiaries,
  });

  const ReferralPayout = getReferralPayout();

  const keys = beneficiaries.map((b) =>
    buildPayoutIdempotencyKey(reward, b.userId)
  );

  /* --- Voie rapide : déjà versé ? ---------------------------------------- */

  const alreadyPaid = await ReferralPayout.find({
    idempotencyKey: { $in: keys },
    status: "succeeded",
  }).lean();

  if (alreadyPaid.length) {
    const replay = buildReplayResponse(alreadyPaid, { fingerprint });

    if (replay.fingerprintMismatch) {
      /**
       * Même clé, paramètres différents. On ne repaie SURTOUT pas — mais on ne
       * se tait pas non plus : c'est le signe d'un barème modifié après coup ou
       * d'un appelant qui réutilise une clé. Il faut que quelqu'un regarde.
       */
      logger.error?.(
        "[REFERRAL][TX-CORE][TRANSFER] empreinte divergente sur une cle deja versee",
        { rewardId: reward, correlationId, fingerprint }
      );
    }

    logReferral("transferReferralBonus.already_paid", {
      rewardId: reward,
      correlationId,
      keys,
    });

    return replay;
  }

  /* --- Conversions de change : HORS transaction Mongo ---------------------
   * Un appel réseau à l'intérieur d'une transaction Mongo maintient les verrous
   * ouverts pendant toute la latence du tiers. On calcule donc tous les
   * mouvements d'abord, on n'ouvre la transaction qu'ensuite.
   */

  const movements = [];

  for (const beneficiary of beneficiaries) {
    const movement = await buildMovement({
      nominalBonusAmount: beneficiary.amount,
      nominalBonusCurrency: inputBonusCurrency,
      creditedCurrency: beneficiary.payoutCurrency,
      treasuryCurrency: treasuryCur,
    });

    movements.push({ beneficiary, movement });
  }

  const treasuryDebitTotal = roundForCurrency(
    movements.reduce(
      (acc, m) => acc + safeNumber(m.movement.treasuryDebitedAmount),
      0
    ),
    treasuryCur
  );

  if (!(treasuryDebitTotal > 0)) {
    return {
      ok: true,
      skipped: true,
      code: "NO_POSITIVE_BONUS",
      rewardId: reward,
      treasuryDebitTotal: 0,
      beneficiaries: [],
    };
  }

  const payoutRefBase =
    String(metadata?.payoutRefBase || "").trim() || `REFBONUS-${reward}`;

  const session = await mongoose.startSession();
  let result = null;

  try {
    await session.withTransaction(async () => {
      /* 1. LE VERROU, AVANT TOUT MOUVEMENT.
       *    Si une autre exécution est passée par là, l'insertion échoue ici —
       *    donc avant que le moindre centime ne bouge. */
      const payoutDocs = movements.map(({ beneficiary, movement }) => ({
        idempotencyKey: buildPayoutIdempotencyKey(reward, beneficiary.userId),
        requestFingerprint: fingerprint,
        rewardId: reward,
        beneficiaryId: beneficiary.userId,
        beneficiaryRole: beneficiary.role,
        treasuryUserId: treasuryUser,
        treasurySystemType: systemType,
        creditedAmount: movement.creditedAmount,
        creditedCurrency: movement.creditedCurrency,
        treasuryDebitedAmount: movement.treasuryDebitedAmount,
        treasuryCurrency: treasuryCur,
        status: "processing",
        correlationId: String(correlationId || ""),
        triggerTxId: String(triggerTxId || ""),
        programVersion: String(programVersion || ""),
        transactionReference: `${payoutRefBase}-${beneficiary.role.toUpperCase()}`,
      }));

      await ReferralPayout.create(payoutDocs, { session, ordered: true });

      /* 2. Débit de la trésorerie. */
      await debitReferralTreasury({
        treasuryUserId: treasuryUser,
        treasurySystemType: systemType,
        treasuryCurrency: treasuryCur,
        amount: treasuryDebitTotal,
        session,
        metadata: {
          ...metadata,
          rewardId: reward,
          correlationId: String(correlationId || ""),
          payoutRefBase,
          beneficiaries: beneficiaries.map((b) => ({
            userId: b.userId,
            role: b.role,
          })),
        },
      });

      /* 3. Crédit de chaque bénéficiaire, avec capture du solde avant/après. */
      const credited = [];

      for (const { beneficiary, movement } of movements) {
        if (movement.skipped || !(movement.creditedAmount > 0)) continue;

        const reference = `${payoutRefBase}-${beneficiary.role.toUpperCase()}`;

        const balances = await creditWalletWithBalances({
          userId: beneficiary.userId,
          currency: movement.creditedCurrency,
          amount: movement.creditedAmount,
          session,
          errorCode: `${beneficiary.role.toUpperCase()}_WALLET_CREDIT_FAILED`,
        });

        const txDoc = await insertReferralHistoryTransaction(
          buildUserVisibleReferralTx({
            reference,
            idempotencyKey: buildPayoutIdempotencyKey(
              reward,
              beneficiary.userId
            ),
            userId: beneficiary.userId,
            senderId: treasuryUser,
            receiverId: beneficiary.userId,
            amount: movement.creditedAmount,
            currency: movement.creditedCurrency,
            role: beneficiary.role,
            triggerTxId,
            payoutRefBase,
            rewardId: reward,
            correlationId,
            balanceBefore: balances.balanceBefore,
            balanceAfter: balances.balanceAfter,
            label: beneficiary.label || beneficiary.role,
            metadata: {
              payoutRefBase,
              fromTreasuryUserId: treasuryUser,
              treasurySystemType: systemType,
              nominalBonusAmount: movement.nominalBonusAmount,
              nominalBonusCurrency: movement.nominalBonusCurrency,
              treasuryDebitedAmount: movement.treasuryDebitedAmount,
              treasuryCurrency: treasuryCur,
              conversions: movement.conversions,
              programVersion: String(programVersion || ""),
            },
          }),
          session
        );

        await writeReferralLedgerEntries({
          transactionId: txDoc?._id,
          reference,
          beneficiaryId: beneficiary.userId,
          beneficiaryCurrency: movement.creditedCurrency,
          creditedAmount: movement.creditedAmount,
          treasuryUserId: treasuryUser,
          treasurySystemType: systemType,
          treasuryCurrency: treasuryCur,
          treasuryDebitedAmount: movement.treasuryDebitedAmount,
          session,
          metadata: {
            role: beneficiary.role,
            rewardId: reward,
            correlationId: String(correlationId || ""),
            payoutRefBase,
            triggerTxId: String(triggerTxId || ""),
            conversions: movement.conversions,
          },
        });

        credited.push({
          userId: beneficiary.userId,
          role: beneficiary.role,
          nominalBonusAmount: movement.nominalBonusAmount,
          nominalBonusCurrency: movement.nominalBonusCurrency,
          creditedAmount: movement.creditedAmount,
          creditedCurrency: movement.creditedCurrency,
          treasuryDebitedAmount: movement.treasuryDebitedAmount,
          treasuryCurrency: treasuryCur,
          balanceBefore: balances.balanceBefore,
          balanceAfter: balances.balanceAfter,
          transactionReference: reference,
          transactionId: txDoc?._id ? String(txDoc._id) : null,
          conversions: movement.conversions,
        });
      }

      result = {
        ok: true,
        alreadyPaid: false,
        code: null,
        rewardId: reward,
        correlationId: String(correlationId || ""),
        treasuryUserId: treasuryUser,
        treasurySystemType: systemType,
        treasuryCurrency: treasuryCur,
        bonusInputCurrency: inputBonusCurrency,
        treasuryDebitTotal,
        payoutRefBase,
        beneficiaries: credited,
      };

      /* 4. Clôture du registre : le versement devient définitif, et porte la
       *    réponse qui sera rejouée à l'identique en cas de nouvel appel. */
      const completedAt = new Date();

      for (const entry of credited) {
        await ReferralPayout.updateOne(
          {
            idempotencyKey: buildPayoutIdempotencyKey(reward, entry.userId),
          },
          {
            $set: {
              status: "succeeded",
              balanceBefore: entry.balanceBefore,
              balanceAfter: entry.balanceAfter,
              transactionId: entry.transactionId,
              transactionReference: entry.transactionReference,
              responseSnapshot: result,
              completedAt,
            },
          },
          { session }
        );
      }
    });

    logReferral("transferReferralBonus.success", result);
    return result;
  } catch (e) {
    /**
     * E11000 = un autre passage a déjà versé (concurrence, rejeu, reprise de
     * worker). Ce n'est pas une erreur : c'est exactement la garantie qui joue
     * son rôle. On relit le registre et on renvoie la réponse d'origine.
     */
    if (e?.code === 11000) {
      const settled = await ReferralPayout.find({
        idempotencyKey: { $in: keys },
        status: "succeeded",
      }).lean();

      if (settled.length) {
        logReferral("transferReferralBonus.already_paid_on_conflict", {
          rewardId: reward,
          correlationId,
        });

        return buildReplayResponse(settled, { fingerprint });
      }

      /**
       * E11000 sans versement enregistré : c'est l'index unique de
       * `Transaction` qui a mordu — une récompense accordée AVANT ce
       * dispositif. L'argent est déjà parti ; il ne doit pas repartir.
       */
      logger.warn?.(
        "[REFERRAL][TX-CORE][TRANSFER] doublon detecte sur l'historique (versement anterieur au registre)",
        { rewardId: reward, correlationId, payoutRefBase }
      );

      return {
        ok: true,
        alreadyPaid: true,
        code: "ALREADY_PAID_LEGACY",
        rewardId: reward,
        payoutRefBase,
        beneficiaries: [],
      };
    }

    const errorResult = {
      ok: false,
      code: e?.code || "TXCORE_REFERRAL_TRANSFER_FAILED",
      message: e?.message || "Referral transfer failed",
      details: e?.details || null,
      rewardId: reward,
      correlationId: String(correlationId || ""),
    };

    logReferral("transferReferralBonus.error", {
      ...errorResult,
      stack: e?.stack || "",
    });

    return errorResult;
  } finally {
    await session.endSession();
  }
}

module.exports = {
  transferReferralBonus,
  // Exportés pour les tests d'idempotence : ces deux fonctions définissent
  // la garantie « exactement une fois » et doivent être vérifiables isolément.
  buildPayoutIdempotencyKey,
  computeRequestFingerprint,
};