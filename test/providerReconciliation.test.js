"use strict";

/**
 * ============================================================================
 * RÉCONCILIATION CONTRE LE PRESTATAIRE — F.3
 * ============================================================================
 *
 * Ce que ces tests protègent avant tout, ce n'est pas la détection : c'est
 * l'ABSENCE de fausse détection. Un contrôle qui signale des dossiers
 * parfaitement normaux est désactivé dans la semaine, et il ne sert alors plus
 * à rien le jour où il a raison.
 *
 * Trois faux positifs sont donc testés explicitement, parce que chacun a été
 * écrit à dessein dans le code :
 *   - le remboursement légitime (crédité PUIS remboursé) ;
 *   - le règlement encore en cours (bail non expiré) ;
 *   - la transaction antérieure au registre des rappels.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  PROVIDER_ANOMALIES,
  DEFAULT_DELAYS,
  canonicalVerdict,
  isSuccessApplied,
  isFailureApplied,
  classifyStuckEvent,
  lastProviderWord,
  classifyVerdict,
  resolveRegistryFloor,
  classifySettlementTimeout,
  correlationKeys,
  transactionKeys,
} = require("../src/services/reconciliation/providerReconciliationRules");

const { LEASE_MS } = require("../src/services/webhooks/webhookIdempotency");
const {
  mergeReports,
} = require("../src/services/reconciliation/reconciliationScheduler");

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const NOW = Date.parse("2026-08-26T12:00:00.000Z");

const ago = (ms) => new Date(NOW - ms);

/* -------------------------------------------------------------------------- */
/* Normalisation des verdicts                                                 */
/* -------------------------------------------------------------------------- */

test("canonicalVerdict reconnaît les synonymes de succès des prestataires", () => {
  for (const s of ["SUCCESS", "succeeded", "Paid", "SETTLED", "captured", "completed"]) {
    assert.equal(canonicalVerdict(s), "SUCCESS", s);
  }
});

test("canonicalVerdict reconnaît les synonymes d'échec", () => {
  for (const s of ["FAILED", "cancelled", "Rejected", "reversed", "EXPIRED"]) {
    assert.equal(canonicalVerdict(s), "FAILED", s);
  }
});

test("canonicalVerdict ne devine pas : l'inconnu reste PROCESSING", () => {
  // Un statut qu'on ne comprend pas ne doit surtout pas être lu comme un
  // succès : il déclencherait un écart « succès non appliqué » imaginaire.
  assert.equal(canonicalVerdict("QUELQUE_CHOSE_DE_NOUVEAU"), "PROCESSING");
  assert.equal(canonicalVerdict(null), "PROCESSING");
  assert.equal(canonicalVerdict(undefined), "PROCESSING");
  assert.equal(canonicalVerdict(""), "PROCESSING");
});

/* -------------------------------------------------------------------------- */
/* Notre état : le fait avant la déclaration                                  */
/* -------------------------------------------------------------------------- */

test("isSuccessApplied s'appuie sur les drapeaux, pas sur le statut", () => {
  // `confirmed` sans aucun drapeau : le dossier se dit abouti, l'argent n'a
  // pas bougé. Ce n'est pas un succès appliqué.
  assert.equal(isSuccessApplied({ status: "confirmed" }), false);

  assert.equal(isSuccessApplied({ status: "pending", beneficiaryCredited: true }), true);
  assert.equal(isSuccessApplied({ status: "pending", fundsCaptured: true }), true);
  assert.equal(isSuccessApplied(null), false);
});

test("isFailureApplied couvre les trois issues négatives", () => {
  for (const status of ["cancelled", "failed", "refunded"]) {
    assert.equal(isFailureApplied({ status }), true, status);
  }
  assert.equal(isFailureApplied({ status: "pending" }), false);
});

/* -------------------------------------------------------------------------- */
/* 1 et 2. Rappels restés en plan                                             */
/* -------------------------------------------------------------------------- */

test("un rappel en cours dans sa fenêtre de bail n'est PAS une anomalie", () => {
  const event = { status: "processing", startedAt: ago(MINUTE) };
  assert.equal(classifyStuckEvent(event, { now: NOW, leaseMs: LEASE_MS }), null);
});

