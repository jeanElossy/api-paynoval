"use strict";

/**
 * ============================================================================
 * L'ÂGE DU DERNIER PASSAGE — LA SEULE FORME QUI DÉTECTE UNE ABSENCE
 * ============================================================================
 *
 * Ces tests sont **purs** : aucune connexion Mongo, aucun Redis, aucun serveur
 * HTTP, aucune attente réelle (l'horloge est injectée). Règle B.5.
 *
 * Ils portent sur la propriété qui justifie tout le fichier : un compteur
 * d'exécutions ne distingue pas « le worker ne tourne plus » de « le worker n'a
 * rien eu à faire » — les deux le laissent immobile. Seul un âge monte tout
 * seul quand rien ne se passe.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  WORKERS,
  KNOWN_WORKERS,
  STATE,
  declareWorker,
  describe: decrire,
  snapshotAll,
  resetWorkerRegistry,
  registerWorkerMetrics,
} = require("../src/services/workerMetrics");

/** Horloge pilotée : c'est ce qui permet de vieillir de six heures sans attendre. */
function horloge(depart = 1_700_000_000_000) {
  let t = depart;

  return {
    now: () => t,
    avance(ms) {
      t += ms;
      return t;
    },
  };
}

const muet = { warn() {}, info() {}, error() {} };

test.beforeEach(() => resetWorkerRegistry());

/* -------------------------------------------------------------------------- */
/* L'ÂGE, ET POURQUOI CE N'EST PAS UN COMPTEUR                                */
/* -------------------------------------------------------------------------- */

/**
 * ⚠️ LE TEST CENTRAL DE LA TÂCHE.
 *
 * Un worker qui tourne sans rien trouver et un worker mort ont exactement le
 * même compteur d'exécutions vu de loin : immobile entre deux instants. On
 * vérifie ici que l'ÂGE les sépare.
 *
 * Il tombe si `describe()` renvoie autre chose qu'un temps écoulé — par exemple
 * si on remplace l'âge par `entry.runs`, où les deux branches vaudraient 1.
 */
test("l'âge distingue « ne tourne plus » de « rien à faire », un compteur non", async () => {
  const h = horloge();

  const vivant = declareWorker(WORKERS.REFERRAL_OUTBOX, { logger: muet, now: h.now });
  const mort = declareWorker(WORKERS.TX_AUTO_CANCEL, { logger: muet, now: h.now });

  // Les deux passent une fois, sans rien trouver.
  await vivant.record(async () => ({ claimed: 0 }));
  await mort.record(async () => ({ cancelled: 0 }));

  h.avance(3600_000); // une heure

  // Le worker vivant continue de passer ; le mort a perdu sa minuterie.
  await vivant.record(async () => ({ claimed: 0 }));

  const [vu] = snapshotAll(h.now()).filter((s) => s.worker === WORKERS.REFERRAL_OUTBOX);
  const [perdu] = snapshotAll(h.now()).filter((s) => s.worker === WORKERS.TX_AUTO_CANCEL);

  assert.equal(
    vu.runs,
    perdu.runs + 1,
    "mise en scène : les deux workers doivent avoir des compteurs proches"
  );

  assert.ok(
    vu.ageSeconds < 1,
    `le worker vivant affiche un âge de ${vu.ageSeconds} s alors qu'il vient de passer`
  );

  assert.equal(
    perdu.ageSeconds,
    3600,
    "le worker mort doit afficher 3600 s. S'il affiche 0 ou -1, l'alerte " +
      "`worker_last_run_age_seconds > seuil` ne se déclenchera JAMAIS et son " +
      "arrêt restera invisible — le défaut exact que cette tâche corrige."
  );
});

/**
 * Le cas le plus vicieux : le worker a démarré, la minuterie n'a jamais tiré.
 * Aucun passage, donc aucun horodatage de passage — et pourtant il FAUT alerter.
 *
 * Il tombe si l'on renvoie 0 (« passage à l'instant ») ou -1 (« pas de mesure »)
 * quand `lastRunAt` est vide, au lieu de compter depuis la déclaration.
 */
