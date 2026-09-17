"use strict";

/**
 * ============================================================================
 * MODES DE CHANGE — UNE SEULE DÉFINITION DU TAUX APPLIQUÉ, ET SES GARDE-FOUS
 * ============================================================================
 *
 * ── Les défauts fermés le 2026-09-16 ────────────────────────────────────────
 *
 * 1. **Aucune borne sur les modes qui s'écartent du marché.** `OVERRIDE`
 *    n'exigeait qu'un taux > 0 : saisir 655,957 (EUR→XOF) sur une règle
 *    XOF→EUR était accepté — un taux 430 000 fois trop favorable, arrêté
 *    seulement si le second valideur le voyait. `DELTA_ABS` n'avait aucune
 *    borne, et `DELTA_PERCENT` acceptait +10 % : un taux MEILLEUR que le
 *    marché, donc une perte de PayNoval sur chaque opération du corridor.
 *
 * 2. **Une perte de change invisible.** Le revenu de change était calculé avec
 *    un plancher à zéro, et le mode `OVERRIDE` ne citait aucun taux de marché :
 *    une marge négative, ou la marge contenue dans un taux imposé, n'apparaissait
 *    nulle part — ni au devis, ni sur la transaction, ni à la trésorerie.
 *
 * ── Ce que tient ce module ──────────────────────────────────────────────────
 *
 * · `appliedRateFor` : LA formule, utilisée par le moteur. Un contrôle qui juge
 *   une règle avec une autre formule que celle qui facture ne contrôle rien.
 * · `validateFxModeShape` (pur, synchrone) : ce qui se juge sans taux de
 *   marché — sens de l'ajustement, paire précise exigée.
 * · `assertFxWithinMarket` (taux de marché INJECTÉ) : l'écart au marché, jugé
 *   au dépôt ET à l'approbation, parce que le marché bouge entre les deux.
 *
 * Pratique de référence : Wise et Revolut publient leur taux comme un écart
 * explicite au taux du marché ; un taux client supérieur au marché n'existe
 * que comme promotion délibérée, portée en frais négatifs visibles — jamais
 * comme un taux saisi.
 *
 * Module PUR : aucune dépendance réseau ni base au chargement.
 */

/** Lit une borne d'environnement ; illisible ⇒ la valeur par défaut, jamais NaN. */
function borne(nom, defaut, env = process.env) {
  const brut = env[nom];
  if (brut === undefined || String(brut).trim() === "") return defaut;
  const n = Number(brut);
  return Number.isFinite(n) && n > 0 ? n : defaut;
}

/**
 * Écart maximal, en %, entre le taux client et le taux du marché pour les
 * modes `OVERRIDE` et `DELTA_ABS`. Même ordre de grandeur que la borne de
 * marge (`PRICING_FX_MARKUP_PERCENT_MAX`).
 */
function ecartMarcheMaxPercent(env = process.env) {
  return borne("PRICING_FX_MARKET_DEVIATION_MAX_PERCENT", 10, env);
}

const MODES_JUGES_AU_MARCHE = Object.freeze(["OVERRIDE", "DELTA_ABS"]);

const upper = (v) => String(v ?? "").trim().toUpperCase();

