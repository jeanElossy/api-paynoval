// File: services/aml.js
"use strict";

const AMLLog = require("../models/AMLLog");

const { getSingleTxLimit } = require("../tools/amlLimits");
const { getCurrencySymbolByCode } = require("../tools/currency");

/* -------------------------------------------------------------------------- */
/* Model helpers                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Modèle `Transaction` de la base TRANSACTIONS, résolu au premier usage.
 *
 * ⚠️ Défaut fermé le 2026-09-17. `models/Transaction.js` exporte une FABRIQUE
 * `(conn) => model`. L'ancien résolveur cherchait `countDocuments` / `find` /
 * `aggregate` sur l'export, puis sur `.Transaction`, `.default`… : il ne
 * trouvait jamais rien et levait `TRANSACTION_MODEL_UNAVAILABLE` à CHAQUE appel.
 *
 * Tant que le cumul retombait à 0 (jusqu'au 2026-09-15), le plafond journalier
 * n'a donc JAMAIS été vérifié ; depuis l'échec en fermeture, toute opération
 * passant par `middleware/aml.js` répondait `503 AML_STATS_UNAVAILABLE`
 * (participation de cagnotte, transferts). Même motif que
 * `resolveCagnotteSettlementModel` ci-dessous.
 */
function resolveTransactionModel() {
  const { getTxConn } = require("../config/db");
  const conn = getTxConn();
  return conn.models.Transaction || require("../models/Transaction")(conn);
}

async function safeCountDocuments(Model, query) {
  return Model.countDocuments(query);
}

async function safeFind(Model, query, select = "") {
  let q = Model.find(query);

  if (select) q = q.select(select);

  const out = await q.lean();
  return Array.isArray(out) ? out : [];
}

/* -------------------------------------------------------------------------- */
/* Currency helpers                                                           */
/* -------------------------------------------------------------------------- */

function normalizeIso(v) {
  const s = String(v || "").trim().toUpperCase();

  if (!s) return "";

  if (s === "FCFA" || s === "CFA" || s === "F CFA" || s.includes("CFA")) {
    return "XOF";
  }

  if (s === "€" || s.includes("EUR")) return "EUR";
  if (s === "$" || s === "$USD" || s.includes("USD")) return "USD";
  if (s === "$CAD" || s.includes("CAD")) return "CAD";
  if (s.includes("GBP") || s.includes("£")) return "GBP";
  if (s.includes("XOF")) return "XOF";
  if (s.includes("XAF")) return "XAF";

  const letters = s.replace(/[^A-Z]/g, "");

  if (/^[A-Z]{3}$/.test(letters)) return letters;
  if (/^[A-Z]{3}$/.test(s)) return s;

  return "";
}

