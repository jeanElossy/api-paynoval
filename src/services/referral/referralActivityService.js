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
  "BANK_TRANSFER_TO_PAYNOVAL",
  "PAYNOVAL_TO_BANK_PAYOUT",
  "CARD_TOPUP_TO_PAYNOVAL",
  "PAYNOVAL_TO_CARD_PAYOUT",
]);

/** Statuts considérés comme un succès définitif côté Tx-Core. */
const CONFIRMED_STATUSES = ["confirmed"];

/** Bornes de la fenêtre interrogeable, en jours. */
const MAX_WINDOW_DAYS = 400;

function asObjectId(value) {
  if (!value) return null;
  const raw = String(value);
  if (!mongoose.Types.ObjectId.isValid(raw)) return null;
  return new mongoose.Types.ObjectId(raw);
}

function safeNumber(value) {
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

/**
 * Valide et normalise les paramètres reçus.
 * Lève une erreur portant un `code` exploitable par le contrôleur HTTP.
 */
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

  const excludeTypes = (Array.isArray(input.excludeTypes) ? input.excludeTypes : [])
    .map((t) => String(t || "").trim())
    .filter(Boolean);

  const excludeCounterpartyUserId = asObjectId(input.excludeCounterpartyUserId);

  return { userId, flows, since, until, excludeTypes, excludeCounterpartyUserId };
}

/**
 * Agrège l'activité qualifiante d'un utilisateur.
 *
 * LE CHOIX DE LA DATE. On filtre sur `confirmedAt` et non `createdAt` : ce qui
 * compte est le moment où l'argent est réellement parti, pas celui où
 * l'utilisateur a rempli le formulaire. Une transaction créée avant le
 * parrainage mais confirmée après ne doit pas ouvrir de droit — d'où le repli
 * sur `createdAt` uniquement quand `confirmedAt` est absent, afin qu'aucune
 * transaction ancienne ne se glisse dans la fenêtre par le seul fait d'un champ
 * manquant.
 *
 * LE CHOIX DE L'ACTEUR. `userId` OU `sender` : les deux champs coexistent dans
 * l'historique selon l'ancienneté du document. Interroger un seul des deux
 * ferait manquer des transactions et priverait injustement un filleul de son
 * bonus.
 *
 * @returns {Promise<{count:number, totalsByCurrency:Array, firstAt:Date|null,
 *                    lastAt:Date|null, window:{since:Date,until:Date}}>}
 */
async function getQualifyingActivity(rawInput = {}) {
  const {
    userId,
    flows,
    since,
    until,
    excludeTypes,
    excludeCounterpartyUserId,
  } = normalizeQuery(rawInput);

  const match = {
    status: { $in: CONFIRMED_STATUSES },
    flow: { $in: flows },
    $and: [
      { $or: [{ userId }, { sender: userId }] },
      {
        $or: [
          { confirmedAt: { $gte: since, $lte: until } },
          {
            $and: [
              { confirmedAt: { $in: [null, undefined] } },
              { createdAt: { $gte: since, $lte: until } },
            ],
          },
        ],
      },
    ],
  };

  if (excludeTypes.length) {
    match.type = { $nin: excludeTypes };
  }

  if (excludeCounterpartyUserId) {
    // Le bénéficiaire ne doit pas être la contrepartie exclue (le parrain) :
    // sans cela, l'aller-retour d'une même somme entre parrain et filleul
    // suffit à remplir les conditions.
    match.receiver = { $ne: excludeCounterpartyUserId };
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

  const rows = await Transaction.aggregate(pipeline);

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

  return {
    count,
    totalsByCurrency,
    firstAt: dates.length ? new Date(Math.min(...dates)) : null,
    lastAt: dates.length ? new Date(Math.max(...dates)) : null,
    window: { since, until },
  };
}

module.exports = {
  getQualifyingActivity,
  ALLOWED_FLOWS,
  MAX_WINDOW_DAYS,
};
