"use strict";

/**
 * ============================================================================
 * RÉFÉRENCE DE COMPORTEMENT PAR CLIENT — « est-ce habituel POUR LUI ? »
 * ============================================================================
 *
 * ── CE QUE CE MODULE COMBLE ─────────────────────────────────────────────
 *
 * `riskScore.js` comparait le montant à la limite du RAIL — la même pour tout
 * le monde. Conséquence mesurée : un client dont chaque virement vaut 30 €, qui
 * en envoie soudain 900, ne déclenchait RIEN, parce que 900 reste loin sous la
 * limite. Et symétriquement, un client dont l'habitude est de 2 000 € voyait
 * ses virements ordinaires frôler des seuils pensés pour d'autres.
 *
 * C'est le signal central de Stripe Radar, de PayPal et de toute banque
 * moderne : **l'anomalie n'est pas un montant, c'est un ÉCART À SOI-MÊME.**
 *
 * `paynoval-backend/services/monitoring/fraudRules.js` calcule déjà un écart de
 * ce type — mais en SUPERVISION, c'est-à-dire après coup et en lecture seule.
 * Il constate. Ce module-ci met le même raisonnement **sur le chemin de la
 * décision**, là où il peut encore déclencher une vérification.
 *
 * ── ⚠️ LA MÉDIANE, PAS LA MOYENNE ───────────────────────────────────────
 *
 * Défaut classique et coûteux : un client qui a fait 29 virements de 20 € et
 * UN de 5 000 € a une moyenne de 186 €. Comparé à cette moyenne, son virement
 * habituel de 20 € paraît anormalement bas, et un nouveau virement de 1 000 €
 * paraît normal. **Une seule valeur extrême détruit la référence.**
 *
 * La médiane ne bouge pas : elle reste à 20 €. C'est une statistique ROBUSTE,
 * et c'est ce qu'il faut quand la donnée aberrante est précisément ce qu'on
 * cherche à détecter.
 *
 * ── ⚠️ CE MODULE NE DÉCIDE PAS, IL DÉCRIT ───────────────────────────────
 *
 * Il rend des SIGNAUX pondérés, que `computeRiskScore` additionne aux autres.
 * Aucun de ces signaux ne bloque seul : ils sont tous « mous », donc soumis au
 * plafond `SOFT_SCORE_CAP`. Au pire ils déclenchent une REVUE — jamais un refus
 * sec. Un client honnête qui change d'habitude doit pouvoir s'expliquer, pas se
 * heurter à un 403.
 *
 * ── ⚠️ UNE RÉFÉRENCE NON ÉTABLIE N'EST PAS UNE RÉFÉRENCE À ZÉRO ─────────
 *
 * En dessous de `minTransactions`, on ne sait pas ce qui est habituel pour ce
 * client. On le DIT (`available: false`), et `riskScore` le traduit en
 * `SIGNAL_UNAVAILABLE`. Traiter « je ne sais pas » comme « tout va bien » est
 * exactement la faute que ce projet a déjà corrigée sur la vélocité.
 */

/**
 * Paramètres. Un seul endroit, gelé : un ajustement doit être visible en revue
 * de code, pas enfoui dans une condition.
 *
 * ⚠️ POINTS DE DÉPART, PAS VÉRITÉS (règle B.7). Ils n'ont été calibrés sur
 * aucun trafic réel — il n'y en a pas encore. Ils sont délibérément LARGES :
 * une règle trop sensible met en revue des clients honnêtes, et une file de
 * revue pleine de faux positifs finit par ne plus être lue du tout.
 */
