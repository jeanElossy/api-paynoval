"use strict";

const crypto = require("crypto");

/**
 * ============================================================================
 * IDEMPOTENCE DES RAPPELS PRESTATAIRE
 * ============================================================================
 *
 * Le rejeu est le comportement NORMAL d'un prestataire de paiement : tous
 * réémettent tant qu'ils n'ont pas reçu un 2xx, et plusieurs réémettent même
 * après. Ce module décide ce qu'on fait d'un rappel déjà vu.
 *
 * TROIS ISSUES, ET LE CHOIX DU CODE HTTP EST LA PARTIE DÉLICATE :
 *
 *   - **jamais vu** → on réserve l'événement, puis on règle ;
 *   - **déjà traité** → **200**, avec l'en-tête `Webhook-Replayed`. Répondre
 *     autre chose ferait réessayer le prestataire indéfiniment sur un
 *     événement dont on a déjà tiré toutes les conséquences ;
 *   - **en cours ailleurs** → **409**. Surtout PAS 200 : acquitter un
 *     traitement qui peut encore échouer ferait perdre l'événement
 *     définitivement, puisque le prestataire cesserait de le réémettre.
 *
 * ⚠️ ORDRE DES OPÉRATIONS — C'EST LUI QUI PROTÈGE.
 *
 *     réserver (`processing`) → RÉGLER → marquer `processed`
 *
 * Jamais l'inverse. Marquer d'abord ferait perdre l'événement pour de bon si le
 * règlement échouait ensuite : le rejeu suivant serait pris pour un doublon et
 * ignoré, et l'argent n'arriverait jamais chez le bénéficiaire — sans qu'aucune
 * erreur n'apparaisse nulle part.
 *
 * ⚠️ UNE RÉSERVATION PÉRIMÉE SE REPREND. Un processus tué au milieu du
 * règlement laisse un `processing` éternel ; sans bail, l'événement serait
 * bloqué pour toujours. Le bail est volontairement LONG (5 min) : un règlement
 * qui appelle un prestataire peut être lent, et reprendre trop tôt créerait le
 * double traitement qu'on cherche à empêcher.
 */

const LEASE_MS = 5 * 60 * 1000;

/** Sérialisation stable : `{a,b}` et `{b,a}` doivent donner la même empreinte. */
function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;

  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

/**
 * Empreinte de la charge NORMALISÉE, réduite aux champs qui décrivent le FAIT.
 *
 * Y inclure l'horodatage de réception ou un identifiant de requête rendrait
 * chaque rejeu unique — et la déduplication ne dédupliquerait plus rien, tout
 * en donnant l'apparence de fonctionner.
 */
function computeEventFingerprint(payload = {}) {
  const noyau = {
    reference: payload.reference ?? null,
    providerReference: payload.providerReference ?? null,
    provider: payload.provider ?? null,
    rail: payload.rail ?? null,
    eventType: payload.eventType ?? null,
    providerStatus: payload.providerStatus ?? null,
    amount: payload.amount ?? null,
    currency: payload.currency ?? null,
  };

  return crypto.createHash("sha256").update(stableStringify(noyau)).digest("hex");
}

/**
 * La clé de déduplication : l'identifiant du prestataire s'il existe, sinon
 * l'empreinte préfixée pour qu'on sache toujours d'où elle vient.
 *
 * @returns {{key: string, derived: boolean}}
 */
function resolveEventKey(payload = {}) {
  const fourni = String(payload?.eventId || "").trim();
  if (fourni) return { key: fourni, derived: false };

  return { key: `fp:${computeEventFingerprint(payload)}`, derived: true };
}

/**
 * Décide, à partir d'un enregistrement existant, ce qu'il faut faire.
 * PURE — c'est la partie où une erreur crédite deux fois, donc celle qui doit
 * être testable sans base.
 *
 * @returns {{action: "process"|"replay"|"conflict"|"retake", status: number}}
 */
function decideFromRecord(record, { now = Date.now(), leaseMs = LEASE_MS } = {}) {
  if (!record) return { action: "process", status: 200 };

  if (record.status === "processed") {
    return { action: "replay", status: record.responseStatus || 200 };
  }

  if (record.status === "failed") {
    // Un échec doit pouvoir être rejoué : c'est tout l'intérêt du rejeu
    // prestataire.
    return { action: "retake", status: 200 };
  }

  const debut = record.startedAt ? new Date(record.startedAt).getTime() : 0;

  if (debut && now - debut > leaseMs) {
    // Bail expiré : le processus qui l'avait réservé est mort.
    return { action: "retake", status: 200 };
  }

  return { action: "conflict", status: 409 };
}

module.exports = {
  LEASE_MS,
  stableStringify,
  computeEventFingerprint,
  resolveEventKey,
  decideFromRecord,
};
