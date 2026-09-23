"use strict";

/**
 * ============================================================================
 * CONSOMMATEURS DANS LE PROCESSUS WEB — le mode « un seul service »
 * ============================================================================
 *
 * Constaté le 2026-09-23 : hébergement à trois web services, aucun background
 * worker (payant). Les quatre consommateurs n'avaient jamais tourné : aucune
 * notification de transaction, surveillance AML asynchrone aveugle.
 *
 * Ce fichier échoue si quelqu'un :
 *   · remet le défaut à « aucun consommateur » — l'incident revient en silence
 *     sur tous les déploiements qui ne posent pas la variable ;
 *   · fait qu'une faute de frappe coupe les consommateurs ;
 *   · laisse une branche en échec empêcher les autres, ou le serveur ;
 *   · introduit une lecture BLOQUANTE, qui gèlerait le client Redis partagé
 *     avec le relais et la limitation de débit ;
 *   · recrée une deuxième liste de consommateurs dans `workers/all.js`.
 *
 * Test **pur** : aucune connexion.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const { BRANCHES, CLES, lireReglage, start } = require("../src/services/events/inlineConsumers");

const RACINE = path.join(__dirname, "..");
const lire = (...p) => fs.readFileSync(path.join(RACINE, ...p), "utf8");

function journal() {
  const lignes = { info: [], warn: [], error: [] };
  return {
    lignes,
    info: (m) => lignes.info.push(String(m)),
    warn: (m) => lignes.warn.push(String(m)),
    error: (m) => lignes.error.push(String(m)),
    debug() {},
  };
}

function fausseBranche(cle, { casse = false, arrets = [] } = {}) {
  return {
    cle,
    titre: cle,
    charger: () => ({
      build: () => {
        if (casse) throw new Error(`${cle} en panne`);
        return {
          groupe: `groupe-${cle}`,
          start: async () => ({ stop: () => arrets.push(cle) }),
        };
      },
    }),
  };
}

/* -------------------------------------------------------------------------- */

test("⚠️ SANS variable : TOUS les consommateurs démarrent", () => {
  /**
   * LE VERROU DU FICHIER. Un défaut « aucun » reproduirait exactement
   * l'incident : aucun déploiement existant ne pose cette variable.
   */
  const { cles, source } = lireReglage({});

  assert.deepStrictEqual(cles, CLES);
  assert.strictEqual(source, "default");
});

test("« false » les retire explicitement", () => {
  for (const v of ["false", "0", "off", "none"]) {
    assert.deepStrictEqual(lireReglage({ EVENT_CONSUMERS_INLINE: v }).cles, []);
  }
});

test("une liste choisit les branches", () => {
  assert.deepStrictEqual(
    lireReglage({ EVENT_CONSUMERS_INLINE: "notifications, risk" }).cles,
    ["risk", "notifications"]
  );
});

test("une faute de frappe NE coupe PAS les consommateurs, et se signale", () => {
  /**
   * Couper la surveillance AML et les notifications à cause de « notifs » au
   * lieu de « notifications » serait la pire lecture possible.
   */
  const r = lireReglage({ EVENT_CONSUMERS_INLINE: "notifs" });

  assert.deepStrictEqual(r.cles, CLES);
  assert.deepStrictEqual(r.inconnues, ["notifs"]);
});

test("les quatre consommateurs connus sont listés", () => {
  assert.deepStrictEqual([...CLES].sort(), ["notifications", "referral", "risk", "settlement"]);
});

/* -------------------------------------------------------------------------- */

test("une branche en panne n'empêche pas les autres, et le dit", async () => {
  const j = journal();
  const arrets = [];

  const h = await start({
    logger: j,
    env: {},
    branches: CLES.map((c) => fausseBranche(c, { casse: c === "risk", arrets })),
  });

  assert.deepStrictEqual(h.echecs, ["risk"]);
  assert.deepStrictEqual(h.demarres, ["settlement", "referral", "notifications"]);
  assert.ok(j.lignes.error.some((l) => l.includes("NON DÉMARRÉ")));

  h.stop();
  assert.deepStrictEqual(arrets, ["settlement", "referral", "notifications"]);
});

