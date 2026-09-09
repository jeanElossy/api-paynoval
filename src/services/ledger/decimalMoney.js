"use strict";

/**
 * ============================================================================
 * ARITHMÉTIQUE DÉCIMALE EXACTE — POUR CUMULER DES ÉCRITURES SANS DÉRIVER
 * ============================================================================
 *
 * POURQUOI CE MODULE EXISTE
 * -------------------------
 * `doubleEntry.js` cumule ses jambes en `Number`, et c'est défendable là-bas :
 * il vérifie l'équilibre d'UN LOT — deux à quatre jambes, jamais plus. L'erreur
 * de représentation d'une poignée d'additions reste très en dessous du demi-
 * centime de `BALANCE_EPSILON`.
 *
 * Le contrôle portefeuille ↔ grand livre ne travaille pas sur un lot. Il cumule
 * **toutes les écritures de la vie d'un compte** — des milliers, un jour des
 * millions. Là, l'argument tombe :
 *
 *     0.1 + 0.2 === 0.30000000000000004
 *
 * ── CE QUE ÇA COÛTE, MESURÉ ET NON SUPPOSÉ (2026-09-01, Node 20)
 *
 * Le nombre d'écritures seul ne suffit pas à franchir la tolérance de 0,005 :
 * 100 000 additions de `0.01` dérivent de 7,6·10⁻¹⁰, très en dessous. Ce n'est
 * donc PAS l'argument.
 *
 * L'argument est la MAGNITUDE. Un flottant perd ses petits chiffres dès que le
 * cumul est grand, et un solde en XOF l'est vite (1 milliard de FCFA ≈ 1,5 M€ ;
 * un compte de compensation bien davantage). Même mesure, avec un solde de
 * départ réaliste :
 *
 *     départ 10⁷, puis 100 000 × 0.01  →  écart 0,000022   (sous la tolérance)
 *     départ 10⁹, puis 100 000 × 0.01  →  écart 0,00095    (un cinquième)
 *     départ 10¹², puis 100 000 × 0.01 →  écart 0,977      (195× la tolérance)
 *
 * La troisième ligne est une **fausse alerte sur un portefeuille sain**, et un
 * contrôle qui crie au loup est désactivé dans la semaine — il aura alors coûté
 * plus cher que son absence, parce qu'on aura cessé de regarder.
 *
 * L'inverse est pire encore : un écart réel de quelques centimes se loge sous
 * la tolérance élargie qu'on finit toujours par mettre pour faire taire le
 * bruit. Le contrôle passe alors au vert sur de l'argent perdu.
 *
 * (Ces trois chiffres sont rejoués par `test/walletLedgerReconciliation.test.js`,
 * qui vérifie que le cumul exact, lui, tombe juste dans les trois cas.)
 *
 * COMMENT
 * -------
 * Un montant est représenté par un couple exact `{ units: BigInt, scale }`, où
 * la valeur vaut `units / 10^scale`. `BigInt` est un entier de précision
 * arbitraire : l'addition n'a AUCUNE erreur, quel que soit le nombre de termes.
 * Rien n'est jamais converti en `Number` pour être additionné ou comparé.
 *
 * ⚠️ `toNumber()` existe pour l'AFFICHAGE seulement, et il est nommé pour qu'on
 * ne s'y trompe pas. Aucune décision de ce module ne passe par lui.
 *
 * FERMETURE SUR DONNÉE ILLISIBLE (règle B.2)
 * ------------------------------------------
 * `parseDecimal()` rend `null` — jamais `0` — sur une valeur absente,
 * malformée, ou hors des bornes admises. Un montant illisible n'est pas un
 * montant nul : le traiter comme nul transformerait une donnée corrompue en
 * « tout va bien ». L'appelant DOIT traiter `null` comme un arrêt, pas comme un
 * zéro.
 */

/**
 * Bornes de sécurité sur la valeur analysée.
 *
 * Une écriture du grand livre est un `Decimal128` : au plus 34 chiffres
 * significatifs. Ces bornes sont donc très larges pour de la monnaie, et leur
 * rôle est ailleurs : empêcher qu'une valeur aberrante — arrivée par une
 * migration, une importation, ou une donnée façonnée à la main — fasse calculer
 * `10n ** 6000n` et bloque le processus. On refuse au lieu de calculer.
 */
const MAX_SIGNIFICANT_DIGITS = 80;
const MAX_SCALE = 40;

const POWERS = new Map();

function pow10(n) {
  if (n < 0) throw new RangeError("pow10: exposant négatif");
  if (!POWERS.has(n)) POWERS.set(n, 10n ** BigInt(n));
  return POWERS.get(n);
}

