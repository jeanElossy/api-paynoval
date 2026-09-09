"use strict";

/**
 * ============================================================================
 * LE CÂBLAGE — UN MODULE QUI SAIT COMPTER NE PROUVE RIEN
 * ============================================================================
 *
 * ── La leçon qu'on ne répète pas ────────────────────────────────────────────
 * `mongodb_pool_max_size` affichait **0** sur le service réel alors que le pool
 * valait 15 : `attachPoolMetrics()` s'abonnait APRÈS la connexion, or le pilote
 * émet `connectionPoolCreated` PENDANT. Les tests unitaires ne pouvaient pas
 * l'attraper — **ils émettaient eux-mêmes l'événement** et validaient un
 * réducteur parfaitement correct. Le câblage, lui, perdait tout.
 *
 * `workerMetrics.test.js` a exactement ce point faible : il alimente le registre
 * à la main. Il prouve que la comptabilité est juste, pas qu'un worker déclare
 * son passage.
 *
 * ── Ce que ce fichier vérifie, et comment ───────────────────────────────────
 * Il démarre les **VRAIS** `start*Worker()` des quatre travailleurs de fond,
 * avec le seul travail du tour remplacé par une doublure (`runOnce`), puis
 * vérifie que le registre de `workerMetrics` a bien enregistré le passage sous
 * le bon nom. Aucune connexion Mongo, aucun Redis, aucun serveur HTTP, et
 * surtout — pour le rejeu de règlement — **aucun mouvement d'argent** : c'est
 * précisément ce que l'injection de `runOnce` garantit (règle B.5).
 *
 * Il tombe si l'on retire `metrics.record(...)` d'un tick, si l'on retire un
 * `declareWorker(...)` d'un démarrage, ou si l'on renomme un worker du
 * catalogue sans mettre à jour son point d'appel.
 *
 * ── Ce qu'il ne peut pas faire ──────────────────────────────────────────────
 * `require("../src/server")` démarre un serveur HTTP et charge la configuration
 * stricte : la suite cesserait d'être pure. Le câblage de `server.js` est donc
 * vérifié sur son TEXTE. C'est une garantie plus faible — elle dit que l'appel
 * est écrit, pas qu'il s'exécute — mais elle attrape le cas réel : quelqu'un
 * qui déplace ou supprime l'enregistrement des jauges.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  WORKERS,
  KNOWN_WORKERS,
  STATE,
  snapshotAll,
  resetWorkerRegistry,
} = require("../src/services/workerMetrics");

const {
  startTransactionAutoCancelWorker,
} = require("../src/services/transactionAutoCancelService");
const {
  startReferralOutboxWorker,
} = require("../src/services/referral/referralOutboxWorker");
const {
  startReconciliationWorker,
} = require("../src/services/reconciliation/reconciliationScheduler");
const {
  startSettlementReplayWorker,
} = require("../src/services/settlement/settlementReplay");

const SRC = path.join(__dirname, "..", "src");

function etat(nom) {
  return snapshotAll().find((s) => s.worker === nom);
}

test.beforeEach(() => resetWorkerRegistry());

/* -------------------------------------------------------------------------- */
/* LES QUATRE WORKERS DÉCLARENT ET COMPTENT LEUR PASSAGE                      */
/* -------------------------------------------------------------------------- */

/**
 * Le tableau décrit, pour chaque worker, comment le démarrer sans toucher à
 * quoi que ce soit de réel. `intervalMs` est volontairement énorme : le tour
 * qui compte est celui que le test déclenche, jamais la minuterie.
 */
const WORKERS_REELS = [
  {
    nom: WORKERS.TX_AUTO_CANCEL,
    demarrer: (runOnce) =>
      startTransactionAutoCancelWorker({
        intervalMs: 3600_000,
        batchSize: 1,
        workerId: "test",
        runOnce,
      }),
    /** Ce worker fait un premier tour DÈS le démarrage. */
    tourAuDemarrage: true,
  },
  {
    nom: WORKERS.REFERRAL_OUTBOX,
    demarrer: (runOnce) =>
      startReferralOutboxWorker({
        intervalMs: 3600_000,
        reapIntervalMs: 3600_000,
        batchSize: 1,
        workerId: "test",
        runOnce,
      }),
    tourAuDemarrage: true,
  },
  {
    nom: WORKERS.RECONCILIATION,
    demarrer: (runOnce) =>
      startReconciliationWorker({ intervalMs: 3600_000, enabled: true, runOnce }),
    /** Pas de premier tour au démarrage — choix documenté du planificateur. */
    tourAuDemarrage: false,
  },
  {
    nom: WORKERS.SETTLEMENT_REPLAY,
    demarrer: (runOnce) =>
      startSettlementReplayWorker({ intervalMs: 3600_000, enabled: true, runOnce }),
    tourAuDemarrage: false,
  },
];

