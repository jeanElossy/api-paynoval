"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const { buildDedupKey } = require("../src/services/ledger/doubleEntry");

/**
 * ============================================================================
 * LA DÉDUPLICATION DU GRAND LIVRE
 * ============================================================================
 *
 * Ce que ces tests protègent, en une phrase : en mode dégradé (sans transaction
 * MongoDB), un rejeu écrivait le mouvement DEUX FOIS — et comme les deux jambes
 * étaient doublées, le grand livre restait ÉQUILIBRÉ. La balance de vérification
 * ne voyait rien, et le solde comptable du compte valait le double du vrai.
 *
 * C'est le seul défaut du grand livre qu'aucun de nos contrôles précédents ne
 * pouvait détecter. D'où l'index unique — et d'où ces tests.
 */

/* ==========================================================================
 * 1. LA CLÉ — DÉTERMINISTE, ET ABSENTE QUAND ELLE SERAIT FAUSSE
 * ======================================================================== */

test("la clé est identique d'une tentative à l'autre", () => {
  // C'est toute la propriété recherchée : un rejeu du MÊME mouvement doit
  // reconstruire exactement la même clé, sinon l'index ne le reconnaît pas.
  const a = buildDedupKey({ transactionId: "tx1", scope: "reserve", legIndex: 0 });
  const b = buildDedupKey({ transactionId: "tx1", scope: "reserve", legIndex: 0 });

  assert.equal(a, b);
  assert.equal(a, "tx1|reserve|0");
});

test("les deux jambes d'un même lot ont des clés distinctes", () => {
  /**
   * Sans `legIndex`, les deux jambes des frais d'annulation — qui partagent
   * compte, sens et type — porteraient la même clé : la seconde serait refusée
   * par l'index et le lot ne s'écrirait qu'à moitié.
   */
  const leg0 = buildDedupKey({ transactionId: "tx1", scope: "fee", legIndex: 0 });
  const leg1 = buildDedupKey({ transactionId: "tx1", scope: "fee", legIndex: 1 });

  assert.notEqual(leg0, leg1);
});

test("deux transactions ne partagent jamais une clé", () => {
  assert.notEqual(
    buildDedupKey({ transactionId: "tx1", scope: "reserve", legIndex: 0 }),
    buildDedupKey({ transactionId: "tx2", scope: "reserve", legIndex: 0 })
  );
});

test("aucune clé sans portée explicite", () => {
  /**
   * Le point le plus important du dispositif. Une clé posée par défaut serait
   * forcément trop large, et refuserait une opération légitime qui se répète
   * (deux remboursements partiels du même montant). Pas de portée, pas de clé,
   * pas de contrainte.
   */
  assert.equal(buildDedupKey({ transactionId: "tx1", legIndex: 0 }), null);
  assert.equal(buildDedupKey({ transactionId: "tx1", scope: "", legIndex: 0 }), null);
  assert.equal(buildDedupKey({ transactionId: "tx1", scope: "   ", legIndex: 0 }), null);
  assert.equal(buildDedupKey({ scope: "reserve", legIndex: 0 }), null);
  assert.equal(buildDedupKey({ transactionId: "tx1", scope: "r", legIndex: null }), null);
  assert.equal(buildDedupKey({ transactionId: "tx1", scope: "r", legIndex: 1.5 }), null);
});

/* ==========================================================================
 * 2. LE SCHÉMA — L'INDEX DOIT ÊTRE PARTIEL, PAS SEULEMENT UNIQUE
 * ======================================================================== */

function ledgerSchema() {
  const conn = mongoose.createConnection();
  return require("../src/models/LedgerEntry")(conn).schema;
}

