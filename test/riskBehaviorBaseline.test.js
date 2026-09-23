"use strict";

/**
 * ============================================================================
 * RÉFÉRENCE DE COMPORTEMENT PAR CLIENT
 * ============================================================================
 *
 * Chaque test vise un défaut PRÉCIS qui ferait passer une fraude ou refuser un
 * client honnête. Réintroduire la faute doit faire échouer le test (règle B.5).
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  BASELINE_CONFIG,
  BASELINE_SIGNALS,
  median,
  summarizeHistory,
  evaluateBaseline,
} = require("../src/services/risk/behaviorBaseline");

const { computeRiskScore, WEIGHTS, SOFT_SCORE_CAP, BANDS } =
  require("../src/services/risk/riskScore");

const {
  cacheKey,
  createBaselineStore,
  CACHE_TTL_SECONDS,
  BASELINE_STATUSES,
} = require("../src/services/risk/baselineStore");

/* ========================================================================== */
/* LA MÉDIANE — la statistique robuste                                        */
/* ========================================================================== */

test("médiane : une valeur aberrante ne déplace pas la référence", () => {
  const ordinaire = new Array(29).fill(20);

  assert.equal(median(ordinaire), 20);

  // ⚠️ LE DÉFAUT VISÉ : avec une MOYENNE, ce seul virement de 5 000 porterait
  // la référence à 186 — et tout virement de 1 000 paraîtrait alors normal.
  assert.equal(median([...ordinaire, 5000]), 20);
});

test("médiane : nombre pair d'éléments — moyenne des deux valeurs centrales", () => {
  assert.equal(median([10, 20, 30, 40]), 25);
});

test("médiane : les montants nuls ou négatifs sont écartés", () => {
  // Les inclure abaisserait la référence, donc rendrait TOUT virement anormal.
  assert.equal(median([0, -5, 100, 100, 100]), 100);
});

test("médiane : aucune donnée exploitable rend null, jamais zéro", () => {
  // Zéro serait une référence — et diviser par elle rendrait tout infini.
  assert.equal(median([]), null);
  assert.equal(median([0, 0]), null);
  assert.equal(median(null), null);
});

test("médiane : ne mute pas la liste reçue", () => {
  const source = [30, 10, 20];
  median(source);
  assert.deepEqual(source, [30, 10, 20]);
});

/* ========================================================================== */
/* LE RÉSUMÉ D'HISTORIQUE                                                     */
/* ========================================================================== */

test("résumé : compte, médiane, maximum et répartition horaire", () => {
  const resume = summarizeHistory([
    { amount: 10, hour: 14 },
    { amount: 20, hour: 14 },
    { amount: 30, hour: 9 },
  ]);

  assert.equal(resume.count, 3);
  assert.equal(resume.median, 20);
  assert.equal(resume.max, 30);
  assert.equal(resume.hourCounts[14], 2);
  assert.equal(resume.hourCounts[9], 1);
  assert.equal(resume.hourCounts.length, 24);
});

test("résumé : une heure hors bornes n'est comptée nulle part", () => {
  const resume = summarizeHistory([
    { amount: 10, hour: 24 },
    { amount: 10, hour: -1 },
    { amount: 10, hour: null },
  ]);

  assert.equal(
    resume.hourCounts.reduce((t, v) => t + v, 0),
    0
  );
  // Les montants, eux, restent comptés : une heure illisible n'invalide pas
  // le montant de la même ligne.
  assert.equal(resume.count, 3);
});

/* ========================================================================== */
/* LA COMPARAISON                                                             */
/* ========================================================================== */

function reference({ count = 30, median: med = 100, max = 200, heure = null } = {}) {
  const hourCounts = new Array(24).fill(0);

  if (heure === null) {
    /**
     * Historique concentré sur une plage ouvrable plausible, et réparti à
     * l'unité près : la garde de `evaluateBaseline` compte la SOMME des
     * seaux horaires, pas `count`. Un helper qui en distribuerait davantage
     * ferait passer la garde qu'on veut précisément éprouver.
     */
    for (let i = 0; i < count; i += 1) hourCounts[8 + (i % 12)] += 1;
  } else {
    hourCounts[heure] = count;
  }

  return { count, median: med, max, hourCounts };
}

test("référence non établie : en dessous du minimum, on ne compare pas", () => {
  const verdict = evaluateBaseline({
    amount: 100000,
    baseline: reference({ count: BASELINE_CONFIG.minTransactions - 1 }),
  });

  assert.equal(verdict.available, false);
  assert.equal(verdict.signals.length, 0);
  assert.match(verdict.reason, /habitude non établie/);
});

