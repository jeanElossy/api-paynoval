"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  BANDS,
  computeRiskScore,
  explainRisk,
  bandFor,
} = require("../src/services/risk/riskScore");

/**
 * Ce que ces tests protègent : `getMLScore` renvoyait `Math.random() * 0.4`.
 * Trois défauts cumulés — la même transaction notée deux fois donnait deux
 * scores, la branche aléatoire ne pouvait JAMAIS atteindre le seuil de 0.9, et
 * le score d'une transaction passée était irreproductible lors d'un litige.
 */

const BASE = {
  amount: 100,
  singleTxLimit: 1000,
  velocity: { countLastHour: 0, amountLast24h: 0, sameDestinationLast10min: 0 },
  stats: { lastHour: 0, dailyTotal: 0, sameDestShortTime: 0 },
  accountAgeDays: 400,
  isNewBeneficiary: false,
  kycLevel: "full",
  sanctioned: false,
  blacklistHit: null,
};

/* ==========================================================================
 * LA PROPRIÉTÉ FONDAMENTALE
 * ======================================================================== */

test("le même virement note TOUJOURS pareil", () => {
  /**
   * La propriété qui rend tout le reste possible : sans elle, ni test, ni
   * explication au client, ni justification à un contrôle. Cent tirages
   * suffisent à détruire toute survivance de hasard.
   */
  const entree = { ...BASE, amount: 950, accountAgeDays: 3 };
  const premier = computeRiskScore(entree);

  for (let i = 0; i < 100; i += 1) {
    const suivant = computeRiskScore(entree);
    assert.equal(suivant.score, premier.score);
    assert.deepEqual(suivant.reasons, premier.reasons);
  }
});

test("un virement ordinaire ne déclenche RIEN", () => {
  // Le premier devoir d'un contrôle antifraude est de ne pas gêner les clients
  // honnêtes : ils sont l'immense majorité.
  const v = computeRiskScore(BASE);

  assert.equal(v.score, 0);
  assert.equal(v.band, "allow");
  assert.deepEqual(v.reasons, []);
});

/* ==========================================================================
 * SIGNAUX DURS
 * ======================================================================== */

test("une liste noire décide SEULE — elle ne se pondère pas", () => {
  /**
   * Diluer une liste noire dans une somme pondérée permettrait à un profil par
   * ailleurs excellent de passer sous le seuil. Elle court-circuite le calcul.
   */
  const v = computeRiskScore({
    ...BASE,
    blacklistHit: { code: "BLACKLISTED_EMAIL" },
  });

  assert.equal(v.band, "block");
  assert.equal(v.hardBlock, true);
  assert.equal(v.score, 1);
  assert.equal(v.reasons[0].code, "BLACKLIST");
  assert.equal(v.reasons.length, 1, "aucun autre signal n'est évalué");
});

test("une sanction décide SEULE aussi", () => {
  const v = computeRiskScore({ ...BASE, sanctioned: true });

  assert.equal(v.band, "block");
  assert.equal(v.hardBlock, true);
});

/* ==========================================================================
 * MONTANT
 * ======================================================================== */

test("un montant au-dessus de la limite pèse lourd", () => {
  const v = computeRiskScore({ ...BASE, amount: 1500 });

  assert.ok(v.score >= 0.5);
  assert.ok(v.reasons.some((r) => r.code === "AMOUNT_OVER_SINGLE_LIMIT"));
});

test("un montant JUSTE SOUS la limite est un signal en soi", () => {
  /**
   * C'est la signature du fractionnement : découper un gros montant en
   * plusieurs virements passant chacun sous le seuil. Un contrôle qui ne
   * regarde que le dépassement ne voit jamais cette technique.
   */
  const v = computeRiskScore({ ...BASE, amount: 950 });

  assert.ok(v.reasons.some((r) => r.code === "AMOUNT_NEAR_SINGLE_LIMIT"));
  assert.equal(v.band, "allow", "seul, ce signal ne suffit pas à retenir");
});

test("sans limite connue, le montant n'invente aucun signal", () => {
  const v = computeRiskScore({ ...BASE, singleTxLimit: 0, amount: 999999 });

  assert.ok(!v.reasons.some((r) => r.code.startsWith("AMOUNT_")));
});

/* ==========================================================================
 * VÉLOCITÉ
 * ======================================================================== */

test("une rafale de virements est retenue", () => {
  const v = computeRiskScore({
    ...BASE,
    velocity: { countLastHour: 9, amountLast24h: 0, sameDestinationLast10min: 0 },
  });

  assert.ok(v.reasons.some((r) => r.code === "VELOCITY_COUNT_BURST"));
});

test("le même bénéficiaire martelé est retenu", () => {
  const v = computeRiskScore({
    ...BASE,
    velocity: { countLastHour: 0, amountLast24h: 0, sameDestinationLast10min: 4 },
  });

  assert.ok(v.reasons.some((r) => r.code === "VELOCITY_SAME_DESTINATION"));
});

test("on retient le PLUS ÉLEVÉ du cache et de la base", () => {
  /**
   * Le cache est plus frais, la base plus complète. Sous-estimer une rafale est
   * le sens DANGEREUX de l'erreur : entre les deux sources, on prend la plus
   * alarmante.
   */
  const v = computeRiskScore({
    ...BASE,
    velocity: { countLastHour: 0, amountLast24h: 0, sameDestinationLast10min: 0 },
    stats: { lastHour: 9, dailyTotal: 0, sameDestShortTime: 0 },
  });

  assert.ok(v.reasons.some((r) => r.code === "VELOCITY_COUNT_BURST"));
});

