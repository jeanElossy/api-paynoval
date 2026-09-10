"use strict";

/**
 * ============================================================================
 * GARDE DU CRIBLAGE — ON NE PART PAS EN PRODUCTION SANS CONFRONTER AUX LISTES
 * ============================================================================
 *
 * ── Le défaut mesuré le 2026-09-10 ─────────────────────────────────────────
 *
 * `services/risk/sanctionsScreening.js` fait 1 359 lignes, gère cinq
 * fournisseurs, est branché sur les deux chemins de l'argent — et il est
 * ÉTEINT. `SANCTIONS_SCREENING_ENABLED` n'est renseignée nulle part et vaut
 * `false` par défaut. Rien, nulle part, ne le disait.
 *
 * Aucun bénéficiaire, aucun contributeur, aucun payeur n'est confronté à une
 * liste de sanctions. Le code donne toutes les apparences du contraire : les
 * routes sont montées, le middleware appelle le service, le service répond, les
 * journaux sont propres. C'est le mode de panne le plus coûteux — celui qui a
 * l'air de marcher.
 *
 * ── Pourquoi un garde, et pas simplement une valeur par défaut à `true` ────
 *
 * Parce qu'activer par défaut ne résout rien : sans fournisseur configuré, le
 * service retomberait sur `mock`, qui répond « aucune correspondance » à tout.
 * On aurait remplacé un contrôle éteint par un contrôle qui MENT — strictement
 * pire, puisque les journaux annonceraient alors un criblage actif.
 *
 * La seule réponse honnête est de REFUSER LE DÉMARRAGE : l'exploitant doit
 * choisir un fournisseur. C'est une décision qu'aucun défaut ne peut prendre à
 * sa place.
 *
 * ── Les trois régimes ──────────────────────────────────────────────────────
 *
 *   · `NODE_ENV=production` (ou `SANCTIONS_SCREENING_STRICT=true`)
 *        → criblage éteint ou en `mock` = DÉMARRAGE REFUSÉ.
 *
 *   · développement
 *        → autorisé, mais ANNONCÉ avec sa conséquence à chaque démarrage. On ne
 *          s'habitue pas à un avertissement qui nomme ce qu'il coûte.
 *
 *   · `SANCTIONS_SCREENING_ALLOW_DISABLED=true` en production
 *        → échappatoire NOMMÉE et grep-able, qui journalise en `error`. Elle
 *          existe pour un incident — un fournisseur défaillant qu'on doit
 *          contourner à 3 h du matin — pas pour une mise en service. Une
 *          échappatoire dont on peut lister les usages vaut mieux qu'un garde
 *          qu'on désactive en commentant une ligne.
 *
 * ── Fournisseur sans contrat commercial ────────────────────────────────────
 *
 * `opensanctions` / `yente` s'auto-héberge et consomme les données publiques
 * d'OpenSanctions (listes ONU, UE, OFAC, PEP). C'est la voie qui ne demande
 * aucune signature :
 *
 *     SANCTIONS_SCREENING_ENABLED=true
 *     SANCTIONS_SCREENING_PROVIDER=opensanctions
 *     SANCTIONS_SCREENING_BASE_URL=http://yente:8000
 *     SANCTIONS_SCREENING_DATASET=default
 *     SANCTIONS_SCREENING_FAIL_CLOSED=true
 *
 * Les fournisseurs commerciaux (`sumsub`, `complyadvantage`) restent gérés par
 * le même service et n'exigent que leurs clés.
 */

const VRAI = Object.freeze(["1", "true", "yes", "on"]);

function estVrai(valeur) {
  return VRAI.includes(String(valeur ?? "").trim().toLowerCase());
}

/** Fournisseurs qui consultent RÉELLEMENT une liste. `mock` n'en fait pas partie. */
const FOURNISSEURS_REELS = Object.freeze([
  "opensanctions",
  "yente",
  "sumsub",
  "complyadvantage",
  "complyadvantage_mesh",
]);

/**
 * Décrit l'état du criblage. Fonction PURE : elle ne lit aucun fichier, ne
 * journalise rien, ne lève rien — elle constate. C'est ce qui la rend testable
 * sans configuration.
 */
