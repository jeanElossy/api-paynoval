"use strict";

const runtime = require("../shared/runtime");
const { pickAuthedUserId } = require("../shared/helpers");
const { toPublicTransaction } = require("../../../models/transactionSerializer");
const { buildOwnershipQuery } = require("../shared/ownershipQuery");

/**
 * HISTORIQUE DES TRANSACTIONS
 * ============================================================================
 *
 * ═══ POURQUOI CE FICHIER EST ÉCRIT EN INJECTION ═══════════════════════════
 *
 * C'est le motif de référence du dépôt, et il remplace ici la « couture »
 * (`runtime.overrideModels`). Les deux rendent le code testable ; ils ne se
 * valent pas.
 *
 *   • La couture écrase un **singleton global**. Un `restoreModels()` oublié
 *     fuit dans les tests suivants, deux tests ne peuvent pas s'exécuter en
 *     parallèle, et la signature de la fonction ne dit rien de ce dont elle
 *     dépend : il faut lire le corps.
 *
 *   • L'injection **reçoit** ses dépendances. `createListInternal({ Transaction })`
 *     énonce son besoin. Un test lui passe un double sans toucher à quoi que ce
 *     soit de global. Changer d'implémentation ne touche qu'un endroit : le
 *     point de composition, en bas de ce fichier.
 *
 * La couture reste utile comme outil de **transition** — on ne convertit pas
 * 45 000 lignes en un passage. La règle : injection pour le code neuf et pour
 * les modules qu'on touche, couture pour couvrir le reste en attendant.
 *
 * ═══ CE QUE CE HANDLER A CORRIGÉ ═════════════════════════════════════════
 *
 * Le filtre portait un `$or` à six branches, dont trois — `receiverUserId`,
 * `createdBy`, `ownerUserId` — **absentes du schéma `Transaction`** (vérifié :
 * `git log -S` sur le modèle ne rend rien ; elles sont écrites dans le
 * sous-objet `meta`, jamais à la racine). MongoDB n'utilise une union d'index
 * pour un `$or` que si TOUTES les branches sont indexées : une seule non
 * couverte faisait basculer le planificateur en balayage complet de collection,
 * payé DEUX fois par page (`find` et `countDocuments` portent le même filtre).
 *
 * La sélection des branches vit dans `shared/ownershipQuery.js`, module pur.
 *
 * ═══ LE PIÈGE DU `.lean()`, ET POURQUOI LE SÉRIALISEUR EST OBLIGATOIRE ════
 *
 * C'était le `toJSON()` de Mongoose qui retirait `securityAnswerHash`,
 * `verificationToken` et `securityCode`. `.lean()` rend des objets simples,
 * sans `toJSON()` : posé sans précaution, il aurait renvoyé les secrets avec un
 * code 200, sans rien casser d'observable, sur le chemin le plus fréquenté de
 * l'application.
 *
 * Deux barrières indépendantes, et c'est délibéré :
 *   1. la **projection** écarte les secrets dès la requête — ils ne quittent
 *      jamais MongoDB ;
 *   2. le **sérialiseur** les retire à nouveau à la sortie.
 *
 * Une seule aurait suffi en théorie. Deux garantissent qu'un oubli dans l'une
 * ne devient pas une fuite. `assertNoSecrets` (ci-dessous) refuse d'ailleurs de
 * construire le handler si la projection cesse de couvrir un secret.
 */

/** Plafond de pagination. Au-delà, la réponse devient trop lourde pour le mobile. */
const DEFAULT_MAX_LIMIT = 100;
const DEFAULT_LIMIT = 25;

/**
 * Champs jamais transmis. Doit rester aligné sur `SECRET_FIELDS` du
 * sérialiseur — `assertNoSecrets()` le vérifie au démarrage plutôt qu'en
 * production.
 */
const LIST_PROJECTION = Object.freeze({
  securityAnswerHash: 0,
  verificationToken: 0,
  securityCode: 0,
  attemptCount: 0,
  lastAttemptAt: 0,
  lockedUntil: 0,

  /**
   * Écarté dès la requête, pas seulement à la sérialisation : cinquante
   * entrées de rappel prestataire par transaction, sur une liste paginée, ce
   * sont des kilo-octets transférés depuis Mongo pour être jetés ensuite.
   * L'assertion ci-dessous rend cet oubli impossible.
   */
  webhookHistory: 0,

  __v: 0,
});

