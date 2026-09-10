"use strict";

/**
 * ============================================================================
 * CADRE DE CONSOMMATION — L'IDEMPOTENCE N'EST PAS OPTIONNELLE
 * ============================================================================
 *
 * ── Ce que « au moins une fois » impose ─────────────────────────────────────
 *
 * Le relais peut publier deux fois le même événement (mort entre l'envoi et le
 * marquage). Redis peut relivrer un message non acquitté. Un consommateur qui
 * traite deux fois DOIT produire le même résultat qu'en le traitant une fois.
 *
 * Ce cadre ne peut pas rendre un gestionnaire idempotent à sa place — c'est une
 * propriété du traitement, pas du transport. Ce qu'il fait, c'est fournir
 * l'identifiant stable qui permet de l'être (`eventId`, l'identifiant Mongo de
 * l'événement, invariant à travers les rejeux) et refuser de démarrer un
 * consommateur qui ne déclare pas comment il dédoublonne.
 *
 * ── Trois façons de perdre un message, toutes fermées ───────────────────────
 *
 *   1. le consommateur meurt avant d'acquitter → `XAUTOCLAIM` le récupère
 *      après `minIdleMs` ;
 *   2. le gestionnaire échoue → on N'ACQUITTE PAS ; le message reste en
 *      attente et sera réclamé ;
 *   3. le gestionnaire échoue TOUJOURS (message empoisonné) → au-delà de
 *      `livraisonsMax`, le message part en LETTRE MORTE, est acquitté, et son
 *      échec est journalisé. Sans ce troisième cas, un seul message
 *      indigeste bloque le groupe pour toujours.
 *
 * ── Ce qu'un acquittement veut dire ─────────────────────────────────────────
 *
 * « J'ai fini d'en faire quelque chose », pas « ça s'est bien passé ». Un
 * message envoyé en lettre morte est acquitté : le refuser indéfiniment serait
 * confondre la file de travail avec le journal des erreurs.
 */

const os = require("os");
const crypto = require("crypto");

const stream = require("./stream");

const CONSOMMATEUR = `${os.hostname()}:${process.pid}:${crypto
  .randomBytes(3)
  .toString("hex")}`;

/**
 * Au-delà de ce nombre de livraisons, le message est réputé empoisonné.
 * Volontairement bas : un message qui échoue cinq fois ne réussira pas la
 * sixième, et le garder en file retarde tous les suivants.
 */
const LIVRAISONS_MAX = Math.max(2, Number(process.env.EVENT_CONSUMER_MAX_DELIVERIES || 5));

/** Un message inactif plus longtemps que ça est réclamable par un autre. */
const INACTIVITE_MS = Math.max(
  10000,
  Number(process.env.EVENT_CONSUMER_CLAIM_IDLE_MS || 60000)
);

const INTERVALLE_MS = Math.max(
  200,
  Number(process.env.EVENT_CONSUMER_INTERVAL_MS || 1000)
);

/**
 * Crée un consommateur.
 *
 * @param {object}   options
 * @param {string}   options.groupe        nom du groupe de consommateurs
 * @param {string[]} options.evenements    noms d'événements traités (filtre)
 * @param {Function} options.handler       async ({ eventId, name, payload }) => void
 * @param {Function} options.dejaTraite    async (eventId) => boolean — l'idempotence
 * @param {Function} [options.onDeadLetter] async (message, err) => void
 */