test("un worker démarré qui n'a JAMAIS tourné voit son âge monter depuis son démarrage", () => {
  const h = horloge();

  declareWorker(WORKERS.RECONCILIATION, { logger: muet, now: h.now });

  h.avance(7200_000); // deux heures sans le moindre tour

  const vu = snapshotAll(h.now()).find((s) => s.worker === WORKERS.RECONCILIATION);

  assert.equal(
    vu.ageSeconds,
    7200,
    "sans passage, l'âge doit courir depuis le démarrage du worker : c'est le " +
      "seul moyen de détecter une minuterie qui n'a jamais été replanifiée."
  );

  // Et il reste distinguable d'un worker qui tourne vraiment.
  assert.equal(vu.runs, 0);
  assert.equal(
    vu.lastRunTimestamp,
    0,
    "aucun passage : l'horodatage doit rester à 0, sinon on croirait à un tour réel"
  );
  assert.equal(vu.lastSuccess, -1);
  assert.equal(vu.lastDurationSeconds, -1);
});

/* -------------------------------------------------------------------------- */
/* LES TROIS ÉTATS — ET POURQUOI ZÉRO N'EST JAMAIS « JE NE SAIS PAS »         */
/* -------------------------------------------------------------------------- */

/**
 * Un worker qui n'a pas démarré du tout (par exemple `startAutoCancelWorker()`
 * a levé et `server.js` a rattrapé) doit publier une série, pas disparaître :
 * une série absente ne déclenche aucune alerte.
 *
 * Il tombe si `snapshotAll` n'itère que le registre au lieu du catalogue fermé.
 */
test("un worker jamais déclaré publie quand même sa série, en worker_enabled=-1", () => {
  const vu = snapshotAll();

  assert.equal(
    vu.length,
    KNOWN_WORKERS.length,
    "les quatre workers du catalogue doivent toujours être publiés, y compris " +
      "ceux qui n'ont jamais démarré — sinon leur absence est muette."
  );

  for (const s of vu) {
    assert.equal(s.state, STATE.NEVER_DECLARED);
    assert.equal(s.ageSeconds, -1);
  }
});

/**
 * Éteint volontairement (`SETTLEMENT_REPLAY_WORKER≠true`) : l'âge doit valoir
 * -1, sinon il monterait indéfiniment et produirait une alerte permanente sur
 * une décision assumée.
 *
 * Il tombe si la branche `!entry.enabled` de `describe()` disparaît.
 */
test("un worker éteint par configuration ne produit pas une alerte permanente", () => {
  const h = horloge();

  declareWorker(WORKERS.SETTLEMENT_REPLAY, { enabled: false, logger: muet, now: h.now });

  h.avance(30 * 24 * 3600_000); // un mois

  const vu = snapshotAll(h.now()).find((s) => s.worker === WORKERS.SETTLEMENT_REPLAY);

  assert.equal(vu.state, STATE.DISABLED, "éteint se lit 0, pas -1 : il a bien été déclaré");
  assert.equal(
    vu.ageSeconds,
    -1,
    "un worker éteint doit sortir de l'alerte d'âge, pas la déclencher pour toujours"
  );
});

/* -------------------------------------------------------------------------- */
/* UN PASSAGE EN ÉCHEC RESTE UN PASSAGE                                       */
/* -------------------------------------------------------------------------- */

/**
 * ⚠️ Règle B.1 — ne jamais masquer un problème. L'instrumentation compte
 * l'échec puis RELAIE l'erreur : si elle l'avalait, elle transformerait un
 * worker en panne en worker silencieux.
 *
 * Il tombe si `record()` avale l'erreur (le `assert.rejects` échoue) ou si elle
 * n'incrémente pas `failures`.
 */
