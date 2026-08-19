"use strict";

/**
 * Idempotence du versement de parrainage.
 *
 * PÉRIMÈTRE — à lire avant d'ajouter un test ici. Ce fichier vérifie
 * l'ALGORITHME : détermination des clés, stabilité des empreintes, et la
 * séquence « poser le verrou avant de bouger l'argent ». Il ne vérifie pas
 * MongoDB, qui n'est pas disponible dans cette suite (contrainte du dépôt :
 * logique pure, aucun `.env`, aucune connexion).
 *
 * La garantie de bout en bout, index unique compris, se vérifie avec
 * `node scripts/verifyReferralIdempotency.js` contre une vraie base.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildPayoutIdempotencyKey,
  computeRequestFingerprint,
  computeBackoffMs,
  normalizeBeneficiaries,
} = require("../src/services/referral/referralKeys");

/* ────────────────────────────── CLÉ DE VERSEMENT ────────────────────────── */

test("la cle de versement suit le format impose par la specification", () => {
  assert.equal(
    buildPayoutIdempotencyKey("rw1", "usr9"),
    "REFERRAL_BONUS:rw1:usr9"
  );
});

test("la cle est deterministe : mille appels, une seule valeur", () => {
  const keys = new Set();

  for (let i = 0; i < 1000; i++) {
    keys.add(buildPayoutIdempotencyKey("reward-42", "user-7"));
  }

  assert.equal(keys.size, 1);
});

test("deux beneficiaires d'une meme recompense ont des cles distinctes", () => {
  const sponsor = buildPayoutIdempotencyKey("rw1", "sponsor1");
  const referee = buildPayoutIdempotencyKey("rw1", "referee1");

  assert.notEqual(sponsor, referee);
});

test("le meme beneficiaire sur deux recompenses a des cles distinctes", () => {
  assert.notEqual(
    buildPayoutIdempotencyKey("rw1", "user1"),
    buildPayoutIdempotencyKey("rw2", "user1")
  );
});

/* ─────────────────────────────── EMPREINTE ──────────────────────────────── */

const baseRequest = {
  rewardId: "rw1",
  treasuryUserId: "treasury1",
  treasurySystemType: "REFERRAL_TREASURY",
  treasuryCurrency: "CAD",
  bonusInputCurrency: "XOF",
  beneficiaries: [
    { userId: "sponsor1", role: "sponsor", amount: 2000, payoutCurrency: "XOF" },
    { userId: "referee1", role: "referee", amount: 1000, payoutCurrency: "XOF" },
  ],
};

test("l'empreinte est stable pour des parametres identiques", () => {
  assert.equal(
    computeRequestFingerprint(baseRequest),
    computeRequestFingerprint(baseRequest)
  );
});

test("l'ordre des beneficiaires ne change pas l'empreinte", () => {
  const reversed = {
    ...baseRequest,
    beneficiaries: [...baseRequest.beneficiaries].reverse(),
  };

  assert.equal(
    computeRequestFingerprint(baseRequest),
    computeRequestFingerprint(reversed)
  );
});

test("un montant different produit une empreinte differente", () => {
  const tampered = {
    ...baseRequest,
    beneficiaries: [
      { ...baseRequest.beneficiaries[0], amount: 5000 },
      baseRequest.beneficiaries[1],
    ],
  };

  assert.notEqual(
    computeRequestFingerprint(baseRequest),
    computeRequestFingerprint(tampered)
  );
});

test("un beneficiaire different produit une empreinte differente", () => {
  const tampered = {
    ...baseRequest,
    beneficiaries: [
      { ...baseRequest.beneficiaries[0], userId: "attaquant" },
      baseRequest.beneficiaries[1],
    ],
  };

  assert.notEqual(
    computeRequestFingerprint(baseRequest),
    computeRequestFingerprint(tampered)
  );
});

test("une tresorerie differente produit une empreinte differente", () => {
  assert.notEqual(
    computeRequestFingerprint(baseRequest),
    computeRequestFingerprint({ ...baseRequest, treasuryUserId: "autre" })
  );
});

/* ────────────────────────── FILTRAGE DES BÉNÉFICIAIRES ──────────────────── */

test("un beneficiaire a montant nul est ecarte : pas de cle, pas d'ecriture", () => {
  const list = normalizeBeneficiaries(
    [
      { userId: "a", role: "sponsor", amount: 2000, payoutCurrency: "XOF" },
      { userId: "b", role: "referee", amount: 0, payoutCurrency: "XOF" },
    ],
    "XOF"
  );

  assert.equal(list.length, 1);
  assert.equal(list[0].userId, "a");
});

test("un beneficiaire sans identifiant ou sans role est ecarte", () => {
  const list = normalizeBeneficiaries(
    [
      { userId: "", role: "sponsor", amount: 2000 },
      { userId: "b", role: "", amount: 1000 },
      { userId: "c", role: "referee", amount: 1000 },
    ],
    "XOF"
  );

  assert.equal(list.length, 1);
  assert.equal(list[0].userId, "c");
});

test("un montant negatif ne peut pas produire de versement", () => {
  const list = normalizeBeneficiaries(
    [{ userId: "a", role: "sponsor", amount: -5000, payoutCurrency: "XOF" }],
    "XOF"
  );

  assert.equal(list.length, 0);
});