const BASELINE_CONFIG = Object.freeze({
  /** Profondeur de l'historique servant de référence, en jours. */
  lookbackDays: 90,

  /** En dessous, l'habitude n'est pas établie : on ne compare pas. */
  minTransactions: 8,

  /** Nombre d'opérations lues au maximum — borne le coût de la requête. */
  maxSamples: 500,

  /** Écart à la médiane du titulaire, en multiples. */
  typicalRatioSoft: 6,
  typicalRatioHard: 15,

  /** Multiple du plus gros montant jamais envoyé par ce client. */
  historicalMaxRatio: 1.5,

  /**
   * Heure inhabituelle : il faut un historique plus fourni que pour le montant.
   * Sur 8 opérations, aucune heure n'est significative — 8 points répartis sur
   * 24 heures ne disent rien, et crier « 3 h du matin ! » sur cette base
   * produirait une alerte par client honnête.
   */
  minTransactionsForHour: 30,
  /** Part de l'historique en dessous de laquelle l'heure est dite inhabituelle. */
  unusualHourMaxShare: 0.02,
});

/** Codes rendus. Ils NOMMENT leur motif — un score sans motif ne se défend pas. */
const BASELINE_SIGNALS = Object.freeze({
  ABOVE_HABIT: "AMOUNT_ABOVE_CUSTOMER_HABIT",
  FAR_ABOVE_HABIT: "AMOUNT_FAR_ABOVE_CUSTOMER_HABIT",
  ABOVE_HISTORICAL_MAX: "AMOUNT_ABOVE_CUSTOMER_MAX",
  UNUSUAL_HOUR: "UNUSUAL_HOUR_FOR_CUSTOMER",
});

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Médiane d'une liste de nombres. PURE et testable — c'est le cœur robuste.
 *
 * ⚠️ Ne modifie pas la liste reçue : trier sur place muterait le tableau de
 * l'appelant, et ce genre d'effet de bord se paie très loin de sa cause.
 */
function median(values) {
  const tri = (Array.isArray(values) ? values : [])
    .map(num)
    .filter((n) => n > 0)
    .sort((a, b) => a - b);

  if (!tri.length) return null;

  const milieu = Math.floor(tri.length / 2);

  return tri.length % 2 === 1
    ? tri[milieu]
    : (tri[milieu - 1] + tri[milieu]) / 2;
}

/**
 * Résume un historique en une référence exploitable.
 *
 * @param {Array<{amount:number, hour:number}>} operations
 * @returns {{count:number, median:number|null, max:number, hourCounts:number[]}}
 */
function summarizeHistory(operations) {
  const lignes = Array.isArray(operations) ? operations : [];

  const montants = [];
  const hourCounts = new Array(24).fill(0);
  let max = 0;

  for (const ligne of lignes) {
    const montant = num(ligne?.amount);

    /**
     * Un montant nul ou négatif n'est pas une opération du client : c'est une
     * ligne illisible ou une écriture technique. L'inclure abaisserait la
     * médiane, donc rendrait TOUT virement anormal — une règle de fraude qui
     * s'emballe est pire qu'une règle absente.
     */
    if (montant > 0) {
      montants.push(montant);
      if (montant > max) max = montant;
    }

    /**
     * ⚠️ `null` DOIT ÊTRE ÉCARTÉ AVANT `Number()`, pas après.
     *
     * Défaut trouvé par le test « une heure hors bornes n'est comptée nulle
     * part » : `Number(null)` vaut 0, et `Number.isInteger(0)` est vrai. Toute
     * opération dont l'heure n'avait pas pu être lue était donc comptée à
     * MINUIT. Deux conséquences, opposées et toutes deux fausses :
     *
     *   · le seau de 0 h se remplissait d'opérations qui n'y ont jamais eu
     *     lieu, faisant passer minuit pour une heure habituelle — et masquant
     *     donc les virements nocturnes réellement anormaux ;
     *   · les autres heures voyaient leur part diluée.
     *
     * `Number("")` vaut également 0 : la chaîne vide est écartée par la même
     * garde.
     */
    const heureBrute = ligne?.hour;

    if (heureBrute !== null && heureBrute !== undefined && heureBrute !== "") {
      const heure = Number(heureBrute);

      if (Number.isInteger(heure) && heure >= 0 && heure <= 23) {
        hourCounts[heure] += 1;
      }
    }
  }

  return {
    count: montants.length,
    median: median(montants),
    max,
    hourCounts,
  };
}

