'use strict';

/**
 * STATUT DE TRANSACTION + RÔLE → TYPE DU CATALOGUE — LOGIQUE PURE
 * -----------------------------------------------------------------------------
 * ⚠️ CE FICHIER EXISTE EN DEUX EXEMPLAIRES IDENTIQUES, DANS DEUX DÉPÔTS :
 *
 *     paynoval-backend/services/notifications/transactionTypes.js   (celui-ci)
 *     api-paynoval/src/services/notifications/transactionTypes.js
 *
 * Même situation que `services/rateLimitStore.js` : deux dépôts séparés, aucun
 * paquet commun. La duplication est assumée, mais elle a une règle — **toute
 * modification doit être portée dans les deux, dans le même commit.** Une
 * divergence ici ne lève aucune erreur : elle produit deux services qui ne
 * s'accordent plus sur le type d'une même transaction, donc deux préférences
 * différentes appliquées au même fait.
 *
 * Tx-Core s'en sert pour DÉCLARER le type ; le backend pour VÉRIFIER ce qu'il
 * reçoit et pour rattraper les événements de l'ancien format restés sur le bus.
 *
 * ── POURQUOI TROIS STATUTS PARTAGENT UN TYPE ────────────────────────────────
 *
 * `initiated`, `processing` et `confirmed` donnent tous `TRANSACTION_SENT` pour
 * l'expéditeur. Ce n'est pas un raccourci : le TYPE porte la préférence, la
 * priorité et les canaux, pas le contenu. Quelqu'un qui coupe « argent envoyé »
 * veut couper les trois étapes du même envoi — pas seulement la dernière. Le
 * libellé exact de l'étape vit dans le titre et le corps, que le producteur
 * fournit, et la clé d'idempotence inclut le statut : les trois étapes ne se
 * dédoublonnent donc pas entre elles.
 *
 * C'est la granularité de Wise (« Your transfer is on its way » / « has
 * arrived », un seul réglage) et de Revolut (« Payments », un seul réglage).
 */

/** Rôles connus. Tout le reste est traité comme `sender` — voir plus bas. */
const ROLES = Object.freeze(['sender', 'receiver']);

/**
 * Statuts émis par Tx-Core, relevés dans les appelants de
 * `notifyTransactionEvent` (initiateInternal, initiateExternalTransactions ×2,
 * confirmTransaction ×3, cancelTransaction, cancellation.service,
 * transactionAutoCancelService) et par `notifyParties` (règlements externes).
 */
const STATUS_TYPES = Object.freeze({
  initiated: { sender: 'TRANSACTION_SENT', receiver: 'TRANSACTION_RECEIVED' },
  processing: { sender: 'TRANSACTION_SENT', receiver: 'TRANSACTION_RECEIVED' },
  confirmed: { sender: 'TRANSACTION_SENT', receiver: 'TRANSACTION_RECEIVED' },
  completed: { sender: 'TRANSACTION_SENT', receiver: 'TRANSACTION_RECEIVED' },

  cancelled: { sender: 'TRANSACTION_CANCELLED', receiver: 'TRANSACTION_CANCELLED' },
  canceled: { sender: 'TRANSACTION_CANCELLED', receiver: 'TRANSACTION_CANCELLED' },
  expired: { sender: 'TRANSACTION_CANCELLED', receiver: 'TRANSACTION_CANCELLED' },

  failed: { sender: 'TRANSACTION_FAILED', receiver: 'TRANSACTION_FAILED' },
  rejected: { sender: 'TRANSACTION_FAILED', receiver: 'TRANSACTION_FAILED' },

  refunded: { sender: 'TRANSACTION_REFUND', receiver: 'TRANSACTION_REFUND' },
  reversed: { sender: 'TRANSACTION_REFUND', receiver: 'TRANSACTION_REFUND' },
});

/**
 * Anciens noms de type portés par les événements déjà sur le bus
 * (`transaction_confirmed`, `transaction_initiated`…).
 *
 * ⚠️ CETTE TABLE N'EST PAS DÉCORATIVE — C'EST LA COMPATIBILITÉ DE DÉPLOIEMENT.
 *
 * Les deux services ne se déploient pas à la même seconde. Pendant la bascule,
 * le backend reçoit des événements produits par l'ANCIEN Tx-Core, qui n'annonce
 * qu'un `transaction_<statut>`. Sans cette table, ces événements seraient
 * refusés en `UNKNOWN_TYPE` : notification jamais affichée, et un 4xx que le
 * consommateur marque « refus définitif ». Un déploiement en deux temps aurait
 * donc perdu, définitivement, toutes les notifications en vol.
 */
const LEGACY_PREFIX = 'transaction_';

/**
 * Normalise un rôle.
 *
 * Un rôle absent ou inconnu vaut `sender`. C'est le choix le moins mauvais :
 * l'expéditeur est celui qui a DÉCLENCHÉ l'opération, donc celui pour qui une
 * notification inattendue est la moins déroutante. Lever ici ferait perdre la
 * notification pour une métadonnée manquante.
 */
function normalizeRole(role) {
  const value = String(role || '').trim().toLowerCase();
  return ROLES.includes(value) ? value : 'sender';
}

function normalizeStatus(status) {
  return String(status || '').trim().toLowerCase();
}

/**
 * Type de catalogue pour un (statut, rôle).
 *
 * @param {object} params
 * @param {string} params.status  statut Tx-Core (`confirmed`, `cancelled`…)
 * @param {string} [params.role]  `sender` | `receiver`
 * @returns {{type: string, matched: boolean}}
 *          `matched: false` ⇒ statut absent de la table. L'appelant DOIT le
 *          journaliser avec le statut reçu : c'est le seul signal qu'un nouveau
 *          statut a été introduit sans être déclaré ici.
 */
function resolveTransactionType({ status, role } = {}) {
  const key = normalizeStatus(status);
  const side = normalizeRole(role);

  const entry = STATUS_TYPES[key];

  if (entry && entry[side]) return { type: entry[side], matched: true };

  /**
   * Statut inconnu : on notifie quand même, avec le type de la famille.
   *
   * Un statut non déclaré ne doit pas faire disparaître la notification — un
   * utilisateur privé de l'information « votre transfert a changé d'état » est
   * un défaut plus grave qu'un type approximatif. Le titre et le corps, eux,
   * portent le statut réel : l'utilisateur lit la bonne information.
   */
  return {
    type: side === 'receiver' ? 'TRANSACTION_RECEIVED' : 'TRANSACTION_SENT',
    matched: false,
  };
}

/**
 * Traduit un ancien nom (`transaction_confirmed`) en type de catalogue.
 *
 * @param {object} params
 * @param {string} params.legacyType  `transaction_<statut>`
 * @param {string} [params.role]
 * @returns {{type: string, matched: boolean}|null} `null` si ce n'est pas un
 *          nom transactionnel hérité — l'appelant doit alors chercher ailleurs.
 */
function resolveLegacyTransactionType({ legacyType, role } = {}) {
  const value = String(legacyType || '').trim().toLowerCase();

  if (!value.startsWith(LEGACY_PREFIX)) return null;

  return resolveTransactionType({
    status: value.slice(LEGACY_PREFIX.length),
    role,
  });
}

/** Statuts déclarés. Sert aux tests et aux messages de diagnostic. */
const KNOWN_STATUSES = Object.freeze(Object.keys(STATUS_TYPES));

module.exports = {
  KNOWN_STATUSES,
  LEGACY_PREFIX,
  ROLES,
  STATUS_TYPES,
  normalizeRole,
  normalizeStatus,
  resolveLegacyTransactionType,
  resolveTransactionType,
};
