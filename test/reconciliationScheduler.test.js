"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  summarizeAnomalies,
  buildRunDocument,
  JOB_NAME,
} = require("../src/services/reconciliation/reconciliationScheduler");

const {
  buildAcquireFilter,
  buildAcquireUpdate,
} = require("../src/services/cronLock");

const {
  MAX_STORED_ANOMALIES,
} = require("../src/models/ReconciliationRun");

/**
 * Aucun de ces tests n'ouvre de connexion Mongo. Le planificateur est écrit pour
 * que ses décisions vivent dans des fonctions pures — c'est ce qui permet de les
 * vérifier ici sans base, et de garder la suite sous les trois secondes.
 */

/* -------------------------------------------------------------------------- */
/* Agrégation des anomalies                                                   */
/* -------------------------------------------------------------------------- */

test("les anomalies sont comptées PAR TYPE, pas seulement au total", () => {
  /**
   * « 400 STUCK_RESERVATION » appelle une réaction très différente de
   * « 1 WALLET_IMBALANCE », alors que les deux valent « des écarts existent ».
   * C'est le comptage par type qui rend l'alerte exploitable.
   */
  const byType = summarizeAnomalies([
    { type: "WALLET_IMBALANCE" },
    { type: "STUCK_RESERVATION" },
    { type: "STUCK_RESERVATION" },
    { type: "STUCK_RESERVATION" },
  ]);

  assert.deepEqual(byType, { WALLET_IMBALANCE: 1, STUCK_RESERVATION: 3 });
});

test("une anomalie sans type est comptée, pas ignorée", () => {
  // Perdre silencieusement un écart parce qu'il est mal formé serait le pire
  // comportement possible pour un dispositif de détection.
  assert.deepEqual(summarizeAnomalies([{}, { type: null }]), { UNKNOWN: 2 });
});

test("aucune anomalie donne un objet vide, pas null", () => {
  assert.deepEqual(summarizeAnomalies([]), {});
  assert.deepEqual(summarizeAnomalies(undefined), {});
});

/* -------------------------------------------------------------------------- */
/* Construction du compte-rendu                                               */
/* -------------------------------------------------------------------------- */

function makeReport(anomalies = []) {
  return {
    window: { sinceHours: 48, since: new Date("2026-08-24T00:00:00Z") },
    checked: { wallets: 10, transactions: 20, ledgerEntries: 30, reservations: 40 },
    anomalies,
  };
}

const RUN_CTX = {
  workerId: "host:1:abcd",
  startedAt: new Date("2026-08-26T02:00:00Z"),
  durationMs: 4200,
};

test("un balayage sans écart est marqué sain", () => {
  const doc = buildRunDocument(makeReport([]), RUN_CTX);

  assert.equal(doc.job, JOB_NAME);
  assert.equal(doc.status, "completed");
  assert.equal(doc.healthy, true);
  assert.equal(doc.anomalyCount, 0);
  assert.equal(doc.anomaliesTruncated, false);
  assert.deepEqual(doc.checked, {
    wallets: 10,
    transactions: 20,
    ledgerEntries: 30,
    reservations: 40,
    // Axe prestataire (F.3) : absent de ce rapport d'exemple, donc à zéro.
    providerEvents: 0,
    awaitingSettlement: 0,
  });
});

test("un balayage avec écarts n'est PAS sain, même s'il aboutit techniquement", () => {
  const doc = buildRunDocument(
    makeReport([{ type: "WALLET_IMBALANCE" }]),
    RUN_CTX
  );

  assert.equal(doc.status, "completed", "techniquement terminé");
  assert.equal(doc.healthy, false, "mais pas sain — la distinction est le sujet");
  assert.equal(doc.anomalyCount, 1);
});

test("le COMPTE est exact même quand l'échantillon est tronqué", () => {
  /**
   * Un balayage dégradé peut produire des milliers d'écarts. Tout stocker
   * ferait heurter la limite de 16 Mo de MongoDB, et l'écriture du rapport
   * échouerait le jour où il est le plus utile. Le compte doit rester juste.
   */
  const many = Array.from({ length: MAX_STORED_ANOMALIES + 250 }, () => ({
    type: "STUCK_RESERVATION",
  }));

  const doc = buildRunDocument(makeReport(many), RUN_CTX);

  assert.equal(doc.anomalyCount, MAX_STORED_ANOMALIES + 250, "compte exact");
  assert.equal(doc.anomalies.length, MAX_STORED_ANOMALIES, "échantillon borné");
  assert.equal(doc.anomaliesTruncated, true);
  assert.equal(
    doc.anomaliesByType.STUCK_RESERVATION,
    MAX_STORED_ANOMALIES + 250,
    "l'agrégat porte sur TOUTES les anomalies, pas sur l'échantillon"
  );
});

test("la fenêtre analysée est conservée — sinon le rapport est ininterprétable", () => {
  const doc = buildRunDocument(makeReport([]), RUN_CTX);

  assert.equal(doc.window.sinceHours, 48);
  assert.deepEqual(doc.window.since, new Date("2026-08-24T00:00:00Z"));
});

