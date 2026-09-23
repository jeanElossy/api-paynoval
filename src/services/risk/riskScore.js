"use strict";

/**
 * ============================================================================
 * SCORE DE RISQUE — DÉTERMINISTE, EXPLICABLE, SANS HASARD
 * ============================================================================
 *
 * ⚠️ CE MODULE REMPLACE `getMLScore`, QUI RENVOYAIT `Math.random() * 0.4`.
 *
 * Ce n'était pas une approximation en attendant mieux : c'était un générateur
 * aléatoire portant un nom qui laissait croire à un modèle. Trois conséquences,
 * et la troisième est la pire :
 *
 *   1. la même transaction notée deux fois donnait deux scores différents —
 *      donc rien n'était testable ;
 *   2. le seuil de blocage était 0.9 et le tirage plafonnait à 0.4 : la branche
 *      « aléatoire » ne bloquait JAMAIS. Le seul signal réel était « montant
 *      au-dessus de la limite », qui renvoyait 0.92 en dur ;
 *   3. en cas de litige ou de contrôle, **le score d'une transaction passée
 *      était irreproductible**. On ne peut ni l'expliquer au client, ni le
 *      justifier à un régulateur, ni comprendre après coup pourquoi un
 *      virement légitime a été refusé.
 *
 * LES TROIS PROPRIÉTÉS EXIGÉES ICI :
 *
 *   - **Déterminisme.** Aucune horloge, aucun hasard, aucune entrée/sortie. Les
 *     mêmes entrées rendent le même verdict, aujourd'hui et dans six mois.
 *   - **Explicabilité.** Chaque point de score NOMME sa raison. Un score sans
 *     motifs ne se conteste pas et ne se défend pas.
 *   - **Un signal absent n'est jamais un signal négatif.** Si la vélocité n'a
 *     pas pu être lue, on l'écrit (`SIGNAL_UNAVAILABLE`) et on ajoute une
 *     petite incertitude. La faire passer pour zéro reviendrait à récompenser
 *     une panne du cache.
 */

const {
  evaluateBaseline,
  BASELINE_SIGNALS,
} = require("./behaviorBaseline");

/**
 * Bandes de décision.
 *
 * `REVIEW` n'est PAS un refus : la transaction est créée en `pending_review` et
 * attend un opérateur. C'est ce que font Stripe et Wise, et c'est très
 * différent d'un 403 — lequel dit « non » à un client légitime sans lui laisser
 * de recours ni laisser de trace exploitable.
 */
const BANDS = Object.freeze({
  REVIEW: 0.55,
  BLOCK: 0.85,
});

/**
 * ⚠️ PLAFOND DES SIGNAUX MOUS — SEUL UN SIGNAL DUR PEUT BLOQUER.
 *
 * Trouvé en écrivant les tests, et c'est un défaut de calibrage réel : cinq
 * signaux modérés (montant proche de la limite, rafale, compte neuf,
 * bénéficiaire neuf, KYC incomplet) totalisent exactement 1.00 et franchissaient
 * donc la bande de blocage.
 *
 * Or ce profil décrit aussi, mot pour mot, **un nouveau client honnête faisant
 * son premier virement important vers un proche**. Le refuser d'un 403 le
 * laisse sans recours et sans explication — précisément ce que la bande
 * « revue » existe pour éviter.
 *
 * La règle appliquée est celle des grands émetteurs : **un système automatique
 * met en REVUE ; le refus sec est réservé à une correspondance certaine**
 * (liste noire, sanction). Les signaux mous s'accumulent donc librement, mais
 * plafonnent juste sous la bande de blocage : ils peuvent toujours déclencher
 * une revue, jamais un refus.
 *
 * Le score réel reste consultable dans `rawScore` — le plafond ne doit pas
 * masquer l'information à l'opérateur qui traitera le dossier.
 */
const SOFT_SCORE_CAP = 0.84;

/**
 * Poids des signaux. Additifs, puis bornés à 1.
 *
 * Ils sont ici, en un seul endroit et gelés, pour qu'un ajustement soit un
 * changement VISIBLE en revue de code — et non une constante enfouie dans une
 * condition.
 */