test("référence absente : `available` faux, et pas un blanc-seing silencieux", () => {
  const verdict = evaluateBaseline({ amount: 100000, baseline: null });

  assert.equal(verdict.available, false);
  assert.equal(verdict.signals.length, 0);
});

test("montant conforme à l'habitude : aucun signal", () => {
  const verdict = evaluateBaseline({ amount: 120, baseline: reference() });

  assert.equal(verdict.available, true);
  assert.equal(
    verdict.signals.filter((s) => s.code.startsWith("AMOUNT_")).length,
    0
  );
});

test("écart modéré : signal SOUPLE, et pas le signal fort", () => {
  // 100 × 6 = 600, seuil souple atteint, seuil dur (×15) non.
  const verdict = evaluateBaseline({ amount: 600, baseline: reference({ max: 5000 }) });
  const codes = verdict.signals.map((s) => s.code);

  assert.ok(codes.includes(BASELINE_SIGNALS.ABOVE_HABIT));
  assert.ok(!codes.includes(BASELINE_SIGNALS.FAR_ABOVE_HABIT));
});

test("écart majeur : signal FORT, et les deux ne se cumulent jamais", () => {
  const verdict = evaluateBaseline({ amount: 2000, baseline: reference({ max: 50000 }) });
  const codes = verdict.signals.map((s) => s.code);

  assert.ok(codes.includes(BASELINE_SIGNALS.FAR_ABOVE_HABIT));

  // ⚠️ LE DÉFAUT VISÉ : cumuler les deux compterait deux fois le même fait et
  // pousserait vers la revue des clients qui n'ont dépassé qu'un seuil.
  assert.ok(!codes.includes(BASELINE_SIGNALS.ABOVE_HABIT));
});

test("dépassement du plus gros envoi connu : signal distinct de l'écart à la médiane", () => {
  // Montant sous le seuil souple (×6) mais au-delà du record (200 × 1.5 = 300).
  const verdict = evaluateBaseline({ amount: 400, baseline: reference({ max: 200 }) });
  const codes = verdict.signals.map((s) => s.code);

  assert.ok(codes.includes(BASELINE_SIGNALS.ABOVE_HISTORICAL_MAX));
  assert.ok(!codes.includes(BASELINE_SIGNALS.ABOVE_HABIT));
});

test("le ratio est rendu, pour que le dossier de revue soit lisible", () => {
  const verdict = evaluateBaseline({ amount: 1000, baseline: reference({ median: 100 }) });
  assert.equal(verdict.ratio, 10);
});

test("heure inhabituelle : signalée quand l'historique est assez fourni", () => {
  const verdict = evaluateBaseline({
    amount: 100,
    hour: 3,
    baseline: reference({ count: 60 }),
  });

  assert.ok(verdict.signals.some((s) => s.code === BASELINE_SIGNALS.UNUSUAL_HOUR));
});

test("heure inhabituelle : JAMAIS signalée sur un historique trop mince", () => {
  // ⚠️ LE DÉFAUT VISÉ : sur 10 opérations réparties sur 24 heures, presque
  // toute heure est « inhabituelle ». La règle crierait au loup en permanence.
  const verdict = evaluateBaseline({
    amount: 100,
    hour: 3,
    baseline: reference({ count: BASELINE_CONFIG.minTransactionsForHour - 1 }),
  });

  assert.ok(!verdict.signals.some((s) => s.code === BASELINE_SIGNALS.UNUSUAL_HOUR));
});

test("heure habituelle : aucun signal horaire", () => {
  const verdict = evaluateBaseline({
    amount: 100,
    hour: 14,
    baseline: reference({ count: 60 }),
  });

  assert.ok(!verdict.signals.some((s) => s.code === BASELINE_SIGNALS.UNUSUAL_HOUR));
});

test("comparaison : purement déterministe", () => {
  const args = { amount: 900, hour: 3, baseline: reference({ count: 60 }) };

  assert.deepEqual(evaluateBaseline(args), evaluateBaseline(args));
});

/* ========================================================================== */
/* INTÉGRATION DANS LE SCORE                                                  */
/* ========================================================================== */

const base = {
  amount: 100,
  singleTxLimit: 100000,
  velocity: { countLastHour: 1, amountLast24h: 100, sameDestinationLast10min: 0 },
  accountAgeDays: 400,
  kycLevel: "full",
};

test("score : tous les codes de référence ont un poids déclaré", () => {
  // ⚠️ LE DÉFAUT VISÉ : un code sans poids serait compté zéro en silence —
  // une règle écrite mais inopérante, pire qu'une règle absente.
  for (const code of Object.values(BASELINE_SIGNALS)) {
    assert.equal(
      typeof WEIGHTS[code],
      "number",
      `poids manquant pour ${code}`
    );
  }
});

