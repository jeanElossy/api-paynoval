"use strict";

const os = require("os");
const crypto = require("crypto");

const { getTxConn } = require("../config/db");

let logger = console;
try {
  logger = require("../logger");
} catch {}

/**
 * ⚠️ RÉSOLUTION PARESSEUSE — CONTRAINTE PROPRE À CE SERVICE.
 *
 * Le backend principal résout son modèle au chargement (`require(...)()`), sur
 * la connexion mongoose par défaut. Ici c'est impossible : `getTxConn()` lève
 * tant que `connectTransactionsDB()` n'a pas tourné, et le CLAUDE.md du dépôt
 * l'interdit explicitement — « ne jamais résoudre un modèle de la connexion tx
 * au chargement du module ». Charger ce fichier deviendrait impossible hors
 * d'un processus serveur démarré, y compris dans un test.
 */
let _CronLock = null;

function cronLockModel() {
  if (!_CronLock) {
    _CronLock = require("../models/CronLock")(getTxConn());
  }
  return _CronLock;
}

/**
 * UN SEUL EXÉCUTANT PAR TÂCHE PLANIFIÉE
 * =============================================================================
 *
 * Le motif est celui du worker d'outbox (`services/outboxPublisher.js:86`) et du
 * worker d'auto-annulation de Tx-Core : on ne coordonne pas les processus entre
 * eux, on leur fait disputer une écriture atomique. Celui dont l'écriture passe
 * exécute ; les autres passent leur tour, sans erreur et sans attendre.
 *
 * ═══ CE QUE CE VERROU NE PROMET PAS ═══════════════════════════════════════
 *
 * Il garantit qu'une tâche ne s'exécute pas **en parallèle** sur plusieurs
 * instances. Il ne garantit pas l'exécution exactement-une-fois : si un
 * processus meurt après avoir travaillé mais avant de relâcher, la tâche
 * repartira à l'expiration du verrou.
 *
 * C'est le bon arbitrage ici, et il faut le dire explicitement : ces tâches sont
 * des balayages idempotents — un instantané FX écrase le précédent, un balayage
 * de statuts recalcule un état. Les rejouer est sans conséquence ; ne jamais les
 * rejouer, en revanche, laisserait le système figé après un incident.
 *
 * ⚠️ N'utiliser ce verrou que pour des tâches **idempotentes**. Un traitement
 * qui déplacerait de l'argent demanderait, lui, une clé d'idempotence — le
 * dispositif existe déjà dans Tx-Core (`middleware/idempotency.js`).
 *
 * ═══ LA DURÉE DE VIE EST UN ENGAGEMENT ════════════════════════════════════
 *
 * Une tâche qui dépasse son TTL peut voir son verrou repris par une autre
 * instance pendant qu'elle travaille encore. Le TTL doit donc être choisi
 * nettement au-dessus de la durée observée, et `release` refuse de libérer un
 * verrou qui ne nous appartient plus — sans quoi on libérerait celui du voisin.
 */

/** Durée de vie par défaut. Généreuse : un verrou trop court est pire qu'inutile. */
const DEFAULT_TTL_MS = 5 * 60 * 1000;

/**
 * Identité de ce processus.
 *
 * L'aléa n'est pas décoratif : deux conteneurs peuvent partager un nom d'hôte et
 * un identifiant de processus. Sans lui, deux instances pourraient se croire
 * détentrices du même verrou et se le libérer mutuellement.
 */
function buildWorkerId() {
  return `${os.hostname()}:${process.pid}:${crypto
    .randomBytes(4)
    .toString("hex")}`;
}

const WORKER_ID = buildWorkerId();

/**
 * Filtre de prise de verrou : libre, ou expiré.
 *
 * Extrait pour être testable sans base : c'est la condition qui décide qui
 * exécute, et elle mérite d'être vérifiée seule.
 */
function buildAcquireFilter(jobName, now) {
  return {
    _id: jobName,
    $or: [
      { expiresAt: null },
      { expiresAt: { $exists: false } },
      { expiresAt: { $lte: now } },
    ],
  };
}

function buildAcquireUpdate(token, now, ttlMs) {
  return {
    $set: {
      lockedBy: token,
      lockedAt: now,
      expiresAt: new Date(now.getTime() + ttlMs),
    },
  };
}

/**
 * Tente de prendre le verrou.
 *
 * @returns {Promise<string|null>} Le jeton si le verrou est pris, `null` si une
 *          autre instance l'a déjà — ce qui n'est pas une erreur.
 */
