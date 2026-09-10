"use strict";

/**
 * ============================================================================
 * LE RELAIS — DE LA BASE VERS LE BUS, AU MOINS UNE FOIS
 * ============================================================================
 *
 * ── Son unique travail ──────────────────────────────────────────────────────
 *
 * Lire les événements non publiés de `domain_events`, les envoyer sur le flux,
 * marquer publiés. Rien d'autre : il ne décide rien, ne transforme rien, ne
 * filtre rien.
 *
 * ── Pourquoi l'ORDRE des deux écritures n'est pas négociable ────────────────
 *
 * On publie D'ABORD sur le flux, on marque publié ENSUITE. L'inverse — marquer
 * puis publier — perd l'événement si le processus meurt entre les deux : il est
 * réputé publié et ne sera jamais renvoyé.
 *
 * Dans cet ordre, la même mort produit un DOUBLON : l'événement repart au tour
 * suivant. C'est le compromis choisi, et c'est celui de tous les bus de
 * paiement — « au moins une fois » plutôt que « au plus une fois », parce qu'un
 * doublon se traite chez le consommateur (idempotence) alors qu'une perte ne se
 * traite nulle part.
 *
 * ── Le bail plutôt qu'un statut ─────────────────────────────────────────────
 *
 * Un événement en cours de traitement est marqué par `claimedBy` + `claimedUntil`.
 * Le bail EXPIRE. Un statut `processing` laissé par un processus mort, lui,
 * bloque une file pour toujours — c'est le mode de panne que l'invariant 5
 * (« tout verrou distribué porte un TTL et un propriétaire ») interdit.
 *
 * ── Ce qu'il fait quand Redis est absent ────────────────────────────────────
 *
 * RIEN, et il le dit. Il ne marque surtout pas publié : les événements
 * s'accumulent en base, intacts, et repartent dès que le transport revient. Un
 * relais qui « réussirait » sans transport perdrait tout, en silence.
 */

const os = require("os");
const crypto = require("crypto");

const { getTxConn } = require("../../config/db");
const stream = require("./stream");

const IDENTITE = `${os.hostname()}:${process.pid}:${crypto
  .randomBytes(4)
  .toString("hex")}`;

const INTERVALLE_MS = Math.max(
  200,
  Number(process.env.EVENT_RELAY_INTERVAL_MS || 1000)
);

const LOT = Math.min(500, Math.max(1, Number(process.env.EVENT_RELAY_BATCH || 100)));

/** Durée du bail. Doit dépasser largement le temps d'un lot. */
const BAIL_MS = Math.max(5000, Number(process.env.EVENT_RELAY_LEASE_MS || 30000));

/**
 * Au-delà, on cesse de réessayer et on le DIT. On ne supprime pas : un
 * événement de conformité qu'on n'a pas su publier est une information, et la
 * jauge `event_relay_stuck` la rend visible.
 */
const TENTATIVES_MAX = Math.max(3, Number(process.env.EVENT_RELAY_MAX_ATTEMPTS || 10));

let _modele = null;

function modele() {
  if (!_modele) _modele = require("../../models/DomainEvent")(getTxConn());
  return _modele;
}

/**
 * Réserve un lot d'événements.
 *
 * ⚠️ Réservation UN PAR UN via `findOneAndUpdate`, pas un `updateMany`.
 * `updateMany` ne rend pas les documents modifiés : il faudrait relire par
 * `claimedBy`, et entre les deux un autre relais peut avoir réservé et libéré.
 * L'atomicité document par document est ce qui rend deux relais concurrents
 * inoffensifs.
 */
