"use strict";

const runtime = require("../shared/runtime");
const { pickAuthedUserId } = require("../shared/helpers");
const { toPublicTransaction } = require("../../../models/transactionSerializer");
const {
  buildOwnershipQuery,
  modelHasPath,
  OWNERSHIP_FIELDS,
} = require("../shared/ownershipQuery");

/**
 * HISTORIQUE DES TRANSACTIONS
 * ============================================================================
 *
 * C'est le chemin de lecture le plus fréquenté de l'application. Jusqu'au
 * 2026-08-25, il balayait la collection `transactions` **entière**, deux fois,
 * à chaque page.
 *
 * ═══ POURQUOI LE BALAYAGE COMPLET ═════════════════════════════════════════
 *
 * Le filtre portait un `$or` à six branches :
 *
 *     sender · receiver · receiverUserId · createdBy · ownerUserId · userId
 *                          └──────────── ces trois-là ────────────┘
 *
 * Ces trois champs **n'existent pas dans le schéma `Transaction`**. Vérifié
 * plutôt que supposé : `git log -S"receiverUserId" -- models/Transaction.js`
 * ne rend rien, ils n'y ont jamais figuré. Ils sont bien écrits quelque part
 * (`initiateInternal.js:649`, `flowHelpers.js:388`) mais dans le sous-objet
 * **`meta`** — donc en `meta.ownerUserId`, jamais à la racine, qui est ce que
 * la requête interrogeait.
 *
 * Or MongoDB n'utilise une union d'index pour un `$or` que si **toutes** les
 * branches sont indexées. Une seule branche non couverte — et aucun index ne
 * pouvait couvrir un champ absent du schéma — fait basculer le planificateur en
 * COLLSCAN. Les deux requêtes du `Promise.all` portaient le même filtre : le
 * balayage était donc payé deux fois par page affichée.
 *
 * Rien n'était perdu pour autant : toute transaction que ces branches
 * désigneraient est déjà couverte, la création posant `userId`, `sender` et
 * `receiver` à la racine — pour le flux interne comme pour les flux externes.
 * Les branches ne servaient à rien ; elles coûtaient tout.
 *
 * ═══ LA GARDE, PLUTÔT QUE LA SUPPRESSION SÈCHE ════════════════════════════
 *
 * On ne se contente pas de retirer les trois lignes : on n'ajoute une branche
 * que si le schéma porte réellement le champ. Le motif n'est pas de nous, il
 * vient du dépôt — `sandboxTransaction.service.js:165` le fait déjà avec
 * `modelHasPath`. Sa vertu est d'être auto-corrigeant : le jour où quelqu'un
 * ajoute `ownerUserId` au schéma, la branche revient d'elle-même, indexable, au
 * lieu de réintroduire un balayage complet en silence.
 */

/**
 * Projection : ce que l'historique a besoin de lire.
 *
 * On exclut plutôt qu'on énumère. Une liste blanche serait plus économe, mais
 * le schéma porte plus de 400 champs et l'application en affiche beaucoup :
 * en oublier un casserait l'écran d'historique de façon difficile à voir.
 * L'exclusion, elle, ne peut que laisser passer un champ de trop — jamais en
 * manquer un.
 *
 * Les secrets sont **aussi** retirés par le sérialiseur. Les écarter dès la
 * requête évite simplement de les faire voyager depuis Mongo.
 */
const LIST_PROJECTION = Object.freeze({
  securityAnswerHash: 0,
  verificationToken: 0,
  securityCode: 0,
  attemptCount: 0,
  lastAttemptAt: 0,
  lockedUntil: 0,
  __v: 0,
});

async function listInternal(req, res, next) {
  try {
    const userId = pickAuthedUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, message: "Non autorisé" });
    }

    const Transaction = runtime.Transaction;
    if (!Transaction) {
      return res.status(500).json({
        success: false,
        message: "Transaction model indisponible",
      });
    }

    const skip = Math.max(parseInt(req.query.skip, 10) || 0, 0);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 100);

    const query = buildOwnershipQuery(Transaction, userId);

    /**
     * `limit + 1` : on demande un document de plus que ce qu'on rendra. Sa
     * présence dit s'il reste quelque chose après cette page, sans compter quoi
     * que ce soit. C'est le `has_more` de Stripe et de Wise, et c'est ce qui
     * permettra au client de paginer sans jamais dépendre d'un total.
     */
    /**
     * Les deux requêtes sont indépendantes : elles partent ensemble. La page
     * coûte donc un aller-retour, pas deux — c'est ce que faisait déjà la
     * version précédente, et il n'y a aucune raison de le perdre.
     *
     * `total` est conservé : la passerelle relaie le corps tel quel et des
     * clients déjà installés peuvent le lire. Il est désormais peu coûteux —
     * la requête étant indexable, le compte se fait sur l'index, sans toucher
     * aux documents. Il reste toutefois proportionnel au nombre de transactions
     * de l'utilisateur : c'est `hasMore` qui est la bonne primitive, et c'est
     * vers elle que les clients doivent migrer. `total` disparaîtra quand plus
     * personne ne le lira.
     */
    const [docs, total] = await Promise.all([
      Transaction.find(query, LIST_PROJECTION)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit + 1)
        /**
         * `.lean()` : Mongo rend des objets simples au lieu de documents
         * hydratés. Sur une page de cent transactions d'un schéma de plus de
         * 400 champs, l'hydratation était le poste de CPU dominant, après le
         * balayage lui-même.
         *
         * ⚠️ Conséquence : plus de `toJSON()`, donc plus de retrait automatique
         * des secrets. C'est `toPublicTransaction` qui s'en charge — la même
         * fonction que celle branchée sur le `toJSON` du schéma.
         */
        .lean(),
      Transaction.countDocuments(query),
    ]);

    const hasMore = docs.length > limit;
    const page = hasMore ? docs.slice(0, limit) : docs;

    return res.json({
      success: true,
      count: page.length,
      total,
      hasMore,
      data: page.map(toPublicTransaction),
      skip,
      limit,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listInternal,
  buildOwnershipQuery,
  modelHasPath,
  OWNERSHIP_FIELDS,
  LIST_PROJECTION,
};