test("les montants XOF sont arrondis a l'unite, les EUR au centime", () => {
  const xof = normalizeBeneficiaries(
    [{ userId: "a", role: "sponsor", amount: 2000.7 }],
    "XOF"
  );
  const eur = normalizeBeneficiaries(
    [{ userId: "a", role: "sponsor", amount: 4.006 }],
    "EUR"
  );

  assert.equal(xof[0].amount, 2001);
  assert.equal(eur[0].amount, 4.01);
});

/**
 * Cas limite documenté plutôt que corrigé.
 *
 * `(4.005).toFixed(2)` vaut "4.00" et non "4.01" : 4.005 n'est pas
 * représentable en IEEE 754 et vaut en réalité 4.00499…, donc l'arrondi au
 * centime inférieur est correct au regard de la valeur réellement stockée.
 *
 * Sans conséquence ici : les montants de bonus viennent d'un barème fixe
 * (2000 XOF, 4 EUR, 5 CAD…) et ne sont jamais le produit d'un calcul qui
 * tomberait sur un demi-centime. Ce test existe pour que ce comportement soit
 * constaté et assumé, et non découvert un jour comme une surprise.
 */
test("l'arrondi au demi-centime suit la representation IEEE 754", () => {
  const eur = normalizeBeneficiaries(
    [{ userId: "a", role: "sponsor", amount: 4.005 }],
    "EUR"
  );

  assert.equal(eur[0].amount, 4);
});

/* ─────────────────────────────── BACKOFF ────────────────────────────────── */

test("le delai de reprise croit avec les tentatives", () => {
  const first = computeBackoffMs(1, { baseMs: 1000, maxMs: 1_000_000 });
  const fifth = computeBackoffMs(5, { baseMs: 1000, maxMs: 1_000_000 });

  assert.ok(fifth > first, `${fifth} devrait depasser ${first}`);
});

test("le delai de reprise est plafonne", () => {
  const huge = computeBackoffMs(50, { baseMs: 1000, maxMs: 60_000 });

  // Plafond + gigue maximale (20 % du plafond, borne a 30 s).
  assert.ok(huge <= 60_000 + 12_000, `${huge} depasse le plafond attendu`);
});

test("la gigue disperse les reprises simultanees", () => {
  const delays = new Set();

  for (let i = 0; i < 50; i++) {
    delays.add(computeBackoffMs(3, { baseMs: 10_000, maxMs: 1_000_000 }));
  }

  // Sans gigue, les 50 valeurs seraient identiques et repartiraient ensemble.
  assert.ok(delays.size > 1, "les reprises ne sont pas dispersees");
});

/* ───────────────── SÉQUENCE : LE VERROU AVANT LE MOUVEMENT ──────────────── */

/**
 * Reproduction fidèle de la sémantique d'un index unique MongoDB : une clé déjà
 * présente fait échouer l'insertion avec un code 11000.
 */
function createUniqueStore() {
  const rows = new Map();

  return {
    rows,
    insert(key, value) {
      if (rows.has(key)) {
        throw Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
      }
      rows.set(key, value);
    },
  };
}

/**
 * Même séquence que `transferReferralBonus` : poser la clé D'ABORD, ne bouger
 * l'argent QUE si l'insertion a réussi.
 */
function attemptPayout({ store, rewardId, beneficiaryId, onMove }) {
  const key = buildPayoutIdempotencyKey(rewardId, beneficiaryId);

  try {
    store.insert(key, { beneficiaryId });
  } catch (err) {
    if (err.code === 11000) return { moved: false, reason: "ALREADY_PAID" };
    throw err;
  }

  onMove();
  return { moved: true };
}

test("100 evenements identiques ne produisent qu'un seul mouvement (§23)", () => {
  const store = createUniqueStore();
  let movements = 0;

  const results = [];

  for (let i = 0; i < 100; i++) {
    results.push(
      attemptPayout({
        store,
        rewardId: "rw-critique",
        beneficiaryId: "beneficiaire-1",
        onMove: () => {
          movements += 1;
        },
      })
    );
  }

  assert.equal(movements, 1, "l'argent a bouge plus d'une fois");
  assert.equal(store.rows.size, 1, "plus d'un versement enregistre");
  assert.equal(results.filter((r) => r.moved).length, 1);
  assert.equal(results.filter((r) => r.reason === "ALREADY_PAID").length, 99);
});

test("le verrou est pose AVANT le mouvement : un echec de crédit ne consomme pas la cle deux fois", () => {
  const store = createUniqueStore();
  let attempts = 0;

  const first = () =>
    attemptPayout({
      store,
      rewardId: "rw2",
      beneficiaryId: "b2",
      onMove: () => {
        attempts += 1;
        throw new Error("WALLET_CREDIT_FAILED");
      },
    });

  assert.throws(first, /WALLET_CREDIT_FAILED/);
  assert.equal(attempts, 1);

  // La cle a bien ete posee : une seconde tentative ne rebouge pas l'argent.
  const second = attemptPayout({
    store,
    rewardId: "rw2",
    beneficiaryId: "b2",
    onMove: () => {
      attempts += 1;
    },
  });

  assert.equal(second.moved, false);
  assert.equal(attempts, 1);
});

test("deux beneficiaires d'une meme recompense sont payes chacun une fois", () => {
  const store = createUniqueStore();
  const moved = [];

  for (let i = 0; i < 10; i++) {
    for (const beneficiaryId of ["sponsor1", "referee1"]) {
      attemptPayout({
        store,
        rewardId: "rw3",
        beneficiaryId,
        onMove: () => moved.push(beneficiaryId),
      });
    }
  }

  assert.deepEqual(moved.sort(), ["referee1", "sponsor1"]);
});