test("la date de fin découle de la durée mesurée, pas d'une seconde horloge", () => {
  const doc = buildRunDocument(makeReport([]), RUN_CTX);

  assert.equal(doc.durationMs, 4200);
  assert.deepEqual(doc.finishedAt, new Date("2026-08-26T02:00:04.200Z"));
});

test("un rapport incomplet ne fait pas échouer la construction", () => {
  // Le compte-rendu d'un balayage partiel vaut mieux que pas de compte-rendu.
  const doc = buildRunDocument({}, RUN_CTX);

  assert.equal(doc.anomalyCount, 0);
  assert.deepEqual(doc.checked, {
    wallets: 0,
    transactions: 0,
    ledgerEntries: 0,
    reservations: 0,
    providerEvents: 0,
    awaitingSettlement: 0,
  });

  /**
   * Un rapport vide ne doit PAS prétendre que le contrôle des silences a eu
   * lieu : `settlementTimeoutSkipped` reste faux, mais `reason` reste nul —
   * c'est ce qui distingue « posé et vert » de « jamais posé ».
   */
  assert.equal(doc.registry.reason, null);
});

/* -------------------------------------------------------------------------- */
/* Le verrou de tâche                                                         */
/* -------------------------------------------------------------------------- */

test("le verrou n'est pris que s'il est libre ou expiré", () => {
  const now = new Date("2026-08-26T02:00:00Z");
  const filter = buildAcquireFilter(JOB_NAME, now);

  assert.equal(filter._id, JOB_NAME);

  // Les trois formes d'un verrou disponible : jamais posé, champ absent, expiré.
  assert.deepEqual(filter.$or, [
    { expiresAt: null },
    { expiresAt: { $exists: false } },
    { expiresAt: { $lte: now } },
  ]);
});

test("prendre le verrou repousse toujours son expiration", () => {
  /**
   * Sans `expiresAt` dans le futur, une seconde instance satisferait le filtre
   * immédiatement après la première et le balayage tournerait en double.
   */
  const now = new Date("2026-08-26T02:00:00Z");
  const ttl = 30 * 60 * 1000;

  const update = buildAcquireUpdate("jeton", now, ttl);

  assert.equal(update.$set.lockedBy, "jeton");
  assert.deepEqual(update.$set.expiresAt, new Date(now.getTime() + ttl));
  assert.ok(update.$set.expiresAt > now);
});

test("le nom de la tâche est stable — c'est la clé du verrou", () => {
  /**
   * `_id` porte le nom : le changer libérerait le verrou détenu sous l'ancien
   * nom et autoriserait deux balayages concurrents le temps d'un déploiement
   * progressif.
   */
  assert.equal(JOB_NAME, "transaction-reconciliation");
});

/* -------------------------------------------------------------------------- */
/* Chargement                                                                 */
/* -------------------------------------------------------------------------- */

test("le planificateur se charge sans connexion Mongo", () => {
  /**
   * Contrainte du dépôt : aucun module ne doit résoudre un modèle de la
   * connexion `tx` à l'import. Ce test échouerait au `require` en tête de
   * fichier si la règle était enfreinte — il documente l'intention.
   */
  const mod = require("../src/services/reconciliation/reconciliationScheduler");

  assert.equal(typeof mod.startReconciliationWorker, "function");
  assert.equal(typeof mod.runReconciliationOnce, "function");
  assert.equal(typeof mod.getLastRun, "function");
});

test("le worker se désactive proprement par variable d'environnement", () => {
  const {
    startReconciliationWorker,
  } = require("../src/services/reconciliation/reconciliationScheduler");

  const handle = startReconciliationWorker({ enabled: false });

  assert.equal(handle, null, "désactivé ⇒ aucun minuteur, aucun effet de bord");
});

/* -------------------------------------------------------------------------- */
/* Planification — rattrapage ancré sur le dernier passage enregistré          */
/* -------------------------------------------------------------------------- */

const {
  decideRun,
  startReconciliationWorker,
  CHECK_EVERY_MS,
} = require("../src/services/reconciliation/reconciliationScheduler");

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-10-01T12:00:00Z");
const ago = (ms) => new Date(NOW - ms);

test("échéance : aucun passage enregistré ⇒ balayage dû", () => {
  const d = decideRun({}, { now: NOW, periodMs: DAY });
  assert.equal(d.due, true);
  assert.equal(d.reason, "never-ran");
});

test("échéance : dernier passage complet il y a 2,2 j ⇒ balayage dû (l'alerte du 2026-10-01)", () => {
  const last = ago(2.2 * DAY);
  const d = decideRun({ lastCompletedAt: last, lastAttemptAt: last }, { now: NOW, periodMs: DAY });
  assert.equal(d.due, true);
  assert.equal(d.reason, "overdue");
});

