"use strict";

/**
 * ============================================================================
 * L'ABONNÉ DE LA LISTE NOIRE — L'AVERTISSEMENT QUI RESTAIT EN PRODUCTION
 * ============================================================================
 *
 * Après le correctif du 2026-08-26 sur le magasin de limitation, TX Core
 * démarrait correctement mais journalisait encore, à chaque déploiement :
 *
 *     [AML] abonnement à l'invalidation impossible
 *     (Stream isn't writeable and enableOfflineQueue options is false)
 *     — la liste noire se rafraîchira par TTL seul.
 *
 * LA CAUSE, ET POURQUOI ELLE EST CONTRE-INTUITIVE
 * -----------------------------------------------
 * `duplicate()` recopie `this.options` — donc la valeur COURANTE de
 * `enableOfflineQueue`, que `closeOfflineQueueWhenReady` vient de remettre à
 * `false` sur le client principal. Le client dupliqué hérite d'une file FERMÉE
 * alors qu'il n'est pas encore connecté : un client dupliqué ouvre sa PROPRE
 * connexion, mesurée à ~1,2 s sur cette infrastructure (TLS compris).
 *
 * ⚠️ LA CONSÉQUENCE N'EST PAS COSMÉTIQUE. Sans pub/sub, ajouter quelqu'un à la
 * liste noire ne se propage aux autres instances qu'à l'expiration du TTL. Une
 * décision de conformité prise à l'instant T ne prend effet qu'à T + TTL, sur
 * des instances qui continuent d'accepter ses virements entre-temps.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const {
  closeOfflineQueueWhenReady,
} = require("../src/services/redisStoreSafety");

/** Doublure d'un client ioredis, avec la sémantique réelle de `duplicate`. */
function faireClient(options = { enableOfflineQueue: true }) {
  const auditeurs = {};

  return {
    options: { ...options },
    once(evt, fn) {
      auditeurs[evt] = fn;
      return this;
    },
    emit(evt) {
      auditeurs[evt]?.();
    },
    // ioredis : `new Redis({ ...this.options, ...override })`
    duplicate(override) {
      return faireClient({ ...this.options, ...override });
    },
  };
}

test("LE DÉFAUT — un duplicate nu hérite d'une file FERMÉE", () => {
  const principal = faireClient();
  closeOfflineQueueWhenReady(principal);
  principal.emit("ready");

  const abonne = principal.duplicate();

  assert.equal(
    abonne.options.enableOfflineQueue,
    false,
    "c'est exactement ce qui faisait échouer l'abonnement"
  );
});

test("LE CORRECTIF — l'override rouvre la file pour la connexion de l'abonné", () => {
  const principal = faireClient();
  closeOfflineQueueWhenReady(principal);
  principal.emit("ready");

  const abonne = principal.duplicate({ enableOfflineQueue: true });

  assert.equal(abonne.options.enableOfflineQueue, true);
});

test("l'abonné referme sa file une fois SA propre connexion établie", () => {
  /**
   * Le même raisonnement que pour le client principal : la file ouverte est une
   * fenêtre de démarrage, pas un régime permanent.
   */
  const principal = faireClient();
  const abonne = principal.duplicate({ enableOfflineQueue: true });

  closeOfflineQueueWhenReady(abonne, { label: "risk" });
  abonne.emit("ready");

  assert.equal(abonne.options.enableOfflineQueue, false);
});

test("l'ordre de connexion des deux clients n'a pas d'importance", () => {
  // L'abonné peut se connecter avant ou après le principal : chacun gère sa
  // propre fenêtre.
  const principal = faireClient();
  closeOfflineQueueWhenReady(principal);

  const abonne = principal.duplicate({ enableOfflineQueue: true });
  closeOfflineQueueWhenReady(abonne, { label: "risk" });

  abonne.emit("ready");
  principal.emit("ready");

  assert.equal(abonne.options.enableOfflineQueue, false);
  assert.equal(principal.options.enableOfflineQueue, false);
});

/* -------------------------------------------------------------------------- */
/* Le câblage                                                                 */
/* -------------------------------------------------------------------------- */

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const SERVEUR = stripComments(fs.readFileSync(require.resolve("../src/server"), "utf8"));

test("le serveur duplique AVEC l'override, jamais nu", () => {
  assert.match(SERVEUR, /redisClient\.duplicate\(\{\s*enableOfflineQueue:\s*true\s*\}\)/);
  assert.ok(
    !/redisClient\.duplicate\(\)/.test(SERVEUR),
    "un duplicate nu réintroduirait le défaut"
  );
});

test("l'abonné passe par le même traitement que le client principal", () => {
  assert.match(SERVEUR, /closeOfflineQueueWhenReady\(riskSubscriber/);
});

test("le module de sûreté est importé au NIVEAU DU MODULE", () => {
  /**
   * Il sert à deux endroits : le bloc de limitation de débit et `bootstrap()`.
   * Un `const` déclaré dans le premier n'est pas visible depuis le second, et
   * l'erreur n'apparaîtrait qu'à l'exécution — au démarrage, en production.
   */
  const avantBootstrap = SERVEUR.slice(0, SERVEUR.indexOf("async function bootstrap"));
  const imports = avantBootstrap.match(/require\("\.\/services\/redisStoreSafety"\)/g) || [];

  assert.equal(imports.length, 1, "un seul import, hors de tout bloc");

  // Il doit précéder la première utilisation.
  const iImport = SERVEUR.indexOf('require("./services/redisStoreSafety")');
  const iUsage = SERVEUR.indexOf("closeOfflineQueueWhenReady(redisClient");

  assert.ok(iImport > 0 && iUsage > iImport, "import avant usage");
});
