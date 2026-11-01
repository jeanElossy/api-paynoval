"use strict";

/**
 * ============================================================================
 * PLAFONDS — CE QUI A DÉJÀ ÉTÉ UTILISÉ (2026-10-17)
 * ============================================================================
 *
 * Ce que comptent Wise, Revolut et PayPal, et ce que compte désormais PayNoval :
 *
 *   - les opérations LANCÉES PAR LE COMPTE (`Transaction.userId` : l'expéditeur
 *     d'un envoi, le titulaire d'un dépôt) — jamais l'argent REÇU d'un tiers ;
 *   - de la MÊME opération (dépôt, retrait, transfert), du MÊME rail, dans la
 *     MÊME devise source ;
 *   - qui engagent de l'argent : en attente, en traitement, en revue, bloquées
 *     ou confirmées. Une opération échouée, annulée ou remboursée ne compte
 *     plus — son argent est revenu ;
 *   - sur 24 h et 30 jours GLISSANTS.
 *
 * Le cumul précédent (`services/aml.js:getUserTransactionsStats`) comptait
 * l'argent reçu (`receiver`), les opérations échouées et annulées, mélangeait
 * dépôts, retraits et transferts d'un même rail et interrogeait une dizaine de
 * champs en `$or` sans index. Il reste utilisé pour les signaux de vélocité ;
 * le PLAFOND, lui, se lit ici.
 *
 * Une opération dont le type n'est pas enregistré (antérieure au champ
 * `operationType`) et qui sort vers mobile money ou carte peut être un retrait
 * OU un transfert : elle compte dans les DEUX. Surcompter bloque un peu tôt ;
 * sous-compter laisserait passer au-delà du plafond. Elles sortent de la
 * fenêtre de 30 jours d'elles-mêmes.
 *
 * Fonctions pures + un chargeur qui ne fait qu'UNE requête indexée
 * (`{ userId: 1, createdAt: -1 }`). Aucune erreur avalée : un cumul illisible
 * remonte, et l'appelant refuse (règle B.2).
 */

const { WINDOWS, catalogOperation, catalogRail } = require("./limitCatalog");

/** Statuts dont l'argent est revenu, ou n'est jamais parti. */
const RELEASED_STATUSES = Object.freeze(["failed", "cancelled", "canceled", "refunded", "reversed", "rejected", "expired"]);

const isCounted = (status) => !RELEASED_STATUSES.includes(String(status || "").trim().toLowerCase());

/** Rail d'une transaction, depuis son flow Tx-Core. */
function railOfTransaction(tx = {}) {
  const flow = String(tx.flow || "").toUpperCase();
  if (flow.includes("MOBILEMONEY")) return "mobilemoney";
  if (flow.includes("CARD")) return "card";
  if (flow === "PAYNOVAL_INTERNAL_TRANSFER") return "paynoval";
  return null;
}

/**
 * Opération(s) dans lesquelles une transaction compte. Le type enregistré fait
 * foi ; à défaut, le flow — et un envoi externe ancien compte des deux côtés.
 */
function operationsOfTransaction(tx = {}) {
  const declared = catalogOperation(tx.operationType);
  if (declared) return [declared];

  const flow = String(tx.flow || "").toUpperCase();
  if (flow.endsWith("_TO_PAYNOVAL")) return ["DEPOSIT"];
  if (flow === "PAYNOVAL_INTERNAL_TRANSFER") return ["TRANSFER"];
  if (flow.startsWith("PAYNOVAL_TO_")) return ["WITHDRAW", "TRANSFER"];
  return [];
}

const toNumber = (value) => {
  if (value === null || value === undefined) return NaN;
  const raw = typeof value === "object" && typeof value.toString === "function" ? value.toString() : value;
  return Number(raw);
};

