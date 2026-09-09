"use strict";

/**
 * LE BALAYAGE SOLDE ↔ GRAND LIVRE COUVRE TOUTE LA POPULATION, PAR ROTATION
 * ============================================================================
 *
 * Le troisième axe de réconciliation est le seul contrôle qui vérifie
 * l'invariant 2 de bout en bout : *le solde est-il bien le cumul de ses
 * écritures ?* La balance de vérification du grand livre ne le voit pas — un
 * doublon parfait la laisse ÉQUILIBRÉE.
 *
 * ── Le défaut, trouvé le 2026-09-03 ───────────────────────────────────────
 *
 * Le planificateur passait `limit = RECONCILIATION_LIMIT || 5000` à un balayage
 * paginé par clé dont le curseur `lastId` **repartait de `null` à chaque
 * exécution**. Sur les 20 000 portefeuilles mesurés, il rebalayait
 * indéfiniment les 5 000 plus petits `_id` : **15 000 n'étaient jamais
 * vérifiés**, et rien ne le disait. Le rapport annonçait « aucun écart ».
 *
 * Un contrôle qui ne voit jamais 75 % de la population ne couvre pas ce qu'on
 * croit — et c'est pire qu'un contrôle absent, parce qu'il rassure.
 *
 * ── Ce que ce test verrouille ─────────────────────────────────────────────
 *
 * 1. le point de reprise est REFUSÉ s'il est illisible (jamais un repli muet) ;
 * 2. la rotation avance tant que la population n'est pas épuisée ;
 * 3. elle repart de zéro — et seulement là — quand elle l'est ;
 * 4. le planificateur LIT le point de reprise et le REPASSE au balayage ;
 * 5. il le PERSISTE dans le document d'exécution.
 *
 * Retirer `after` de l'appel, ou cesser de persister le curseur, fait tomber
 * ce test.
 *
 * Lecture du source pour les points 4 et 5 : instancier le planificateur
 * résoudrait `getTxConn()`, donc une connexion Mongo. Aucun test de ce dépôt
 * n'en ouvre, et c'est ce qui les rend rapides.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const mongoose = require("mongoose");

const {
  parseAfter,
} = require("../src/services/reconciliation/walletLedgerReconciliationService");

const {
  construireEtatBalayage,
} = require("../src/services/reconciliation/reconciliationScheduler");

const CHEMIN_PLANIF = path.join(
  __dirname,
  "..",
  "src",
  "services",
  "reconciliation",
  "reconciliationScheduler.js"
);
const SOURCE = fs.readFileSync(CHEMIN_PLANIF, "utf8");

const OID = "64b7f3a1c2d4e5f601020304";

/* -------------------------------------------------------------------------- */
/* 1. Un point de reprise illisible est REFUSÉ                                */
/* -------------------------------------------------------------------------- */

test("un point de reprise illisible LÈVE — pas de repli muet sur le début", () => {
  for (const mauvais of ["pas-un-id", "123", "zzzz", "64b7f3a1c2d4e5f60102030"]) {
    assert.throws(
      () => parseAfter(mauvais),
      /Point de reprise illisible/i,
      `« ${mauvais} » doit être refusé : repartir du début en silence ferait ` +
        "rebalayer les mêmes portefeuilles sans que rien ne le signale"
    );
  }
});

test("l'absence de point de reprise est légitime — c'est le début d'une rotation", () => {
  for (const vide of [null, undefined, ""]) {
    assert.equal(parseAfter(vide), null);
  }
});

test("un identifiant valide est accepté, sous les deux formes", () => {
  assert.equal(String(parseAfter(OID)), OID);
  assert.equal(String(parseAfter(new mongoose.Types.ObjectId(OID))), OID);
});

/* -------------------------------------------------------------------------- */
/* 2 et 3. La rotation avance, puis se referme                                */
/* -------------------------------------------------------------------------- */

const rapport = (cursor, population = 20000) => ({
  cursor,
  population: { matching: population },
});

test("tant que la population n'est pas épuisée, le curseur AVANCE", () => {
  const etat = construireEtatBalayage(
    rapport({ lastSeen: OID, rotationCompleted: false }),
    { lastSeen: null, sweepsSinceRotation: 0, lastRotationAt: null }
  );

  assert.equal(etat.lastSeen, OID, "sans cela, le tour suivant repart du début");
  assert.equal(etat.rotationCompleted, false);
  assert.equal(etat.sweepsSinceRotation, 1);
  assert.equal(etat.population, 20000);
});

test("le compteur de tours s'incrémente — c'est ce qui rend le piétinement visible", () => {
  const etat = construireEtatBalayage(
    rapport({ lastSeen: OID, rotationCompleted: false }),
    { lastSeen: "000000000000000000000001", sweepsSinceRotation: 3, lastRotationAt: null }
  );

  assert.equal(etat.sweepsSinceRotation, 4);
});

