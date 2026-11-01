"use strict";

/**
 * JEUX DE DÉPART DES ACCÈS DE DÉMONSTRATION — MODULE PUR (2026-10-31).
 *
 * Un jeu décrit l'HISTORIQUE AFFICHÉ d'un compte de démonstration. Ce sont des
 * lignes d'historique, pas des opérations : aucun argent ne bouge. Le solde
 * initial, déjà posé par le grand livre au provisionnement, joue le rôle d'un
 * solde d'ouverture ; le passé qu'on affiche ne l'explique pas au franc près et
 * ne prétend pas le faire. Le grand livre reste donc exact, et rejouer le jeu
 * après une réinitialisation ne touche à aucun solde.
 *
 * Ces lignes portent `internalImported: true`, le statut déjà prévu pour une
 * transaction qui n'a pas été exécutée par le moteur, et le contexte
 * `SEED_CONTEXT` : elles sortent des plafonds et ne se confirment, ne s'annulent
 * ni ne se remboursent jamais (statut final).
 *
 * Tout est fictif : les noms le disent, et les frais affichés sont indicatifs.
 */

const SEED_CONTEXT = "sandbox_seed";

const DAY_MS = 24 * 60 * 60 * 1000;

const ACTIVE_HISTORY = Object.freeze([
  { daysAgo: 2, kind: "deposit", rail: "mobilemoney", provider: "wave", amount: 150000, fee: 0 },
  { daysAgo: 3, kind: "transfer_out", amount: 25000, fee: 250 },
  { daysAgo: 5, kind: "withdraw", provider: "orange", amount: 40000, fee: 800 },
  { daysAgo: 8, kind: "transfer_in", amount: 60000, fee: 0 },
  { daysAgo: 11, kind: "deposit", rail: "card", provider: "visa_direct", amount: 100000, fee: 2500 },
  { daysAgo: 14, kind: "transfer_out", amount: 15000, fee: 150 },
  { daysAgo: 19, kind: "withdraw", provider: "mtn", amount: 30000, fee: 600 },
  { daysAgo: 23, kind: "deposit", rail: "mobilemoney", provider: "orange", amount: 75000, fee: 0 },
  { daysAgo: 27, kind: "transfer_in", amount: 35000, fee: 0 },
  { daysAgo: 34, kind: "withdraw", provider: "moov", amount: 20000, fee: 400 },
  { daysAgo: 41, kind: "deposit", rail: "mobilemoney", provider: "wave", amount: 200000, fee: 0 },
  { daysAgo: 48, kind: "transfer_out", amount: 50000, fee: 500 },
]);

const DATASETS = Object.freeze({
  fresh: Object.freeze([]),
  active: ACTIVE_HISTORY,
  cagnottes: ACTIVE_HISTORY.slice(0, 6),
});

const FLOW_OF = Object.freeze({
  deposit: { mobilemoney: "MOBILEMONEY_COLLECTION_TO_PAYNOVAL", card: "CARD_TOPUP_TO_PAYNOVAL" },
  withdraw: "PAYNOVAL_TO_MOBILEMONEY_PAYOUT",
  transfer: "PAYNOVAL_INTERNAL_TRANSFER",
});

function seedError(message) {
  const err = new Error(message);
  err.code = "INVALID_DEMO_DATASET";
  err.status = 400;
  err.statusCode = 400;
  return err;
}

function assertDataset(dataset) {
  if (!Object.prototype.hasOwnProperty.call(DATASETS, dataset)) {
    throw seedError(`Jeu de données inconnu : ${JSON.stringify(dataset)}.`);
  }
  return dataset;
}

/**
 * Les montants du jeu sont en XOF. Une devise forte se divise par 500, et le
 * mobile money n'existe que pour les comptes ivoiriens : ailleurs, la carte.
 */