async function acquire(jobName, { ttlMs = DEFAULT_TTL_MS, model = null } = {}) {
  const m = model || cronLockModel();
  const now = new Date();
  const token = `${WORKER_ID}#${crypto.randomBytes(4).toString("hex")}`;

  /**
   * Cas courant : le document existe déjà (la tâche a tourné au moins une fois).
   * `findOneAndUpdate` est atomique au document — deux instances ne peuvent pas
   * satisfaire le filtre toutes les deux, la seconde relisant un `expiresAt`
   * désormais dans le futur.
   */
  const taken = await m.findOneAndUpdate(
    buildAcquireFilter(jobName, now),
    buildAcquireUpdate(token, now, ttlMs),
    { new: true }
  );

  if (taken) return token;

  /**
   * Premier passage : aucun document. On insère.
   *
   * `_id` porte l'index unique que MongoDB impose : si deux instances insèrent
   * au même instant, l'une reçoit une erreur de clé dupliquée. C'est un refus
   * net — exactement ce qu'on veut — et non une course qu'il faudrait arbitrer.
   */
  try {
    await m.create({
      _id: jobName,
      lockedBy: token,
      lockedAt: now,
      expiresAt: new Date(now.getTime() + ttlMs),
    });

    return token;
  } catch (err) {
    if (isDuplicateKey(err)) return null;

    throw err;
  }
}

function isDuplicateKey(err) {
  return err?.code === 11000 || err?.codeName === "DuplicateKey";
}

/**
 * Relâche le verrou — **uniquement s'il nous appartient encore**.
 *
 * Le filtre sur `lockedBy` est la partie qui compte. Si notre verrou avait
 * expiré et qu'une autre instance l'avait repris, libérer sans vérifier
 * ouvrirait la tâche à une seconde exécution concurrente : précisément ce que
 * ce module existe pour empêcher.
 */
async function release(
  jobName,
  token,
  { model = null, durationMs = null, error = null } = {}
) {
  if (!token) return false;

  const m = model || cronLockModel();

  const res = await m.updateOne(
    { _id: jobName, lockedBy: token },
    {
      $set: {
        lockedBy: "",
        expiresAt: new Date(0),
        lastRunAt: new Date(),
        lastRunMs: durationMs,
        lastError: error ? String(error).slice(0, 500) : null,
      },
      $inc: { runCount: 1 },
    }
  );

  return (res?.modifiedCount || 0) > 0;
}

/**
 * Exécute `fn` si et seulement si ce processus obtient le verrou.
 *
 * @param {string}   jobName  Nom de la tâche. Sert de clé du verrou.
 * @param {Function} fn       Travail à effectuer. Doit être idempotent.
 * @param {object}   [opts]
 * @param {number}   [opts.ttlMs] Durée de vie du verrou.
 * @returns {Promise<{ ran: boolean, result?: * , error?: Error }>}
 *          `ran: false` signifie « une autre instance s'en charge » — ce n'est
 *          pas un échec, et l'appelant ne doit pas le traiter comme tel.
 */
async function withCronLock(jobName, fn, { ttlMs = DEFAULT_TTL_MS, model = null } = {}) {
  let token = null;

  try {
    token = await acquire(jobName, { ttlMs, model });
  } catch (err) {
    /**
     * Une panne du verrou ne doit pas devenir une panne de la tâche — mais elle
     * ne doit pas non plus la laisser s'exécuter partout. On s'abstient, et on
     * le dit : c'est le choix sûr, la tâche repartira au tour suivant.
     */
    logger.warn(`[cron:${jobName}] verrou indisponible, exécution ignorée`, {
      message: err?.message || String(err),
    });

    return { ran: false, error: err };
  }

  if (!token) {
    logger.debug?.(`[cron:${jobName}] déjà pris par une autre instance`);
    return { ran: false };
  }

  const startedAt = Date.now();

  try {
    const result = await fn();
    const durationMs = Date.now() - startedAt;

    await release(jobName, token, { model, durationMs });

    logger.info(`[cron:${jobName}] terminé en ${durationMs} ms`);

    return { ran: true, result };
  } catch (err) {
    const durationMs = Date.now() - startedAt;

    /**
     * On relâche même en cas d'échec. Garder le verrou jusqu'à expiration
     * retarderait la prochaine tentative sans rien protéger : l'erreur est
     * conservée dans le document, pas dans le verrou.
     */
    await release(jobName, token, { model, durationMs, error: err?.message }).catch(
      () => {}
    );

    logger.error(`[cron:${jobName}] échec après ${durationMs} ms`, {
      message: err?.message || String(err),
    });

    return { ran: true, error: err };
  }
}

module.exports = {
  withCronLock,
  acquire,
  release,
  buildWorkerId,
  buildAcquireFilter,
  buildAcquireUpdate,
  isDuplicateKey,
  WORKER_ID,
  DEFAULT_TTL_MS,
};