test("score : référence inconnue → SIGNAL_UNAVAILABLE, jamais un silence", () => {
  const verdict = computeRiskScore({ ...base, baseline: null });

  const motifs = verdict.reasons.filter((r) => r.code === "SIGNAL_UNAVAILABLE");
  assert.ok(motifs.some((r) => /habitude non établie|référence illisible/.test(r.detail)));
});

test("score : un écart majeur à l'habitude pousse vers la REVUE", () => {
  const habituel = computeRiskScore({
    ...base,
    amount: 100,
    baseline: reference({ count: 60 }),
    hour: 14,
  });

  const anormal = computeRiskScore({
    ...base,
    amount: 5000,
    baseline: reference({ count: 60, median: 100, max: 200 }),
    hour: 3,
  });

  assert.equal(habituel.band, "allow");
  assert.ok(anormal.score > habituel.score);
  assert.equal(anormal.band, "review");
});

test("score : l'écart à l'habitude ne BLOQUE jamais à lui seul", () => {
  // ⚠️ L'INVARIANT LE PLUS IMPORTANT DE CE CHANTIER. Un client qui change
  // d'habitude doit pouvoir s'expliquer, pas se heurter à un 403.
  const verdict = computeRiskScore({
    ...base,
    amount: 5000,
    singleTxLimit: 100000,
    baseline: reference({ count: 60, median: 100, max: 200 }),
    hour: 3,
    velocity: null,
    stats: null,
    accountAgeDays: null,
    isNewBeneficiary: true,
    kycLevel: "",
  });

  assert.notEqual(verdict.band, "block");
  assert.ok(verdict.score <= SOFT_SCORE_CAP);
  assert.ok(verdict.score < BANDS.BLOCK);
});

test("score : un signal DUR bloque toujours, référence ou pas", () => {
  const verdict = computeRiskScore({
    ...base,
    baseline: reference({ count: 60 }),
    blacklistHit: { code: "FRAUDE_CONFIRMEE" },
  });

  assert.equal(verdict.band, "block");
  assert.equal(verdict.hardBlock, true);
});