test("le seuil additionne le bail : juste avant l'échéance, rien n'est signalé", () => {
  const juste = LEASE_MS + DEFAULT_DELAYS.unsettledGraceMs - 1000;
  const event = { status: "processing", startedAt: ago(juste) };

  assert.equal(classifyStuckEvent(event, { now: NOW, leaseMs: LEASE_MS }), null);
});

test("un rappel réservé et jamais clos au-delà du bail + grâce est signalé", () => {
  const event = { status: "processing", startedAt: ago(2 * HOUR) };
  const verdict = classifyStuckEvent(event, { now: NOW, leaseMs: LEASE_MS });

  assert.equal(verdict.type, PROVIDER_ANOMALIES.PROVIDER_EVENT_UNSETTLED);
  assert.equal(verdict.ageMs, 2 * HOUR);
});

test("un échec récent n'est pas signalé : le prestataire va rejouer", () => {
  const event = { status: "failed", updatedAt: ago(5 * MINUTE) };
  assert.equal(classifyStuckEvent(event, { now: NOW, leaseMs: LEASE_MS }), null);
});

test("un échec jamais repris au-delà de la grâce est signalé", () => {
  const event = { status: "failed", updatedAt: ago(3 * HOUR) };
  const verdict = classifyStuckEvent(event, { now: NOW, leaseMs: LEASE_MS });

  assert.equal(verdict.type, PROVIDER_ANOMALIES.PROVIDER_EVENT_FAILED);
});

test("un échec ancien se date sur updatedAt, pas sur createdAt", () => {
  // Reçu il y a trois jours mais rejoué il y a une minute : c'est vivant.
  const event = {
    status: "failed",
    createdAt: ago(3 * 24 * HOUR),
    updatedAt: ago(MINUTE),
  };

  assert.equal(classifyStuckEvent(event, { now: NOW, leaseMs: LEASE_MS }), null);
});

test("un rappel traité n'est jamais une anomalie de blocage", () => {
  const event = { status: "processed", startedAt: ago(30 * 24 * HOUR) };
  assert.equal(classifyStuckEvent(event, { now: NOW, leaseMs: LEASE_MS }), null);
});

test("classifyStuckEvent tolère une date absente sans lever", () => {
  assert.equal(classifyStuckEvent({ status: "processing" }, { now: NOW, leaseMs: LEASE_MS }), null);
  assert.equal(classifyStuckEvent(null, { now: NOW, leaseMs: LEASE_MS }), null);
});

/* -------------------------------------------------------------------------- */
/* Le dernier mot                                                             */
/* -------------------------------------------------------------------------- */

test("lastProviderWord retient le rappel le plus récent, pas le premier", () => {
  const events = [
    { _id: "a", providerStatus: "FAILED", createdAt: ago(5 * HOUR) },
    { _id: "b", providerStatus: "SUCCESS", createdAt: ago(1 * HOUR) },
  ];

  const word = lastProviderWord(events);

  // Premier essai échoué, second réussi : conclure à l'échec ferait réclamer
  // un remboursement pour de l'argent bien reçu.
  assert.equal(word.event._id, "b");
  assert.equal(word.verdict, "SUCCESS");
});

test("lastProviderWord préfère processedAt quand il existe", () => {
  const events = [
    { _id: "a", providerStatus: "SUCCESS", createdAt: ago(3 * HOUR), processedAt: ago(10 * MINUTE) },
    { _id: "b", providerStatus: "FAILED", createdAt: ago(2 * HOUR) },
  ];

  assert.equal(lastProviderWord(events).event._id, "a");
});

test("un rappel « en cours » ne masque pas un SUCCÈS annoncé à la même seconde", () => {
  /**
   * Défaut trouvé à la vérification sur base, pas en test : le rappel
   * `PROCESSING` l'emportait par simple ordre d'arrivée et le contrôle
   * concluait « rien à signaler » sur un succès jamais appliqué — le pire des
   * écarts, masqué par le plus anodin des événements.
   */
  const at = ago(5 * HOUR);
  const events = [
    { _id: "a", providerStatus: "SUCCESS", createdAt: at },
    { _id: "b", providerStatus: "PROCESSING", createdAt: at },
  ];

  const word = lastProviderWord(events);
  assert.equal(word.verdict, "SUCCESS");
  assert.equal(word.event._id, "a");
});

