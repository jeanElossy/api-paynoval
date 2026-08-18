"use strict";

/**
 * PORTÉE « LES TRANSACTIONS DE CET UTILISATEUR »
 * -----------------------------------------------------------------------------
 * Isolé du contrôleur pour une raison précise : c'est le seul endroit où une
 * erreur ne se voit pas à l'écran mais fait fuiter l'historique d'autres
 * comptes. Ici, le module ne dépend que de Mongoose — ni config, ni base, ni
 * Express — et peut donc être vérifié seul, sans démarrer le service.
 *
 * Une transaction rattache son compte par TROIS champs, et il faut les trois :
 *
 *   - `sender` / `receiver` — les deux côtés d'un transfert entre comptes ;
 *   - `userId`             — les opérations qui n'ont qu'une partie locale
 *                            (dépôt, retrait, paiement sortant).
 *
 * N'en interroger qu'un ferait disparaître des pans entiers de l'historique,
 * et ce sont justement ceux qu'un agent support cherche en premier.
 */

const mongoose = require("mongoose");

const isValidObjectId = (id) =>
  mongoose.Types.ObjectId.isValid(String(id || ""));

/**
 * @param {string} userId  identifiant Mongo du compte
 * @param {string} email   e-mail du compte (facultatif)
 * @returns {Array} clauses à placer dans un `$or` — vide si rien d'exploitable
 */
function buildUserScopeQuery(userId, email) {
  const clauses = [];

  if (userId && isValidObjectId(userId)) {
    const oid = new mongoose.Types.ObjectId(String(userId));
    clauses.push({ sender: oid }, { receiver: oid }, { userId: oid });
  }

  /**
   * L'e-mail complète l'identifiant : une transaction vers un destinataire pas
   * encore inscrit ne porte aucun `ObjectId`, seulement `recipientEmail`.
   *
   * Comparaison à l'identique, jamais en `regex` : une portée approximative
   * ramènerait les transactions de `jean@x.com` dans la fiche de `jea@x.com`.
   * La recherche floue est le rôle de `search`, pas celui d'un filtre de
   * portée.
   */
  if (email && typeof email === "string" && email.includes("@")) {
    const normalized = email.trim().toLowerCase();
    clauses.push(
      { senderEmail: normalized },
      { recipientEmail: normalized },
      { toEmail: normalized }
    );
  }

  return clauses;
}

module.exports = { buildUserScopeQuery, isValidObjectId };
