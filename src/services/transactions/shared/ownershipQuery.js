"use strict";

/**
 * RATTACHEMENT D'UN UTILISATEUR À SES TRANSACTIONS
 * ============================================================================
 *
 * Module **pur** : il ne tire ni `config`, ni `runtime`, ni connexion Mongo.
 * C'est la condition pour qu'il soit testable — `dotenv-safe` interrompt le
 * chargement de tout ce qui touche `src/config` hors environnement complet, et
 * le dépôt applique déjà cette règle (`utils/rateLimitKey.js`,
 * `utils/redactSensitive.js`, `services/notifications/outboxPolicy.js`).
 *
 * ═══ CE QUE CE MODULE EMPÊCHE DE REVENIR ══════════════════════════════════
 *
 * L'historique interrogeait six champs par `$or`, dont trois absents du schéma
 * `Transaction` : `receiverUserId`, `createdBy`, `ownerUserId`. Ils sont écrits
 * dans le sous-objet `meta`, jamais à la racine — donc ces branches
 * n'appariaient rien.
 *
 * Elles coûtaient pourtant très cher : MongoDB n'utilise une union d'index pour
 * un `$or` que si TOUTES les branches sont indexées. Une seule branche non
 * couverte — et aucun index ne peut couvrir un champ absent du schéma — fait
 * basculer le planificateur en balayage complet de la collection.
 *
 * La garde par `modelHasPath` est préférée à la suppression sèche parce qu'elle
 * est auto-corrigeante : si `ownerUserId` entre un jour au schéma, la branche
 * revient d'elle-même, indexable. Si quelqu'un ajoute un champ à la liste sans
 * l'ajouter au schéma, rien ne se dégrade.
 *
 * ⚠️ Un champ ajouté à `OWNERSHIP_FIELDS` **et** au schéma doit aussi recevoir
 * un index composé `{ champ: 1, createdAt: -1 }`. Sans le `createdAt`, MongoDB
 * apparie mais ne peut plus satisfaire le tri par l'index : il bascule sur un
 * tri bloquant en mémoire, dont la limite de 32 Mo finit par être atteinte sur
 * les comptes les plus actifs.
 */

/**
 * Champs par lesquels un utilisateur peut être rattaché à une transaction.
 *
 * Les trois premiers sont au schéma et portent chacun leur index composé.
 * Les trois derniers ne le sont pas : ils restent listés pour que la garde les
 * récupère s'ils y entrent un jour, et sont ignorés d'ici là.
 */
const OWNERSHIP_FIELDS = Object.freeze([
  "sender",
  "receiver",
  "userId",
  "receiverUserId",
  "createdBy",
  "ownerUserId",
]);

/**
 * Vrai si le schéma du modèle déclare ce chemin.
 *
 * Repris de `sandboxTransaction.service.js:165`. Volontairement tolérant : un
 * modèle absent ou un schéma inattendu rend `false`, jamais une exception. Une
 * consultation d'historique ne doit pas échouer parce qu'une introspection a
 * mal tourné.
 */
function modelHasPath(Model, path) {
  try {
    return Boolean(Model?.schema?.path(path));
  } catch (_) {
    return false;
  }
}

/**
 * Construit le filtre de rattachement, en n'y mettant que des champs indexables.
 *
 * @param {object} Model   Modèle Mongoose `Transaction`.
 * @param {*}      userId  Identifiant de l'utilisateur authentifié.
 * @returns {object}       Filtre Mongo. Forme simple s'il n'y a qu'un champ,
 *                         `$or` sinon — un `$or` à une branche est inutilement
 *                         plus coûteux à planifier.
 */
function buildOwnershipQuery(Model, userId) {
  const or = [];

  for (const field of OWNERSHIP_FIELDS) {
    if (modelHasPath(Model, field)) {
      or.push({ [field]: userId });
    }
  }

  /**
   * Repli. Il ne devrait jamais servir — `userId` est au schéma — mais un `$or`
   * vide est une erreur MongoDB, et l'historique doit rendre une liste vide
   * plutôt qu'un 500 si l'introspection venait à échouer.
   */
  if (!or.length) return { userId };

  return or.length === 1 ? or[0] : { $or: or };
}

module.exports = {
  buildOwnershipQuery,
  modelHasPath,
  OWNERSHIP_FIELDS,
};
