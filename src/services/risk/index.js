"use strict";

/**
 * ============================================================================
 * ASSEMBLAGE DU CONTRÔLE DE RISQUE — UN SEUL POINT D'ENTRÉE
 * ============================================================================
 *
 * Trois modules purs — le score, la vélocité, la liste noire — et un endroit
 * où on les branche. L'initialisation ne vit PAS dans `middleware/aml.js` :
 * ce fichier fait déjà 1333 lignes, et y ajouter la construction d'un client
 * Redis et d'un cache de base rendrait le contrôle impossible à tester sans
 * infrastructure.
 *
 * ⚠️ TOUT EST PARESSEUX. Les connexions n'existent qu'après
 * `connectTransactionsDB()` ; résoudre le modèle à l'import rendrait ce module
 * — donc le middleware, donc toutes les routes — impossible à charger hors d'un
 * processus serveur démarré. C'est le même défaut que celui déjà corrigé dans
 * `config.js` et `ledgerService.js`.
 *
 * ⚠️ AUCUNE FONCTION D'ICI NE LÈVE SUR LE CHEMIN D'UN PAIEMENT. Un contrôle de
 * risque qui fait échouer un virement parce que son cache n'a pas répondu est
 * un défaut plus grave que le risque qu'il prétend couvrir.
 */

const { createVelocityTracker } = require("./velocity");
const {
  createBlacklistStore,
  publishInvalidation,
} = require("./blacklistStore");
const { computeRiskScore, explainRisk, BANDS } = require("./riskScore");

let _velocity = null;
let _blacklist = null;
let _publisher = null;

/**
 * Chargement de la liste noire depuis MongoDB.
 *
 * `active: true` ET une date d'expiration non dépassée : une entrée expirée
 * reste EN BASE — on veut garder la trace de la décision et de son motif, c'est
 * la première chose qu'un contrôle demande — mais elle cesse de bloquer.
 */
async function loadBlacklistEntries() {
  const { getTxConn } = require("../../config/db");
  const AmlBlacklistEntry = require("../../models/AmlBlacklistEntry")(getTxConn());

  const now = new Date();

  return AmlBlacklistEntry.find(
    {
      active: true,
      $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
    },
    "type value"
  ).lean();
}

/**
 * @param {object} deps
 * @param {object|null} deps.redisClient    client ioredis (commandes)
 * @param {object|null} deps.redisSubscriber client DÉDIÉ à l'abonnement
 * @param {object|null} deps.logger
 */
async function initRiskEngine({
  redisClient = null,
  redisSubscriber = null,
  logger = null,
  loadEntries = loadBlacklistEntries,
} = {}) {
  _velocity = createVelocityTracker({ client: redisClient });
  _publisher = redisClient;

  /**
   * L'ancienne liste statique sert d'amorçage. Sans elle, la première seconde
   * d'exécution — avant le premier chargement en base — se ferait avec une
   * liste VIDE, c'est-à-dire sans aucun blocage, au moment précis où le service
   * accepte ses premières requêtes.
   */
  let seed = null;
  try {
    seed = require("../../aml/blacklist.json");
  } catch {
    seed = null;
  }

  _blacklist = createBlacklistStore({ loadEntries, seed, logger });

  /**
   * ⚠️ LE CLIENT D'ABONNEMENT DOIT ÊTRE DÉDIÉ. Un client Redis en mode abonné
   * ne peut plus exécuter de commandes ordinaires : réutiliser celui de la
   * limitation de débit la casserait, silencieusement.
   */
  // Premier chargement en tâche de fond : ne pas retarder le démarrage.
  _blacklist.refresh({ force: true }).catch(() => {});

  /**
   * ⚠️ L'ABONNEMENT EST ATTENDU. Il met plus de 700 ms à s'enregistrer sur une
   * connexion TLS, et une version antérieure annonçait le succès aussitôt : le
   * démarrage journalisait « invalidation par pub/sub » alors que `publish`
   * touchait zéro abonné. C'est pourquoi `initRiskEngine` rend une PROMESSE.
   */
  return _blacklist
    .subscribe(redisSubscriber)
    .then((subscribed) => ({
      velocityEnabled: _velocity.usable(),
      blacklistSubscribed: subscribed,
    }))
    .catch(() => ({
      velocityEnabled: _velocity.usable(),
      blacklistSubscribed: false,
    }));
}

/** Magasin de liste noire, ou un magasin inerte si le moteur n'est pas amorcé. */
function blacklist() {
  if (_blacklist) return _blacklist;

  /**
   * Inerte plutôt que `null` : un appelant qui oublierait le contrôle
   * d'existence obtiendrait une exception sur le chemin d'un paiement. Ici il
   * obtient « rien en liste noire » — ce qui est le comportement d'avant ce
   * chantier, donc jamais une régression.
   */
  return {
    has: () => false,
    refresh: async () => ({ ok: false, count: 0, stale: true }),
    snapshot: () => ({ count: 0, stale: true, everLoaded: false }),
    size: () => 0,
  };
}

function velocity() {
  if (_velocity) return _velocity;
  return {
    record: async () => false,
    read: async () => null,
    usable: () => false,
  };
}

/**
 * Prévient toutes les instances qu'une entrée de liste noire a changé.
 * Best-effort : si la publication échoue, le TTL rattrapera plus lentement.
 */
async function invalidateBlacklist() {
  await blacklist().refresh({ force: true });
  return publishInvalidation(_publisher);
}

/** Remise à zéro — utilisée par les tests. */
function resetRiskEngine() {
  _velocity = null;
  _blacklist = null;
  _publisher = null;
}

module.exports = {
  BANDS,
  initRiskEngine,
  resetRiskEngine,
  blacklist,
  velocity,
  invalidateBlacklist,
  computeRiskScore,
  explainRisk,
  loadBlacklistEntries,
};
