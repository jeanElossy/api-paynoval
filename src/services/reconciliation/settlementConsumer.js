"use strict";

/**
 * ============================================================================
 * RÉCONCILIATION DÉCLENCHÉE PAR ÉVÉNEMENT — la branche « Settlement » du bus
 * ============================================================================
 *
 * ── Ce que ça corrige ───────────────────────────────────────────────────────
 *
 * La réconciliation tournait uniquement sur MINUTERIE. Un écart entre une
 * transaction et le grand livre attendait le prochain balayage : plusieurs
 * heures pendant lesquelles un solde s'affichait sans que les écritures le
 * justifient. Sur le chemin de l'argent, le délai de détection EST le défaut.
 *
 * ── Pourquoi le balayage périodique RESTE ───────────────────────────────────
 *
 * ⚠️ Ce consommateur ne le remplace pas, et le retirer serait une régression.
 *
 * Un contrôle déclenché par événement a exactement les angles morts du bus :
 * il ne voit pas ce que le bus n'a pas livré, ni les états qui changent sans
 * événement — rappels prestataires, rattrapages manuels, écritures orphelines
 * dont aucune transaction ne parle. Le balayage attrape tout cela.
 *
 * Les deux ensemble : l'événement donne la VITESSE, le balayage donne la
 * COUVERTURE. Choisir l'un contre l'autre, c'est perdre l'autre moitié.
 *
 * ── Ce qu'il ne fait pas ────────────────────────────────────────────────────
 *
 * Il ne CORRIGE rien. Il lit, compare et signale — comme le service qu'il
 * appelle. Une correction automatique d'écriture comptable violerait
 * l'invariant 4 : pour corriger, on écrit une contre-écriture, jamais on ne
 * réécrit l'originale, et cette décision revient à un humain.
 */

const { getTxConn } = require("../../config/db");
const { createConsumer } = require("../events/consumer");
const logger = require("../../utils/logger");

const {
  reconcileOneTransaction,
} = require("./transactionReconciliationService");

const GROUPE = "settlement-reconciliation";

const EVENEMENTS = Object.freeze([
  "transaction.confirmed.v1",
  "transaction.cancelled.v1",
]);

let _ProcessedEvent = null;

function ProcessedEvent() {
  if (!_ProcessedEvent) {
    _ProcessedEvent = require("../../models/ProcessedEvent")(getTxConn());
  }
  return _ProcessedEvent;
}

async function handler(message) {
  const transactionId = message?.payload?.transactionId;

  const bilan = await reconcileOneTransaction(transactionId);

  if (bilan.anomalies.length) {
    /**
     * ⚠️ `error`, pas `warn`. Un écart entre une transaction et le grand livre
     * est une incohérence du chemin de l'argent : il doit apparaître dans ce
     * que la supervision REMONTE, pas dans ce qu'elle filtre.
     *
     * On journalise les TYPES et les identifiants, jamais les montants ni les
     * comptes — le détail est dans `reconciliation_runs` et dans le grand
     * livre, tous deux à accès restreint (règle B.4).
     */
    logger.error("[settlement] écart transaction ↔ grand livre", {
      transactionId: String(transactionId || ""),
      reference: message?.payload?.reference || "",
      types: bilan.anomalies.map((a) => a.type),
      nb: bilan.anomalies.length,
      declencheur: message.name,
    });
  }

  await ProcessedEvent().create({
    group: GROUPE,
    eventId: message.eventId,
    eventName: message.name,
    processedAt: new Date(),
    outcome: bilan.anomalies.length
      ? `anomalies:${bilan.anomalies.length}`
      : bilan.raison || "coherent",
  });
}

async function dejaTraite(eventId) {
  if (!eventId) return false;

  const trouve = await ProcessedEvent()
    .findOne({ group: GROUPE, eventId: String(eventId) })
    .select({ _id: 1 })
    .lean();

  return Boolean(trouve);
}

async function onDeadLetter(message, err) {
  /**
   * Une transaction non réconciliée n'est PAS perdue : le balayage périodique
   * la reprendra. C'est précisément pourquoi il reste en place — et c'est ce
   * que ce message doit dire, pour qu'on ne le lise pas comme une perte.
   */
  logger.error("[settlement] transaction NON réconciliée par événement", {
    eventId: message?.eventId,
    transactionId: message?.payload?.transactionId || "",
    message: err?.message,
    consequence:
      "sera reprise par le balayage périodique de la réconciliation — " +
      "détection retardée, pas perdue",
  });

  try {
    await ProcessedEvent().create({
      group: GROUPE,
      eventId: message.eventId,
      eventName: message.name,
      processedAt: new Date(),
      outcome: "lettre-morte",
    });
  } catch {
    /** Le registre est un confort ici : l'essentiel est déjà journalisé. */
  }
}

function build({ logger: journal = logger } = {}) {
  return createConsumer({
    groupe: GROUPE,
    evenements: EVENEMENTS,
    handler,
    dejaTraite,
    onDeadLetter,
    logger: journal,
  });
}

function annoncer(journal = logger) {
  journal.info?.(
    `✅ Réconciliation événementielle — ${EVENEMENTS.join(", ")}. ` +
      "Le balayage périodique reste actif : l'événement donne la vitesse, le " +
      "balayage donne la couverture."
  );
}

module.exports = { GROUPE, EVENEMENTS, handler, dejaTraite, build, annoncer };
