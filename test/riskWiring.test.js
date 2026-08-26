"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const mongoose = require("mongoose");

/**
 * ⚠️ LES COMMENTAIRES SONT RETIRÉS AVANT TOUTE RECHERCHE.
 *
 * Sans cela, ces tests se déclenchent sur leur propre documentation : les
 * fichiers concernés expliquent en toutes lettres ce qui a été retiré (« cette
 * fonction renvoyait `Math.random() * 0.4` »), et une recherche naïve prend
 * cette explication pour du code vivant. Même piège que dans
 * `transactionStatusInvariant.test.js` et `adminTxProxy.test.js`.
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const lire = (chemin) =>
  stripComments(fs.readFileSync(require.resolve(chemin), "utf8"));

const AML_MIDDLEWARE = lire("../src/middleware/aml");
const AML_SERVICE = lire("../src/services/aml");
const INIT_INTERNE = lire("../src/services/transactions/handlers/initiateInternal");
const INIT_EXTERNE = lire(
  "../src/services/transactions/handlers/initiateExternalTransactions"
);

/**
 * Le câblage est la partie du chantier qu'aucun test unitaire ne couvre : les
 * trois modules peuvent être parfaits et n'être appelés par personne. Un score
 * de risque qui ne décide de rien est plus dangereux qu'une absence de score,
 * parce qu'il donne l'apparence d'un contrôle.
 */