test("l'index de déduplication est déclaré, unique ET partiel", () => {
  /**
   * Il est cherché dans `scripts/ensure-ledger-indexes.js`, pas au schéma, et
   * ce n'est pas un détail.
   *
   * ⚠️ La justification de ce choix a été corrigée le 2026-08-28 : elle
   * invoquait un `autoIndex` actif, coupé depuis `src/config/db.js`. La
   * décision, elle, reste bonne. La vraie raison : cet index vit avec les trois
   * autres index hors schéma de `ledgerentries` dans un script qu'on lance
   * **quand on le décide**, en heure creuse, en suivant la construction. Et
   * cela vaut doublement pour un index UNIQUE — si sa construction échoue, elle
   * échoue en silence sur un événement de connexion que personne ne lit, et le
   * schéma affiche alors une garantie que la base ne porte pas.
   *
   * ⚠️ Il ne se pose PAS par `npm run indexes:apply` mais par
   * `npm run indexes:ledger`. Voir `BENCHMARKS.md` §8.2.
   *
   * Ce test lit donc le SCRIPT — c'est-à-dire ce qui existera réellement en
   * production.
   */
  const fs = require("node:fs");
  const path = require("node:path");

  const source = fs.readFileSync(
    path.join(__dirname, "..", "scripts", "ensure-ledger-indexes.js"),
    "utf8"
  );

  assert.match(source, /keys: \{ dedupKey: 1 \}/, "index dedupKey absent du script");
  assert.match(source, /name: "dedupKey_unique_partial"/);
  assert.match(source, /unique: true/);

  /**
   * `partialFilterExpression` n'est pas une optimisation, c'est la condition de
   * sûreté : sans elle, l'index couvrirait tout l'historique — qui n'a aucune
   * clé — et refuserait la deuxième écriture sans clé, c'est-à-dire presque
   * toutes. Sa construction pourrait aussi échouer sur des doublons hérités.
   */
  assert.match(
    source,
    /partialFilterExpression: \{ dedupKey: \{ \$type: "string" \} \}/
  );
});

test("le schéma ne redéclare PAS l'index — il se construirait tout seul", () => {
  const found = ledgerSchema()
    .indexes()
    .find(([fields]) => Object.keys(fields).join() === "dedupKey");

  assert.equal(found, undefined);
});

test("`dedupKey` est ABSENT par défaut, jamais null", () => {
  /**
   * Avec `default: null`, Mongoose écrirait le champ partout : le filtre
   * `$type: "string"` les exclurait encore, mais un futur assouplissement du
   * filtre transformerait chaque `null` en collision. Le champ doit être
   * absent.
   */
  assert.equal(ledgerSchema().path("dedupKey").defaultValue, undefined);
});

/* ==========================================================================
 * 3. `postDoubleEntry` — CE QUI SE PASSE QUAND L'INDEX REFUSE
 * ======================================================================== */

/** Grand livre programmable : on choisit ce que l'insertion fait. */
function makeLedger() {
  const state = { written: [], stored: [], throwDuplicate: false, opts: [] };

  return {
    state,
    model: {
      /**
       * `insertMany` et non `create` : c'est ce que `postDoubleEntry` appelle
       * désormais. `Model.create(tableau)` lançait N sauvegardes PARALLÈLES
       * (`Promise.all` — vérifié dans mongoose 7.8.12), donc pas de lot.
       */
      async insertMany(docs, opts) {
        const list = Array.isArray(docs) ? docs : [docs];
        state.opts.push(opts);

        if (state.throwDuplicate) {
          const err = new Error("E11000 duplicate key error");
          err.code = 11000;
          throw err;
        }

        state.written.push(list);
        return list;
      },
      async find(query) {
        const wanted = query?.dedupKey?.$in || [];
        // Ordre volontairement INVERSÉ : `find` rend l'ordre de l'index, pas
        // celui des clés. Le service doit remettre les jambes dans l'ordre.
        return state.stored
          .filter((d) => wanted.includes(d.dedupKey))
          .reverse();
      },
    },
  };
}

/**
 * @param {boolean} sharedClient les deux connexions partagent-elles le même
 *   `MongoClient` ? C'est la SEULE façon d'avoir une vraie transaction Mongo.
 *   À `false`, on est en mode dégradé : `startTxSession()` rend malgré tout une
 *   session, mais aucune transaction ne la couvre.
 */
