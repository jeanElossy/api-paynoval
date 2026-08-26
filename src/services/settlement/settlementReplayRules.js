"use strict";

/**
 * ============================================================================
 * REJEU D'UN RÈGLEMENT DEPUIS LE REGISTRE — LES RÈGLES, SANS LA BASE
 * ============================================================================
 *
 * POURQUOI CE REJEU EXISTE
 * ------------------------
 * Jusqu'à F.4, une seule chose pouvait relancer un règlement : le prestataire
 * lui-même, en réémettant son rappel. Or F.3 a montré que ça ne suffit pas —
 * les rejeux d'un prestataire se tarissent, et le registre garde alors des
 * événements AUTHENTIFIÉS dont le règlement ne s'est jamais terminé :
 *
 *   - `PROVIDER_EVENT_UNSETTLED` : un processus est mort en plein règlement ;
 *   - `PROVIDER_EVENT_FAILED`    : nous n'avons pas su agir, et il a abandonné.
 *
 * Nous avions la matière et aucun moyen de nous en servir. C'est ce que ce
 * module débloque.
 *
 * ⚠️ POURQUOI REJOUER SANS VÉRIFIER DE SIGNATURE EST SÛR — ET SEULEMENT ICI
 * ------------------------------------------------------------------------
 * Le rejeu ne peut PAS revérifier la signature : le corps brut n'est plus
 * conservé (il portait le numéro et le nom du bénéficiaire). Ce serait
 * inacceptable si le registre pouvait contenir n'importe quoi.
 *
 * Il ne le peut pas. `providerWebhookController` appelle `claimEvent` **après**
 * la vérification de signature et **avant** le règlement — cet ordre est
 * verrouillé par un test. Le registre ne contient donc, par construction, que
 * des événements dont la signature a déjà été validée une fois.
 *
 * C'est précisément la raison pour laquelle cet ordre avait été choisi en F.2 :
 * enregistrer un événement non authentifié aurait permis à quiconque de remplir
 * le registre. Rejouer depuis un registre potentiellement empoisonné aurait
 * transformé ce défaut en exécution de virements arbitraires.
 *
 * ⚠️ TOUT AJOUT D'UNE AUTRE VOIE D'ÉCRITURE DANS `provider_webhook_events`
 * CASSE CET INVARIANT. Il n'y en a qu'une, et elle doit le rester.
 */

/**
 * Au-delà, on cesse de réessayer et l'événement est escaladé.
 *
 * Un rejeu illimité sur le chemin de l'argent est une mauvaise idée : un
 * événement qui échoue à cause d'un défaut de code échouerait à chaque tour, et
 * le travail de fond martèlerait indéfiniment les primitives monétaires. Passé
 * ce compte, le silence est plus utile que l'insistance — c'est la
 * réconciliation qui le signalera, et un humain tranchera.
 */
const MAX_ATTEMPTS = 5;

/**
 * Attente minimale entre deux tentatives, et elle CROÎT.
 *
 * Un échec est rarement instantanément réparable : la cause est le plus souvent
 * une indisponibilité passagère (base, service tiers). Réessayer aussitôt
 * consomme une tentative pour rien, et les cinq seraient brûlées en une minute.
 */
const BASE_BACKOFF_MS = 5 * 60 * 1000;

function backoffFor(attempts) {
  const n = Math.max(1, Number(attempts) || 1);

  // 5 min, 10, 20, 40… plafonné à 2 h pour rester utile.
  return Math.min(BASE_BACKOFF_MS * 2 ** (n - 1), 2 * 60 * 60 * 1000);
}

function toTime(value) {
  if (!value) return null;
  const t = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * La charge stockée permet-elle de retrouver la transaction ?
 *
 * Sans identifiant, le règlement lèverait un 404 à chaque tour et brûlerait les
 * cinq tentatives sans rien apprendre. Mieux vaut le dire tout de suite : c'est
 * un événement à examiner, pas à rejouer.
 *
 * Le prédicat reprend `assertSettlementHasIdentifier` du contrôleur — même
 * exigence, appliquée en amont.
 */
function hasUsableIdentifier(payload) {
  if (!payload || typeof payload !== "object") return false;

  return Boolean(payload.transactionId || payload.reference || payload.providerReference);
}

const REASONS = Object.freeze({
  OK: "OK",
  ALREADY_PROCESSED: "ALREADY_PROCESSED",
  LEASE_ACTIVE: "LEASE_ACTIVE",
  BACKOFF: "BACKOFF",
  EXHAUSTED: "EXHAUSTED",
  NO_IDENTIFIER: "NO_IDENTIFIER",
  UNKNOWN_STATUS: "UNKNOWN_STATUS",
});

/**
 * Cet événement peut-il être rejoué maintenant ?
 *
 * Pure. Ne dit jamais « oui » par défaut : chaque refus porte son motif, parce
 * qu'un événement qu'on ne rejoue pas doit pouvoir être expliqué sans relire le
 * code.
 *
 * @returns {{eligible: boolean, reason: string}}
 */
function isReplayable(record, { now, leaseMs, maxAttempts = MAX_ATTEMPTS } = {}) {
  if (!record) return { eligible: false, reason: REASONS.UNKNOWN_STATUS };

  const status = String(record.status || "").toLowerCase();

  if (status === "processed") {
    return { eligible: false, reason: REASONS.ALREADY_PROCESSED };
  }

  if (!hasUsableIdentifier(record.payload)) {
    return { eligible: false, reason: REASONS.NO_IDENTIFIER };
  }

  const attempts = Number(record.attempts) || 1;

  if (attempts >= maxAttempts) {
    return { eligible: false, reason: REASONS.EXHAUSTED };
  }

  if (status === "processing") {
    /**
     * Un bail encore valide signifie qu'une autre instance travaille dessus.
     * Le lui prendre ferait régler deux fois en parallèle — la transaction
     * Mongo et les drapeaux l'empêcheraient de doubler l'argent, mais on aurait
     * fabriqué la course qu'on cherche justement à éviter.
     */
    const startedAt = toTime(record.startedAt) ?? toTime(record.createdAt);
    if (startedAt === null) return { eligible: false, reason: REASONS.UNKNOWN_STATUS };

    if (now - startedAt <= leaseMs) {
      return { eligible: false, reason: REASONS.LEASE_ACTIVE };
    }

    return { eligible: true, reason: REASONS.OK };
  }

  if (status === "failed") {
    const lastTouch =
      toTime(record.updatedAt) ?? toTime(record.startedAt) ?? toTime(record.createdAt);

    if (lastTouch === null) return { eligible: false, reason: REASONS.UNKNOWN_STATUS };

    if (now - lastTouch < backoffFor(attempts)) {
      return { eligible: false, reason: REASONS.BACKOFF };
    }

    return { eligible: true, reason: REASONS.OK };
  }

  return { eligible: false, reason: REASONS.UNKNOWN_STATUS };
}

module.exports = {
  MAX_ATTEMPTS,
  BASE_BACKOFF_MS,
  REASONS,
  backoffFor,
  hasUsableIdentifier,
  isReplayable,
};