test("score : chaque motif de référence NOMME son écart", () => {
  const verdict = computeRiskScore({
    ...base,
    amount: 5000,
    baseline: reference({ count: 60, median: 100, max: 200 }),
  });

  const motif = verdict.reasons.find(
    (r) => r.code === BASELINE_SIGNALS.FAR_ABOVE_HABIT
  );

  assert.ok(motif, "le motif doit être présent");
  assert.match(motif.detail, /× l'habitude/);
  // ⚠️ RÈGLE B.4 : le motif qualifie l'écart, il ne divulgue pas le montant.
  assert.ok(!/5000/.test(motif.detail));
});

/* ========================================================================== */
/* LE MAGASIN — bornes, cache, et l'absence d'exception                       */
/* ========================================================================== */

test("clé de cache : versionnée, et séparée par devise", () => {
  assert.equal(cacheKey("u1", "XOF"), "risk:baseline:v1:u1:XOF");

  // ⚠️ Mélanger deux devises produirait des rapports absurdes : 100 CAD et
  // 100 XOF n'ont rien à voir.
  assert.notEqual(cacheKey("u1", "XOF"), cacheKey("u1", "CAD"));

  // Sans devise, la clé reste distincte d'une devise nommée.
  assert.equal(cacheKey("u1", null), "risk:baseline:v1:u1:ANY");
});

test("la référence ne se calcule que sur des opérations CONFIRMÉES", () => {
  // ⚠️ LE DÉFAUT VISÉ : inclure les tentatives laisserait un fraudeur
  // FABRIQUER sa propre référence avant le virement qui compte.
  assert.deepEqual([...BASELINE_STATUSES], ["confirmed"]);
});

function modeleFactice({ lignes = [], leve = null } = {}) {
  const vues = [];

  return {
    vues,
    Model: {
      aggregate(pipeline) {
        vues.push(pipeline);
        return {
          option() {
            if (leve) return Promise.reject(leve);
            return Promise.resolve(lignes);
          },
        };
      },
    },
  };
}

test("magasin : la requête est bornée en volume ET en temps", async () => {
  const { Model, vues } = modeleFactice({ lignes: [] });

  let optionsVues = null;
  Model.aggregate = (pipeline) => {
    vues.push(pipeline);
    return {
      option(o) {
        optionsVues = o;
        return Promise.resolve([]);
      },
    };
  };

  const magasin = createBaselineStore({
    resolveModel: () => Model,
    buildAmountExpr: () => "$amount",
  });

  await magasin.read({ userId: "u1", currencyIso: "XOF" });

  const limite = vues[0].find((e) => e.$limit);
  assert.equal(limite.$limit, BASELINE_CONFIG.maxSamples);

  // ⚠️ Sans `maxTimeMS`, une base lente transforme un contrôle de risque en
  // panne de paiement.
  assert.ok(optionsVues.maxTimeMS > 0);
});

test("magasin : une agrégation qui échoue rend null — jamais une exception", async () => {
  const { Model } = modeleFactice({ leve: new Error("mongo indisponible") });

  const avertis = [];

  const magasin = createBaselineStore({
    resolveModel: () => Model,
    buildAmountExpr: () => "$amount",
    logger: { warn: (m) => avertis.push(m) },
  });

  const resultat = await magasin.read({ userId: "u1" });

  assert.equal(resultat, null);
  // ⚠️ RÈGLE B.1 : la panne est SIGNALÉE, pas avalée. Sans ce journal, une
  // agrégation cassée serait indiscernable d'un client sans historique.
  assert.equal(avertis.length, 1);
});

test("magasin : sans identifiant, rend null sans toucher la base", async () => {
  let appele = false;

  const magasin = createBaselineStore({
    resolveModel: () => {
      appele = true;
      return {};
    },
    buildAmountExpr: () => "$amount",
  });

  assert.equal(await magasin.read({ userId: "" }), null);
  assert.equal(appele, false);
});

test("magasin : le cache est relu, et il porte un TTL explicite", async () => {
  const stocke = new Map();
  let ttlVu = null;

  const redis = {
    status: "ready",
    async get(k) {
      return stocke.get(k) || null;
    },
    async set(k, v, mode, ttl) {
      ttlVu = { mode, ttl };
      stocke.set(k, v);
      return "OK";
    },
    async del(k) {
      stocke.delete(k);
      return 1;
    },
  };

  const { Model } = modeleFactice({
    lignes: [
      { amount: 10, hour: 9 },
      { amount: 30, hour: 9 },
    ],
  });

  const magasin = createBaselineStore({
    redisClient: redis,
    resolveModel: () => Model,
    buildAmountExpr: () => "$amount",
  });

  const premier = await magasin.read({ userId: "u1", currencyIso: "XOF" });
  assert.equal(premier.median, 20);

  // Laisse l'écriture best-effort aboutir.
  await new Promise((r) => setImmediate(r));

  // ⚠️ INVARIANT A.6 : aucune clé Redis sans expiration.
  assert.equal(ttlVu.mode, "EX");
  assert.equal(ttlVu.ttl, CACHE_TTL_SECONDS);

  const second = await magasin.read({ userId: "u1", currencyIso: "XOF" });
  assert.equal(second.median, 20);
  assert.equal(magasin.stats().hits, 1);
  assert.equal(magasin.stats().calculs, 1);
});

test("magasin : une entrée de cache illisible est ignorée, pas prise pour vide", async () => {
  // ⚠️ LE DÉFAUT VISÉ : rendre `{count: 0}` ferait croire à une habitude non
  // établie, alors qu'on n'a simplement pas su relire le cache.
  const redis = {
    status: "ready",
    async get() {
      return "{ceci n'est pas du json";
    },
    async set() {
      return "OK";
    },
  };

  const { Model } = modeleFactice({ lignes: [{ amount: 50, hour: 9 }] });

  const magasin = createBaselineStore({
    redisClient: redis,
    resolveModel: () => Model,
    buildAmountExpr: () => "$amount",
  });

  const resultat = await magasin.read({ userId: "u1" });
  assert.equal(resultat.median, 50);
  assert.equal(magasin.stats().calculs, 1);
});

test("magasin : une panne du cache ne fait pas échouer la lecture", async () => {
  const redis = {
    status: "ready",
    async get() {
      throw new Error("redis coupé");
    },
    async set() {
      throw new Error("redis coupé");
    },
  };

  const { Model } = modeleFactice({ lignes: [{ amount: 50, hour: 9 }] });

  const magasin = createBaselineStore({
    redisClient: redis,
    resolveModel: () => Model,
    buildAmountExpr: () => "$amount",
  });

  const resultat = await magasin.read({ userId: "u1" });
  assert.equal(resultat.median, 50);
});

test("magasin inerte : rend null, pas un résumé vide", async () => {
  // ⚠️ Un résumé vide se traduirait en « habitude établie et respectée »,
  // c'est-à-dire en blanc-seing accordé par une panne.
  const { baseline, resetRiskEngine } = require("../src/services/risk");
  resetRiskEngine();

  assert.equal(await baseline().read({ userId: "u1" }), null);
});
