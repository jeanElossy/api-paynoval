"use strict";

/**
 * MONTANTS DES COMPTES INTERNES — EXACTS EN BASE, COMPATIBLES À LA LECTURE
 * =============================================================================
 *
 * ── Le défaut fermé le 2026-09-22 ─────────────────────────────────────────
 *
 * `txsystembalances.balances` stockait des **flottants**, incrémentés par
 * `$inc`. Mesuré en base : `CAD: 16.150000000000002` sur la trésorerie des
 * frais de cagnotte, `97.91000000000001` sur celle des frais, après seulement
 * quelques dizaines de mouvements. L'écart est invisible au centime près
 * aujourd'hui, et c'est exactement le problème : il grandit sans jamais lever
 * d'erreur, jusqu'au jour où les comptes ne tombent plus juste.
 *
 * Les portefeuilles CLIENTS étaient déjà en `Decimal128` (`TxWalletBalance`) ;
 * les comptes internes, non. C'est cet écart que ce module ferme.
 *
 * ── Compatibilité, et pourquoi elle compte ici ────────────────────────────
 *
 * Plusieurs lecteurs font `Number(wallet.balances[CUR] || 0)` — et
 * `Number(Decimal128)` vaut `NaN`. Basculer le stockage sans filet
 * transformerait donc un solde en `NaN`, silencieusement, sur le chemin de
 * l'argent. Le modèle expose désormais des NOMBRES à la lecture (accesseur
 * Mongoose) et garde la valeur EXACTE en base ; les décisions monétaires
 * passent par `readExact`, jamais par un flottant.
 */

const mongoose = require("mongoose");
const D = require("./decimalMoney");

/** Devises sans sous-unité : un « centime » n'y existe pas. */
const ZERO_DECIMAL_CURRENCIES = new Set(["XOF", "XAF", "JPY", "KRW", "CLP", "VND"]);

function scaleFor(currency) {
  const cur = String(currency || "").trim().toUpperCase();
  return ZERO_DECIMAL_CURRENCIES.has(cur) ? 0 : 2;
}

/**
 * Arrondi commercial à l'échelle de la devise, en arithmétique EXACTE.
 * Rend une chaîne décimale, ou `null` si la valeur est illisible — jamais `0`
 * (règle B.2 : un montant illisible n'est pas un montant nul).
 */
function roundToCurrency(value, currency) {
  const parsed = D.parseDecimal(value);
  if (parsed === null) return null;

  const scale = scaleFor(currency);
  const text = D.format(parsed);
  const [entier, decimales = ""] = text.replace("-", "").split(".");
  const negatif = text.startsWith("-");

  if (decimales.length <= scale) {
    const complete = scale === 0 ? entier : `${entier}.${decimales.padEnd(scale, "0")}`;
    return `${negatif ? "-" : ""}${complete}`;
  }

  // Arrondi au plus proche, moitié vers le haut, sans jamais passer par un
  // flottant : on travaille sur les chiffres.
  const gardees = decimales.slice(0, scale);
  const suivant = Number(decimales[scale]);

  let unites = BigInt(entier + gardees.padEnd(scale, "0") || "0");
  if (suivant >= 5) unites += 1n;

  const brut = unites.toString().padStart(scale + 1, "0");
  const partieEntiere = scale === 0 ? brut : brut.slice(0, brut.length - scale);
  const partieDecimale = scale === 0 ? "" : brut.slice(brut.length - scale);

  return `${negatif ? "-" : ""}${partieEntiere}${scale === 0 ? "" : `.${partieDecimale}`}`;
}

/**
 * Montant prêt pour la base : `Decimal128` exact, arrondi à la devise.
 * Lève sur une valeur illisible — le chemin de l'argent échoue en fermeture.
 */
function toDecimal128(value, currency) {
  const rounded = roundToCurrency(value, currency);

  if (rounded === null) {
    throw new Error(
      `Montant illisible (${value}) pour ${currency} : aucune valeur par défaut n'est appliquée.`
    );
  }

  return mongoose.Types.Decimal128.fromString(rounded);
}

/**
 * Solde EXACT d'une devise, en chaîne décimale — la forme sur laquelle on
 * compare et on décide. `null` si le solde est illisible, `"0"` s'il est absent
 * (une devise jamais mouvementée vaut bien zéro).
 */
function readExact(wallet, currency) {
  const cur = String(currency || "").trim().toUpperCase();
  const raw = wallet?.balances?.[cur];

  if (raw === undefined || raw === null) return "0";

  const parsed = D.parseDecimal(raw);
  return parsed === null ? null : D.format(parsed);
}

/** Pour l'AFFICHAGE et les lecteurs historiques : un `Number`, jamais `NaN`. */
function readNumber(wallet, currency) {
  const exact = readExact(wallet, currency);
  if (exact === null) return null;

  const n = Number(exact);
  return Number.isFinite(n) ? n : null;
}

/** `a` couvre-t-il `b` ? Comparaison exacte, sans flottant. */
function covers(a, b) {
  const left = D.parseDecimal(a);
  const right = D.parseDecimal(b);

  if (left === null || right === null) return false;
  return D.compare(left, right) >= 0;
}

/**
 * Accesseur Mongoose : rend la carte des soldes en NOMBRES, pour que les
 * lecteurs existants (`Number(wallet.balances[CUR])`) continuent de fonctionner
 * alors que la base stocke des `Decimal128`.
 */
function balancesAsNumbers(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;

  const out = {};

  for (const [cur, value] of Object.entries(raw)) {
    const parsed = D.parseDecimal(value);
    // Une valeur illisible est rendue TELLE QUELLE : la masquer par 0 ferait
    // lire « compte vide » sur une donnée corrompue.
    out[cur] = parsed === null ? value : Number(D.format(parsed));
  }

  return out;
}

module.exports = {
  ZERO_DECIMAL_CURRENCIES,
  scaleFor,
  roundToCurrency,
  toDecimal128,
  readExact,
  readNumber,
  covers,
  balancesAsNumbers,
};
