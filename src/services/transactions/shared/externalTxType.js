"use strict";

/**
 * ============================================================================
 * LE TYPE D'UNE OPÉRATION EXTERNE SE DÉCLARE — IL NE SE DEVINE PAS
 * ============================================================================
 *
 * ── Le défaut mesuré le 2026-09-16 ──────────────────────────────────────────
 *
 * `normalizeTxTypeForPricing` rendait `"TRANSFER"` quand l'appelant ne
 * fournissait NI `txType` NI `action`. Un appel qui ne dit pas s'il s'agit d'un
 * dépôt ou d'un retrait était donc tarifé comme un transfert — et facturé.
 *
 * C'est la règle B.2 : sur le chemin de l'argent, une donnée absente arrête
 * l'opération, elle ne prend pas de valeur par défaut. « Je ne sais pas » et
 * « c'est un transfert » sont deux choses différentes, et la seconde est la
 * plus dangereuse des deux parce qu'elle est plausible : elle produit un prix
 * d'apparence normale, calculé sur le mauvais barème.
 *
 * Les conséquences étaient concrètes : dépôt et retrait n'ont pas les mêmes
 * commissions prestataire, et le barème `TRANSFER · MOBILEMONEY` a une marge
 * distincte de `WITHDRAW · MOBILEMONEY`. Un appelant muet payait le mauvais
 * tarif sans que rien ne le signale.
 *
 * ── Ce que fait ce module ───────────────────────────────────────────────────
 *
 * Il rend le type DÉCLARÉ, ou `null`. Il ne choisit jamais à la place de
 * l'appelant. C'est au handler de refuser en 400 — la même discipline que
 * `utils/money.js:tauxEffectif`, qui rend `null` plutôt que d'inventer 1.
 *
 * Les clients actuels déclarent tous leur type : l'application mobile pose
 * `txType` ET `action` dans son constructeur externe, et les contrôleurs
 * cagnotte passent un type explicite. Le repli ne protégeait donc personne —
 * il masquait les appelants qui, eux, ne déclarent rien.
 *
 * Module PUR : aucune base, aucun réseau, aucune dépendance.
 */

/** Les seuls types qu'un appelant externe peut déclarer. */
const TYPES_EXTERNES = Object.freeze(["TRANSFER", "DEPOSIT", "WITHDRAW"]);

/**
 * @param {object} body corps de la requête (déjà fusionné).
 * @returns {string|null} le type déclaré, ou `null` si l'appelant s'est tu.
 */
function resoudreTypeExterne(body = {}) {
  const declare = String(body?.txType || body?.transactionType || "")
    .trim()
    .toUpperCase();

  if (declare) return declare;

  /**
   * `action` est l'ancienne forme, encore émise par l'application mobile à côté
   * de `txType`. Elle reste acceptée : c'est une DÉCLARATION de l'appelant, pas
   * une déduction de notre part.
   */
  const action = String(body?.action || "").trim().toLowerCase();

  if (action === "deposit") return "DEPOSIT";
  if (action === "withdraw") return "WITHDRAW";

  return null;
}

module.exports = { resoudreTypeExterne, TYPES_EXTERNES };