function num(v) {
  if (v === null || v === undefined || String(v).trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function estJoker(code) {
  const c = upper(code);
  return !c || c === "ALL" || c === "*";
}

/**
 * Le taux appliqué au client pour un mode donné.
 *
 * @param {{mode: string, fx: object, marketRate: number|null}} params
 * @returns {number|null} `null` si le taux ne peut pas être établi.
 */
function appliedRateFor({ mode, fx = {}, marketRate }) {
  const m = upper(mode) || "PASS_THROUGH";

  if (m === "OVERRIDE") {
    const r = num(fx.overrideRate);
    return r !== null && r > 0 ? r : null;
  }

  const marche = num(marketRate);
  if (marche === null || marche <= 0) return null;

  let taux = marche;

  if (m === "MARKUP_PERCENT") taux = marche * (1 - (num(fx.markupPercent) || 0) / 100);
  else if (m === "DELTA_PERCENT") taux = marche * (1 + (num(fx.percent) || 0) / 100);
  else if (m === "DELTA_ABS") taux = marche + (num(fx.deltaAbs) || 0);

  return Number.isFinite(taux) && taux > 0 ? taux : null;
}

/**
 * Contrôles qui ne demandent aucun taux de marché.
 *
 * @returns {{ok: true} | {ok: false, message: string}}
 */
function validateFxModeShape(proposed = {}) {
  const fx = proposed.fx || {};
  const scope = proposed.scope || {};
  const mode = upper(fx.mode) || "PASS_THROUGH";

  if (mode === "DELTA_PERCENT" && (num(fx.percent) || 0) > 0) {
    return {
      ok: false,
      message:
        "Un ajustement positif donnerait au client un taux MEILLEUR que le marché : " +
        "PayNoval perdrait de l'argent sur chaque opération. Une promotion se porte en frais, pas en taux.",
    };
  }

  if (mode === "DELTA_ABS" && (num(fx.deltaAbs) || 0) > 0) {
    return {
      ok: false,
      message:
        "Un ajustement absolu positif donnerait au client un taux MEILLEUR que le marché : " +
        "PayNoval perdrait de l'argent sur chaque opération.",
    };
  }

  if (MODES_JUGES_AU_MARCHE.includes(mode)) {
    const de = upper(scope.fromCurrency);
    const vers = upper(scope.toCurrency);

    if (estJoker(de) || estJoker(vers) || de === vers) {
      return {
        ok: false,
        message:
          `Le mode « ${mode === "OVERRIDE" ? "Taux imposé" : "Ajustement (valeur absolue)"} » ` +
          "n'a de sens que pour une paire de devises précise et distincte : un même taux " +
          "ne peut pas valoir pour XOF→EUR et pour CAD→USD.",
      };
    }
  }

  return { ok: true };
}

/**
 * Écart du taux client au marché, jugé au moment du dépôt et de l'approbation.
 *
 * Échoue en FERMETURE : sans taux de marché, un taux imposé ne peut pas être
 * jugé, donc il n'est pas publié (règle B.2).
 *
 * @param {{proposed: object, getMarketRate: (from: string, to: string) => Promise<number|null>, env?: object}} params
 * @returns {Promise<{ok: true, deviationPercent?: number} | {ok: false, status: number, message: string}>}
 */
async function assertFxWithinMarket({ proposed = {}, getMarketRate, env = process.env }) {
  const fx = proposed.fx || {};
  const mode = upper(fx.mode) || "PASS_THROUGH";

  if (!MODES_JUGES_AU_MARCHE.includes(mode)) return { ok: true };

  const forme = validateFxModeShape(proposed);
  if (!forme.ok) return { ...forme, status: 400 };

  const de = upper(proposed.scope?.fromCurrency);
  const vers = upper(proposed.scope?.toCurrency);

  let marche = null;
  try {
    marche = num(await getMarketRate(de, vers));
  } catch {
    marche = null;
  }

  if (marche === null || marche <= 0) {
    return {
      ok: false,
      status: 503,
      message:
        `Taux du marché ${de}→${vers} indisponible : l'écart du taux proposé ne peut pas être ` +
        "vérifié, la règle n'est pas acceptée. Réessayez plus tard.",
    };
  }

  const client = appliedRateFor({ mode, fx, marketRate: marche });

  if (client === null) {
    return { ok: false, status: 400, message: "Le taux client qui en résulterait est nul ou négatif." };
  }

  const ecart = ((client - marche) / marche) * 100;
  const max = ecartMarcheMaxPercent(env);

  if (ecart > 0) {
    return {
      ok: false,
      status: 400,
      message:
        `Le taux client (${client}) est SUPÉRIEUR au taux du marché (${marche}) de ` +
        `${ecart.toFixed(2)} % : PayNoval perdrait de l'argent sur chaque opération ${de}→${vers}.`,
    };
  }

  if (Math.abs(ecart) > max) {
    return {
      ok: false,
      status: 400,
      message:
        `Le taux client (${client}) s'écarte du taux du marché (${marche}) de ` +
        `${Math.abs(ecart).toFixed(2)} %, au-delà de la borne de ${max} % : ` +
        "vérifiez le sens de la paire et la saisie. Si c'est voulu, relevez la borne explicitement.",
    };
  }

  return { ok: true, deviationPercent: ecart };
}

module.exports = {
  appliedRateFor,
  validateFxModeShape,
  assertFxWithinMarket,
  ecartMarcheMaxPercent,
  borne,
  MODES_JUGES_AU_MARCHE,
};