test("un ÉCHEC postérieur l'emporte bien sur un SUCCÈS antérieur", () => {
  // La règle ne privilégie pas le succès : elle écarte les non-verdicts.
  const events = [
    { _id: "a", providerStatus: "SUCCESS", createdAt: ago(5 * HOUR) },
    { _id: "b", providerStatus: "FAILED", createdAt: ago(1 * HOUR) },
  ];

  assert.equal(lastProviderWord(events).verdict, "FAILED");
});

test("sans aucun verdict terminal, le dernier « en cours » fait foi", () => {
  const events = [
    { _id: "a", providerStatus: "PROCESSING", createdAt: ago(5 * HOUR) },
    { _id: "b", providerStatus: "PROCESSING", createdAt: ago(1 * HOUR) },
  ];

  const word = lastProviderWord(events);
  assert.equal(word.verdict, "PROCESSING");
  assert.equal(word.event._id, "b");
});

test("à date égale, le départage est déterministe et non dicté par l'ordre", () => {
  /**
   * Deux rappels à la même seconde sont la norme lors d'une rafale. Si le
   * résultat dépendait de l'ordre rendu par Mongo, deux balayages successifs
   * pourraient conclure différemment sur les mêmes données — et un contrôle
   * financier non reproductible n'est pas un contrôle.
   */
  const at = ago(3 * HOUR);
  const a = { _id: "aaa", providerStatus: "SUCCESS", createdAt: at };
  const b = { _id: "bbb", providerStatus: "FAILED", createdAt: at };

  assert.equal(lastProviderWord([a, b]).event._id, "bbb");
  assert.equal(lastProviderWord([b, a]).event._id, "bbb", "ordre inverse, même conclusion");
});

test("lastProviderWord rend null sur une liste vide ou sans date", () => {
  assert.equal(lastProviderWord([]), null);
  assert.equal(lastProviderWord([{ providerStatus: "SUCCESS" }]), null);
});

/* -------------------------------------------------------------------------- */
/* 3 à 5. Verdict contre état                                                 */
/* -------------------------------------------------------------------------- */

const vieux = (verdict) => ({
  event: { _id: "e", providerStatus: verdict },
  verdict,
  at: NOW - 5 * HOUR,
});

test("un rappel sur une transaction introuvable est orphelin", () => {
  const out = classifyVerdict(null, vieux("SUCCESS"), { now: NOW });
  assert.equal(out.type, PROVIDER_ANOMALIES.PROVIDER_EVENT_ORPHAN);
});

test("l'orphelin ne bénéficie d'aucune grâce : une transaction absente ne va pas apparaître", () => {
  const frais = { event: { _id: "e" }, verdict: "SUCCESS", at: NOW - 10 * 1000 };
  const out = classifyVerdict(null, frais, { now: NOW });

  assert.equal(out.type, PROVIDER_ANOMALIES.PROVIDER_EVENT_ORPHAN);
});

test("un verdict PROCESSING ne contredit rien", () => {
  const tx = { status: "pending" };
  assert.equal(classifyVerdict(tx, vieux("PROCESSING"), { now: NOW }), null);
});

test("SUCCÈS annoncé et non appliqué : le client a payé et n'a rien reçu", () => {
  const tx = { status: "pending", beneficiaryCredited: false, fundsCaptured: false };
  const out = classifyVerdict(tx, vieux("SUCCESS"), { now: NOW });

  assert.equal(out.type, PROVIDER_ANOMALIES.PROVIDER_SUCCESS_NOT_APPLIED);
  assert.equal(out.verdict, "SUCCESS");
});

test("SUCCÈS annoncé récemment : la grâce protège le règlement en cours", () => {
  const tx = { status: "pending", beneficiaryCredited: false };
  const frais = { event: { _id: "e" }, verdict: "SUCCESS", at: NOW - MINUTE };

  // Entre le rappel et l'état final il y a un règlement asynchrone : signaler
  // ici produirait une alerte qui se résout toute seule en quelques secondes.
  assert.equal(classifyVerdict(tx, frais, { now: NOW }), null);
});