for (const { nom, demarrer, tourAuDemarrage } of WORKERS_REELS) {
  test(`le worker « ${nom} » se déclare au démarrage et compte son passage`, async () => {
    assert.equal(
      etat(nom).state,
      STATE.NEVER_DECLARED,
      "mise en scène : le registre doit être vierge avant le démarrage"
    );

    let tours = 0;
    const handle = demarrer(async () => {
      tours += 1;
      return { claimed: 0, cancelled: 0 };
    });

    try {
      assert.equal(
        etat(nom).state,
        STATE.ENABLED,
        `« ${nom} » n'a pas appelé declareWorker() au démarrage. Sans ` +
          "déclaration, /metrics ne publie aucune série pour lui et son arrêt " +
          "reste invisible — la panne exacte que cette instrumentation corrige."
      );

      assert.ok(
        typeof handle?.tick === "function",
        `« ${nom} » doit exposer tick() — c'est ce qui permet de vérifier le ` +
          "câblage sans attendre la minuterie ni ouvrir de connexion."
      );

      await handle.tick();

      assert.ok(tours >= 1, "mise en scène : la doublure de travail doit avoir été appelée");

      const vu = etat(nom);

      assert.equal(
        vu.runs,
        tourAuDemarrage ? tours : 1,
        `« ${nom} » a exécuté ${tours} tour(s) mais le registre en compte ` +
          `${vu.runs} : le tick n'est pas enveloppé par metrics.record().`
      );

      assert.equal(vu.failures, 0);
      assert.equal(vu.lastSuccess, 1, "un tour réussi doit se lire 1");
      assert.ok(
        vu.lastRunTimestamp > 0,
        "sans horodatage de passage, l'âge repartirait du démarrage du worker " +
          "et on ne saurait jamais si un tour a réellement eu lieu"
      );
      assert.ok(vu.ageSeconds >= 0 && vu.ageSeconds < 60);
    } finally {
      handle?.stop?.();
    }
  });
}

/**
 * ⚠️ Un tour qui échoue doit être compté — et l'erreur ne doit pas s'échapper
 * du worker (les quatre ticks journalisent puis absorbent, comportement
 * inchangé). Sans ce test, une instrumentation posée AUTOUR du try/catch
 * existant ne verrait jamais un seul échec et `worker_failures` resterait à
 * zéro pendant que le worker échoue en boucle.
 */
test("un tour en échec est compté sans faire échouer le worker", async () => {
  const handle = startReconciliationWorker({
    intervalMs: 3600_000,
    enabled: true,
    runOnce: async () => {
      throw new Error("panne simulée");
    },
  });

  try {
    // Ne doit pas rejeter : le tick journalise et absorbe, comme avant.
    await handle.tick();

    const vu = etat(WORKERS.RECONCILIATION);

    assert.equal(
      vu.failures,
      1,
      "l'échec n'est pas compté : metrics.record() est probablement posé " +
        "AUTOUR du try/catch du tick, où l'erreur est déjà absorbée."
    );
    assert.equal(vu.runs, 1, "un échec reste un passage");
    assert.equal(vu.lastSuccess, 0);
    assert.ok(vu.ageSeconds < 60, "l'âge reste frais : le worker tourne, il échoue");
  } finally {
    handle?.stop?.();
  }
});

/**
 * Les deux workers désactivables par configuration doivent se déclarer QUAND
 * MÊME, en `worker_enabled=0`. Sinon « éteint volontairement » et « n'a jamais
 * démarré » produisent la même absence de série, et on ne peut alerter ni sur
 * l'un ni sur l'autre.
 */