async function reserver(limite) {
  const M = modele();
  const maintenant = new Date();
  const jusqu = new Date(maintenant.getTime() + BAIL_MS);

  const lot = [];

  for (let i = 0; i < limite; i += 1) {
    const doc = await M.findOneAndUpdate(
      {
        publishedAt: null,
        attempts: { $lt: TENTATIVES_MAX },
        $or: [{ claimedUntil: null }, { claimedUntil: { $lte: maintenant } }],
      },
      {
        $set: { claimedBy: IDENTITE, claimedUntil: jusqu },
        $inc: { attempts: 1 },
      },
      { sort: { occurredAt: 1 }, new: true }
    ).lean();

    if (!doc) break;
    lot.push(doc);
  }

  return lot;
}

async function marquerPublie(id) {
  await modele().updateOne(
    { _id: id },
    { $set: { publishedAt: new Date(), claimedBy: "", claimedUntil: null, lastError: "" } }
  );
}

async function marquerEchec(id, err) {
  await modele().updateOne(
    { _id: id },
    {
      $set: {
        claimedBy: "",
        claimedUntil: null,
        lastError: String(err?.message || err).slice(0, 2000),
      },
    }
  );
}

/**
 * Un tour de relais. Rend un compte-rendu — c'est ce que les tests observent et
 * ce que la supervision exporte.
 */
async function tick({ logger = console } = {}) {
  if (!stream.clientOuNull()) {
    return { transport: false, publies: 0, echecs: 0, lus: 0 };
  }

  const lot = await reserver(LOT);

  let publies = 0;
  let echecs = 0;

  for (const evenement of lot) {
    try {
      const redisId = await stream.xadd(evenement);

      if (!redisId) {
        /**
         * Le transport a disparu entre la réservation et l'envoi. On libère le
         * bail sans marquer publié : l'événement repartira. Ne PAS le marquer
         * est tout l'intérêt de ce test.
         */
        await marquerEchec(evenement._id, new Error("TRANSPORT_INDISPONIBLE"));
        echecs += 1;
        continue;
      }

      await marquerPublie(evenement._id);
      publies += 1;
    } catch (err) {
      await marquerEchec(evenement._id, err);
      echecs += 1;

      logger.error?.("[events][relay] publication échouée", {
        eventId: String(evenement._id),
        name: evenement.name,
        attempts: evenement.attempts,
        message: err?.message,
      });
    }
  }

  return { transport: true, publies, echecs, lus: lot.length };
}

/** Combien d'événements ont épuisé leurs tentatives — jauge de supervision. */
async function bloques() {
  return modele().countDocuments({
    publishedAt: null,
    attempts: { $gte: TENTATIVES_MAX },
  });
}

/** Combien attendent d'être publiés — jauge de retard du bus. */
async function enAttente() {
  return modele().countDocuments({ publishedAt: null });
}

function start({ logger = console } = {}) {
  let arrete = false;
  let enCours = false;

  const timer = setInterval(async () => {
    /** Un tour lent ne doit pas déclencher un second tour concurrent. */
    if (arrete || enCours) return;

    enCours = true;

    try {
      const bilan = await tick({ logger });

      if (bilan.echecs > 0) {
        logger.warn?.("[events][relay] tour terminé avec des échecs", bilan);
      }
    } catch (err) {
      logger.error?.("[events][relay] tour interrompu", {
        message: err?.message || String(err),
      });
    } finally {
      enCours = false;
    }
  }, INTERVALLE_MS);

  /** Ne retient pas le processus à l'arrêt. */
  timer.unref?.();

  logger.info?.(
    `✅ Relais d'événements démarré — flux « ${stream.FLUX} », lot ${LOT}, ` +
      `intervalle ${INTERVALLE_MS} ms, bail ${BAIL_MS} ms, borne du journal ` +
      `${stream.TAILLE_MAX} entrées.`
  );

  return {
    stop() {
      arrete = true;
      clearInterval(timer);
    },
  };
}

module.exports = {
  IDENTITE,
  INTERVALLE_MS,
  LOT,
  BAIL_MS,
  TENTATIVES_MAX,
  reserver,
  tick,
  bloques,
  enAttente,
  start,
};