function loadService(ledger, { sharedClient = false } = {}) {
  const dbPath = require.resolve("../src/config/db");
  const svcPath = require.resolve("../src/services/ledgerService");

  const models = { LedgerEntry: ledger.model };
  const clientA = { id: "client-A" };
  const clientB = sharedClient ? clientA : { id: "client-B" };

  const txConn = {
    models,
    model: (name) => models[name] || ledger.model,
    getClient: () => clientA,
  };
  const usersConn = { ...txConn, getClient: () => clientB };

  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: { getTxConn: () => txConn, getUsersConn: () => usersConn },
  };

  delete require.cache[svcPath];
  delete require.cache[require.resolve("../src/models/LedgerEntry")];
  delete require.cache[require.resolve("../src/utils/sharedSession")];

  return require("../src/services/ledgerService");
}

const BALANCED_LEGS = [
  {
    accountType: "USER_WALLET",
    accountId: "wallet:u1:XOF",
    direction: "DEBIT",
    entryType: "RESERVE",
    amount: 1000,
    currency: "XOF",
  },
  {
    accountType: "SYSTEM_RESERVE",
    accountId: "reserve:u1:XOF",
    direction: "CREDIT",
    entryType: "RESERVE",
    amount: 1000,
    currency: "XOF",
  },
];

test("une portée fournie pose une clé sur CHAQUE jambe", async () => {
  const ledger = makeLedger();
  const svc = loadService(ledger);

  await svc.postDoubleEntry({
    transactionId: "tx1",
    entryType: "RESERVE",
    legs: BALANCED_LEGS,
    dedupScope: "reserveSenderFunds",
  });

  const batch = ledger.state.written[0];
  assert.equal(batch.length, 2);
  assert.equal(batch[0].dedupKey, "tx1|reserveSenderFunds|0");
  assert.equal(batch[1].dedupKey, "tx1|reserveSenderFunds|1");
});

test("sans portée, le champ n'est pas écrit du tout", async () => {
  const ledger = makeLedger();
  const svc = loadService(ledger);

  await svc.postDoubleEntry({
    transactionId: "tx1",
    entryType: "REFUND",
    legs: BALANCED_LEGS,
  });

  // `in` et non `=== undefined` : c'est l'ABSENCE de la propriété qui compte
  // pour l'index partiel, pas sa valeur.
  for (const doc of ledger.state.written[0]) {
    assert.equal("dedupKey" in doc, false);
  }
});

test("un rejeu déjà enregistré réussit en silence — il ne double rien", async () => {
  /**
   * L'idempotence proprement dite. Relancer l'erreur ferait échouer une
   * transaction pourtant correctement comptabilisée, et un appelant qui
   * réessaie tournerait en boucle sur un mouvement déjà passé.
   */
  const ledger = makeLedger();
  const svc = loadService(ledger);

  ledger.state.stored = [
    { dedupKey: "tx1|reserveSenderFunds|0" },
    { dedupKey: "tx1|reserveSenderFunds|1" },
  ];
  ledger.state.throwDuplicate = true;

  const result = await svc.postDoubleEntry({
    transactionId: "tx1",
    entryType: "RESERVE",
    legs: BALANCED_LEGS,
    dedupScope: "reserveSenderFunds",
  });

  assert.equal(result.length, 2);
  assert.equal(ledger.state.written.length, 0, "rien n'a été réécrit");
});

test("un lot INCOMPLET est signalé, jamais absorbé", async () => {
  /**
   * Le cas qu'il ne faut surtout pas confondre avec un rejeu : la première
   * tentative s'est interrompue APRÈS la première jambe. Le grand livre porte
   * un lot déséquilibré. Absorber la collision en silence le laisserait tel
   * quel, définitivement.
   */
  const ledger = makeLedger();
  const svc = loadService(ledger);

  ledger.state.stored = [{ dedupKey: "tx1|reserveSenderFunds|0" }];
  ledger.state.throwDuplicate = true;

  await assert.rejects(
    () =>
      svc.postDoubleEntry({
        transactionId: "tx1",
        entryType: "RESERVE",
        legs: BALANCED_LEGS,
        dedupScope: "reserveSenderFunds",
      }),
    (err) => {
      assert.equal(err.code, "LEDGER_PARTIAL_POSTING");
      assert.match(err.message, /1 jambe\(s\) enregistrée\(s\) sur 2/);
      return true;
    }
  );
});