/**
 * Compare une opération à la référence du titulaire.
 *
 * PURE — aucune horloge, aucune base. C'est ce qui rend la décision
 * reproductible six mois plus tard, devant un client ou un régulateur.
 *
 * @param {object} input
 * @param {number} input.amount    montant de l'opération en cours
 * @param {number|null} input.hour heure UTC (0-23), ou `null` si inconnue
 * @param {object|null} input.baseline  sortie de `summarizeHistory`, ou `null`
 * @param {object} [config]
 *
 * @returns {{available: boolean, reason: string|null, ratio: number|null,
 *            signals: Array<{code:string, detail:string}>}}
 */
function evaluateBaseline({ amount, hour = null, baseline = null } = {}, config = BASELINE_CONFIG) {
  const cfg = { ...BASELINE_CONFIG, ...(config || {}) };
  const signals = [];

  if (!baseline || typeof baseline !== "object") {
    return { available: false, reason: "référence illisible", ratio: null, signals };
  }

  const count = num(baseline.count);

  if (count < cfg.minTransactions) {
    /**
     * ⚠️ PAS UN SIGNAL D'ALERTE, ET PAS NON PLUS UN BLANC-SEING. « Habitude non
     * établie » est une information distincte de « habitude respectée ». Le
     * client neuf est déjà couvert par le signal `NEW_ACCOUNT` de `riskScore` ;
     * le redoubler ici punirait deux fois le même fait.
     */
    return {
      available: false,
      reason: `habitude non établie (${count} < ${cfg.minTransactions} opérations)`,
      ratio: null,
      signals,
    };
  }

  const mediane = num(baseline.median);
  const montant = num(amount);

  let ratio = null;

  if (mediane > 0 && montant > 0) {
    ratio = montant / mediane;

    if (ratio >= cfg.typicalRatioHard) {
      signals.push({
        code: BASELINE_SIGNALS.FAR_ABOVE_HABIT,
        detail: `${ratio.toFixed(1)}× l'habitude du titulaire`,
      });
    } else if (ratio >= cfg.typicalRatioSoft) {
      signals.push({
        code: BASELINE_SIGNALS.ABOVE_HABIT,
        detail: `${ratio.toFixed(1)}× l'habitude du titulaire`,
      });
    }
  }

  /**
   * Dépasser son propre record est un signal DISTINCT de l'écart à la médiane :
   * un client dont les montants varient beaucoup a une médiane peu parlante,
   * mais un plafond, lui, reste un plafond.
   */
  const maxHistorique = num(baseline.max);

  if (maxHistorique > 0 && montant > maxHistorique * cfg.historicalMaxRatio) {
    signals.push({
      code: BASELINE_SIGNALS.ABOVE_HISTORICAL_MAX,
      detail: `au-delà du plus gros envoi connu de ce compte (×${(montant / maxHistorique).toFixed(1)})`,
    });
  }

  /* ------------------------------------------------------- heure inhabituelle */
  const heures = Array.isArray(baseline.hourCounts) ? baseline.hourCounts : [];
  const totalHeures = heures.reduce((t, v) => t + num(v), 0);

  if (
    Number.isInteger(hour) &&
    hour >= 0 &&
    hour <= 23 &&
    totalHeures >= cfg.minTransactionsForHour
  ) {
    const part = num(heures[hour]) / totalHeures;

    if (part <= cfg.unusualHourMaxShare) {
      signals.push({
        code: BASELINE_SIGNALS.UNUSUAL_HOUR,
        detail: `${hour}h UTC — ${(part * 100).toFixed(1)} % de l'historique de ce compte`,
      });
    }
  }

  return { available: true, reason: null, ratio, signals };
}

module.exports = {
  BASELINE_CONFIG,
  BASELINE_SIGNALS,
  median,
  summarizeHistory,
  evaluateBaseline,
};