test("un signal ABSENT n'est jamais un signal négatif", () => {
  /**
   * ══ LE POINT LE PLUS IMPORTANT DE CE MODULE ══
   *
   * Si ni le cache ni la base ne répondent, on ne sait rien du rythme de ce
   * compte. Traiter cette absence comme un zéro reviendrait à RÉCOMPENSER une
   * panne du cache : il suffirait de la provoquer pour effacer la vélocité.
   *
   * On l'écrit, et on ajoute une petite incertitude.
   */
  const v = computeRiskScore({ ...BASE, velocity: null, stats: null });

  assert.ok(v.score > 0);
  assert.ok(
    v.reasons.some(
      (r) => r.code === "SIGNAL_UNAVAILABLE" && r.detail.includes("vélocité")
    )
  );
});

/* ==========================================================================
 * PROFIL
 * ======================================================================== */

test("un compte tout neuf pèse — le fraudeur n'attend pas", () => {
  const v = computeRiskScore({ ...BASE, accountAgeDays: 2 });

  assert.ok(v.reasons.some((r) => r.code === "NEW_ACCOUNT"));
});

test("le KYC ne compte QUE si le montant le justifie", () => {
  /**
   * Exiger une pièce d'identité pour un virement de 5 € ferait fuir les clients
   * honnêtes sans gêner personne d'autre. Le signal est conditionné au montant.
   */
  const petit = computeRiskScore({ ...BASE, kycLevel: "none", amount: 10 });
  const gros = computeRiskScore({ ...BASE, kycLevel: "none", amount: 950 });

  assert.ok(!petit.reasons.some((r) => r.code === "KYC_INSUFFICIENT"));
  assert.ok(gros.reasons.some((r) => r.code === "KYC_INSUFFICIENT"));
});

/* ==========================================================================
 * BANDES ET EXPLICABILITÉ
 * ======================================================================== */

test("la revue n'est PAS un refus", () => {
  /**
   * Un 403 dit « non » à un client légitime sans recours et sans trace
   * exploitable. `review` crée la transaction en `pending_review` : un
   * opérateur tranche. C'est ce que font Stripe et Wise.
   */
  assert.equal(bandFor(BANDS.REVIEW), "review");
  assert.equal(bandFor(BANDS.REVIEW - 0.01), "allow");
  assert.equal(bandFor(BANDS.BLOCK), "block");
});

test("plusieurs signaux moyens finissent par mériter une revue", () => {
  // Aucun de ces signaux ne suffit seul. Leur accumulation, si.
  const v = computeRiskScore({
    ...BASE,
    amount: 950,
    accountAgeDays: 1,
    isNewBeneficiary: true,
    kycLevel: "none",
    velocity: { countLastHour: 9, amountLast24h: 0, sameDestinationLast10min: 0 },
  });

  assert.equal(v.band, "review");
  assert.ok(v.reasons.length >= 4);
});

test("des signaux MOUS ne bloquent JAMAIS, même tous réunis", () => {
  /**
   * ══ CALIBRAGE TROUVÉ PAR CE TEST ══
   *
   * Ces cinq signaux totalisent exactement 1.00 et franchissaient la bande de
   * blocage. Or ce profil décrit aussi, mot pour mot, un nouveau client honnête
   * faisant son premier virement important vers un proche. Le refuser d'un 403
   * le laisse sans recours et sans explication.
   *
   * Règle des grands émetteurs : un système automatique met en REVUE, le refus
   * sec est réservé à une correspondance certaine.
   */
  const v = computeRiskScore({
    ...BASE,
    amount: 999999,
    accountAgeDays: 0,
    isNewBeneficiary: true,
    kycLevel: "none",
    velocity: { countLastHour: 99, amountLast24h: 9e9, sameDestinationLast10min: 99 },
  });

  assert.equal(v.rawScore, 1, "le score brut, lui, sature bien à 1");
  assert.ok(v.score < BANDS.BLOCK);
  assert.equal(v.band, "review");
  assert.ok(v.reasons.some((r) => r.code === "SOFT_SCORE_CAPPED"));
});

test("le plafond ne CACHE pas le score réel à l'opérateur", () => {
  // C'est lui qui traitera le dossier : lui montrer un score rogné sans le dire
  // fausserait son jugement.
  const v = computeRiskScore({
    ...BASE,
    amount: 999999,
    accountAgeDays: 0,
    isNewBeneficiary: true,
    kycLevel: "none",
    velocity: { countLastHour: 99, amountLast24h: 9e9, sameDestinationLast10min: 99 },
  });

  assert.ok(v.rawScore > v.score);
  assert.match(explainRisk(v), /SOFT_SCORE_CAPPED/);
});

test("chaque point de score NOMME sa raison", () => {
  /**
   * Un score sans motifs ne se conteste pas et ne se défend pas. C'est aussi ce
   * que l'opérateur lit dans le dossier de revue : sans lui, il voit un nombre
   * et doit deviner.
   */
  const v = computeRiskScore({ ...BASE, amount: 1500, accountAgeDays: 1 });

  const somme = v.reasons.reduce((t, r) => t + r.weight, 0);
  assert.equal(Number(somme.toFixed(10)), Number(v.score.toFixed(10)));

  const texte = explainRisk(v);
  assert.match(texte, /AMOUNT_OVER_SINGLE_LIMIT/);
  assert.match(texte, /NEW_ACCOUNT/);
});

test("aucun signal, aucun texte inventé", () => {
  assert.equal(explainRisk(computeRiskScore(BASE)), "aucun signal de risque");
  assert.equal(explainRisk(null), "aucun signal de risque");
});
