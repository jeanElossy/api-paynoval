"use strict";

/**
 * ============================================================================
 * ACTIVITÉ QUALIFIANTE — Tx-Core est TÉMOIN, jamais JUGE
 * ============================================================================
 *
 * Ce service répond à une seule question, factuelle : « qu'a réellement fait
 * cet utilisateur, dans cette fenêtre, sur ces flux ? ». Il ne connaît ni les
 * seuils, ni les montants de bonus, ni la notion d'éligibilité. La décision
 * appartient au backend principal, qui détient le lien de parrainage.
 *
 * Cette séparation n'est pas cosmétique. C'est elle qui rend le zero-trust
 * possible : le principal ne peut pas se faire mentir sur l'activité, puisqu'il
 * l'obtient de la base qui la détient ; et Tx-Core ne peut pas être manipulé
 * pour accorder un bonus, puisqu'il ne sait pas ce qu'est un bonus.
 *
 * DÉFENSE EN PROFONDEUR
 * ---------------------
 * Les paramètres arrivent d'un autre service, donc ils ne sont pas dignes de
 * confiance pour autant. Les flux demandés sont confrontés à une liste blanche,
 * la fenêtre est bornée, et l'identifiant est validé comme ObjectId. Un service
 * interne compromis ne doit pas pouvoir transformer cet endpoint en extracteur
 * de données arbitraire.
 */

const mongoose = require("mongoose");
const { Transaction } = require("../transactions/shared/runtime");

/**
 * Liste blanche des flux interrogeables. Un appelant ne peut pas inventer un
 * flux ni demander l'agrégation de tout le trafic en passant `flow: {$ne:null}`.
 */
const ALLOWED_FLOWS = new Set([
  "PAYNOVAL_INTERNAL_TRANSFER",
  "MOBILEMONEY_COLLECTION_TO_PAYNOVAL",
  "PAYNOVAL_TO_MOBILEMONEY_PAYOUT",
  "CARD_TOPUP_TO_PAYNOVAL",
  "PAYNOVAL_TO_CARD_PAYOUT",
]);

/** Statuts considérés comme un succès définitif côté Tx-Core. */
const CONFIRMED_STATUSES = ["confirmed"];

/** Borne de sécurité : une fenêtre ne peut pas dépasser ~13 mois. */
const MAX_WINDOW_DAYS = 400;

/**
 * Nombre maximal de transactions RENDUES en détail. Au-delà, la liste est
 * tronquée et la réponse le DIT (`transactionsTruncated`) — un juge qui ne
 * verrait qu'une partie des faits sans le savoir jugerait faux. Les agrégats,
 * eux, portent toujours sur la totalité.
 */
const MAX_DETAILED_TRANSACTIONS = 200;

/** Nombre maximal de contreparties à exclure qu'un appelant peut fournir. */
const MAX_EXCLUDED_COUNTERPARTIES = 1000;

/**
 * Types et contextes qui ne sont JAMAIS une activité, quoi que demande
 * l'appelant : un bonus, ou sa reprise, ne peut pas ouvrir droit à un bonus.
 * Posé ici en dur — en plus de `excludeTypes` fourni par le principal — parce
 * qu'une garantie de ce genre ne dépend pas du bon paramétrage d'un autre
 * service.
 */
const ALWAYS_EXCLUDED_TYPES = Object.freeze([
  "referral_bonus",
  "referral_bonus_reversal",
]);
const ALWAYS_EXCLUDED_CONTEXTS = Object.freeze(["referral_bonus"]);

function asObjectId(value) {
  if (!value) return null;
  const raw = String(value);
  if (!mongoose.Types.ObjectId.isValid(raw)) return null;
  return new mongoose.Types.ObjectId(raw);
}

