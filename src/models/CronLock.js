"use strict";

const mongoose = require("mongoose");

/**
 * VERROU DE TÂCHE PLANIFIÉE
 * =============================================================================
 *
 * Le démarrage du serveur lançait `startBadgesCron()`, `startFxHistoryCron()`,
 * `require("./src/cron")` et `scheduleNotifications()` **inconditionnellement**,
 * plus un instantané FX au boot. Avec N instances web, cela donnait N
 * instantanés FX par jour, N balayages d'annonces toutes les cinq minutes, et
 * N appels à l'API de change **à chaque redéploiement**.
 *
 * Ce n'est pas une inefficacité théorique : un fournisseur de taux facture à
 * l'appel et limite le débit. Multiplier les instances multipliait la facture et
 * rapprochait du plafond, sans que rien ne le signale.
 *
 * ═══ POURQUOI MONGO PLUTÔT QUE REDIS ══════════════════════════════════════
 *
 * `redlock` figure dans les dépendances du dépôt et n'est importé nulle part.
 * L'y brancher supposerait de déployer Redis — ce que la règle du projet
 * n'autorise pas sans accord, et ce dont ce problème n'a pas besoin.
 *
 * Un verrou de cron demande peu : un gagnant par fenêtre, et la libération d'un
 * verrou dont le porteur est mort. MongoDB le fait avec l'atomicité au document,
 * qui est exactement ce sur quoi repose déjà le worker d'outbox
 * (`services/outboxPublisher.js:86`) et le worker d'auto-annulation de Tx-Core.
 * On réutilise un mécanisme déjà éprouvé en production plutôt que d'en
 * introduire un second.
 *
 * ═══ CE QUE LE SCHÉMA GARANTIT ════════════════════════════════════════════
 *
 * `_id` est le nom de la tâche. C'est le cœur du dispositif : `_id` porte un
 * index unique que MongoDB impose sans qu'on le déclare, donc deux instances qui
 * tentent d'insérer le même verrou au même instant ne peuvent pas réussir toutes
 * les deux. La perdante reçoit une erreur de clé dupliquée — un refus net, pas
 * une course silencieuse.
 */
const cronLockSchema = new mongoose.Schema(
  {
    /** Nom de la tâche. Sert de clé primaire, donc unique par construction. */
    _id: {
      type: String,
      required: true,
      trim: true,
    },

    /**
     * Qui détient le verrou. `hostname:pid:aléa` — l'aléa est indispensable :
     * deux instances peuvent partager un nom d'hôte et un identifiant de
     * processus dans un ordonnanceur de conteneurs.
     */
    lockedBy: {
      type: String,
      default: "",
    },

    lockedAt: {
      type: Date,
      default: null,
    },

    /**
     * Date au-delà de laquelle le verrou est considéré comme abandonné.
     *
     * C'est ce qui évite le blocage définitif : un processus tué par un
     * redéploiement, un OOM ou un SIGKILL ne libère rien. Sans expiration, la
     * tâche ne repartirait jamais — et personne ne s'en apercevrait avant que
     * quelqu'un remarque l'absence d'instantané FX.
     */
    expiresAt: {
      type: Date,
      default: null,
      index: true,
    },

    /** Dernière exécution menée à son terme. Sert au diagnostic. */
    lastRunAt: {
      type: Date,
      default: null,
    },

    lastRunMs: {
      type: Number,
      default: null,
    },

    lastError: {
      type: String,
      default: null,
    },

    runCount: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
    collection: "cron_locks",
    /**
     * `_id` est fourni par nous : Mongoose ne doit pas en générer un.
     */
    _id: true,
    versionKey: false,
  }
);

module.exports = (conn = mongoose) =>
  conn.models.CronLock || conn.model("CronLock", cronLockSchema);