function createConsumer({
  groupe,
  evenements,
  handler,
  dejaTraite,
  onDeadLetter,
  logger = console,
}) {
  if (!groupe || typeof groupe !== "string") {
    throw new Error("[events][consumer] un groupe est requis.");
  }

  if (typeof handler !== "function") {
    throw new Error("[events][consumer] un gestionnaire est requis.");
  }

  /**
   * ⚠️ REFUS DE DÉMARRER SANS STRATÉGIE DE DÉDOUBLONNAGE.
   *
   * C'est le point le plus important de ce fichier. Un consommateur sans
   * `dejaTraite` fonctionnerait parfaitement en développement — où chaque
   * message n'arrive qu'une fois — et compterait deux fois en production, au
   * premier redéploiement. On ferme la porte à la construction plutôt que de
   * découvrir la double comptabilisation dans un rapport de conformité.
   */
  if (typeof dejaTraite !== "function") {
    throw new Error(
      `[events][consumer] le groupe « ${groupe} » ne déclare pas comment il ` +
        "dédoublonne. La livraison est AU MOINS UNE FOIS : sans `dejaTraite`, " +
        "un redéploiement fait traiter deux fois le même événement."
    );
  }

  const filtre = Array.isArray(evenements) && evenements.length
    ? new Set(evenements)
    : null;

  async function traiter(message) {
    if (message.corrompu) {
      logger.error?.("[events][consumer] charge illisible — lettre morte", {
        groupe,
        eventId: message.eventId,
        redisId: message.redisId,
      });

      await onDeadLetter?.(message, new Error("PAYLOAD_ILLISIBLE"));
      await stream.ack({ groupe, redisId: message.redisId });
      return { statut: "lettre-morte" };
    }

    if (filtre && !filtre.has(message.name)) {
      /**
       * Un événement hors périmètre est acquitté immédiatement : le laisser en
       * attente ferait grossir la file de ce groupe sans fin. Le flux est
       * partagé, les groupes ne le sont pas.
       */
      await stream.ack({ groupe, redisId: message.redisId });
      return { statut: "ignore" };
    }

    if (await dejaTraite(message.eventId)) {
      await stream.ack({ groupe, redisId: message.redisId });
      return { statut: "doublon" };
    }

    try {
      await handler(message);
      await stream.ack({ groupe, redisId: message.redisId });
      return { statut: "traite" };
    } catch (err) {
      const nb = await stream.livraisons({ groupe, redisId: message.redisId });

      if (nb >= LIVRAISONS_MAX) {
        logger.error?.("[events][consumer] message empoisonné — lettre morte", {
          groupe,
          eventId: message.eventId,
          name: message.name,
          livraisons: nb,
          message: err?.message,
        });

        await onDeadLetter?.(message, err);
        await stream.ack({ groupe, redisId: message.redisId });
        return { statut: "lettre-morte" };
      }

      logger.warn?.("[events][consumer] échec — sera relivré", {
        groupe,
        eventId: message.eventId,
        name: message.name,
        livraisons: nb,
        message: err?.message,
      });

      /** Pas d'acquittement : c'est ce qui provoque la relivraison. */
      return { statut: "echec" };
    }
  }

  async function tick() {
    if (!stream.clientOuNull()) return { transport: false };

    const bilan = { transport: true, traites: 0, doublons: 0, echecs: 0, lettresMortes: 0 };

    /**
     * Les messages ABANDONNÉS d'abord. Les traiter après les nouveaux les
     * ferait attendre indéfiniment sur un flux actif — c'est-à-dire exactement
     * quand la reprise compte.
     */
    const { entrees: abandonnes } = await stream.autoClaim({
      groupe,
      consommateur: CONSOMMATEUR,
      minIdleMs: INACTIVITE_MS,
    });

    /**
     * ⚠️ LECTURE NON BLOQUANTE, ET C'EST DÉLIBÉRÉ.
     *
     * Ce tour est appelé par une minuterie : bloquer ici garderait la connexion
     * Redis occupée entre deux tours, empêcherait `stop()` de rendre la main, et
     * ferait manquer l'arrêt sur SIGTERM.
     *
     * ⚠️ `blockMs: 0` a longtemps signifié l'INVERSE de ce qu'on croyait : en
     * Redis, `BLOCK 0` veut dire « attends indéfiniment ». `readGroup` n'envoie
     * désormais `BLOCK` que si une attente est réellement demandée — voir son
     * en-tête, qui raconte comment le défaut s'est manifesté.
     */
    const nouveaux = await stream.readGroup({
      groupe,
      consommateur: CONSOMMATEUR,
    });

    for (const message of [...abandonnes, ...nouveaux]) {
      const { statut } = await traiter(message);

      if (statut === "traite") bilan.traites += 1;
      else if (statut === "doublon") bilan.doublons += 1;
      else if (statut === "echec") bilan.echecs += 1;
      else if (statut === "lettre-morte") bilan.lettresMortes += 1;
    }

    return bilan;
  }

  async function start() {
    await stream.ensureGroup(groupe);

    let arrete = false;
    let enCours = false;

    const timer = setInterval(async () => {
      if (arrete || enCours) return;
      enCours = true;

      try {
        const bilan = await tick();

        if (bilan.lettresMortes) {
          logger.error?.("[events][consumer] lettres mortes sur ce tour", {
            groupe,
            ...bilan,
          });
        }
      } catch (err) {
        logger.error?.("[events][consumer] tour interrompu", {
          groupe,
          message: err?.message || String(err),
        });
      } finally {
        enCours = false;
      }
    }, INTERVALLE_MS);

    timer.unref?.();

    logger.info?.(
      `✅ Consommateur « ${groupe} » démarré — ${
        filtre ? [...filtre].join(", ") : "tous les événements"
      }.`
    );

    return {
      stop() {
        arrete = true;
        clearInterval(timer);
      },
    };
  }

  return { groupe, tick, traiter, start, CONSOMMATEUR };
}

module.exports = { createConsumer, LIVRAISONS_MAX, INACTIVITE_MS, CONSOMMATEUR };
