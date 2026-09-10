"use strict";

/**
 * ============================================================================
 * AMORÇAGE COMMUN DES CONSOMMATEURS — écrit une fois, pas par worker
 * ============================================================================
 *
 * ── Pourquoi ce module existe ───────────────────────────────────────────────
 *
 * Chaque consommateur du bus a besoin des mêmes quatre choses : les connexions
 * Mongo, un client Redis posé dans l'accesseur partagé, un arrêt propre sur
 * SIGTERM, et des annonces de démarrage honnêtes.
 *
 * Écrire cela dans chaque point d'entrée produirait des copies — et les copies
 * divergent. Le dépôt en porte déjà la démonstration : deux `aml.js` de même
 * souche avaient accumulé 1 234 lignes d'écart, chacun recevant la moitié des
 * correctifs. Un worker qui oublierait de fermer Redis, ou qui n'attendrait pas
 * l'acquittement du tour en cours à l'arrêt, ne se remarquerait qu'au moment
 * d'un redéploiement.
 *
 * ── Ce qu'il garantit ───────────────────────────────────────────────────────
 *
 * · UN SEUL client Redis par processus (invariant A8) ;
 * · absence de Redis = mode annoncé, pas arrêt : les événements restent dans
 *   `domain_events`, intacts, et repartent au retour du transport ;
 * · arrêt différé de 1,5 s pour que le tour en cours acquitte ce qu'il a
 *   traité — sortir sec ferait relivrer du travail déjà fait à chaque
 *   redéploiement.
 */

const Redis = require("ioredis");

const logger = require("../../utils/logger");
const { connectTransactionsDB, getTxConn } = require("../../config/db");
const { setClient } = require("../redisClientAccessor");
const stream = require("./stream");

/**
 * ⚠️ UN PROCESSUS DE CONSOMMATION OUVRE SON PROPRE CLIENT, ET C'EST CONFORME.
 *
 * L'invariant A8 dit « aucune REQUÊTE HTTP ne crée de connexion Redis » : un
 * client réutilisable par PROCESSUS. Un worker est un processus distinct du
 * serveur ; il lui faut le sien — un seul, posé une fois dans l'accesseur
 * partagé pour que `stream.js` le trouve.
 */
function ouvrirRedis(etiquette) {
  const url = process.env.REDIS_URL || "";

  if (!url) {
    logger.error(
      `❌ [${etiquette}] REDIS_URL absente — CONSÉQUENCE : ce consommateur ne ` +
        "reçoit aucun événement. Rien n'est perdu (tout reste dans " +
        "`domain_events`), mais rien n'est examiné tant que le transport manque."
    );

    return null;
  }

  const client = new Redis(url, {
    maxRetriesPerRequest: null,
    enableOfflineQueue: true,
  });

  client.on("error", (err) => {
    logger.error(`[${etiquette}][redis] erreur de connexion`, {
      message: err?.message || String(err),
    });
  });

  client.on("ready", () => logger.info(`[${etiquette}][redis] connexion prête`));

  return client;
}

/**
 * Démarre un consommateur dans son propre processus.
 *
 * @param {object}   options
 * @param {string}   options.etiquette   nom court, préfixe des journaux
 * @param {string}   options.titre       ligne de démarrage lisible
 * @param {Function} options.construire  () => consommateur (createConsumer)
 * @param {Function} [options.annoncer]  (logger) => void — politique en vigueur
 */
async function demarrerConsommateur({ etiquette, titre, construire, annoncer }) {
  let poignee = null;
  let redis = null;

  async function arreter(signal) {
    logger.info(`🛑 ${titre} — arrêt (${signal})`);

    try {
      poignee?.stop?.();
    } catch {}

    try {
      await redis?.quit?.();
    } catch {}

    /**
     * ⚠️ Sortie APRÈS un court délai, pas immédiate : un tour en cours doit
     * pouvoir acquitter ce qu'il a traité. Sortir sec ferait relivrer des
     * messages déjà traités — ce que le dédoublonnage absorbe, mais au prix
     * d'un travail refait à chaque redéploiement.
     */
    setTimeout(() => process.exit(0), 1500).unref();
  }

  process.on("SIGTERM", () => arreter("SIGTERM"));
  process.on("SIGINT", () => arreter("SIGINT"));

  process.on("unhandledRejection", (err) => {
    logger.error(`[${etiquette}] rejet non traité`, {
      message: err?.message || String(err),
    });
  });

  logger.info(`▶️  ${titre} — démarrage`);

  /**
   * ⚠️ CET APPEL OUVRE DEUX BASES, ET IL LE FAUT.
   *
   * `connectTransactionsDB()` ouvre d'abord la base des UTILISATEURS — qui est
   * la connexion GLOBALE de Mongoose dans ce service — puis en dérive celle des
   * transactions par `useDb`. Les deux sont nécessaires : `domain_events` et
   * `processed_events` sont sur la connexion transactions, tandis qu'`AMLLog`
   * est déclaré en `mongoose.model(...)` global et vit donc côté utilisateurs.
   *
   * ⚠️ DETTE SIGNALÉE, NON CORRIGÉE : un journal de conformité qui décrit des
   * mouvements d'argent a sa place avec les transactions. Le déplacer suppose
   * une migration de données — une décision d'exploitation.
   */
  await connectTransactionsDB();

  if (!getTxConn()) {
    logger.error(
      `❌ [${etiquette}] connexion aux transactions indisponible — arrêt.`
    );

    process.exit(1);
  }

  redis = ouvrirRedis(etiquette);

  if (redis) {
    setClient(redis);
  } else {
    /**
     * On ne s'arrête PAS : le processus reste en vie, annonce son état, et
     * reprend dès que Redis revient. S'arrêter ferait boucler le redémarrage de
     * l'orchestrateur et noierait la cause dans le bruit.
     */
    logger.warn(
      `⚠️ [${etiquette}] DÉMARRÉ SANS TRANSPORT — n'examine rien tant que ` +
        "REDIS_URL n'est pas renseignée."
    );
  }

  annoncer?.(logger);

  const consommateur = construire({ logger });

  logger.info(
    `📨 [${etiquette}] flux « ${stream.FLUX} » — groupe « ${consommateur.groupe} ».`
  );

  poignee = await consommateur.start();

  logger.info(`✅ ${titre} en écoute`);

  return { consommateur, poignee, redis };
}

module.exports = { demarrerConsommateur, ouvrirRedis };
