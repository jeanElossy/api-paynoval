"use strict";

/**
 * ============================================================================
 * SANTÉ DU BUS — UN CONSOMMATEUR ABSENT NE DOIT PLUS ÊTRE INVISIBLE
 * ============================================================================
 *
 * ── L'incident qui a produit ce fichier ────────────────────────────────────
 *
 * 2026-09-23 : transaction réelle, trois canaux activés, AUCUNE notification.
 * `worker:notifications` n'était pas déployé. `/readyz` vert, `/metrics` muet,
 * aucun journal. Les notifications de connexion arrivaient, elles — produites
 * dans le backend, sans traverser le bus — ce qui rendait la panne encore plus
 * déroutante.
 *
 * ── Ce que ce fichier doit attraper ─────────────────────────────────────────
 *
 * Il échoue si quelqu'un :
 *   · compte un groupe ABSENT comme « à jour » (le meilleur score pour le pire
 *     état) ;
 *   · confond « pas de transport » avec « groupes absents » (quatre alertes à
 *     chaque coupure de Redis — donc ignorées) ;
 *   · remplace un `lag` inconnu par 0 ;
 *   · ajoute un consommateur sans l'ajouter à la surveillance ;
 *   · fait passer `/readyz` au rouge sur un retard de notification ;
 *   · retire le contrôle du démarrage du serveur.
 *
 * Test **pur** : aucune connexion.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const {
  ETATS,
  GROUPES_ATTENDUS,
  evaluerGroupes,
  messagePour,
  start,
} = require("../src/services/events/busHealth");

const RACINE = path.join(__dirname, "..");

function groupe(nom, { lag = 0, pending = 0, consumers = 1 } = {}) {
  return { name: nom, lag, pending, consumers, lastDeliveredId: "0-0" };
}

const tousPresents = () => GROUPES_ATTENDUS.map((g) => groupe(g.nom));

/* -------------------------------------------------------------------------- */

test("⚠️ un groupe ABSENT est un défaut, jamais un groupe à jour", () => {
  /**
   * LE VERROU DU FICHIER. C'est exactement l'état de l'incident : le groupe
   * `notification-dispatch` n'existait pas, parce que son consommateur n'avait
   * jamais démarré.
   */
  const infos = tousPresents().filter((g) => g.name !== "notification-dispatch");

  const { groupes, degrade, critiqueAbsent } = evaluerGroupes({ infos, longueurFlux: 12 });

  const notif = groupes.find((g) => g.nom === "notification-dispatch");

  assert.strictEqual(notif.etat, ETATS.ABSENT);
  assert.strictEqual(degrade, true);
  assert.strictEqual(critiqueAbsent, true);

  // Son retard, c'est tout le flux : il n'en a jamais rien lu.
  assert.strictEqual(notif.retard, 12);
});

test("un groupe absent sur un flux VIDE reste un défaut", () => {
  /**
   * Le piège du zéro : sur un système au repos, le retard d'un groupe absent
   * vaut 0. Sans état distinct, un consommateur jamais déployé serait
   * indiscernable d'un consommateur parfaitement à jour — c'est pourquoi la
   * série `event_consumer_present` existe à côté du retard.
   */
  const { groupes } = evaluerGroupes({ infos: [], longueurFlux: 0 });

  for (const g of groupes) {
    assert.strictEqual(g.etat, ETATS.ABSENT);
    assert.strictEqual(g.retard, 0);
  }
});

test("pas de transport ≠ groupes absents", () => {
  /**
   * L'absence de MESURE et la mesure d'une ABSENCE sont deux choses. Les
   * confondre ferait alerter sur les quatre consommateurs à chaque coupure de
   * Redis — et une alerte qui sonne pour tout finit ignorée.
   */
  const { groupes, degrade, critiqueAbsent } = evaluerGroupes({ infos: null });

  for (const g of groupes) {
    assert.strictEqual(g.etat, ETATS.INCONNU);
    assert.strictEqual(g.retard, null);
  }

  assert.strictEqual(degrade, false);
  assert.strictEqual(critiqueAbsent, false);
});

test("un retard au-delà du seuil est signalé, en deçà non", () => {
  const infos = tousPresents().map((g) =>
    g.name === "notification-dispatch" ? groupe(g.name, { lag: 900 }) : g
  );

  const enRetard = evaluerGroupes({ infos, retardMax: 500 });
  assert.strictEqual(
    enRetard.groupes.find((g) => g.nom === "notification-dispatch").etat,
    ETATS.EN_RETARD
  );

  const leger = evaluerGroupes({
    infos: tousPresents().map((g) => groupe(g.name, { lag: 40 })),
    retardMax: 500,
  });

  // Quelques messages en vol : c'est un consommateur SAIN qui lit par lots.
  assert.strictEqual(leger.degrade, false);
});

test("un `lag` inconnu retombe sur les messages en attente, jamais sur 0", () => {
  /**
   * Redis < 7 ne rend pas `lag`, et Redis 7 le rend `null` quand il ne peut pas
   * le calculer. Zéro se lirait « à jour » — l'inverse exact de « je ne sais
   * pas ». Les messages non acquittés sont une borne inférieure : moins précis,
   * jamais trompeurs dans le sens rassurant.
   */
  const infos = tousPresents().map((g) =>
    g.name === "notification-dispatch" ? groupe(g.name, { lag: null, pending: 800 }) : g
  );

  const notif = evaluerGroupes({ infos, retardMax: 500 }).groupes.find(
    (g) => g.nom === "notification-dispatch"
  );

  assert.strictEqual(notif.retard, 800);
  assert.strictEqual(notif.etat, ETATS.EN_RETARD);
});