const WEIGHTS = Object.freeze({
  /** Le montant dépasse la limite unitaire du rail. Signal fort et objectif. */
  AMOUNT_OVER_SINGLE_LIMIT: 0.5,
  /** Montant proche de la limite : le fractionnement commence ici. */
  AMOUNT_NEAR_SINGLE_LIMIT: 0.15,

  /** Rafale : beaucoup de virements en peu de temps. */
  VELOCITY_COUNT_BURST: 0.3,
  /** Cumul inhabituel sur 24 h. */
  VELOCITY_AMOUNT_DAILY: 0.25,
  /** Même bénéficiaire martelé en quelques minutes. */
  VELOCITY_SAME_DESTINATION: 0.2,

  /** Compte créé il y a peu : le fraudeur n'attend pas. */
  NEW_ACCOUNT: 0.2,
  /** Bénéficiaire jamais vu sur ce compte. */
  NEW_BENEFICIARY: 0.1,
  /** KYC non finalisé alors que le montant le justifierait. */
  KYC_INSUFFICIENT: 0.25,

  /* ---------------------------------------------------------------------
   * ÉCART À L'HABITUDE DU TITULAIRE — le signal central des fintechs
   * ---------------------------------------------------------------------
   * Les poids ci-dessus comparent au RAIL, donc à tout le monde. Ceux-ci
   * comparent le client À LUI-MÊME. C'est la différence entre « ce montant
   * est gros » et « ce montant est gros POUR CE CLIENT », et c'est la
   * seconde question qui sépare une fraude d'un gros virement légitime.
   *
   * ⚠️ TOUS MOUS. Ensemble ils valent 0.80, donc ils peuvent déclencher une
   * REVUE (0.55) mais jamais franchir seuls le blocage (0.85) — et le
   * plafond `SOFT_SCORE_CAP` le garantit même cumulés au reste. Un client qui
   * change d'habitude doit pouvoir s'expliquer, pas se heurter à un refus.
   */
  /** Montant nettement au-dessus de l'habitude du titulaire. */
  AMOUNT_ABOVE_CUSTOMER_HABIT: 0.2,
  /** Montant sans commune mesure avec son habitude. Exclusif du précédent. */
  AMOUNT_FAR_ABOVE_CUSTOMER_HABIT: 0.35,
  /** Au-delà du plus gros envoi jamais confirmé par ce compte. */
  AMOUNT_ABOVE_CUSTOMER_MAX: 0.15,
  /** Heure à laquelle ce client n'opère jamais. */
  UNUSUAL_HOUR_FOR_CUSTOMER: 0.1,

  /** Un signal qu'on n'a PAS pu lire. Petit, mais jamais nul. */
  SIGNAL_UNAVAILABLE: 0.05,
});

/** Seuils de déclenchement des signaux de vélocité. */
const THRESHOLDS = Object.freeze({
  COUNT_LAST_HOUR: 5,
  SAME_DESTINATION_10MIN: 3,
  /** Part de la limite unitaire au-delà de laquelle on parle de « proche ». */
  NEAR_LIMIT_RATIO: 0.9,
  /** Multiple de la limite unitaire au-delà duquel le cumul 24 h alerte. */
  DAILY_TOTAL_MULTIPLE: 3,
  NEW_ACCOUNT_DAYS: 7,
});

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * @param {object} input
 * @param {number} input.amount                montant, dans la devise du rail
 * @param {number} input.singleTxLimit         limite unitaire du rail
 * @param {object|null} input.velocity         compteurs Redis, ou `null` si illisible
 * @param {object|null} input.stats            statistiques base, ou `null`
 * @param {number|null} input.accountAgeDays   âge du compte, ou `null` si inconnu
 * @param {boolean} input.isNewBeneficiary
 * @param {string} input.kycLevel
 * @param {boolean} input.sanctioned           signal DUR
 * @param {object|null} input.blacklistHit     signal DUR
 * @param {object|null} input.baseline         référence du titulaire, ou `null`
 * @param {number|null} input.hour             heure UTC (0-23) de l'opération
 *
 * @returns {{score: number, band: "allow"|"review"|"block", reasons: Array, hardBlock: boolean}}
 */