test("un tour qui lève est compté en échec, et l'erreur est relayée", async () => {
  const h = horloge();
  const w = declareWorker(WORKERS.TX_AUTO_CANCEL, { logger: muet, now: h.now });

  await assert.rejects(
    () => w.record(async () => {
      h.avance(250);
      throw new Error("base injoignable");
    }),
    /base injoignable/,
    "l'erreur du travail doit remonter intacte : la masquer ferait de cette " +
      "métrique un dispositif d'étouffement (règle B.1)."
  );

  const vu = w.snapshot();

  assert.equal(vu.failures, 1);
  assert.equal(vu.runs, 1, "un échec est un passage : il compte dans les exécutions");
  assert.equal(vu.lastSuccess, 0);
  assert.equal(vu.lastDurationSeconds, 0.25, "la durée est mesurée même en échec");
});

/**
 * L'âge répond à « est-ce que ça tourne encore ? », pas à « est-ce que ça
 * marche ? ». Un worker qui échoue à chaque tour doit garder un âge FRAIS,
 * sinon on part chercher une minuterie perdue au lieu de lire l'erreur.
 *
 * Il tombe si `close()` cesse de mettre à jour `lastRunAt` en cas d'échec.
 */
test("un worker qui échoue à chaque tour garde un âge frais — l'échec se lit ailleurs", async () => {
  const h = horloge();
  const w = declareWorker(WORKERS.RECONCILIATION, { logger: muet, now: h.now });

  for (let i = 0; i < 3; i += 1) {
    h.avance(60_000);
    await w.record(async () => {
      throw new Error("écart de lecture");
    }).catch(() => {});
  }

  const vu = w.snapshot();

  assert.ok(
    vu.ageSeconds < 1,
    `l'âge vaut ${vu.ageSeconds} s : un worker qui tourne et échoue ne doit pas ` +
      "déclencher l'alerte « worker mort », qui enverrait chercher le mauvais défaut."
  );

  assert.equal(vu.failures, 3, "c'est worker_failures qui porte le signal d'échec");
  assert.equal(vu.lastSuccess, 0);
});

/* -------------------------------------------------------------------------- */
/* PASSAGE EN COURS                                                           */
/* -------------------------------------------------------------------------- */

/**
 * `worker_running` sépare « bloqué dans un tour » de « plus planifié » — deux
 * pannes qui produisent le même âge qui monte, et appellent deux réactions
 * opposées.
 */
test("un passage en cours est visible pendant qu'il dure", async () => {
  const h = horloge();
  const w = declareWorker(WORKERS.REFERRAL_OUTBOX, { logger: muet, now: h.now });

  let relacher;
  const bloque = new Promise((resolve) => {
    relacher = resolve;
  });

  const enCours = w.record(() => bloque);

  assert.equal(w.snapshot().running, 1, "le tour est en cours : running doit valoir 1");

  relacher();
  await enCours;

  assert.equal(w.snapshot().running, 0);
});

/* -------------------------------------------------------------------------- */
/* CARDINALITÉ                                                                */
/* -------------------------------------------------------------------------- */

/**
 * L'étiquette `worker` est à valeurs fermées. Un nom hors catalogue est refusé,
 * jamais publié — et le worker continue de tourner : une métrique ne casse
 * jamais un worker.
 *
 * Il tombe si `declareWorker` accepte n'importe quel nom (`snapshotAll`
 * renverrait 5 séries) ou s'il lève au lieu de rendre une poignée inerte.
 */
test("un nom de worker hors catalogue est refusé, et le worker continue de tourner", async () => {
  const avertissements = [];
  const w = declareWorker("worker-inventé-par-une-donnée", {
    logger: { warn: (m) => avertissements.push(m), info() {}, error() {} },
  });

  assert.equal(
    snapshotAll().filter((s) => s.state !== STATE.NEVER_DECLARED).length,
    0,
    "un nom libre ne doit produire AUCUNE série : c'est ainsi qu'on fait " +
      "tomber Prometheus (voir l'en-tête de metrics.js)."
  );

  assert.match(avertissements.join(" "), /NON instrumenté/);

  // La poignée inerte laisse passer le travail sans rien casser.
  assert.equal(await w.record(async () => 42), 42);
});