test("une rotation ACHEVÉE repart de zéro, et seulement là", () => {
  const avant = new Date("2026-01-01T00:00:00Z");
  const etat = construireEtatBalayage(
    rapport({ lastSeen: OID, rotationCompleted: true }),
    { lastSeen: OID, sweepsSinceRotation: 3, lastRotationAt: avant }
  );

  assert.equal(etat.lastSeen, null, "le tour suivant doit repartir du début");
  assert.equal(etat.rotationCompleted, true);
  assert.equal(etat.sweepsSinceRotation, 0);
  assert.ok(etat.lastRotationAt > avant, "la date de rotation doit être rafraîchie");
});

test("un axe désactivé ne fabrique AUCUN état — un contrôle qui n'a pas tourné ne rapporte rien", () => {
  assert.equal(construireEtatBalayage(null, { lastSeen: null }), null);
  assert.equal(construireEtatBalayage(rapport({}), null), null);
});

/* -------------------------------------------------------------------------- */
/* 4 et 5. Le planificateur reprend ET persiste                               */
/* -------------------------------------------------------------------------- */

test("le planificateur LIT le point de reprise avant de balayer", () => {
  assert.match(
    SOURCE,
    /async function dernierPointDeReprise\(\)/,
    "sans lecture du point de reprise, chaque tour repart du début"
  );
  assert.match(SOURCE, /await dernierPointDeReprise\(\)/);
});

test("il le REPASSE au balayage — c'est le correctif lui-même", () => {
  const m = SOURCE.match(/reconcileWalletsAgainstLedger\(\{[\s\S]{0,220}?\}\)/);
  assert.ok(m, "appel au troisième axe introuvable");

  assert.match(
    m[0],
    /after:\s*reprise\.lastSeen/,
    "sans `after`, la pagination repart de `null` : les mêmes `limit` " +
      "portefeuilles sont rebalayés et le reste n'est JAMAIS vérifié"
  );
});

test("la lecture précède l'appel — un curseur lu après ne sert à rien", () => {
  const posLecture = SOURCE.indexOf("await dernierPointDeReprise()");
  const posAppel = SOURCE.indexOf("reconcileWalletsAgainstLedger({");
  assert.ok(posLecture > -1 && posAppel > -1);
  assert.ok(posLecture < posAppel);
});

test("il PERSISTE l'état de rotation dans le document d'exécution", () => {
  assert.match(
    SOURCE,
    /walletLedgerSweep:\s*construireEtatBalayage\(walletLedger,\s*reprise\)/,
    "un curseur calculé mais non écrit est perdu au prochain démarrage"
  );

  const modele = fs.readFileSync(
    path.join(__dirname, "..", "src", "models", "ReconciliationRun.js"),
    "utf8"
  );
  assert.match(
    modele,
    /walletLedgerSweep:\s*\{/,
    "le schéma doit déclarer le champ, sinon Mongoose le jette en silence"
  );
  for (const champ of ["lastSeen", "rotationCompleted", "population", "sweepsSinceRotation"]) {
    assert.match(modele, new RegExp(`${champ}:`), `champ ${champ} absent du schéma`);
  }
});

test("le balayage de fond ne garde pas ses verdicts « OK » en mémoire", () => {
  const m = SOURCE.match(/reconcileWalletsAgainstLedger\(\{[\s\S]{0,220}?\}\)/);
  assert.match(
    m[0],
    /keepResults:\s*false/,
    "garder 5 000 verdicts que personne ne lira sature la mémoire pour rien — " +
      "le fichier de service le documente explicitement"
  );
});

/* -------------------------------------------------------------------------- */
/* Le rapport doit permettre de LIRE sa propre couverture                     */
/* -------------------------------------------------------------------------- */

test("le journal du planificateur dit la couverture, pas seulement le verdict", () => {
  const m = SOURCE.match(/\[RECONCILE\] aucun écart[\s\S]{0,600}?\}\);/);
  assert.ok(m, "journal de succès introuvable");
  assert.match(
    m[0],
    /walletLedgerSweep/,
    "« aucun écart » sans la couverture se lit comme « toute la population va " +
      "bien » alors qu'une tranche seulement a été regardée (règle B.6)"
  );
});

test("le service rend population et curseur — sans quoi la couverture est indevinable", () => {
  const service = fs.readFileSync(
    path.join(
      __dirname,
      "..",
      "src",
      "services",
      "reconciliation",
      "walletLedgerReconciliationService.js"
    ),
    "utf8"
  );

  assert.match(service, /cursor:\s*\{[\s\S]{0,300}?rotationCompleted/);
  assert.match(service, /population:\s*\{[\s\S]{0,200}?sweepsToCover/);
  assert.match(
    service,
    /let lastId = startAfter;/,
    "le curseur doit PARTIR du point de reprise ; `let lastId = null` est le défaut d'origine"
  );
});