const DECIMAL_RE = /^([+-])?(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/;

/**
 * Extrait la chaîne décimale d'une valeur telle qu'elle sort de Mongo.
 *
 * Les quatre formes rencontrées réellement dans ce dépôt :
 *   - `Decimal128` (lecture Mongoose sans `.lean()`) → `toString()`
 *   - `{ $numberDecimal: "…" }` (BSON brut / `.lean()` selon la voie)
 *   - une chaîne
 *   - un `Number` (les tests, et les portefeuilles écrits par `$inc`)
 */
function extractString(value) {
  if (value === null || value === undefined) return null;

  if (typeof value === "string") return value.trim();

  if (typeof value === "number") {
    // Un flottant non fini n'est pas un montant. On refuse plutôt que de
    // fabriquer « 0 » ou « NaN ».
    if (!Number.isFinite(value)) return null;
    return String(value);
  }

  if (typeof value === "bigint") return String(value);

  if (typeof value === "object") {
    if (typeof value.$numberDecimal === "string") return value.$numberDecimal.trim();
    if (typeof value.$numberInt === "string") return value.$numberInt.trim();
    if (typeof value.$numberLong === "string") return value.$numberLong.trim();
    if (typeof value.toString === "function") {
      const s = String(value.toString()).trim();
      // `{}.toString()` rend "[object Object]" — ce n'est pas un montant.
      return s.startsWith("[object") ? null : s;
    }
  }

  return null;
}

/**
 * @returns {{ units: bigint, scale: number } | null} `null` si la valeur n'est
 *   pas un montant lisible. **Ne jamais substituer 0 à ce `null`.**
 */
function parseDecimal(value) {
  const raw = extractString(value);
  if (!raw) return null;

  const m = DECIMAL_RE.exec(raw);
  if (!m) return null;

  const sign = m[1] === "-" ? -1n : 1n;
  const intPart = m[2] || "0";
  const fracPart = m[3] !== undefined ? m[3] : m[4] || "";
  const exponent = m[5] ? Number(m[5]) : 0;

  if (!Number.isFinite(exponent) || Math.abs(exponent) > 1000) return null;

  const digits = `${intPart}${fracPart}`;
  if (digits.length > MAX_SIGNIFICANT_DIGITS) return null;

  let units = BigInt(digits) * sign;
  let scale = fracPart.length - exponent;

  // Un exposant positif assez grand rend l'échelle négative : on remonte les
  // unités et on ramène l'échelle à zéro, sans jamais perdre un chiffre.
  if (scale < 0) {
    if (-scale > MAX_SCALE) return null;
    units *= pow10(-scale);
    scale = 0;
  }

  if (scale > MAX_SCALE) return null;

  return { units, scale };
}

function zero() {
  return { units: 0n, scale: 0 };
}

function rescale(a, targetScale) {
  if (a.scale === targetScale) return a.units;
  return a.units * pow10(targetScale - a.scale);
}

function commonScale(a, b) {
  return a.scale > b.scale ? a.scale : b.scale;
}

function add(a, b) {
  const s = commonScale(a, b);
  return { units: rescale(a, s) + rescale(b, s), scale: s };
}

function sub(a, b) {
  const s = commonScale(a, b);
  return { units: rescale(a, s) - rescale(b, s), scale: s };
}

function negate(a) {
  return { units: -a.units, scale: a.scale };
}

function isZero(a) {
  return a.units === 0n;
}

/** -1, 0 ou 1 — comparaison EXACTE, sans passer par un flottant. */
function compare(a, b) {
  const s = commonScale(a, b);
  const ua = rescale(a, s);
  const ub = rescale(b, s);
  if (ua < ub) return -1;
  if (ua > ub) return 1;
  return 0;
}

function abs(a) {
  return a.units < 0n ? negate(a) : a;
}

/**
 * `|a| > tolerance` ? La tolérance est elle-même un décimal exact, pas un
 * flottant : comparer un cumul exact à `0.005` en `Number` réintroduirait
 * précisément l'imprécision qu'on vient d'éliminer.
 */
function exceeds(a, tolerance) {
  return compare(abs(a), abs(tolerance)) > 0;
}

/** Représentation décimale exacte, sans notation exponentielle. */
function format(a) {
  const negative = a.units < 0n;
  let digits = (negative ? -a.units : a.units).toString();

  if (a.scale === 0) return `${negative ? "-" : ""}${digits}`;

  if (digits.length <= a.scale) {
    digits = digits.padStart(a.scale + 1, "0");
  }

  const cut = digits.length - a.scale;
  return `${negative ? "-" : ""}${digits.slice(0, cut)}.${digits.slice(cut)}`;
}

/**
 * ⚠️ AFFICHAGE UNIQUEMENT.
 *
 * Aucune comparaison, aucun cumul, aucune décision de ce module ne passe par
 * cette fonction. Elle existe parce qu'un rapport JSON est plus lisible avec un
 * nombre qu'avec une chaîne — et la chaîne exacte est TOUJOURS livrée à côté.
 */
function toNumber(a) {
  return Number(format(a));
}

/** Somme exacte d'une liste. Sert de point d'entrée aux cumuls. */
function sum(values) {
  let acc = zero();
  for (const v of values) acc = add(acc, v);
  return acc;
}

module.exports = {
  MAX_SIGNIFICANT_DIGITS,
  MAX_SCALE,
  parseDecimal,
  zero,
  add,
  sub,
  sum,
  negate,
  abs,
  compare,
  exceeds,
  isZero,
  format,
  toNumber,
};