test("échéance : dernier passage complet il y a 3 h ⇒ rien à faire", () => {
  const last = ago(3 * HOUR);
  const d = decideRun({ lastCompletedAt: last, lastAttemptAt: last }, { now: NOW, periodMs: DAY });
  assert.equal(d.due, false);
  assert.equal(d.reason, "fresh");
});

test("échéance : un échec récent retient le balayage — une base en panne n'est pas martelée", () => {
  const d = decideRun(
    { lastCompletedAt: ago(2 * DAY), lastAttemptAt: ago(10 * 60 * 1000) },
    { now: NOW, periodMs: DAY, retryAfterMs: HOUR }
  );
  assert.equal(d.due, false);
  assert.equal(d.reason, "retry-backoff");
});

test("échéance : un échec ancien ne bloque pas le rattrapage indéfiniment", () => {
  const d = decideRun(
    { lastCompletedAt: ago(2 * DAY), lastAttemptAt: ago(2 * HOUR) },
    { now: NOW, periodMs: DAY, retryAfterMs: HOUR }
  );
  assert.equal(d.due, true);
});

test("échéance : une date illisible compte comme « jamais balayé », pas comme « frais »", () => {
  const d = decideRun({ lastCompletedAt: "pas une date" }, { now: NOW, periodMs: DAY });
  assert.equal(d.due, true);
});

/**
 * LE TEST DE LA PANNE DU 2026-10-01 (règle B.5).
 *
 * L'ancien worker ne faisait qu'un `setInterval(tick, 24 h)` : un processus qui
 * vit moins de 24 h (mise en veille, redéploiement) ne balayait JAMAIS. Ce
 * test démarre le VRAI worker, avance l'horloge du seul délai de démarrage, et
 * exige un balayage. Sur l'ancien code, aucun balayage n'a lieu avant 24 h.
 */
test("un service qui démarre après une échéance manquée balaie sans attendre 24 h", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });

  let sweeps = 0;
  const handle = startReconciliationWorker({
    enabled: true,
    intervalMs: DAY,
    startupDelayMs: 60_000,
    now: () => NOW,
    readState: async () => ({ lastCompletedAt: ago(2.2 * DAY), lastAttemptAt: ago(2.2 * DAY) }),
    runOnce: async () => {
      sweeps += 1;
      return { ran: true };
    },
  });

  try {
    t.mock.timers.tick(60_000);
    // Laisse s'écouler les promesses du contrôle déclenché par le minuteur.
    for (let i = 0; i < 10; i += 1) await Promise.resolve();

    assert.equal(sweeps, 1, "l'échéance manquée doit être rattrapée au premier contrôle");
  } finally {
    handle.stop();
  }
});

test("le contrôle ne balaie pas quand le dernier passage est récent", async () => {
  let sweeps = 0;
  const handle = startReconciliationWorker({
    enabled: true,
    intervalMs: DAY,
    startupDelayMs: 10 * DAY,
    now: () => NOW,
    readState: async () => ({ lastCompletedAt: ago(HOUR), lastAttemptAt: ago(HOUR) }),
    runOnce: async () => {
      sweeps += 1;
      return { ran: true };
    },
  });

  try {
    const r = await handle.check();
    assert.equal(r.ran, false);
    assert.equal(r.reason, "fresh");
    assert.equal(sweeps, 0);
  } finally {
    handle.stop();
  }
});

test("un état illisible n'est PAS pris pour « jamais balayé » : on s'abstient", async () => {
  let sweeps = 0;
  const handle = startReconciliationWorker({
    enabled: true,
    intervalMs: DAY,
    startupDelayMs: 10 * DAY,
    readState: async () => {
      throw new Error("base injoignable");
    },
    runOnce: async () => {
      sweeps += 1;
      return { ran: true };
    },
  });

  try {
    const r = await handle.check();
    assert.equal(r, null, "le contrôle échoue, il est compté et journalisé");
    assert.equal(sweeps, 0, "aucun balayage à l'aveugle");
  } finally {
    handle.stop();
  }
});

test("deux contrôles simultanés dans une instance ne lancent qu'un balayage", async () => {
  let sweeps = 0;
  let release;
  const gate = new Promise((r) => {
    release = r;
  });

  const handle = startReconciliationWorker({
    enabled: true,
    intervalMs: DAY,
    startupDelayMs: 10 * DAY,
    now: () => NOW,
    readState: async () => ({ lastCompletedAt: null, lastAttemptAt: null }),
    runOnce: async () => {
      sweeps += 1;
      await gate;
      return { ran: true };
    },
  });

  try {
    const a = handle.check();
    const b = handle.check();
    assert.equal(a, b, "le second appel rejoint le contrôle en cours");
    release();
    await Promise.all([a, b]);
    assert.equal(sweeps, 1);
  } finally {
    handle.stop();
  }
});

test("le contrôle d'échéance tourne au plus tous les quarts d'heure", () => {
  assert.ok(CHECK_EVERY_MS <= 15 * 60 * 1000);
});