/** Montant engagé, dans la devise SOURCE ; illisible ⇒ erreur (règle B.2). */
function sourceAmountOf(tx = {}) {
  const amount = toNumber(tx.amountSource ?? tx.amount ?? tx.money?.source?.amount);
  if (!Number.isFinite(amount) || amount < 0) {
    const err = new Error(`Montant illisible sur la transaction ${tx._id || tx.reference || "?"}`);
    err.code = "LIMIT_USAGE_UNREADABLE";
    throw err;
  }
  return amount;
}

const sourceCurrencyOf = (tx = {}) =>
  String(tx.currencySource || tx.senderCurrencySymbol || tx.money?.source?.currency || "").trim().toUpperCase();

/**
 * Cumul pur. `rows` : transactions (et participations de cagnotte normalisées
 * en `{ operationType: "TRANSFER", flow: "PAYNOVAL_INTERNAL_TRANSFER", … }`).
 */
function computeUsage(rows, { operation, rail, currency, now = Date.now() }) {
  const op = catalogOperation(operation);
  const r = catalogRail(rail);
  const iso = String(currency || "").trim().toUpperCase();
  const since24h = now - WINDOWS.rolling24h;
  const since30d = now - WINDOWS.rolling30d;

  let used24h = 0;
  let used30d = 0;
  let oldest24h = null;
  let oldest30d = null;

  for (const tx of rows || []) {
    if (!isCounted(tx.status)) continue;
    if (railOfTransaction(tx) !== r) continue;
    if (!operationsOfTransaction(tx).includes(op)) continue;
    if (sourceCurrencyOf(tx) !== iso) continue;

    const at = new Date(tx.createdAt).getTime();
    if (!Number.isFinite(at) || at < since30d) continue;

    const amount = sourceAmountOf(tx);
    used30d += amount;
    if (oldest30d === null || at < oldest30d) oldest30d = at;

    if (at >= since24h) {
      used24h += amount;
      if (oldest24h === null || at < oldest24h) oldest24h = at;
    }
  }

  const round2 = (n) => Math.round(n * 100) / 100;
  return {
    used24h: round2(used24h),
    used30d: round2(used30d),
    oldest24hAt: oldest24h === null ? null : new Date(oldest24h).toISOString(),
    oldest30dAt: oldest30d === null ? null : new Date(oldest30d).toISOString(),
  };
}

const USAGE_FIELDS = "flow operationType status amountSource amount money.source currencySource senderCurrencySymbol createdAt reference";

/** Participation de cagnotte → ligne de transfert PayNoval (débit du participant). */
const cagnotteRow = (s) => ({
  flow: "PAYNOVAL_INTERNAL_TRANSFER",
  operationType: "TRANSFER",
  status: s.status,
  amountSource: s.source?.amount,
  currencySource: s.source?.currency,
  createdAt: s.createdAt,
  reference: s._id,
});

/**
 * Les opérations du compte sur 30 jours. UNE requête indexée sur
 * `{ userId, createdAt }` ; les participations de cagnotte (qui débitent le
 * solde sans être des `transactions`) en plus.
 */
async function loadUsageRows({ userId, now = Date.now(), Transaction, CagnotteSettlement = null }) {
  const since = new Date(now - WINDOWS.rolling30d);
  // L'historique de départ d'un compte de démonstration n'a engagé aucun argent.
  const rows = await Transaction.find({ userId, createdAt: { $gte: since }, excludedFromUsage: { $ne: true } })
    .select(USAGE_FIELDS)
    .lean();

  if (!CagnotteSettlement) return rows;

  const participations = await CagnotteSettlement.find({
    userId: String(userId),
    status: "confirmed",
    schemaVersion: { $gte: 2 },
    createdAt: { $gte: since },
  })
    .select("status source createdAt")
    .lean();

  return rows.concat(participations.map(cagnotteRow));
}

module.exports = {
  RELEASED_STATUSES,
  isCounted,
  railOfTransaction,
  operationsOfTransaction,
  sourceAmountOf,
  computeUsage,
  loadUsageRows,
};