function safeNumber(v) {
  if (v == null) return 0;

  if (typeof v === "number") {
    return Number.isFinite(v) ? v : 0;
  }

  if (
    typeof v?.toString === "function" &&
    v?.toString !== Object.prototype.toString
  ) {
    const n = parseFloat(
      String(v.toString()).replace(/\s/g, "").replace(",", ".")
    );

    return Number.isFinite(n) ? n : 0;
  }

  const n = parseFloat(String(v).replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

/* -------------------------------------------------------------------------- */
/* AML log                                                                    */
/* -------------------------------------------------------------------------- */

async function logTransaction({
  userId,
  type,
  provider,
  amount,
  currency = null,
  toEmail,
  details,
  flagged = false,
  flagReason = "",
  transactionId = null,
  ip = null,
}) {
  try {
    await AMLLog.create({
      userId: userId || null,
      type: type || "initiate",
      provider: provider || "unknown",
      amount: safeNumber(amount),
      currency: currency ? normalizeIso(currency) || String(currency) : null,
      toEmail: toEmail || "",
      details: details || {},
      flagged: !!flagged,
      flagReason: flagReason || "",
      reviewed: false,
      transactionId,
      ip,
      loggedAt: new Date(),
    });
  } catch (e) {
    /**
     * ON N'AVALE PLUS EN SILENCE — mais on ne LÈVE PAS non plus.
     * ========================================================================
     *
     * Le `catch` d'origine ne faisait qu'un `console.error`. Conséquence non
     * évidente, trouvée le 2026-09-03 : la promesse ne rejetait JAMAIS, donc le
     * `.catch()` structuré posé la veille sur `initiateInternal.js` — celui qui
     * devait rendre visible un échec du journal d'audit avec `transactionId` et
     * `reference` — ne pouvait pas se déclencher. **Un correctif inerte est
     * pire qu'un correctif absent : on le croit en place.**
     *
     * Pourquoi on ne lève pas pour autant : `middleware/aml.js` appelle cette
     * fonction avec `await`, sur le chemin de la requête, AVANT le mouvement
     * d'argent. Lever y transformerait un échec d'écriture de journal en échec
     * de paiement. Or le banc du 2026-09-03 a montré que ces écritures peuvent
     * échouer pour une raison bénigne — « AMLLog validation failed: type:
     * `auto_cancel` is not a valid enum value ». Une ligne de journal mal typée
     * n'a pas à refuser un virement.
     *
     * On rend donc un RÉSULTAT. L'appelant sait, et décide selon sa position :
     * avant le mouvement il peut refuser, après il ne peut que signaler.
     */
    console.error("[AML-LOG] Failed to record log", e?.message || e);

    return { ok: false, error: e?.message || String(e) };
  }

  return { ok: true };
}

/* -------------------------------------------------------------------------- */
/* Query builders                                                             */
/* -------------------------------------------------------------------------- */

function buildCurrencyOrMatch(currencyISO) {
  const iso = normalizeIso(currencyISO);
  if (!iso) return {};

  const symbol = getCurrencySymbolByCode(iso);
  const compat = new Set([iso, symbol]);

  if (iso === "USD") {
    compat.add("$");
    compat.add("$USD");
    compat.add("USD$");
    compat.add("US$");
  }

  if (iso === "CAD") {
    compat.add("$CAD");
    compat.add("CAD$");
  }

  if (iso === "EUR") {
    compat.add("€");
  }

  if (iso === "XOF" || iso === "XAF") {
    compat.add("F CFA");
    compat.add("FCFA");
    compat.add("CFA");
  }

  const values = Array.from(compat).filter(Boolean);

  return {
    $or: [
      { currencySource: { $in: values } },
      { currencyTarget: { $in: values } },
      { currency: { $in: values } },
      { currencyCode: { $in: values } },
      { senderCurrencyCode: { $in: values } },
      { senderCurrencySymbol: { $in: values } },
      { localCurrencyCode: { $in: values } },
      { localCurrencySymbol: { $in: values } },
      { "money.source.currency": { $in: values } },
      { "money.target.currency": { $in: values } },
      { "money.feeSource.currency": { $in: values } },
    ],
  };
}

function normalizeProvider(provider) {
  const p = String(provider || "").trim().toLowerCase();

  if (!p) return "";

  if (p === "mobile_money") return "mobilemoney";
  if (p === "visa") return "visa_direct";

  return p;
}

function buildProviderOrMatch(provider) {
  const p = normalizeProvider(provider);

  if (!p) return {};

  const aliases = new Set([p]);

  if (p === "paynoval") {
    aliases.add("internal");
  }

  if (p === "mobilemoney") {
    aliases.add("mobile_money");
    aliases.add("wave");
    aliases.add("orange");
    aliases.add("mtn");
    aliases.add("moov");
    aliases.add("flutterwave");
  }

  /**
   * Rail carte. « stripe » reste dans les ALIAS DE LECTURE, et seulement là :
   * les transactions historiques portent encore ce prestataire, et les exclure
   * fausserait les cumuls AML — un utilisateur repartirait à zéro de compteur
   * journalier le jour du changement de rail. C'est une requête d'historique,
   * pas une autorisation de router.
   */
  if (p === "stripe" || p === "visa_direct" || p === "card") {
    aliases.add("visa_direct");
    aliases.add("visa");
    aliases.add("card");
    aliases.add("stripe"); // historique uniquement — plus aucun rail actif
  }

  const values = Array.from(aliases);

  return {
    $or: [
      { provider: { $in: values } },
      { funds: { $in: values } },
      { destination: { $in: values } },
      { operator: { $in: values } },
      { "metadata.provider": { $in: values } },
      { "meta.provider": { $in: values } },
      { "metadata.rail": { $in: values } },
      { "meta.rail": { $in: values } },
    ],
  };
}

function buildUserOrMatch(userId) {
  const uid = String(userId || "").trim();

  return {
    $or: [
      { userId: uid },
      { sender: uid },
      { receiver: uid },
      { createdBy: uid },
      { ownerUserId: uid },
      { initiatorUserId: uid },
      { "meta.userId": uid },
      { "metadata.userId": uid },
      { "meta.ownerUserId": uid },
      { "metadata.ownerUserId": uid },
    ],
  };
}

function mergeAndQueries(...parts) {
  const cleanParts = parts.filter(
    (part) => part && typeof part === "object" && Object.keys(part).length > 0
  );

  if (!cleanParts.length) return {};
  if (cleanParts.length === 1) return cleanParts[0];

  return {
    $and: cleanParts,
  };
}

function buildAmountExpression() {
  return {
    $convert: {
      input: {
        $ifNull: [
          "$amountSource",
          {
            $ifNull: [
              "$amount",
              {
                $ifNull: ["$money.source.amount", 0],
              },
            ],
          },
        ],
      },
      to: "double",
      onError: 0,
      onNull: 0,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* AML stats                                                                  */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/* Participations de cagnotte (2026-09-15)                                    */
/* -------------------------------------------------------------------------- */

/**
 * Une participation de cagnotte débite le solde PayNoval du participant, mais
 * elle vit dans `tx_cagnotte_settlements`, pas dans `transactions` : elle
 * échappait au cumul journalier. Vingt participations juste sous le plafond
 * par envoi passaient donc toutes, là où vingt transferts auraient été
 * arrêtés au plafond journalier.
 *
 * Elles comptent désormais, dans la devise SOURCE (celle du participant, que
 * le plafond vise) et seulement sur le rail PayNoval : une participation ne
 * passe par aucun autre.
 */
function appliesToCagnotteParticipations(provider) {
  const p = normalizeProvider(provider);
  return !p || p === "paynoval";
}

function cagnotteParticipationMatch({ userId, currency, since }) {
  const match = {
    userId: String(userId),
    status: "confirmed",
    schemaVersion: { $gte: 2 },
    createdAt: { $gte: since },
  };

  if (currency) match["source.currency"] = currency;
  return match;
}

function resolveCagnotteSettlementModel() {
  const { getTxConn } = require("../config/db");
  const conn = getTxConn();
  return conn.models.CagnotteSettlement || require("../models/CagnotteSettlement")(conn);
}

/**
 * Cumul 24 h et nombre sur la dernière heure. N'avale AUCUNE erreur : une
 * lecture impossible remonte à l'appelant, qui applique la politique déjà
 * nommée pour les statistiques indisponibles (voir `middleware/aml.js`) —
 * pas un second repli à zéro, silencieux celui-là.
 */
async function getCagnotteParticipationStats({ userId, currency, provider, since24h, since1h, Model = null }) {
  if (!userId || !appliesToCagnotteParticipations(provider)) {
    return { dailyTotal: 0, lastHour: 0 };
  }

  const M = Model || resolveCagnotteSettlementModel();
  const rows = await M.aggregate([
    { $match: cagnotteParticipationMatch({ userId, currency, since: since24h }) },
    {
      $group: {
        _id: null,
        total: { $sum: "$source.amount" },
        lastHour: { $sum: { $cond: [{ $gte: ["$createdAt", since1h] }, 1, 0] } },
      },
    },
  ]);

  const row = Array.isArray(rows) && rows.length ? rows[0] : null;
  return { dailyTotal: safeNumber(row?.total), lastHour: Number(row?.lastHour || 0) };
}

async function getUserTransactionsStats(userId, provider, currencyISO = null, { Model = null, CagnotteModel = null } = {}) {
  const uid = String(userId || "").trim();

  if (!uid) {
    return {
      lastHour: 0,
      dailyTotal: 0,
      sameDestShortTime: 0,
    };
  }

  const Transaction = Model || resolveTransactionModel();

  const currency = normalizeIso(currencyISO);
  const currencyMatch = currency ? buildCurrencyOrMatch(currency) : {};
  const providerMatch = buildProviderOrMatch(provider);
  const userMatch = buildUserOrMatch(uid);

  const now = Date.now();
  const lastHourDate = new Date(now - 60 * 60 * 1000);
  const last24hDate = new Date(now - 24 * 60 * 60 * 1000);
  const last10minDate = new Date(now - 10 * 60 * 1000);

  const lastHourQuery = mergeAndQueries(userMatch, providerMatch, currencyMatch, {
    createdAt: { $gte: lastHourDate },
  });

  const dailyQuery = mergeAndQueries(userMatch, providerMatch, currencyMatch, {
    createdAt: { $gte: last24hDate },
  });

  const recentQuery = mergeAndQueries(userMatch, providerMatch, currencyMatch, {
    createdAt: { $gte: last10minDate },
  });

  const lastHour = await safeCountDocuments(Transaction, lastHourQuery);

  /**
   * Aucune erreur avalée (règle B.2) : l'ancien code retombait à 0 si
   * l'agrégation levait, puis encore à 0 si la relecture levait — un cumul
   * illisible devenait « rien dépensé aujourd'hui ». L'erreur remonte au
   * middleware, qui refuse en `503 AML_STATS_UNAVAILABLE`.
   */
  const dailyTotalAgg = await Transaction.aggregate([
    { $match: dailyQuery },
    {
      $group: {
        _id: null,
        total: {
          $sum: buildAmountExpression(),
        },
      },
    },
  ]);

  const dailyTotal =
    Array.isArray(dailyTotalAgg) && dailyTotalAgg.length
      ? safeNumber(dailyTotalAgg[0].total)
      : 0;

  const recentTx = await safeFind(
    Transaction,
    recentQuery,
    "recipientEmail toEmail toIBAN iban toPhone phoneNumber recipientInfo"
  );

  const destCount = {};

  for (const tx of recentTx) {
    const key =
      tx.recipientEmail ||
      tx.toEmail ||
      tx.recipientInfo?.email ||
      tx.recipientInfo?.recipientEmail ||
      tx.toIBAN ||
      tx.iban ||
      tx.toPhone ||
      tx.phoneNumber ||
      tx.recipientInfo?.phone ||
      "none";

    destCount[key] = (destCount[key] || 0) + 1;
  }

  const sameDestShortTime = Object.keys(destCount).length
    ? Math.max(...Object.values(destCount))
    : 0;

  const cagnotte = await getCagnotteParticipationStats({
    userId: uid,
    currency,
    provider,
    since24h: last24hDate,
    since1h: lastHourDate,
    Model: CagnotteModel,
  });

  return {
    lastHour: Number(lastHour || 0) + cagnotte.lastHour,
    dailyTotal: safeNumber(dailyTotal) + cagnotte.dailyTotal,
    sameDestShortTime: Number(sameDestShortTime || 0),
    cagnotteDailyTotal: cagnotte.dailyTotal,
  };
}

/* -------------------------------------------------------------------------- */
/* PEP / Sanctions placeholder                                                */
/* -------------------------------------------------------------------------- */

async function getPEPOrSanctionedStatus(user, { toEmail }) {
  if (
    user?.email === "ministere@etat.gov" ||
    (toEmail && String(toEmail).endsWith("@etat.gov"))
  ) {
    return {
      sanctioned: true,
      reason: "Utilisateur/personne politiquement exposée (PEP)",
    };
  }

  return {
    sanctioned: false,
  };
}

/* -------------------------------------------------------------------------- */
/* `getMLScore` A ÉTÉ RETIRÉ — C'ÉTAIT UN GÉNÉRATEUR ALÉATOIRE                */
/* -------------------------------------------------------------------------- */

/**
 * Cette fonction renvoyait `Math.random() * 0.4`, ou `0.92` si le montant
 * dépassait la limite unitaire. Ce n'était pas une approximation en attendant
 * mieux : c'était un tirage au sort portant un nom qui laissait croire à un
 * modèle. Trois conséquences, et la troisième est la pire :
 *
 *   1. la même transaction notée deux fois donnait deux scores différents,
 *      donc rien n'était testable ;
 *   2. le seuil de blocage valait 0.9 et le tirage plafonnait à 0.4 : la
 *      branche « aléatoire » ne bloquait JAMAIS. Le seul signal réel était le
 *      dépassement de limite, codé en dur ;
 *   3. lors d'un litige ou d'un contrôle, **le score d'une transaction passée
 *      était irreproductible**. Ni explicable au client, ni justifiable devant
 *      un régulateur, ni compréhensible après coup.
 *
 * Le remplacement est `services/risk/riskScore.js` : déterministe, sans
 * horloge ni hasard, et chaque point de score nomme son motif. Il est appelé
 * par `middleware/aml.js`.
 *
 * ⚠️ NE PAS LE RÉINTRODUIRE, sous quelque nom que ce soit. Un score de risque
 * non reproductible est pire que pas de score du tout : il donne l'apparence
 * d'un contrôle.
 */

async function getBusinessKYBStatus() {
  return "validé";
}

module.exports = {
  logTransaction,
  getUserTransactionsStats,
  resolveTransactionModel,
  getPEPOrSanctionedStatus,
  getBusinessKYBStatus,

  normalizeIso,
  safeNumber,
  buildCurrencyOrMatch,

  appliesToCagnotteParticipations,
  cagnotteParticipationMatch,
  getCagnotteParticipationStats,
};