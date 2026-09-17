"use strict";

/**
 * ============================================================================
 * « LIVE » NE VEUT PAS DIRE « FRAIS »
 * ============================================================================
 *
 * Le repli en base était borné à 24 h. Le taux dit « live », lui, ne l'était
 * pas — alors que le fournisseur branché PAR DÉFAUT (`open.er-api.com`, sans
 * clé) ne publie qu'une fois par jour et date lui-même sa table.
 *
 * Un taux de la veille entrait donc dans une tarification exactement comme un
 * taux de la minute, sans que rien ne les distingue. Sur un corridor volatil,
 * c'est la différence entre un prix juste et une perte à chaque opération.
 *
 * Ces tests portent sur les deux fonctions qui rendent le seuil VÉRIFIABLE :
 * l'âge d'un taux, et l'annonce du fournisseur réellement configuré (règle
 * B.6 — un service qui tourne sur une source gratuite doit le dire).
 *
 * Tests **purs** : aucune requête réseau.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  ageDuTaux,
  FX_LIVE_MAX_AGE_MS,
  FX_DB_SNAPSHOT_MAX_AGE_MS,
  fournisseurConfigure,
  isSnapshotFreshEnough,
} = require("../../src/services/pricing/exchangeRateService");

test("l'âge d'un taux se mesure depuis sa date d'émission", () => {
  const ilYaDeuxHeures = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  const age = ageDuTaux(ilYaDeuxHeures);

  assert.ok(age >= 2 * 3600 * 1000 - 5000 && age <= 2 * 3600 * 1000 + 5000);
});

test("une date illisible rend `null` — et non zéro", () => {
  /**
   * Zéro signifierait « tout frais » : la pire valeur de repli possible sur une
   * frontière de change, puisqu'elle franchit tous les contrôles (règle B.2).
   */
  assert.equal(ageDuTaux("pas une date"), null);
  assert.equal(ageDuTaux(null), null);
  assert.equal(ageDuTaux(undefined), null);
});

test("une date FUTURE ne vaut pas un âge négatif", () => {
  const demain = new Date(Date.now() + 86400 * 1000).toISOString();

  assert.equal(
    ageDuTaux(demain),
    0,
    "un âge négatif franchirait n'importe quel seuil de fraîcheur"
  );
});

test("le seuil de fraîcheur existe, et il est borné", () => {
  assert.ok(Number.isFinite(FX_LIVE_MAX_AGE_MS));
  assert.ok(FX_LIVE_MAX_AGE_MS > 0);

  assert.ok(
    FX_LIVE_MAX_AGE_MS <= 24 * 3600 * 1000,
    "un taux de plus de 24 h ne doit jamais tarifer par défaut"
  );

  assert.ok(Number.isFinite(FX_DB_SNAPSHOT_MAX_AGE_MS));
});

test("le fournisseur réellement branché s'annonce, avec sa conséquence", () => {
  const f = fournisseurConfigure();

  assert.ok(typeof f.nom === "string" && f.nom.length > 0);

  if (!f.avecCle) {
    assert.match(f.cadence, /quotidienne/);
    assert.ok(
      f.consequence && f.consequence.length > 0,
      "sans clé, le service tarife sur une source gratuite : la conséquence " +
        "doit être énoncée, pas devinée (règle B.6)"
    );
  }
});

/* -------------------------------------------------------------------------- */
/* Instantané de repli : l'âge est celui de la PUBLICATION                     */
/* -------------------------------------------------------------------------- */

const HEURE = 3600 * 1000;
const SEUIL = Math.min(FX_LIVE_MAX_AGE_MS, FX_DB_SNAPSHOT_MAX_AGE_MS);

test("un instantané enregistré À L'INSTANT mais publié il y a trop longtemps est périmé", () => {
  const snap = {
    rate: 0.0015,
    updatedAt: new Date(),
    asOfDate: new Date(Date.now() - SEUIL - HEURE),
  };

  assert.equal(
    isSnapshotFreshEnough(snap),
    false,
    "la date d'enregistrement ne rajeunit pas un taux : la borne doublerait"
  );
});

test("un instantané publié récemment reste utilisable", () => {
  assert.equal(
    isSnapshotFreshEnough({ rate: 0.0015, asOfDate: new Date(Date.now() - HEURE) }),
    true
  );
});

test("un instantané sans date de publication n'a pas d'âge connu : refusé", () => {
  assert.equal(isSnapshotFreshEnough({ rate: 0.0015, updatedAt: new Date() }), false);
  assert.equal(isSnapshotFreshEnough({ rate: 0.0015, asOfDate: "pas une date" }), false);
});

/* -------------------------------------------------------------------------- */
/* Une table fournisseur par période, pas un appel par paire                  */
/* -------------------------------------------------------------------------- */

const { creerCacheDeTable } = require("../../src/services/pricing/exchangeRateService");

test("mille paires demandées dans la période = UN appel fournisseur", async () => {
  let appels = 0;
  const lire = creerCacheDeTable({
    fetcher: async () => {
      appels += 1;
      return { rates: { USD: 1 }, asOfDate: new Date().toISOString() };
    },
    ttlMs: 60_000,
  });

  await Promise.all(Array.from({ length: 1000 }, () => lire()));
  await lire();

  assert.equal(appels, 1, "une lecture publique ne doit pas pouvoir épuiser le quota du fournisseur");
});

test("la table se relit après la période, et un échec n'est pas mis en cache", async () => {
  let horloge = 0;
  let appels = 0;
  let echouer = true;

  const lire = creerCacheDeTable({
    fetcher: async () => {
      appels += 1;
      if (echouer) throw new Error("429");
      return { rates: {} };
    },
    ttlMs: 1000,
    now: () => horloge,
  });

  await assert.rejects(lire());
  echouer = false;
  await lire();
  assert.equal(appels, 2, "l'échec ne doit pas rester en cache");

  horloge = 500;
  await lire();
  assert.equal(appels, 2);

  horloge = 1500;
  await lire();
  assert.equal(appels, 3);
});