test("un worker éteint par configuration se déclare quand même, en worker_enabled=0", () => {
  const rien = startSettlementReplayWorker({ enabled: false });

  assert.equal(rien, null, "le contrat de retour ne change pas : null quand éteint");
  assert.equal(
    etat(WORKERS.SETTLEMENT_REPLAY).state,
    STATE.DISABLED,
    "le rejeu de règlement est éteint PAR DÉFAUT : sans déclaration, /metrics " +
      "serait muet à son sujet et on ne pourrait pas distinguer « éteint » de " +
      "« censé tourner et jamais démarré »."
  );

  resetWorkerRegistry();

  const rien2 = startReconciliationWorker({ enabled: false });
  assert.equal(rien2, null);
  assert.equal(etat(WORKERS.RECONCILIATION).state, STATE.DISABLED);
});

/* -------------------------------------------------------------------------- */
/* LE CÂBLAGE DEPUIS server.js                                                */
/* -------------------------------------------------------------------------- */

/**
 * Vérification sur le TEXTE de `server.js` : le charger démarrerait un serveur
 * HTTP et exigerait une configuration complète, ce qui détruirait la propriété
 * qui fait la valeur de cette suite (aucune I/O, quelques secondes).
 *
 * Il tombe si quelqu'un supprime l'enregistrement des jauges — auquel cas le
 * registre de workers se remplirait sans que rien ne soit jamais publié.
 */
test("server.js enregistre réellement les jauges de worker", () => {
  const source = fs.readFileSync(path.join(SRC, "server.js"), "utf8");

  assert.match(
    source,
    /require\(["']\.\/services\/workerMetrics["']\)/,
    "server.js ne charge plus services/workerMetrics"
  );

  assert.match(
    source,
    /registerWorkerMetrics\(\s*metrics/,
    "server.js n'appelle plus registerWorkerMetrics(metrics, …) : le registre " +
      "de workers se remplirait sans qu'aucune jauge ne soit publiée sur /metrics."
  );

  /**
   * L'ordre compte, comme pour les pools Mongo : l'enregistrement doit précéder
   * `bootstrap()`, qui démarre les workers. Les jauges lisent le registre à la
   * scrutation, donc l'inverse marcherait aussi — mais l'écrire dans l'ordre
   * évite qu'un futur passage à un enregistrement instantané casse en silence.
   */
  assert.ok(
    source.indexOf("registerWorkerMetrics(") < source.indexOf("async function bootstrap"),
    "les jauges doivent être enregistrées avant bootstrap(), qui démarre les workers"
  );
});

/**
 * Chaque worker du catalogue doit avoir un point d'appel réel. Un nom déclaré
 * dans `WORKERS` mais utilisé nulle part publierait éternellement
 * `worker_enabled=-1` et déclencherait une alerte pour un worker qui n'existe
 * pas — le contraire du but recherché.
 */
test("chaque nom du catalogue est réellement employé par un worker", () => {
  const points = {
    [WORKERS.TX_AUTO_CANCEL]: "services/transactionAutoCancelService.js",
    [WORKERS.REFERRAL_OUTBOX]: "services/referral/referralOutboxWorker.js",
    [WORKERS.RECONCILIATION]: "services/reconciliation/reconciliationScheduler.js",
    [WORKERS.SETTLEMENT_REPLAY]: "services/settlement/settlementReplay.js",

    /**
     * ⚠️ Même fichier que `REFERRAL_OUTBOX`, et ce n'est pas une erreur.
     *
     * `referralOutboxWorker.js` porte DEUX minuteries : la boucle de livraison
     * et le ramasseur de verrous expirés. La seconde a sa propre panne — si
     * elle s'arrête, les événements de parrainage restent verrouillés
     * indéfiniment pendant que la première continue d'afficher un âge sain.
     *
     * Ce qui se déclare n'est pas « un worker », c'est **chaque boucle dont
     * l'arrêt a une conséquence**.
     */
    [WORKERS.REFERRAL_LOCK_REAPER]: "services/referral/referralOutboxWorker.js",
  };

  assert.deepEqual(
    Object.keys(points).sort(),
    [...KNOWN_WORKERS].sort(),
    "le catalogue et la liste des points d'appel ont divergé"
  );

  for (const [nom, fichier] of Object.entries(points)) {
    const source = fs.readFileSync(path.join(SRC, fichier), "utf8");

    assert.match(
      source,
      /declareWorker\(/,
      `${fichier} ne déclare plus son worker « ${nom} »`
    );

    assert.match(
      source,
      /metrics\.record\(/,
      `${fichier} n'enveloppe plus son tour : l'âge du dernier passage ne ` +
        "serait plus mis à jour et le worker paraîtrait mort en permanence."
    );
  }
});