test("sous une VRAIE transaction, la collision est relancée", async () => {
  /**
   * Avec une transaction Mongo, MongoDB annule déjà tout le lot et l'appelant
   * rejoue proprement. Tenter une relecture dans une session en cours
   * d'annulation n'aurait aucun sens : on relance l'erreur d'origine.
   */
  const ledger = makeLedger();
  const svc = loadService(ledger, { sharedClient: true });

  ledger.state.throwDuplicate = true;

  await assert.rejects(
    () =>
      svc.postDoubleEntry({
        transactionId: "tx1",
        entryType: "RESERVE",
        legs: BALANCED_LEGS,
        dedupScope: "reserveSenderFunds",
        session: { id: "fake-session" },
      }),
    (err) => {
      assert.equal(err.code, 11000);
      return true;
    }
  );
});

test("EN MODE DÉGRADÉ, une session ne suffit pas à désactiver le rattrapage", async () => {
  /**
   * ══ LE TEST DE NON-RÉGRESSION LE PLUS IMPORTANT DE CE FICHIER ══
   *
   * La garde testait `session` seul. Or `runtime.startTxSession()` ne consulte
   * jamais `canUseSharedSession()` : en mode dégradé il rend une session, et
   * `runInTransaction` fait `return fn(session)` SANS ouvrir de transaction.
   * La session était donc truthy sans transaction derrière, et le rattrapage —
   * écrit POUR ce régime — s'y désactivait. Le seul chemin qui l'atteignait
   * était celui des tests, qui passaient `session: null`.
   *
   * Ici : session truthy, clients Mongo DIFFÉRENTS. Le rattrapage doit
   * s'exécuter. Relancer laisserait un mouvement de portefeuille déjà validé et
   * non annulable en face d'un grand livre qui refuse l'écriture.
   */
  const ledger = makeLedger();
  const svc = loadService(ledger, { sharedClient: false });

  ledger.state.stored = [
    { dedupKey: "tx1|reserveSenderFunds|0" },
    { dedupKey: "tx1|reserveSenderFunds|1" },
  ];
  ledger.state.throwDuplicate = true;

  const result = await svc.postDoubleEntry({
    transactionId: "tx1",
    entryType: "RESERVE",
    legs: BALANCED_LEGS,
    dedupScope: "reserveSenderFunds",
    session: { id: "session-sans-transaction" },
  });

  assert.equal(result.length, 2);
});

test("le lot part en UNE commande ordonnée, pas en écritures parallèles", async () => {
  /**
   * `Model.create(tableau)` prenait la branche `Promise.all(args.map($save))`
   * de mongoose 7 : N insertions indépendantes et simultanées. Une panne entre
   * les deux laissait une écriture orpheline — le déséquilibre que ce module
   * existe pour empêcher.
   */
  const ledger = makeLedger();
  const svc = loadService(ledger);

  await svc.postDoubleEntry({
    transactionId: "tx1",
    entryType: "RESERVE",
    legs: BALANCED_LEGS,
    dedupScope: "reserveSenderFunds",
  });

  assert.equal(ledger.state.opts.length, 1, "plusieurs appels d'insertion");
  assert.equal(ledger.state.opts[0].ordered, true);
});