function localize(entry, currency) {
  if (currency === "XOF") return entry;

  const scale = (v) => Math.round((v / 500) * 100) / 100;
  const amount = scale(entry.amount);
  const fee = scale(entry.fee);

  if (entry.kind === "deposit" || entry.kind === "withdraw") {
    return { ...entry, amount, fee, rail: "card", provider: "visa_direct" };
  }
  return { ...entry, amount, fee };
}

function buildLine(rawEntry, index, ctx) {
  const { userId, counterpartyId, ownerName, counterpartyName, generation, currency, country, now } = ctx;
  const entry = localize(rawEntry, currency);
  const at = new Date(now.getTime() - entry.daysAgo * DAY_MS);

  const base = {
    mode: "sandbox",
    internalImported: true,
    excludedFromUsage: true,
    initiatedBy: "system",
    context: SEED_CONTEXT,
    contextId: `${userId}:${generation}`,
    reference: `SBX-SEED-${String(userId).slice(-8)}-${generation}-${String(index + 1).padStart(2, "0")}`,
    status: "confirmed",
    userId,
    amount: String(entry.amount),
    transactionFees: String(entry.fee),
    netAmount: String(Math.round((entry.amount - entry.fee) * 100) / 100),
    localAmount: String(Math.round((entry.amount - entry.fee) * 100) / 100),
    exchangeRate: "1",
    currency,
    currencySource: currency,
    currencyTarget: currency,
    senderCurrencySymbol: currency,
    localCurrencySymbol: currency,
    country,
    fundsCaptured: true,
    beneficiaryCredited: true,
    confirmedAt: at,
    createdAt: at,
    updatedAt: at,
  };

  if (entry.kind === "deposit") {
    return {
      ...base,
      flow: FLOW_OF.deposit[entry.rail],
      operationType: "DEPOSIT",
      funds: entry.rail === "card" ? "visa_direct" : "mobilemoney",
      destination: "paynoval",
      provider: entry.provider,
      operator: entry.rail === "card" ? null : entry.provider,
      receiver: userId,
      nameDestinataire: ownerName,
      senderName: ownerName,
    };
  }

  if (entry.kind === "withdraw") {
    const card = entry.rail === "card";
    return {
      ...base,
      flow: card ? "PAYNOVAL_TO_CARD_PAYOUT" : FLOW_OF.withdraw,
      operationType: "WITHDRAW",
      funds: "paynoval",
      destination: card ? "visa_direct" : "mobilemoney",
      provider: entry.provider,
      operator: card ? null : entry.provider,
      sender: userId,
      senderName: ownerName,
      nameDestinataire: ownerName,
    };
  }

  const outgoing = entry.kind === "transfer_out";

  return {
    ...base,
    flow: FLOW_OF.transfer,
    operationType: "TRANSFER",
    funds: "paynoval",
    destination: "paynoval",
    sender: outgoing ? userId : counterpartyId,
    receiver: outgoing ? counterpartyId : userId,
    senderName: outgoing ? ownerName : counterpartyName,
    nameDestinataire: outgoing ? counterpartyName : ownerName,
  };
}

/**
 * Les lignes d'une génération. `now` est injecté : la même entrée rend la même
 * sortie, et une réinitialisation recale l'historique sur la date du jour.
 */
function buildSeedTransactions({
  dataset,
  userId,
  counterpartyId,
  ownerName,
  counterpartyName,
  generation,
  currency,
  country = "CI",
  now,
}) {
  assertDataset(dataset);

  if (!userId || !counterpartyId || !ownerName || !counterpartyName || !currency) {
    throw seedError("Jeu de données : compte, contrepartie ou devise manquants.");
  }

  const ctx = { userId, counterpartyId, ownerName, counterpartyName, generation, currency, country, now };
  return DATASETS[dataset].map((entry, index) => buildLine(entry, index, ctx));
}

module.exports = { SEED_CONTEXT, DATASET_NAMES: Object.freeze(Object.keys(DATASETS)), assertDataset, buildSeedTransactions };