function computeRiskScore(input = {}) {
  const {
    amount = 0,
    singleTxLimit = 0,
    velocity = null,
    stats = null,
    accountAgeDays = null,
    isNewBeneficiary = false,
    kycLevel = "",
    sanctioned = false,
    blacklistHit = null,
    baseline = null,
    hour = null,
  } = input;

  const reasons = [];
  const add = (code, weight, detail) => {
    reasons.push({ code, weight, detail });
  };

  /* ==========================================================================
   * SIGNAUX DURS — ILS NE SE PONDÈRENT PAS
   * ==========================================================================
   * Une liste noire ou une sanction ne sont pas « un signal parmi d'autres » :
   * les diluer dans une somme pondérée permettrait à un profil par ailleurs
   * excellent de passer sous le seuil. Ils décident seuls.
   */
  if (blacklistHit) {
    add("BLACKLIST", 1, blacklistHit.code || "BLACKLISTED");
    return { score: 1, band: "block", reasons, hardBlock: true };
  }

  if (sanctioned) {
    add("SANCTIONED", 1, "personne sanctionnée ou politiquement exposée");
    return { score: 1, band: "block", reasons, hardBlock: true };
  }

  let score = 0;

  /* ------------------------------------------------------------- montant */
  const amt = num(amount);
  const limit = num(singleTxLimit);

  if (limit > 0) {
    if (amt > limit) {
      score += WEIGHTS.AMOUNT_OVER_SINGLE_LIMIT;
      add("AMOUNT_OVER_SINGLE_LIMIT", WEIGHTS.AMOUNT_OVER_SINGLE_LIMIT, `${amt} > ${limit}`);
    } else if (amt >= limit * THRESHOLDS.NEAR_LIMIT_RATIO) {
      /**
       * Juste sous la limite, de façon répétée, c'est la signature du
       * fractionnement (« structuring ») : découper un gros montant en
       * plusieurs virements qui passent chacun sous le seuil.
       */
      score += WEIGHTS.AMOUNT_NEAR_SINGLE_LIMIT;
      add("AMOUNT_NEAR_SINGLE_LIMIT", WEIGHTS.AMOUNT_NEAR_SINGLE_LIMIT, `${amt} ≈ ${limit}`);
    }
  }

  /* ------------------------------------------------------------ vélocité */
  if (velocity === null && stats === null) {
    // Ni le cache ni la base n'ont répondu : on ne sait rien du rythme.
    score += WEIGHTS.SIGNAL_UNAVAILABLE;
    add("SIGNAL_UNAVAILABLE", WEIGHTS.SIGNAL_UNAVAILABLE, "vélocité illisible");
  } else {
    // Le cache est plus frais ; la base sert de repli. On prend le plus élevé
    // des deux : sous-estimer une rafale est le sens dangereux de l'erreur.
    const countLastHour = Math.max(
      num(velocity?.countLastHour),
      num(stats?.lastHour)
    );
    const dailyTotal = Math.max(num(velocity?.amountLast24h), num(stats?.dailyTotal));
    const sameDest = Math.max(
      num(velocity?.sameDestinationLast10min),
      num(stats?.sameDestShortTime)
    );

    if (countLastHour > THRESHOLDS.COUNT_LAST_HOUR) {
      score += WEIGHTS.VELOCITY_COUNT_BURST;
      add("VELOCITY_COUNT_BURST", WEIGHTS.VELOCITY_COUNT_BURST, `${countLastHour} virements en 1 h`);
    }

    if (limit > 0 && dailyTotal > limit * THRESHOLDS.DAILY_TOTAL_MULTIPLE) {
      score += WEIGHTS.VELOCITY_AMOUNT_DAILY;
      add("VELOCITY_AMOUNT_DAILY", WEIGHTS.VELOCITY_AMOUNT_DAILY, `${dailyTotal} cumulés sur 24 h`);
    }

    if (sameDest >= THRESHOLDS.SAME_DESTINATION_10MIN) {
      score += WEIGHTS.VELOCITY_SAME_DESTINATION;
      add("VELOCITY_SAME_DESTINATION", WEIGHTS.VELOCITY_SAME_DESTINATION, `${sameDest} vers le même bénéficiaire en 10 min`);
    }
  }

  /* --------------------------------------------------------------- profil */
  if (accountAgeDays === null) {
    score += WEIGHTS.SIGNAL_UNAVAILABLE;
    add("SIGNAL_UNAVAILABLE", WEIGHTS.SIGNAL_UNAVAILABLE, "âge du compte inconnu");
  } else if (num(accountAgeDays) < THRESHOLDS.NEW_ACCOUNT_DAYS) {
    score += WEIGHTS.NEW_ACCOUNT;
    add("NEW_ACCOUNT", WEIGHTS.NEW_ACCOUNT, `compte créé il y a ${num(accountAgeDays)} j`);
  }

  if (isNewBeneficiary) {
    score += WEIGHTS.NEW_BENEFICIARY;
    add("NEW_BENEFICIARY", WEIGHTS.NEW_BENEFICIARY, "bénéficiaire jamais utilisé");
  }

  /* ----------------------------------------- écart à l'habitude du client */
  const verdictBaseline = evaluateBaseline({ amount: amt, hour, baseline });

  if (!verdictBaseline.available) {
    /**
     * ⚠️ « Habitude inconnue » N'EST PAS « habitude respectée ». Le client
     * neuf, le client rare, la base illisible : dans les trois cas on ignore
     * ce qui est normal pour lui, et l'ignorer en silence reviendrait à
     * récompenser l'absence d'historique — précisément ce qu'un compte
     * jetable offre à un fraudeur.
     */
    score += WEIGHTS.SIGNAL_UNAVAILABLE;
    add(
      "SIGNAL_UNAVAILABLE",
      WEIGHTS.SIGNAL_UNAVAILABLE,
      verdictBaseline.reason || "habitude du titulaire inconnue"
    );
  } else {
    for (const signal of verdictBaseline.signals) {
      const poids = WEIGHTS[signal.code];

      /**
       * Un code sans poids déclaré serait compté zéro EN SILENCE — donc une
       * règle écrite mais inopérante, ce qui est pire qu'une règle absente.
       * On le nomme au lieu de l'ignorer.
       */
      if (!Number.isFinite(poids)) {
        score += WEIGHTS.SIGNAL_UNAVAILABLE;
        add(
          "SIGNAL_UNAVAILABLE",
          WEIGHTS.SIGNAL_UNAVAILABLE,
          `poids manquant pour ${signal.code}`
        );
        continue;
      }

      score += poids;
      add(signal.code, poids, signal.detail);
    }
  }

  /**
   * Le KYC n'est un signal que si le MONTANT le justifie : exiger une pièce
   * d'identité pour un virement de 5 € ferait fuir les clients honnêtes sans
   * gêner personne d'autre.
   */
  const kyc = String(kycLevel || "").trim().toLowerCase();
  const kycInsufficient = !kyc || kyc === "none" || kyc === "0" || kyc === "basic";

  if (kycInsufficient && limit > 0 && amt >= limit * THRESHOLDS.NEAR_LIMIT_RATIO) {
    score += WEIGHTS.KYC_INSUFFICIENT;
    add("KYC_INSUFFICIENT", WEIGHTS.KYC_INSUFFICIENT, `kycLevel=${kyc || "(vide)"} pour un montant élevé`);
  }

  /**
   * ⚠️ DEUX RÉDUCTIONS, ET TOUTES DEUX DOIVENT SE NOMMER.
   *
   * Défaut trouvé le 2026-09-23 en ajoutant les signaux d'habitude, et qui
   * dormait depuis l'écriture du module : le score subissait DEUX réductions
   * successives — la borne à 1 (`clamp01`), puis le plafond des signaux mous —
   * dont **une seule** était expliquée.
   *
   * Tant qu'aucun profil réel ne dépassait 1, la borne ne servait jamais et
   * personne ne pouvait le voir. Avec les signaux d'habitude, des profils
   * légitimes l'atteignent : l'opérateur aurait alors lu un dossier dont les
   * motifs totalisent 1.20 en face d'un score de 0.84, sans rien pour
   * expliquer l'écart de 0.36. Un score dont on ne peut pas refaire le calcul
   * n'est pas explicable — c'est la propriété que ce module revendique.
   *
   * Les trois valeurs sont donc rendues, et chaque marche est nommée :
   *   `signalSum` → somme brute des poids, ce que TOTALISENT les motifs ;
   *   `rawScore`  → bornée à 1, ce que l'opérateur voit dans le dossier ;
   *   `score`     → plafonnée aux signaux mous, ce qui décide de la bande.
   */
  const signalSum = Number(score.toFixed(10));
  const rawScore = clamp01(signalSum);
  const finalScore = Math.min(rawScore, SOFT_SCORE_CAP);

  if (rawScore < signalSum) {
    add(
      "SCORE_CLAMPED",
      0,
      `somme des signaux ${signalSum.toFixed(2)} bornée à 1`
    );
  }

  if (finalScore < rawScore) {
    add(
      "SOFT_SCORE_CAPPED",
      0,
      `score brut ${rawScore.toFixed(2)} plafonné à ${SOFT_SCORE_CAP} — aucun signal dur`
    );
  }

  return {
    score: finalScore,
    /** Non plafonné : c'est ce que l'opérateur doit voir dans le dossier. */
    rawScore,
    /** Somme brute des poids — ce que totalisent les motifs affichés. */
    signalSum,
    band: bandFor(finalScore),
    reasons,
    hardBlock: false,
  };
}

function bandFor(score) {
  if (score >= BANDS.BLOCK) return "block";
  if (score >= BANDS.REVIEW) return "review";
  return "allow";
}

/**
 * Résumé lisible par un humain — c'est ce qui apparaît dans le dossier de revue
 * et dans le journal AML. Sans lui, l'opérateur voit un nombre et doit deviner.
 */
function explainRisk(verdict) {
  if (!verdict?.reasons?.length) return "aucun signal de risque";

  return verdict.reasons
    .map((r) => `${r.code}${r.detail ? ` (${r.detail})` : ""}`)
    .join(" · ");
}

module.exports = {
  BANDS,
  BASELINE_SIGNALS,
  SOFT_SCORE_CAP,
  WEIGHTS,
  THRESHOLDS,
  computeRiskScore,
  explainRisk,
  bandFor,
};