test("le rattrapage rend les jambes DANS L'ORDRE du lot", async () => {
  /**
   * `find` rend l'ordre de l'index, pas celui des clés. Un appelant qui prend
   * `[0]` — c'est le cas de `creditRevenueLineToTreasury` — recevrait sinon une
   * jambe arbitraire. La doublure inverse volontairement l'ordre.
   */
  const ledger = makeLedger();
  const svc = loadService(ledger);

  ledger.state.stored = [
    { dedupKey: "tx1|reserveSenderFunds|0", tag: "jambe-0" },
    { dedupKey: "tx1|reserveSenderFunds|1", tag: "jambe-1" },
  ];
  ledger.state.throwDuplicate = true;

  const result = await svc.postDoubleEntry({
    transactionId: "tx1",
    entryType: "RESERVE",
    legs: BALANCED_LEGS,
    dedupScope: "reserveSenderFunds",
  });

  assert.deepEqual(result.map((d) => d.tag), ["jambe-0", "jambe-1"]);
});

test("une erreur qui n'est PAS un doublon remonte intacte", async () => {
  const ledger = makeLedger();
  const svc = loadService(ledger);

  ledger.model.insertMany = async () => {
    const err = new Error("réseau indisponible");
    err.code = "ECONNRESET";
    throw err;
  };

  await assert.rejects(
    () =>
      svc.postDoubleEntry({
        transactionId: "tx1",
        entryType: "RESERVE",
        legs: BALANCED_LEGS,
        dedupScope: "reserveSenderFunds",
      }),
    (err) => {
      assert.equal(err.code, "ECONNRESET");
      return true;
    }
  );
});

/* ==========================================================================
 * 4. LE CÂBLAGE — QUELLES PRIMITIVES SONT PROTÉGÉES, ET LESQUELLES NON
 * ======================================================================== */

test("les primitives à déclenchement unique portent toutes une portée", () => {
  /**
   * Ces sept écritures ne peuvent survenir qu'UNE FOIS par transaction : la
   * portée peut donc être le contexte lui-même. Si quelqu'un ajoute une
   * primitive au chemin de l'argent sans y penser, ce test ne la verra pas —
   * mais il empêche au moins qu'on retire silencieusement la protection des
   * sept qui comptent le plus.
   */
  const fs = require("node:fs");
  const source = fs.readFileSync(
    require.resolve("../src/services/ledgerService"),
    "utf8"
  );

  const PROTEGEES = [
    "reserveSenderFunds",
    "captureSenderReserve",
    "releaseSenderReserve",
    "creditReceiverFunds",
    "debitReceiverFunds",
    "chargeCancellationFee:sender",
    "chargeCancellationFee:treasury",
  ];

  for (const ctx of PROTEGEES) {
    assert.ok(
      source.includes(`dedupScope: "${ctx}"`),
      `la portée de déduplication a disparu de ${ctx}`
    );
  }
});

test("le remboursement et les lignes de revenu restent DÉLIBÉRÉMENT sans clé", () => {
  /**
   * Ce test verrouille une ABSENCE, ce qui est inhabituel — mais l'absence est
   * ici un choix, pas un oubli : ces deux mouvements peuvent légitimement se
   * répéter à l'identique sur une même transaction (deux remboursements
   * partiels du même montant, deux commissions vers la même trésorerie). Une
   * portée dérivée du seul contexte refuserait le second, c'est-à-dire
   * perdrait de l'argent réellement dû ou réellement encaissé.
   *
   * Le jour où l'appelant transmettra l'identité du remboursement ou de la
   * ligne de revenu, ce test devra être mis à jour EN MÊME TEMPS que la portée
   * — c'est exactement ce qu'on veut forcer.
   */
  const fs = require("node:fs");
  const source = fs.readFileSync(
    require.resolve("../src/services/ledgerService"),
    "utf8"
  );

  assert.equal(source.includes('dedupScope: "refundSenderFunds"'), false);
  assert.equal(
    source.includes("dedupScope: `creditRevenueLineToTreasury"),
    false
  );

  // Et la raison doit rester écrite à côté du code, pas seulement ici.
  assert.match(source, /AUCUN `dedupScope` ICI, ET C'EST DÉLIBÉRÉ/);
});