test("désactivé : rien ne démarre, et la CONSÉQUENCE est annoncée", async () => {
  // Règle B.6 : sans cette ligne, « aucun consommateur ici » ressemblerait à un
  // fonctionnement normal alors que rien ne lit le flux.
  const j = journal();

  const h = await start({
    logger: j,
    env: { EVENT_CONSUMERS_INLINE: "false" },
    branches: CLES.map((c) => fausseBranche(c)),
  });

  assert.deepStrictEqual(h.demarres, []);
  assert.ok(j.lignes.info.some((l) => /aucune notification de transaction/.test(l)));
});

test("le mode est annoncé au démarrage", async () => {
  const j = journal();

  await start({ logger: j, env: {}, branches: CLES.map((c) => fausseBranche(c)) });

  assert.ok(j.lignes.info.some((l) => /DANS le processus web : 4\/4/.test(l)));
});

/* -------------------------------------------------------------------------- */
/* Les invariants dont dépend ce mode                                          */
/* -------------------------------------------------------------------------- */

test("⚠️ la lecture du cadre de consommation n'est PAS bloquante", () => {
  /**
   * Ce mode partage le client Redis du serveur (invariant A8). Une lecture
   * `BLOCK` occuperait la connexion et gèlerait le relais, la limitation de
   * débit et tout le reste — le moteur d'argent attendrait un message.
   */
  const consumer = lire("src", "services", "events", "consumer.js");
  const appel = consumer.slice(consumer.indexOf("stream.readGroup("));
  const args = appel.slice(0, appel.indexOf(");"));

  assert.doesNotMatch(args, /blockMs/);

  const stream = lire("src", "services", "events", "stream.js");
  assert.match(stream, /Number\(blockMs\) > 0 \? \["BLOCK"/);
});

test("aucun nouveau client Redis n'est ouvert par ce mode", () => {
  const source = lire("src", "services", "events", "inlineConsumers.js");

  assert.doesNotMatch(source, /new Redis\(/);
  assert.doesNotMatch(source, /require\("ioredis"\)/);
});

test("le serveur démarre les consommateurs APRÈS le relais, et les arrête", () => {
  const serveur = lire("src", "server.js");

  const posRelais = serveur.indexOf("eventRelay = relais.start(");
  const posInline = serveur.indexOf('require("./services/events/inlineConsumers")');

  assert.ok(posRelais > -1);
  assert.ok(posInline > posRelais);
  assert.match(serveur, /inlineConsumers\?\.stop\?\.\(\)/);
});

test("workers/all.js utilise la MÊME liste — pas une copie", () => {
  const all = lire("workers", "all.js");

  assert.match(all, /require\("\.\.\/src\/services\/events\/inlineConsumers"\)\.BRANCHES/);
  assert.doesNotMatch(all, /require\("\.\.\/src\/services\/risk\/monitoringConsumer"\)/);
});

test("chaque branche pointe vers un fichier consommateur réel", () => {
  const fichiers = {
    risk: ["risk", "monitoringConsumer.js"],
    settlement: ["reconciliation", "settlementConsumer.js"],
    referral: ["referral", "referralConsumer.js"],
    notifications: ["notifications", "notificationConsumer.js"],
  };

  for (const b of BRANCHES) {
    assert.ok(
      fs.existsSync(path.join(RACINE, "src", "services", ...fichiers[b.cle])),
      `branche ${b.cle} : fichier introuvable`
    );
  }
});

/* -------------------------------------------------------------------------- */
/* Mode de déploiement — la bascule vers OVH                                  */
/* -------------------------------------------------------------------------- */

test("DEPLOYMENT_MODE=isolated sort les consommateurs du web", () => {
  const r = lireReglage({ DEPLOYMENT_MODE: "isolated" });

  assert.deepStrictEqual(r.cles, []);
  assert.strictEqual(r.source, "mode");
});

test("la variable explicite garde le dernier mot sur le mode", () => {
  assert.deepStrictEqual(
    lireReglage({ DEPLOYMENT_MODE: "isolated", EVENT_CONSUMERS_INLINE: "notifications" }).cles,
    ["notifications"]
  );
});

test("en mode isolé, l'annonce nomme la cause", async () => {
  const j = journal();

  await start({
    logger: j,
    env: { DEPLOYMENT_MODE: "isolated" },
    branches: CLES.map((c) => fausseBranche(c)),
  });

  assert.ok(j.lignes.info.some((l) => l.includes("DEPLOYMENT_MODE=isolated")));
});
