"use strict";

/**
 * ============================================================================
 * PARRAINAGE SUR LE BUS — la branche « Referral » du schéma cible
 * ============================================================================
 *
 * ── Ce qui change, et ce qui NE change PAS ──────────────────────────────────
 *
 * Ce qui change : le TRANSPORT. L'événement passait par `outboxes` avec
 * `service: "referral"`, drainé par `referralOutboxWorker`. Il passe désormais
 * par le bus partagé, comme la surveillance du risque et la réconciliation.
 *
 * Ce qui ne change pas : la GARANTIE. L'événement est toujours écrit dans la
 * même transaction Mongo que la confirmation financière, et la livraison est
 * toujours au moins une fois. L'exactitude n'a jamais été la responsabilité du
 * transport — elle est celle du registre d'idempotence côté principal
 * (`ReferralPayout`). Un transport « exactement une fois » n'existe pas ; un
 * consommateur idempotent, si.
 *
 * ── Pourquoi migrer un chemin qui fonctionnait ──────────────────────────────
 *
 * Trois files privées, c'était trois politiques de rétention, trois traitements
 * de la lettre morte, trois endroits où regarder quand un bonus manque. Et
 * surtout : la prochaine personne qui ajoute un consommateur doit choisir
 * laquelle imiter. C'est exactement ainsi qu'on se retrouve avec deux AML.
 *
 * ── ⚠️ LA LIVRAISON N'EST PAS RECOPIÉE ──────────────────────────────────────
 *
 * `referralDelivery.deliverItem` est appelée ici ET par l'ancien worker, qui
 * draine le reliquat de l'outbox pendant la transition. Deux implémentations
 * auraient divergé sur le délai, le traitement du 4xx et le corps de requête.
 *
 * ── Ce que le principal reçoit ──────────────────────────────────────────────
 *
 * `{ refereeId, triggerTxId, correlationId }`. Aucun montant, aucune devise,
 * aucun bonus : le principal RÉÉVALUE le filleul à partir de ses propres
 * données. Le bus ne porte jamais d'ordre de paiement.
 */

const { getTxConn } = require("../../config/db");
const { createConsumer } = require("../events/consumer");
const { deliverItem } = require("./referralDelivery");
const logger = require("../../utils/logger");

const GROUPE = "referral-award";

const EVENEMENTS = Object.freeze(["referral.activity.confirmed.v1"]);

let _ProcessedEvent = null;

function ProcessedEvent() {
  if (!_ProcessedEvent) {
    _ProcessedEvent = require("../../models/ProcessedEvent")(getTxConn());
  }
  return _ProcessedEvent;
}

async function handler(message) {
  const charge = message?.payload || {};

  /**
   * ⚠️ ON N'ACQUITTE PAS UN ÉCHEC TEMPORAIRE.
   *
   * `deliverItem` lève. Le cadre de consommation n'acquitte alors pas, et Redis
   * relivrera le message — c'est le comportement voulu pour un principal
   * momentanément indisponible.
   *
   * Un 4xx, lui, porte `permanent: true` : le répéter donnerait le même
   * résultat. On journalise et on ACQUITTE, sinon le message tourne cinq fois
   * pour rien avant la lettre morte, en retardant tous les suivants.
   */
  try {
    await deliverItem({ payload: charge });
  } catch (err) {
    if (err?.permanent) {
      logger.error("[referral] refus DÉFINITIF du principal — bonus non versé", {
        refereeId: String(charge.refereeId || ""),
        triggerTxId: String(charge.triggerTxId || ""),
        correlationId: String(charge.correlationId || ""),
        code: err?.code,
        consequence:
          "aucun rejeu ne changera la réponse ; ce filleul doit être examiné " +
          "à la main s'il remplissait les conditions",
      });

      await marquerTraite(message, `refus-permanent:${err?.code || "?"}`);
      return;
    }

    throw err;
  }

  await marquerTraite(message, "livre");
}

async function marquerTraite(message, outcome) {
  await ProcessedEvent().create({
    group: GROUPE,
    eventId: message.eventId,
    eventName: message.name,
    processedAt: new Date(),
    outcome,
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
   * ⚠️ UN BONUS NON VERSÉ EST UN PRÉJUDICE POUR UN UTILISATEUR RÉEL.
   *
   * Le journal doit porter de quoi le retrouver et le rattraper à la main :
   * l'identifiant du filleul, celui de la transaction déclenchante, et la
   * corrélation. Sans eux, l'information est perdue même si la ligne existe.
   */
  logger.error("[referral] BONUS NON VERSÉ — lettre morte", {
    eventId: message?.eventId,
    refereeId: String(message?.payload?.refereeId || ""),
    triggerTxId: String(message?.payload?.triggerTxId || ""),
    correlationId: String(message?.payload?.correlationId || ""),
    message: err?.message,
    consequence:
      "le filleul ne recevra pas son bonus tant qu'un rattrapage manuel n'a " +
      "pas eu lieu ; l'événement reste consultable dans domain_events",
  });

  try {
    await marquerTraite(message, "lettre-morte");
  } catch {
    /** L'essentiel est déjà journalisé ; le registre est un confort. */
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
    `✅ Parrainage sur le bus — ${EVENEMENTS.join(", ")} → ` +
      "POST /api/v1/internal/referral/award-bonus (le principal réévalue, " +
      "aucun montant ne transite)."
  );
}

module.exports = { GROUPE, EVENEMENTS, handler, dejaTraite, build, annoncer };