function safeNumber(value) {
  if (value && typeof value === "object" && typeof value.toString === "function") {
    const n = Number(value.toString());
    return Number.isFinite(n) ? n : 0;
  }
  const n =
    typeof value === "number"
      ? value
      : parseFloat(String(value ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

function normalizeCurrency(value, fallback = "XOF") {
  const code = String(value || fallback)
    .trim()
    .toUpperCase();
  return code || fallback;
}

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function normalizeQuery(input = {}) {
  const userId = asObjectId(input.userId);

  if (!userId) {
    throw Object.assign(new Error("USER_ID_INVALID"), {
      code: "USER_ID_INVALID",
      status: 400,
    });
  }

  const requestedFlows = Array.isArray(input.flows) ? input.flows : [];
  const flows = requestedFlows
    .map((f) => String(f || "").trim())
    .filter((f) => ALLOWED_FLOWS.has(f));

  if (!flows.length) {
    throw Object.assign(new Error("FLOWS_REQUIRED"), {
      code: "FLOWS_REQUIRED",
      status: 400,
    });
  }

  const since = parseDate(input.since);
  const until = parseDate(input.until) || new Date();

  if (!since) {
    throw Object.assign(new Error("SINCE_REQUIRED"), {
      code: "SINCE_REQUIRED",
      status: 400,
    });
  }

  if (since > until) {
    throw Object.assign(new Error("WINDOW_INVALID"), {
      code: "WINDOW_INVALID",
      status: 400,
    });
  }

  const windowDays = (until - since) / (24 * 60 * 60 * 1000);

  if (windowDays > MAX_WINDOW_DAYS) {
    throw Object.assign(new Error("WINDOW_TOO_LARGE"), {
      code: "WINDOW_TOO_LARGE",
      status: 400,
    });
  }

  const excludeTypes = [
    ...new Set([
      ...ALWAYS_EXCLUDED_TYPES,
      ...(Array.isArray(input.excludeTypes) ? input.excludeTypes : [])
        .map((t) => String(t || "").trim())
        .filter(Boolean),
    ]),
  ];

  const rawCounterparties = [
    input.excludeCounterpartyUserId,
    ...(Array.isArray(input.excludeCounterpartyUserIds)
      ? input.excludeCounterpartyUserIds
      : []),
  ].filter(Boolean);

  if (rawCounterparties.length > MAX_EXCLUDED_COUNTERPARTIES) {
    throw Object.assign(new Error("TOO_MANY_EXCLUDED_COUNTERPARTIES"), {
      code: "TOO_MANY_EXCLUDED_COUNTERPARTIES",
      status: 400,
    });
  }

  const excludeCounterparties = rawCounterparties
    .map(asObjectId)
    .filter(Boolean);

  return { userId, flows, since, until, excludeTypes, excludeCounterparties };
}

/** Filtre temporel commun : date de confirmation, à défaut date de création. */
function windowClause(since, until) {
  return {
    $or: [
      { confirmedAt: { $gte: since, $lte: until } },
      {
        $and: [
          { confirmedAt: { $in: [null, undefined] } },
          { createdAt: { $gte: since, $lte: until } },
        ],
      },
    ],
  };
}

/**
 * Faits d'activité d'un utilisateur sur une fenêtre.
 *
 * Rend, SANS JAMAIS JUGER :
 *   - `count`, `totalsByCurrency`         agrégats sur la totalité ;
 *   - `transactions`                      le détail, dans l'ordre chronologique
 *                                         (borné, et la troncature est dite) ;
 *   - `inboundCounterparties`             les comptes qui ont ENVOYÉ de l'argent
 *                                         à cet utilisateur par virement interne
 *                                         sur la même fenêtre.
 *
 * Le dernier point sert au principal à neutraliser la « circulation » : envoyer
 * 30 000 à un complice qui les renvoie, deux fois, remplit les conditions sans
 * qu'un franc n'ait quitté le duo. Tx-Core ne dit pas « c'est une fraude » — il
 * dit qui a envoyé quoi. Le juge décide.
 */
async function getQualifyingActivity(rawInput = {}) {
  const {
    userId,
    flows,
    since,
    until,
    excludeTypes,
    excludeCounterparties,
  } = normalizeQuery(rawInput);

  const match = {
    status: { $in: CONFIRMED_STATUSES },
    flow: { $in: flows },
    type: { $nin: excludeTypes },
    context: { $nin: ALWAYS_EXCLUDED_CONTEXTS },
    $and: [{ $or: [{ userId }, { sender: userId }] }, windowClause(since, until)],
  };

  if (excludeCounterparties.length) {
    // Le bénéficiaire ne doit pas être une contrepartie exclue (le parrain et
    // son réseau) : sans cela, l'aller-retour d'une même somme suffit.
    match.receiver = { $nin: excludeCounterparties };
  }

  const pipeline = [
    { $match: match },
    {
      $group: {
        _id: { $toUpper: { $ifNull: ["$currency", "XOF"] } },
        count: { $sum: 1 },
        total: { $sum: { $ifNull: ["$amount", 0] } },
        largest: { $max: { $ifNull: ["$amount", 0] } },
        firstAt: { $min: { $ifNull: ["$confirmedAt", "$createdAt"] } },
        lastAt: { $max: { $ifNull: ["$confirmedAt", "$createdAt"] } },
      },
    },
    { $sort: { total: -1 } },
  ];

  const [rows, detailed, inbound] = await Promise.all([
    Transaction.aggregate(pipeline),
    Transaction.find(match)
      .select("_id reference flow amount currency receiver confirmedAt createdAt")
      .sort({ confirmedAt: 1, createdAt: 1, _id: 1 })
      .limit(MAX_DETAILED_TRANSACTIONS + 1)
      .lean(),
    Transaction.distinct("sender", {
      status: { $in: CONFIRMED_STATUSES },
      flow: "PAYNOVAL_INTERNAL_TRANSFER",
      receiver: userId,
      sender: { $ne: userId },
      type: { $nin: ALWAYS_EXCLUDED_TYPES },
      context: { $nin: ALWAYS_EXCLUDED_CONTEXTS },
      ...windowClause(since, until),
    }),
  ]);

  const totalsByCurrency = rows.map((row) => ({
    currency: normalizeCurrency(row._id),
    count: safeNumber(row.count),
    total: safeNumber(row.total),
    largest: safeNumber(row.largest),
  }));

  const count = totalsByCurrency.reduce((acc, row) => acc + row.count, 0);

  const dates = rows
    .flatMap((row) => [row.firstAt, row.lastAt])
    .filter(Boolean)
    .map((d) => new Date(d).getTime())
    .filter((t) => Number.isFinite(t));

  const truncated = detailed.length > MAX_DETAILED_TRANSACTIONS;

  const transactions = detailed.slice(0, MAX_DETAILED_TRANSACTIONS).map((tx) => ({
    id: String(tx._id),
    reference: String(tx.reference || ""),
    flow: String(tx.flow || ""),
    amount: safeNumber(tx.amount),
    currency: normalizeCurrency(tx.currency),
    receiverId: tx.receiver ? String(tx.receiver) : null,
    confirmedAt: tx.confirmedAt || tx.createdAt || null,
  }));

  return {
    count,
    totalsByCurrency,
    transactions,
    transactionsTruncated: truncated,
    inboundCounterparties: (inbound || []).filter(Boolean).map(String),
    firstAt: dates.length ? new Date(Math.min(...dates)) : null,
    lastAt: dates.length ? new Date(Math.max(...dates)) : null,
    window: { since, until },
  };
}

/**
 * Statut ACTUEL d'un lot de transactions — lecture seule, bornée.
 *
 * Filet de la reprise de bonus : l'événement `referral.activity.reversed.v1`
 * peut finir en lettre morte. Le principal relit donc périodiquement le statut
 * des transactions qui ont ouvert un bonus ; une transaction qui n'est plus
 * `confirmed` doit déclencher une réévaluation. Seuls l'identifiant et le
 * statut sortent — aucun montant, aucune contrepartie.
 */
async function getTransactionStatuses({ txIds = [] } = {}) {
  const ids = [...new Set((Array.isArray(txIds) ? txIds : []).map(String))]
    .filter((id) => mongoose.Types.ObjectId.isValid(id))
    .slice(0, 1000);

  if (!ids.length) return { statuses: [] };

  const rows = await Transaction.find({ _id: { $in: ids.map((id) => new mongoose.Types.ObjectId(id)) } })
    .select("_id status refundedAt")
    .lean();

  const found = new Map(rows.map((r) => [String(r._id), r]));

  return {
    statuses: ids.map((id) => ({
      id,
      status: found.get(id)?.status || "not_found",
      refundedAt: found.get(id)?.refundedAt || null,
    })),
  };
}

module.exports = {
  getQualifyingActivity,
  getTransactionStatuses,
  normalizeQuery,
  ALLOWED_FLOWS,
  ALWAYS_EXCLUDED_TYPES,
  MAX_WINDOW_DAYS,
  MAX_DETAILED_TRANSACTIONS,
  MAX_EXCLUDED_COUNTERPARTIES,
};