/**
 * Vérifie que la projection couvre bien tous les secrets connus du sérialiseur.
 *
 * Cette assertion s'exécute à la CONSTRUCTION du handler, donc au démarrage du
 * service : ajouter un secret au sérialiseur sans l'ajouter ici fait échouer le
 * boot, bruyamment, plutôt que de laisser fuir un champ en production.
 */
function assertNoSecrets(projection, secretFields) {
  const missing = secretFields.filter(
    (f) => !Object.prototype.hasOwnProperty.call(projection, f)
  );

  if (missing.length) {
    throw new Error(
      `listInternal : la projection ne couvre pas ${missing.join(", ")}. ` +
        `Tout champ de SECRET_FIELDS doit y figurer.`
    );
  }
}

/**
 * Construit le handler à partir de ses dépendances.
 *
 * @param {object}   deps
 * @param {object}   deps.Transaction  Modèle Mongoose (ou un double de test).
 * @param {Function} [deps.toPublic]   Sérialiseur de sortie.
 * @param {string[]} [deps.secretFields] Secrets à vérifier dans la projection.
 * @param {object}   [deps.projection]
 * @param {number}   [deps.maxLimit]
 * @returns {Function} Middleware Express `(req, res, next)`.
 */
function createListInternal({
  Transaction,
  toPublic = toPublicTransaction,
  secretFields = require("../../../models/transactionSerializer").SECRET_FIELDS,
  projection = LIST_PROJECTION,
  maxLimit = DEFAULT_MAX_LIMIT,
} = {}) {
  if (!Transaction) {
    throw new Error("listInternal : dépendance `Transaction` manquante");
  }

  if (typeof toPublic !== "function") {
    throw new Error("listInternal : `toPublic` doit être une fonction");
  }

  assertNoSecrets(projection, secretFields);

  return async function listInternal(req, res, next) {
    try {
      const userId = pickAuthedUserId(req);

      if (!userId) {
        return res.status(401).json({ success: false, message: "Non autorisé" });
      }

      const skip = Math.max(parseInt(req.query.skip, 10) || 0, 0);
      const limit = Math.min(
        Math.max(parseInt(req.query.limit, 10) || DEFAULT_LIMIT, 1),
        maxLimit
      );

      const query = buildOwnershipQuery(Transaction, userId);

      /**
       * Les deux requêtes sont indépendantes : elles partent ensemble, la page
       * coûte donc un aller-retour et non deux.
       *
       * `limit + 1` demande un document de plus que ce qu'on rendra : sa
       * présence dit s'il reste quelque chose après cette page, sans rien
       * compter. C'est le `has_more` de Stripe et de Wise.
       *
       * `total` est conservé par compatibilité — la passerelle relaie le corps
       * tel quel et des clients installés peuvent le lire. Il est désormais peu
       * coûteux, la requête étant indexable. C'est `hasMore` qui est la bonne
       * primitive ; `total` disparaîtra quand plus personne ne le lira.
       */
      const [docs, total] = await Promise.all([
        Transaction.find(query, projection)
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit + 1)
          .lean(),
        Transaction.countDocuments(query),
      ]);

      const list = Array.isArray(docs) ? docs : [];
      const hasMore = list.length > limit;
      const page = hasMore ? list.slice(0, limit) : list;

      return res.json({
        success: true,
        count: page.length,
        total,
        hasMore,
        data: page.map(toPublic),
        skip,
        limit,
      });
    } catch (err) {
      next(err);
    }
  };
}

/* -------------------------------------------------------------------------- */
/* Point de composition                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Seul endroit qui connaît les implémentations réelles.
 *
 * La composition est **paresseuse et mémoïsée** : `runtime.Transaction` résout
 * la connexion Mongo au premier accès, et il ne faut donc pas y toucher au
 * chargement du module — c'est précisément le défaut corrigé ailleurs dans ce
 * dépôt. Une fois construit, le handler est réutilisé : on ne reconstruit rien
 * par requête.
 */
let _composed = null;

function getHandler() {
  if (!_composed) {
    _composed = createListInternal({ Transaction: runtime.Transaction });
  }

  return _composed;
}

/** Middleware exposé aux routes. La signature ne change pas. */
function listInternal(req, res, next) {
  return getHandler()(req, res, next);
}

/** Réservé aux tests : force une recomposition. */
function resetComposition() {
  _composed = null;
}

module.exports = {
  listInternal,
  createListInternal,
  resetComposition,
  assertNoSecrets,
  LIST_PROJECTION,
  DEFAULT_MAX_LIMIT,
  DEFAULT_LIMIT,
};