test("SUCCÈS annoncé et appliqué : rien à signaler", () => {
  const tx = { status: "confirmed", beneficiaryCredited: true };
  assert.equal(classifyVerdict(tx, vieux("SUCCESS"), { now: NOW }), null);
});

test("ÉCHEC annoncé alors que le bénéficiaire a été crédité : perte sèche", () => {
  const tx = { status: "confirmed", beneficiaryCredited: true };
  const out = classifyVerdict(tx, vieux("FAILED"), { now: NOW });

  assert.equal(out.type, PROVIDER_ANOMALIES.PROVIDER_FAILURE_APPLIED);
});

test("FAUX POSITIF ÉVITÉ — un remboursement légitime n'est pas signalé", () => {
  /**
   * Une transaction remboursée porte `beneficiaryCredited: true` (le crédit a
   * bien eu lieu) ET le statut `refunded`. Sans la condition
   * `!isFailureApplied`, le contrôle hurlerait sur TOUS les dossiers déjà
   * traités — c'est-à-dire exactement sur ceux dont on s'est occupé.
   */
  const tx = { status: "refunded", beneficiaryCredited: true };
  assert.equal(classifyVerdict(tx, vieux("FAILED"), { now: NOW }), null);
});

test("FAUX POSITIF ÉVITÉ — une annulation traitée n'est pas signalée", () => {
  const tx = { status: "cancelled", fundsCaptured: true };
  assert.equal(classifyVerdict(tx, vieux("FAILED"), { now: NOW }), null);
});

test("ÉCHEC annoncé sur une transaction jamais aboutie : cohérent, rien à dire", () => {
  const tx = { status: "pending", beneficiaryCredited: false };
  assert.equal(classifyVerdict(tx, vieux("FAILED"), { now: NOW }), null);
});

test("classifyVerdict sans dernier mot rend null", () => {
  assert.equal(classifyVerdict({ status: "pending" }, null, { now: NOW }), null);
});

/* -------------------------------------------------------------------------- */
/* 6. Le silence du prestataire                                               */
/* -------------------------------------------------------------------------- */

test("registre vide : aucun plancher, le contrôle doit être sauté", () => {
  const { floor, reason } = resolveRegistryFloor({});

  assert.equal(floor, null);
  assert.equal(reason, "registry-empty");
});

test("le plancher se calibre sur le plus ancien rappel connu", () => {
  const oldest = ago(10 * 24 * HOUR);
  const { floor, reason } = resolveRegistryFloor({ oldestEventAt: oldest });

  assert.equal(floor, oldest.getTime());
  assert.equal(reason, "oldest-event");
});

test("le plancher explicite prime sur le registre", () => {
  const { floor, reason } = resolveRegistryFloor({
    oldestEventAt: ago(HOUR),
    override: "2026-01-01T00:00:00.000Z",
  });

  assert.equal(floor, Date.parse("2026-01-01T00:00:00.000Z"));
  assert.equal(reason, "override");
});

test("FAUX POSITIF ÉVITÉ — une transaction antérieure au registre n'est jamais signalée", () => {
  /**
   * C'est le piège du premier tour : avant que le registre existe, aucune
   * transaction n'a de rappel enregistré. Sans plancher, le premier balayage
   * lèverait un écart par transaction passée — et un contrôle qui s'ouvre sur
   * des centaines de faux positifs est désactivé dans la semaine.
   */
  const floor = NOW - 24 * HOUR;
  const tx = { executedAt: ago(30 * 24 * HOUR) };

  assert.equal(classifySettlementTimeout(tx, { now: NOW, floor }), null);
});

test("sans plancher, classifySettlementTimeout ne conclut rien", () => {
  const tx = { executedAt: ago(30 * 24 * HOUR) };
  assert.equal(classifySettlementTimeout(tx, { now: NOW, floor: null }), null);
});

test("une remise récente au prestataire n'est pas un silence", () => {
  const floor = NOW - 30 * 24 * HOUR;
  const tx = { executedAt: ago(HOUR) };

  assert.equal(classifySettlementTimeout(tx, { now: NOW, floor }), null);
});

