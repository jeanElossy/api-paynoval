"use strict";

/**
 * ============================================================================
 * PUBLICATION D'UN ÉVÉNEMENT DE DOMAINE — DANS LA TRANSACTION, TOUJOURS
 * ============================================================================
 *
 * ── La règle, en une phrase ─────────────────────────────────────────────────
 *
 * L'événement s'écrit dans la MÊME transaction Mongo que le changement d'état
 * qu'il décrit. Soit les deux existent, soit aucun.
 *
 * ── Pourquoi cette fonction ne publie sur AUCUN bus ─────────────────────────
 *
 * C'est le cœur du motif, et l'erreur classique est de vouloir « gagner du
 * temps » en envoyant aussi sur Redis ici. Ce serait rétablir la double
 * écriture qu'on referme : un `XADD` réussi suivi d'un abandon de transaction
 * annoncerait un virement qui n'a pas eu lieu, et aucun rejeu ne le rattraperait
 * — le message serait déjà parti.
 *
 * Le relais (`relay.js`) publie APRÈS le commit, en lisant la collection. Le
 * délai qu'il introduit est le prix de la correction, et il se mesure en
 * dizaines de millisecondes.
 *
 * ── Pourquoi un échec de publication FAIT ÉCHOUER la transaction ────────────
 *
 * Contrairement aux notifications, qui sont un confort, un événement de domaine
 * porte des conséquences de conformité : c'est lui qui déclenche la
 * surveillance. Un virement qui se valide sans son événement est un virement
 * que la surveillance ne verra jamais — et rien ne le signalerait.
 *
 * On échoue donc en FERMETURE (règle B.2) : si l'événement ne peut pas s'écrire,
 * la transaction ne se valide pas. C'est aussi ce que le motif garantit
 * naturellement, puisque l'écriture est dans la même session.
 */

const { getTxConn } = require("../../config/db");
const { buildPayload, aggregateTypeOf } = require("./contract");

let _modele = null;

function modele() {
  if (!_modele) {
    /**
     * ⚠️ Connexion des TRANSACTIONS, pas celle des utilisateurs.
     *
     * `outboxes` (les notifications) vit dans la base des utilisateurs, et son
     * atomicité repose sur le fait que les deux connexions partagent un
     * `MongoClient` — vrai aujourd'hui, pas garanti demain. Les événements de
     * domaine vivent avec l'état qu'ils décrivent : l'atomicité ne dépend alors
     * d'aucune configuration.
     */
    _modele = require("../../models/DomainEvent")(getTxConn());
  }

  return _modele;
}

/**
 * Écrit un événement de domaine.
 *
 * @param {object}  args
 * @param {string}  args.name         nom versionné, ex. `transaction.initiated.v1`
 * @param {string}  args.aggregateId  identifiant de l'agrégat concerné
 * @param {object}  args.payload      champs nommés, validés par le contrat
 * @param {Date}    [args.occurredAt] instant du fait métier (défaut : maintenant)
 * @param {object}  [session]         session Mongo de l'appelant — voir ci-dessous
 */
async function publishDomainEvent(
  { name, aggregateId, payload, occurredAt } = {},
  session = null
) {
  const charge = buildPayload(name, payload || {});
  const type = aggregateTypeOf(name);

  const identifiant = String(aggregateId || "").trim();

  if (!identifiant) {
    const err = new Error(
      `Événement « ${name} » sans identifiant d'agrégat : il serait impossible ` +
        "de rattacher le fait à ce qu'il décrit (invariant 11)."
    );
    err.code = "EVENT_AGGREGATE_ID_MISSING";
    throw err;
  }

  const document = {
    name,
    aggregateType: type,
    aggregateId: identifiant,
    payload: charge,
    occurredAt: occurredAt instanceof Date ? occurredAt : new Date(),
    publishedAt: null,
    attempts: 0,
  };

  /**
   * ⚠️ `create` AVEC UN TABLEAU quand il y a une session.
   *
   * `Model.create(doc, { session })` traite le second argument comme un SECOND
   * DOCUMENT dans certaines versions de Mongoose : la session est alors ignorée
   * en silence, et l'écriture sort de la transaction. La forme
   * `create([doc], { session })` est la seule qui transmet les options de façon
   * non ambiguë. C'est un piège connu, et il est muet.
   */
  const [cree] = await modele().create([document], session ? { session } : {});

  return cree;
}

/**
 * Variante pour les appelants qui ne DOIVENT pas échouer sur la publication.
 *
 * ⚠️ À N'UTILISER QUE HORS DU CHEMIN DE L'ARGENT. Elle existe pour les chemins
 * d'administration et de rattrapage, où l'absence d'événement est un manque
 * d'observabilité et non une perte de conformité. Elle JOURNALISE toujours —
 * un échec avalé sans trace serait exactement ce que la règle B.1 interdit.
 */
async function publishDomainEventBestEffort(args, session = null, logger = console) {
  try {
    return await publishDomainEvent(args, session);
  } catch (err) {
    logger.error?.("[events] publication impossible — événement PERDU", {
      name: args?.name,
      aggregateId: args?.aggregateId,
      code: err?.code,
      message: err?.message,
    });

    return null;
  }
}

module.exports = { publishDomainEvent, publishDomainEventBestEffort };