/* -------------------------------------------------------------------------- */
/* ENREGISTREMENT DES JAUGES                                                  */
/* -------------------------------------------------------------------------- */

/** Double du registre `createMetrics()` : on capture ce qui est enregistré. */
function fauxMetrics() {
  const jauges = new Map();

  return {
    registerAsyncGauge({ name, help, labelNames, collect }) {
      const valeurs = new Map();

      const g = {
        name,
        help,
        labelNames,
        valeurs,
        reset: () => valeurs.clear(),
        set: (labels, v) => valeurs.set(JSON.stringify(labels), v),
        collect: () => collect(g),
      };

      jauges.set(name, g);
      return g;
    },
    jauges,
    async scruter() {
      for (const g of jauges.values()) await g.collect();
      return jauges;
    },
  };
}

/**
 * La forme livrée est imposée : une jauge d'ÂGE, plus les séries qui expliquent.
 * Ce test verrouille les noms — les renommer casserait toutes les alertes déjà
 * posées, en silence.
 */
test("les huit jauges attendues sont enregistrées, étiquetées par worker", async () => {
  const m = fauxMetrics();

  const { registered, workers } = registerWorkerMetrics(m, { logger: muet });

  assert.equal(registered, true);
  assert.deepEqual(workers, [...KNOWN_WORKERS]);

  const attendues = [
    "worker_last_run_age_seconds",
    "worker_last_run_timestamp_seconds",
    "worker_last_run_duration_seconds",
    "worker_runs",
    "worker_failures",
    "worker_last_run_success",
    "worker_enabled",
    "worker_running",
  ];

  for (const nom of attendues) {
    assert.ok(m.jauges.has(nom), `jauge « ${nom} » absente de /metrics`);
    assert.deepEqual(
      m.jauges.get(nom).labelNames,
      ["worker"],
      `« ${nom} » doit être étiquetée par worker, et par rien d'autre`
    );
  }

  const age = m.jauges.get("worker_last_run_age_seconds");
  assert.match(
    age.help,
    /alerter/i,
    "l'aide de la jauge d'âge doit dire que c'est ELLE qu'on alerte"
  );
});

/**
 * La valeur est lue À LA SCRUTATION, pas figée à l'enregistrement : les jauges
 * sont posées dans `server.js` au chargement, alors qu'aucun worker n'a encore
 * démarré (`bootstrap()` vient plus tard).
 *
 * Il tombe si `collect` capture un instantané au lieu d'appeler `snapshots()`.
 */
test("une jauge posée AVANT le démarrage d'un worker le voit apparaître", async () => {
  const h = horloge();
  const m = fauxMetrics();

  registerWorkerMetrics(m, { logger: muet, snapshots: () => snapshotAll(h.now()) });

  let vu = await m.scruter();
  assert.equal(
    vu.get("worker_enabled").valeurs.get(JSON.stringify({ worker: WORKERS.TX_AUTO_CANCEL })),
    STATE.NEVER_DECLARED
  );

  // Le worker démarre APRÈS l'enregistrement des jauges — comme en vrai.
  const w = declareWorker(WORKERS.TX_AUTO_CANCEL, { logger: muet, now: h.now });
  await w.record(async () => ({ cancelled: 0 }));

  vu = await m.scruter();

  assert.equal(
    vu.get("worker_enabled").valeurs.get(JSON.stringify({ worker: WORKERS.TX_AUTO_CANCEL })),
    STATE.ENABLED,
    "un worker déclaré après l'enregistrement des jauges doit apparaître seul"
  );
  assert.equal(
    vu.get("worker_runs").valeurs.get(JSON.stringify({ worker: WORKERS.TX_AUTO_CANCEL })),
    1
  );
});

