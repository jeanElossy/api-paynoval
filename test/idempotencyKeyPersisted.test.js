"use strict";

/**
 * LA CLÉ D'IDEMPOTENCE ATTEINT RÉELLEMENT LA TRANSACTION
 * ============================================================================
 *
 * Le filet de sécurité annoncé par `middleware/idempotency.js` — « en cas de
 * registre indisponible, le risque de doublon reste couvert en aval par les
 * index uniques » — ne reposait sur RIEN pour le trafic de production.
 *
 * La chaîne, avant le 2026-09-03 :
 *   1. le mobile envoie la clé UNIQUEMENT en en-tête HTTP
 *      (`payNoval-master/tools/api.js` : `headers: { "Idempotency-Key": … }`) ;
 *   2. `extractIdempotencyKey` la lit correctement (en-tête puis corps) ;
 *   3. mais les handlers persistaient `body.idempotencyKey` — le CORPS seul ;
 *   4. `Transaction.idempotencyKey` restait donc `undefined` ;
 *   5. le `partialFilterExpression: { idempotencyKey: { $type: "string", $gt: "" } }`
 *      des index `{sender, idempotencyKey}` et `{userId, idempotencyKey}`
 *      excluait le document ;
 *   6. les deux index uniques ne mordaient sur AUCUNE transaction réelle.
 *
 * Conséquence, en régime dégradé uniquement (registre injoignable, le
 * middleware appelle `next()`) : deux `/initiate` concurrents créaient deux
 * transactions et RÉSERVAIENT LES FONDS DEUX FOIS.
 *
 * Ce test échoue si l'on revient à une lecture du corps seul.
 *
 * Aucune connexion Mongo, aucun serveur.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  resolvePersistedIdempotencyKey,
  extractIdempotencyKey,
} = require("../src/utils/idempotencyKeys");

const RACINE = path.join(__dirname, "..");
const lire = (rel) => fs.readFileSync(path.join(RACINE, rel), "utf8");

/* -------------------------------------------------------------------------- */
/* La résolution elle-même                                                    */
/* -------------------------------------------------------------------------- */

test("la clé posée par le middleware l'emporte sur le corps", () => {
  assert.equal(
    resolvePersistedIdempotencyKey({ idempotencyKey: "depuis-entete" }, { idempotencyKey: "depuis-corps" }),
    "depuis-entete",
    "l'en-tête est la norme (Stripe, Adyen) : il doit primer"
  );
});

test("le corps reste un repli si le middleware n'est pas monté", () => {
  assert.equal(
    resolvePersistedIdempotencyKey({}, { idempotencyKey: "depuis-corps" }),
    "depuis-corps"
  );
});

test("sans clé, on rend `undefined` — jamais null ni chaîne vide", () => {
  /**
   * Le filtre partiel de l'index exige `{ $type: "string", $gt: "" }`. Un `null`
   * ou un `""` créerait un document que l'index n'indexe pas, tout en donnant
   * l'illusion que le champ est renseigné.
   */
  for (const cas of [{}, { idempotencyKey: "" }, { idempotencyKey: "   " }, { idempotencyKey: 42 }]) {
    assert.equal(resolvePersistedIdempotencyKey({}, cas), undefined);
  }
  assert.equal(resolvePersistedIdempotencyKey(null, null), undefined);
});

test("les espaces sont retirés des deux côtés", () => {
  assert.equal(resolvePersistedIdempotencyKey({ idempotencyKey: "  k  " }, {}), "k");
  assert.equal(resolvePersistedIdempotencyKey({}, { idempotencyKey: "  k  " }), "k");
});

/* -------------------------------------------------------------------------- */
/* Le contrat avec le client réel                                             */
/* -------------------------------------------------------------------------- */

test("une requête façon mobile — clé en en-tête, absente du corps — est reconnue", () => {
  const req = { headers: { "Idempotency-Key": "intention-de-virement-42" }, body: { amount: 1000 } };

  assert.equal(
    extractIdempotencyKey(req),
    "intention-de-virement-42",
    "c'est la forme exacte qu'envoie payNoval-master/tools/api.js"
  );
  assert.equal(
    resolvePersistedIdempotencyKey({ ...req, idempotencyKey: extractIdempotencyKey(req) }, req.body),
    "intention-de-virement-42",
    "et elle doit finir persistée sur la transaction"
  );
});

/* -------------------------------------------------------------------------- */
/* Les deux points d'écriture                                                 */
/* -------------------------------------------------------------------------- */

test("le middleware EXPOSE la clé validée aux handlers", () => {
  const src = lire("src/middleware/idempotency.js");

  assert.match(
    src,
    /req\.idempotencyKey\s*=\s*rawKey/,
    "sans cette affectation, les handlers ne voient jamais une clé d'en-tête"
  );

  // Elle doit être posée AVANT le repli `return next()` du registre indisponible,
  // sinon le filet invoqué par ce repli reste vide — le défaut d'origine.
  const posePos = src.indexOf("req.idempotencyKey = rawKey");
  const repliPos = src.indexOf("[IDEMPOTENCY] registre indisponible");
  assert.ok(posePos > -1 && repliPos > -1);
  assert.ok(
    posePos < repliPos,
    "la clé doit être posée avant le repli en régime dégradé, qui s'appuie dessus"
  );
});

test("les handlers d'initiation persistent la clé résolue, pas le corps seul", () => {
  const handlers = [
    "src/services/transactions/handlers/initiateInternal.js",
    "src/services/transactions/handlers/initiateExternalTransactions.js",
  ];

  for (const rel of handlers) {
    const src = lire(rel);

    assert.match(
      src,
      /idempotencyKey:\s*resolvePersistedIdempotencyKey\(/,
      `${rel} doit persister la clé RÉSOLUE (en-tête ou corps)`
    );

    // La forme fautive : lire le corps directement pour ce champ.
    assert.ok(
      !/idempotencyKey:\s*(typeof\s+)?body\.idempotencyKey/.test(src),
      `${rel} ne doit plus persister « body.idempotencyKey » seul : ` +
        "le client mobile n'envoie la clé QUE dans l'en-tête, et le champ " +
        "resterait vide — donc les index uniques partiels ne s'appliqueraient à rien."
    );
  }
});
