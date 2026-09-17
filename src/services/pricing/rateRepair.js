"use strict";

/**
 * ============================================================================
 * RATTRAPAGE DU TAUX INSCRIT SUR LES TRANSACTIONS — DÉCISION PURE
 * ============================================================================
 *
 * Jusqu'au 2026-09-16, `exchangeRate` et `fxRateSourceToTarget` étaient écrits
 * par `dec2`, l'helper des montants : tout taux inférieur à 0,005 devenait
 * « 0.00 » (voir `utils/money.formatRate`). Les transactions déjà écrites
 * portent donc un taux faux dans ces deux champs.
 *
 * ── Ce que ce module décide, et ce qu'il refuse de décider ──────────────────
 *
 * Le taux exact n'est pas perdu : il vit à deux autres endroits de la MÊME
 * transaction, écrits au même instant — `money.fxRateSourceToTarget` (nombre)
 * et `pricingSnapshot.result.appliedRate` (le devis). Le rattrapage RECOPIE,
 * il ne recalcule rien et n'interroge aucun fournisseur de change : un taux de
 * marché d'aujourd'hui n'est pas le taux d'hier.
 *
 * Avant de recopier, deux contrôles, et un doute ARRÊTE la réparation (on
 * signale, on n'écrit pas) :
 *
 *   1. les deux sources exactes doivent concorder ;
 *   2. le taux doit expliquer les montants : `net envoyé × taux ≈ montant reçu`
 *      à l'arrondi de la devise cible près. Un taux qui ne raconte pas la même
 *      histoire que les montants n'est pas une source, c'est une autre faute.
 *
 * Module PUR : ni base, ni réseau. Le script `backfillTransactionRates.js`
 * l'applique.
 */

const {
  decimalsForCurrency,
  formatRate,
} = require("../../utils/money");

/** Lit un Decimal128, un `{ $numberDecimal }`, une chaîne ou un nombre. */
function lireNombre(v) {
  if (v === null || v === undefined) return null;

  const brut =
    typeof v === "object" && v !== null
      ? v.$numberDecimal ?? (typeof v.toString === "function" ? v.toString() : null)
      : v;

  if (brut === null || String(brut).trim() === "") return null;

  const n = Number(brut);
  return Number.isFinite(n) ? n : null;
}

const upper = (v) => String(v ?? "").trim().toUpperCase();

/** Égalité relative : deux écritures d'un même taux, pas deux taux voisins. */
function memeTaux(a, b) {
  if (a === null || b === null) return false;
  return Math.abs(a - b) <= 1e-9 * Math.max(Math.abs(a), Math.abs(b));
}

/**
 * @param {object} tx transaction lue en `lean()`
 * @returns {{
 *   action: "repair"|"ok"|"skip",
 *   reason: string,
 *   rate?: string,
 *   previous?: {exchangeRate: number|null, fxRateSourceToTarget: number|null}
 * }}
 */
function decideRateRepair(tx = {}) {
  const deMoney = lireNombre(tx?.money?.fxRateSourceToTarget);
  const duDevis = lireNombre(tx?.pricingSnapshot?.result?.appliedRate);

  const exact = deMoney ?? duDevis;

  if (exact === null || exact <= 0) {
    return { action: "skip", reason: "NO_EXACT_RATE_SOURCE" };
  }

  if (deMoney !== null && duDevis !== null && !memeTaux(deMoney, duDevis)) {
    return { action: "skip", reason: "RATE_SOURCES_DISAGREE" };
  }

  const texte = formatRate(exact);

  if (texte === null) {
    return { action: "skip", reason: "RATE_NOT_WRITABLE" };
  }

  /**
   * Contrôle de cohérence avec les montants. `netAmount` est le net envoyé,
   * `amountTarget`/`localAmount` le montant reçu (voir
   * `test/txMoneyFields.test.js`).
   */
  const netEnvoye = lireNombre(tx.netAmount);
  const recu = lireNombre(tx.amountTarget ?? tx.localAmount);
  const deviseCible = upper(tx.currencyTarget || tx.localCurrencySymbol);

  if (netEnvoye === null || recu === null || !deviseCible) {
    return { action: "skip", reason: "AMOUNTS_UNREADABLE" };
  }

  const tolerance = 0.5 / 10 ** decimalsForCurrency(deviseCible) + 1e-9;

  if (Math.abs(netEnvoye * Number(texte) - recu) > tolerance) {
    return { action: "skip", reason: "RATE_DOES_NOT_EXPLAIN_AMOUNTS" };
  }

  const previous = {
    exchangeRate: lireNombre(tx.exchangeRate),
    fxRateSourceToTarget: lireNombre(tx.fxRateSourceToTarget),
  };

  const cible = Number(texte);

  if (memeTaux(previous.exchangeRate, cible) && memeTaux(previous.fxRateSourceToTarget, cible)) {
    return { action: "ok", reason: "ALREADY_EXACT" };
  }

  return { action: "repair", reason: "RATE_TRUNCATED", rate: texte, previous };
}

module.exports = { decideRateRepair, lireNombre };