/**
 * `reset()` avant chaque série : sans lui, une valeur d'un cycle précédent
 * survivrait à l'infini et l'alerte resterait allumée après la fin de
 * l'incident. Même raison que dans `mongoPoolMetrics.js`.
 */
test("chaque scrutation repart d'une jauge remise à zéro", async () => {
  const m = fauxMetrics();
  let series = [{ worker: WORKERS.RECONCILIATION, ...decrire(null) }];

  registerWorkerMetrics(m, { logger: muet, snapshots: () => series });

  await m.scruter();
  assert.equal(m.jauges.get("worker_enabled").valeurs.size, 1);

  series = [];
  await m.scruter();

  assert.equal(
    m.jauges.get("worker_enabled").valeurs.size,
    0,
    "sans reset(), une série retirée garderait sa dernière valeur pour toujours"
  );
});

/**
 * B.6 — si les métriques ne peuvent pas s'enregistrer, le démarrage le dit avec
 * sa CONSÉQUENCE. Un message qui dit seulement « échec » n'aide personne.
 */
test("un registre invalide est signalé avec sa conséquence, puis lève", () => {
  const erreurs = [];

  assert.throws(
    () =>
      registerWorkerMetrics(
        {},
        { logger: { error: (m) => erreurs.push(m), warn() {}, info() {} } }
      ),
    /metrics.*invalide/
  );

  assert.match(
    erreurs.join(" "),
    /invisible/,
    "le journal doit nommer la conséquence — l'arrêt d'un worker deviendrait " +
      "invisible — et pas seulement constater l'échec (règle B.6)."
  );
});

/* -------------------------------------------------------------------------- */
/* RENDU RÉEL SUR /metrics                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Les tests ci-dessus passent par une doublure de registre : ils vérifient ce
 * qu'on DEMANDE d'enregistrer, pas ce que `prom-client` accepte. Un nom de
 * métrique invalide, une étiquette non déclarée ou une valeur non numérique ne
 * se verraient qu'à la première scrutation du service réel.
 *
 * Ce test rend donc la page avec le VRAI `prom-client`, sur un registre neuf.
 * Il reste pur : `collectDefault: false`, aucun serveur, aucune I/O.
 *
 * Il tombe si un nom cesse d'être un identifiant Prometheus valide, ou si une
 * jauge publie autre chose qu'un nombre.
 */
test("la page /metrics rend réellement l'âge des quatre workers", async () => {
  const h = horloge();
  const client = require("prom-client");
  const { createMetrics } = require("../src/services/metrics");

  const m = createMetrics({
    client,
    registry: new client.Registry(),
    collectDefault: false,
  });

  registerWorkerMetrics(m, { logger: muet, snapshots: () => snapshotAll(h.now()) });

  const w = declareWorker(WORKERS.TX_AUTO_CANCEL, { logger: muet, now: h.now });
  await w.record(async () => ({ cancelled: 3 }));

  h.avance(900_000); // quinze minutes sans nouveau tour

  const page = await m.metrics();

  assert.match(
    page,
    /^worker_last_run_age_seconds\{worker="tx-auto-cancel"\} 900$/m,
    "l'âge doit apparaître tel quel sur la page — c'est la série qu'on alerte :\n" +
      page
  );

  // Les quatre workers du catalogue sont présents, y compris ceux qui n'ont
  // jamais démarré : leur absence doit être visible, pas silencieuse.
  for (const nom of KNOWN_WORKERS) {
    assert.ok(
      page.includes(`worker_enabled{worker="${nom}"}`),
      `« ${nom} » n'apparaît pas sur la page`
    );
  }

  assert.match(page, /^worker_enabled\{worker="reconciliation"\} -1$/m);
  assert.match(page, /^worker_runs\{worker="tx-auto-cancel"\} 1$/m);
});