test("le générateur aléatoire a disparu, et ne peut pas revenir en silence", () => {
  /**
   * `getMLScore` renvoyait `Math.random() * 0.4`. Le seuil de blocage valait
   * 0.9 : la branche aléatoire ne bloquait JAMAIS. Et le score d'une
   * transaction passée était irreproductible lors d'un litige.
   */
  assert.ok(!/async function getMLScore/.test(AML_SERVICE));
  assert.ok(!/Math\.random/.test(AML_SERVICE), "aucun hasard dans le service AML");
  assert.ok(!/getMLScore\(/.test(AML_MIDDLEWARE), "plus aucun appelant");
});

test("aucun hasard dans le chemin de décision du risque", () => {
  const risque = lire("../src/services/risk/riskScore");

  assert.ok(!/Math\.random/.test(risque));
  // Pas d'horloge non plus : une note doit être reproductible six mois plus tard.
  assert.ok(!/Date\.now\(\)/.test(risque));
  assert.ok(!/new Date\(/.test(risque));
});

test("les trois bandes sont branchées, pas seulement le blocage", () => {
  /**
   * L'ancien code n'avait que deux issues : passer ou refuser sèchement. Un 403
   * dit « non » à un client légitime sans recours, sans explication et sans
   * dossier qu'un opérateur puisse reprendre.
   */
  assert.match(AML_MIDDLEWARE, /riskVerdict\.band === "block"/);
  assert.match(AML_MIDDLEWARE, /riskVerdict\.band === "review"/);
  assert.match(AML_MIDDLEWARE, /req\.riskVerdict = riskVerdict/);
});

test("la revue N'EST PAS un refus — elle ne renvoie aucun 403", () => {
  const bloc = AML_MIDDLEWARE.slice(
    AML_MIDDLEWARE.indexOf('if (riskVerdict.band === "review")'),
    AML_MIDDLEWARE.indexOf("riskEngine\n      .velocity()\n      .record(")
  );

  assert.ok(bloc.length > 0, "bloc de revue introuvable");
  assert.ok(!/res\.status\(403\)/.test(bloc));
  assert.match(bloc, /flagged: true/, "le dossier de revue doit exister");
});

test("les DEUX handlers d'initiation honorent la bande revue", () => {
  // Ne câbler que le rail interne laisserait tout le trafic externe hors
  // contrôle — c'est-à-dire précisément celui qui fait sortir l'argent.
  for (const [nom, source] of [["interne", INIT_INTERNE], ["externe", INIT_EXTERNE]]) {
    assert.match(
      source,
      /riskVerdict\?\.band === "review" \? "pending_review" : "pending"/,
      `rail ${nom} non branché`
    );
    assert.match(source, /riskScore:/, `rail ${nom} : score non persisté`);
    assert.match(source, /riskReasons:/, `rail ${nom} : motifs non persistés`);
  }
});

test("le dossier de risque est DÉCLARÉ au schéma", () => {
  /**
   * Mongoose est en mode strict : un champ non déclaré est jeté SILENCIEUSEMENT
   * à l'écriture. Le handler les poserait, la base ne les garderait pas, et la
   * file de revue n'afficherait que des transactions sans motif — sans qu'aucune
   * erreur n'apparaisse nulle part.
   */
  const conn = mongoose.createConnection();
  const schema = require("../src/models/Transaction")(conn).schema;

  assert.ok(schema.path("riskScore"), "riskScore absent du schéma");
  assert.ok(schema.path("riskReasons"), "riskReasons absent du schéma");
  assert.equal(schema.path("riskScore").options.index, true, "la file de revue trie par risque");
});

test("`pending_review` est une transition que la machine à états connaît", () => {
  // Poser un état que le moteur refuse produirait une transaction que le reste
  // de la chaîne considère comme impossible.
  const { STATES } = require("../src/services/transactionStateMachine");
  assert.equal(STATES.PENDING_REVIEW, "pending_review");
});

test("la vélocité est enregistrée SANS pouvoir faire échouer le virement", () => {
  /**
   * Perdre un compteur dégrade un signal futur ; faire échouer ce virement-ci
   * parce que le cache n'a pas répondu serait bien pire. D'où l'absence
   * d'`await` et le `.catch()`.
   */
  const bloc = AML_MIDDLEWARE.slice(AML_MIDDLEWARE.indexOf("riskEngine\n      .velocity()\n      .record("));

  assert.match(bloc.slice(0, 400), /\.catch\(\(\) => \{\}\)/);
  assert.ok(!/await riskEngine\s*\.\s*velocity\(\)\s*\.record/.test(AML_MIDDLEWARE));
});

test("la liste noire interroge la base ET la liste statique, par un OU", () => {
  /**
   * Jamais une intersection : une entrée présente d'un seul côté doit bloquer.
   * Sinon la migration d'un système vers l'autre ouvrirait une fenêtre pendant
   * laquelle les deux se neutralisent.
   */
  assert.match(AML_MIDDLEWARE, /store\.has\(type, value\) \|\| set\.has\(normalized\)/);
});

test("le moteur de risque est amorcé au démarrage, avec un abonné DÉDIÉ", () => {
  /**
   * Un client Redis passé en mode abonné ne peut plus exécuter de commandes
   * ordinaires : réutiliser celui de la limitation de débit la casserait —
   * silencieusement, puisque `resilientStore` bascule en mémoire sans se
   * plaindre.
   */
  const server = lire("../src/server");

  assert.match(server, /initRiskEngine\(/);
  assert.match(server, /redisSubscriber: riskSubscriber/);

  /**
   * L'ancre a changé le 2026-08-26 : `duplicate()` recopie les options
   * COURANTES du client principal, dont un `enableOfflineQueue` déjà remis à
   * `false`. L'abonné héritait donc d'une file fermée avant d'avoir ouvert sa
   * propre connexion, et l'abonnement échouait à chaque démarrage.
   *
   * La propriété testée ici — un client DÉDIÉ, jamais celui de la limitation —
   * est inchangée. Voir `test/riskSubscriberWiring.test.js`.
   */
  assert.match(server, /redisClient\.duplicate\(\{\s*enableOfflineQueue:\s*true\s*\}\)/);
});

test("un amorçage raté ne bloque PAS le démarrage", () => {
  // Sans moteur, la liste statique et les limites de base continuent de
  // s'appliquer. Refuser de démarrer priverait les utilisateurs du service
  // entier pour une couche de signalement.
  const server = lire("../src/server");
  const bloc = server.slice(server.indexOf("const riskEngine = require(\"./services/risk\")"));

  assert.match(bloc.slice(0, 800), /catch \(err\)/);
  assert.ok(!/process\.exit/.test(bloc.slice(0, 800)));
});