function inspecterCriblage(env = process.env) {
  const actif = estVrai(env.SANCTIONS_SCREENING_ENABLED);
  const fournisseur = String(env.SANCTIONS_SCREENING_PROVIDER || "mock")
    .trim()
    .toLowerCase();

  const production = String(env.NODE_ENV || "").trim() === "production";
  const strict = production || estVrai(env.SANCTIONS_SCREENING_STRICT);
  const echappatoire = estVrai(env.SANCTIONS_SCREENING_ALLOW_DISABLED);

  const reel = actif && FOURNISSEURS_REELS.includes(fournisseur);

  /**
   * ⚠️ `FAIL_CLOSED` n'est vérifié QUE si le criblage est réel. Exiger une
   * posture de fermeture d'un criblage éteint n'aurait aucun sens et noierait
   * le vrai message dans un second avertissement.
   */
  const fermeture = estVrai(env.SANCTIONS_SCREENING_FAIL_CLOSED);

  let motif = "";

  if (!actif) motif = "SANCTIONS_SCREENING_ENABLED absente ou fausse";
  else if (!FOURNISSEURS_REELS.includes(fournisseur)) {
    motif = `fournisseur « ${fournisseur} » — aucune liste réelle n'est consultée`;
  }

  return {
    actif,
    fournisseur,
    reel,
    fermeture,
    strict,
    production,
    echappatoire,
    motif,
  };
}

class ScreeningGuardError extends Error {
  constructor(message) {
    super(message);
    this.name = "ScreeningGuardError";
    this.code = "SANCTIONS_SCREENING_REQUIRED";
  }
}

/**
 * Applique le garde. LÈVE en régime strict si le criblage n'est pas réel.
 *
 * @param {object}   [env]
 * @param {object}   [logger]
 * @returns {object} l'état inspecté, pour que l'appelant puisse l'exposer
 */
function assertScreeningReady(env = process.env, logger = console) {
  const etat = inspecterCriblage(env);

  if (etat.reel) {
    logger.info?.(
      `✅ Criblage sanctions actif — fournisseur « ${etat.fournisseur} », ` +
        `posture de panne : ${etat.fermeture ? "FERMETURE" : "ouverture"}.`
    );

    if (!etat.fermeture) {
      logger.warn?.(
        "⚠️ SANCTIONS_SCREENING_FAIL_CLOSED absente ou fausse — CONSÉQUENCE : " +
          "une panne du fournisseur de criblage LAISSE PASSER l'opération. Sur " +
          "le chemin de l'argent, la règle B.2 demande l'inverse."
      );
    }

    return etat;
  }

  const consequence =
    "CONSÉQUENCE : aucun bénéficiaire, aucun contributeur et aucun payeur " +
    "n'est confronté à une liste de sanctions. Les virements et les " +
    "encaissements passent sans ce contrôle.";

  if (etat.strict && !etat.echappatoire) {
    throw new ScreeningGuardError(
      `Criblage sanctions indisponible (${etat.motif}). ${consequence}\n` +
        "  Renseigner SANCTIONS_SCREENING_ENABLED=true et un fournisseur réel " +
        `(${FOURNISSEURS_REELS.join(", ")}).\n` +
        "  Voie sans contrat commercial : `opensanctions` auto-hébergé (yente).\n" +
        "  Contournement d'incident, à ne pas utiliser pour une mise en " +
        "service : SANCTIONS_SCREENING_ALLOW_DISABLED=true."
    );
  }

  if (etat.strict && etat.echappatoire) {
    /**
     * ⚠️ `error`, pas `warn`. Une échappatoire de conformité active en
     * production doit apparaître dans ce que la supervision remonte, pas dans
     * ce qu'elle filtre.
     */
    logger.error?.(
      `❌ CRIBLAGE DÉSACTIVÉ EN PRODUCTION PAR ÉCHAPPATOIRE EXPLICITE ` +
        `(${etat.motif}). ${consequence} ` +
        "SANCTIONS_SCREENING_ALLOW_DISABLED doit être retirée dès l'incident clos."
    );

    return etat;
  }

  logger.warn?.(`⚠️ Criblage sanctions inactif (${etat.motif}). ${consequence}`);

  return etat;
}

module.exports = {
  FOURNISSEURS_REELS,
  ScreeningGuardError,
  inspecterCriblage,
  assertScreeningReady,
};