test("une remise ancienne sans retour est signalée", () => {
  const floor = NOW - 30 * 24 * HOUR;
  const tx = { executedAt: ago(12 * HOUR) };
  const out = classifySettlementTimeout(tx, { now: NOW, floor });

  assert.equal(out.type, PROVIDER_ANOMALIES.SETTLEMENT_TIMEOUT);
  assert.equal(out.ageMs, 12 * HOUR);
});

test("l'attente se compte depuis la remise au prestataire, pas depuis la création", () => {
  /**
   * Une transaction créée il y a une semaine mais exécutée il y a dix minutes
   * n'attend que depuis dix minutes. Compter depuis `createdAt` signalerait
   * chaque transaction relancée.
   */
  const floor = NOW - 30 * 24 * HOUR;
  const tx = { createdAt: ago(7 * 24 * HOUR), executedAt: ago(10 * MINUTE) };

  assert.equal(classifySettlementTimeout(tx, { now: NOW, floor }), null);
});

/* -------------------------------------------------------------------------- */
/* Corrélation                                                                */
/* -------------------------------------------------------------------------- */

test("un rappel se rattache par identifiant ET par référence", () => {
  const keys = correlationKeys({ transactionId: "abc", transactionReference: "TX-1" });
  assert.deepEqual(keys, ["id:abc", "ref:TX-1"]);
});

test("l'identifiant technique passe avant la référence, qui vient du prestataire", () => {
  const keys = correlationKeys({ transactionId: "abc", transactionReference: "TX-1" });
  assert.equal(keys[0], "id:abc");
});

test("les clés de transaction et de rappel se rejoignent", () => {
  const tx = { _id: "abc", reference: "TX-1" };
  const event = { transactionReference: "TX-1" };

  const communes = correlationKeys(event).filter((k) => transactionKeys(tx).includes(k));
  assert.deepEqual(communes, ["ref:TX-1"]);
});

test("un rappel sans aucune clé n'est rattaché à rien", () => {
  assert.deepEqual(correlationKeys({}), []);
  assert.deepEqual(correlationKeys(null), []);
});

test("la référence est débarrassée de ses espaces avant comparaison", () => {
  assert.deepEqual(correlationKeys({ transactionReference: "  TX-1  " }), ["ref:TX-1"]);
  assert.deepEqual(transactionKeys({ reference: "TX-1 " }), ["ref:TX-1"]);
});

/* -------------------------------------------------------------------------- */
/* Fusion des deux axes                                                       */
/* -------------------------------------------------------------------------- */

test("mergeReports additionne les anomalies des deux axes", () => {
  const merged = mergeReports(
    { anomalies: [{ type: "WALLET_IMBALANCE" }], checked: { wallets: 3 } },
    { anomalies: [{ type: "SETTLEMENT_TIMEOUT" }], checked: { providerEvents: 7 } }
  );

  assert.equal(merged.anomalies.length, 2);
  assert.equal(merged.checked.wallets, 3);
  assert.equal(merged.checked.providerEvents, 7);
  assert.equal(merged.healthy, false);
});

test("mergeReports n'est vert que si les DEUX axes le sont", () => {
  const merged = mergeReports(
    { anomalies: [], checked: {} },
    { anomalies: [{ type: "PROVIDER_EVENT_ORPHAN" }], checked: {} }
  );

  assert.equal(merged.healthy, false);
});

test("mergeReports reporte l'information de registre, qui qualifie le vert", () => {
  const merged = mergeReports(
    { anomalies: [], checked: {} },
    { anomalies: [], checked: {}, registry: { settlementTimeoutSkipped: true } }
  );

  // Vert ET incomplet : sans cette information, « 0 écart » se lirait comme
  // « tout va bien » alors que la question n'a pas été posée.
  assert.equal(merged.healthy, true);
  assert.equal(merged.registry.settlementTimeoutSkipped, true);
});

test("mergeReports tolère un axe absent", () => {
  const merged = mergeReports(null, null);

  assert.equal(merged.healthy, true);
  assert.equal(merged.anomalies.length, 0);
  assert.equal(merged.checked.providerEvents, 0);
});