test("le message d'un défaut dit la CONSÉQUENCE et le CORRECTIF", () => {
  // Règle B.6 : un journal qui dit « absent » sans dire ce que cela coûte ni
  // comment le réparer oblige le lecteur à chercher lui-même, de nuit.
  const { groupes } = evaluerGroupes({ infos: [], longueurFlux: 3 });
  const message = messagePour(groupes.find((g) => g.nom === "notification-dispatch"));

  assert.match(message, /JAMAIS DÉMARRÉ/);
  assert.match(message, /AUCUNE notification de transaction/);
  assert.match(message, /npm run workers:all/);
  assert.match(message, /Rien n'est perdu/);
});

test("un groupe sain ne produit aucun message", () => {
  const { groupes } = evaluerGroupes({ infos: tousPresents() });

  for (const g of groupes) assert.strictEqual(messagePour(g), null);
});

test("seul le consommateur de notifications est « critique »", () => {
  /**
   * Critique = visible par l'utilisateur. C'est ce qui le fait journaliser en
   * `error` plutôt qu'en `warn`, donc réveiller d'autres règles d'alerte.
   */
  const critiques = GROUPES_ATTENDUS.filter((g) => g.critique).map((g) => g.nom);

  assert.deepStrictEqual(critiques, ["notification-dispatch"]);
});

/* -------------------------------------------------------------------------- */
/* La liste attendue suit les consommateurs réels                             */
/* -------------------------------------------------------------------------- */

test("TOUT consommateur du dépôt est surveillé — un nouveau fait échouer la suite", () => {
  /**
   * Les noms de groupes vivent dans quatre fichiers ; la liste surveillée en
   * est une copie. Sans ce test, un cinquième consommateur ajouté demain
   * retomberait exactement dans l'angle mort de l'incident.
   */
  const services = path.join(RACINE, "src", "services");
  const trouves = new Set();

  for (const dossier of fs.readdirSync(services)) {
    const complet = path.join(services, dossier);
    if (!fs.statSync(complet).isDirectory()) continue;

    for (const fichier of fs.readdirSync(complet)) {
      if (!fichier.endsWith(".js")) continue;

      const source = fs.readFileSync(path.join(complet, fichier), "utf8");
      const m = source.match(/^const GROUPE = "([^"]+)";/m);
      if (m) trouves.add(m[1]);
    }
  }

  assert.ok(trouves.size >= 4, `seulement ${trouves.size} consommateurs trouvés`);

  const surveilles = new Set(GROUPES_ATTENDUS.map((g) => g.nom));

  for (const nom of trouves) {
    assert.ok(
      surveilles.has(nom),
      `le consommateur « ${nom} » n'est PAS surveillé par busHealth.js — ajoutez-le ` +
        `à GROUPES_ATTENDUS, sinon son absence redeviendra invisible`
    );
  }

  for (const nom of surveilles) {
    assert.ok(trouves.has(nom), `busHealth.js surveille « ${nom} », qui n'existe plus`);
  }
});

/* -------------------------------------------------------------------------- */
/* Le contrôle périodique                                                     */
/* -------------------------------------------------------------------------- */

test("le contrôle ne lève jamais, même si la lecture échoue", async () => {
  /**
   * Une sonde d'observabilité qui casse ce qui l'appelle transforme un outil de
   * diagnostic en cause de panne. Sans Redis dans ces suites, `lireEtat` rend
   * « inconnu » — le tour doit simplement se terminer.
   */
  const journal = { error() {}, warn() {}, info() {}, debug() {} };
  const moniteur = start({ logger: journal, intervalMs: 60_000 });

  await moniteur.tour();
  moniteur.stop();
});

/* -------------------------------------------------------------------------- */
/* Le câblage                                                                 */
/* -------------------------------------------------------------------------- */

test("le serveur démarre le contrôle avec le relais, et l'arrête proprement", () => {
  const serveur = fs.readFileSync(path.join(RACINE, "src", "server.js"), "utf8");

  const posRelais = serveur.indexOf("eventRelay = relais.start(");
  const posSante = serveur.indexOf("busHealthMonitor = busHealth.start(");

  assert.ok(posRelais > -1);
  assert.ok(posSante > posRelais, "le contrôle doit démarrer avec le relais");

  assert.match(serveur, /busHealth\.registerMetrics\(metrics\)/);
  assert.match(serveur, /busHealthMonitor\?\.stop\?\.\(\)/);
});

test("⚠️ un consommateur absent ne rend PAS /readyz rouge", () => {
  /**
   * `/readyz` rouge sort l'instance de la rotation : une notification en retard
   * mettrait le MOTEUR D'ARGENT à l'arrêt. Correction financière et fiabilité
   * passent avant l'observabilité.
   */
  const readiness = fs.readFileSync(
    path.join(RACINE, "src", "services", "readiness.js"),
    "utf8"
  );

  assert.doesNotMatch(readiness, /busHealth/);
});

test("stream.groupes lit les champs par NOM, pas par position", () => {
  /**
   * L'ordre des champs de `XINFO GROUPS` a changé entre Redis 6 et 7 (`lag` et
   * `entries-read` sont apparus). Un accès par index se serait décalé sans
   * erreur, et aurait rendu le nombre de consommateurs à la place du retard.
   */
  const source = fs.readFileSync(
    path.join(RACINE, "src", "services", "events", "stream.js"),
    "utf8"
  );

  const corps = source.slice(source.indexOf("async function groupes()"));

  assert.match(corps, /champs\[String\(entree\[i\]\)\] = entree\[i \+ 1\]/);
  assert.match(corps, /xinfo\("GROUPS", FLUX\)/);
});
