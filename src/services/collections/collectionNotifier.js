"use strict";

/**
 * ============================================================================
 * PRÉVENIR LE PROPRIÉTAIRE DU PRODUIT QU'UN ENCAISSEMENT EST CONFIRMÉ
 * ============================================================================
 *
 * ── Pourquoi Tx-Core ne crédite pas la cagnotte lui-même ────────────────────
 *
 * La cagnotte appartient au backend principal : c'est lui qui sait si elle est
 * close, si l'objectif est atteint, quels frais s'appliquent, qui notifier, et
 * comment convertir si le contributeur paie dans une autre devise. Écrire cette
 * logique ici obligerait Tx-Core à réimplémenter le produit — avec la
 * divergence garantie qui va avec.
 *
 * Tx-Core dit donc « l'argent est arrivé, voici combien et par quel rail ». Le
 * backend en tire les conséquences métier et redemande à Tx-Core d'écrire au
 * grand livre par `/api/v1/cagnotte/external-participation/settle`.
 *
 * L'aller-retour n'est pas un détour : c'est la même séparation que chez
 * Stripe, où le rappel prévient le serveur du marchand, qui rappelle ensuite
 * l'API pour la suite. Le moteur d'argent ne connaît pas le produit.
 *
 * ── ⚠️ CE QUI SE PASSE SI CET APPEL ÉCHOUE ──────────────────────────────────
 *
 * L'encaissement reste `succeeded` chez nous, sans `settlementReference`. C'est
 * un ÉCART, et il est délibérément visible sous cette forme : le rapprochement
 * cherche exactement les intentions confirmées et non réglées.
 *
 * On ne compense pas — il n'y a rien à compenser, l'argent est bien chez le
 * prestataire. On DÉTECTE, et l'appelant rend une erreur pour que le
 * prestataire réémette son rappel, ce qui refera passer par ici.
 */

const axios = require("axios");

const config = require("../../config");
const logger = require("../../logger");

/**
 * ⚠️ Résolution DÉLÉGUÉE à `utils/principalEndpoint` depuis le 2026-09-10.
 *
 * Cette fonction ne lisait que `PRINCIPAL_URL` ; le parrainage en lisait quatre
 * autres, aucune commune. Sept noms coexistaient dans le service pour désigner
 * la même chose, et chaque appelant en connaissait une partie — de sorte qu'une
 * configuration valide pour l'un ne l'était pas pour l'autre.
 */
function baseBackendPrincipal() {
  return basePrincipal() || String(config?.principalUrl || "").trim().replace(/\/+$/, "");
}

function jetonRappelCagnotte() {
  return String(process.env.CAGNOTTE_GATEWAY_TOKEN || "").trim();
}

class NotificationError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Prévient le backend principal qu'une participation par lien public est
 * encaissée.
 *
 * Rend `{ alreadyProcessed, reference }` — le backend est idempotent sur
 * `txId`, donc un rejeu ne double rien.
 */
async function notifyCagnotteParticipation(intent) {
  const base = baseBackendPrincipal();
  const jeton = jetonRappelCagnotte();

  /**
   * Règle B.2 : on échoue en FERMETURE. Sans URL ni jeton, l'encaissement est
   * acquis chez le prestataire mais ne peut être annoncé à personne — il faut
   * que cela crie, pas que cela passe.
   */
  if (!base) {
    throw new NotificationError(
      "PRINCIPAL_URL_MISSING",
      "PRINCIPAL_URL absente : l'encaissement confirmé ne peut être annoncé."
    );
  }

  if (!jeton) {
    throw new NotificationError(
      "CAGNOTTE_GATEWAY_TOKEN_MISSING",
      "CAGNOTTE_GATEWAY_TOKEN absent : le rappel vers le backend serait refusé."
    );
  }

  const cagnotteId = String(intent?.target?.cagnotteId || "").trim();

  if (!cagnotteId) {
    throw new NotificationError(
      "CAGNOTTE_ID_MISSING",
      "Encaissement confirmé sans identifiant de cagnotte : il n'est " +
        "rattachable à rien."
    );
  }

  const url = `${base}/api/v1/cagnottes/${cagnotteId}/external-payment-callback`;

  /**
   * ⚠️ `txId` porte la RÉFÉRENCE PayNoval de l'encaissement, qui est stable
   * d'un rejeu à l'autre (elle dérive de la clé d'idempotence). C'est elle qui
   * rend la déduplication du backend efficace : un identifiant tiré au hasard
   * ferait passer chaque réémission pour une nouvelle participation.
   */
  const charge = {
    txId: intent.reference,
    amount: intent.amount,
    currency: intent.currency,
    nom: intent.payerDisplayName || "Contributeur externe",
    provider: intent.provider,
    operator: intent.provider,
    status: "succeeded",
    providerReference: intent.providerReference || "",
    codeParticipation: intent?.target?.cagnotteCode || undefined,
  };

  const reponse = await axios.post(url, charge, {
    timeout: 20000,
    validateStatus: () => true,
    headers: {
      "Content-Type": "application/json",
      "x-gateway-token": jeton,
      "x-request-id": intent.reference,
      "Idempotency-Key": intent.idempotencyKey || intent.reference,
    },
  });

  const donnees = reponse?.data || {};

  if (reponse.status < 200 || reponse.status >= 300 || donnees.success !== true) {
    /**
     * ⚠️ On ne journalise ni la charge utile ni la réponse brute : elles
     * portent le nom du contributeur (règle B.4).
     */
    logger.error("[collection] annonce au backend refusée", {
      reference: intent.reference,
      status: reponse.status,
      code: donnees.code || null,
    });

    throw new NotificationError(
      donnees.code || "PRINCIPAL_CALLBACK_FAILED",
      `Le backend principal a refusé l'annonce (${reponse.status}).`
    );
  }

  return {
    alreadyProcessed: donnees.alreadyProcessed === true,
    reference: donnees.reference || "",
  };
}

module.exports = {
  NotificationError,
  notifyCagnotteParticipation,
  baseBackendPrincipal,
  jetonRappelCagnotte,
};
