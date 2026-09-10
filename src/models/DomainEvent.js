"use strict";

/**
 * ============================================================================
 * ÉVÉNEMENTS DE DOMAINE — LE JOURNAL D'ÉCRITURE ANTICIPÉE DU BUS
 * ============================================================================
 *
 * ── Le problème que ce modèle résout : la DOUBLE ÉCRITURE ───────────────────
 *
 * Publier un événement après avoir validé une transaction Mongo, c'est deux
 * écritures qui peuvent diverger : le service tombe entre les deux, et l'argent
 * a bougé sans que personne ne l'apprenne. L'inverse — publier d'abord — annonce
 * un mouvement qui n'aura peut-être jamais lieu.
 *
 * Le motif « outbox transactionnel » referme cette faille : l'événement est
 * écrit DANS LA MÊME TRANSACTION que le changement d'état. Soit les deux
 * existent, soit aucun. Un relais les publie ensuite, à son rythme.
 *
 * C'est le motif standard des plateformes de paiement — Monzo le documente
 * publiquement, l'API `events` de Stripe est bâtie dessus. Le courtier varie
 * (Kafka, Kinesis, Redis Streams) ; le motif, non.
 *
 * ── Pourquoi une collection distincte de `outboxes` ─────────────────────────
 *
 * Deux raisons, et la seconde est décisive.
 *
 *   1. `outboxes` est une FILE DE LIVRAISON de notifications, drainée par
 *      `paynoval-backend/services/outboxPublisher.js`. Y mêler des événements
 *      de domaine mélangerait deux cycles de vie, deux politiques de rejeu et
 *      deux rétentions.
 *
 *   2. ⚠️ `outboxes` vit dans la base des UTILISATEURS. Les changements d'état
 *      transactionnels, eux, se valident sur la connexion des TRANSACTIONS.
 *      Écrire l'événement dans une autre base que l'état qu'il décrit ne donne
 *      l'atomicité que si les deux connexions partagent leur `MongoClient` —
 *      ce que `canUseSharedSession()` vérifie, et qui peut cesser d'être vrai
 *      le jour où les bases sont séparées. Un motif dont la garantie dépend
 *      d'une coïncidence de déploiement n'est pas une garantie.
 *
 * `domain_events` vit donc dans la base des transactions, avec l'état qu'il
 * décrit. L'atomicité ne dépend d'aucune configuration.
 *
 * ── Rétention ───────────────────────────────────────────────────────────────
 *
 * Index TTL de 90 jours sur `publishedAt`. Un événement PUBLIÉ n'a plus qu'une
 * valeur de rejeu et d'audit court terme ; l'audit durable est le grand livre
 * (invariant 2) et `AMLLog`. Un événement NON publié n'expire jamais — c'est
 * une livraison en attente, pas un déchet.
 */

const mongoose = require("mongoose");

const domainEventSchema = new mongoose.Schema(
  {
    /**
     * Nom de l'événement, versionné : `transaction.initiated.v1`.
     *
     * ⚠️ La version fait partie du NOM, pas d'un champ à part. Un consommateur
     * s'abonne à un contrat, pas à un sujet dont la forme peut changer sous
     * lui. Publier `.v2` à côté de `.v1` laisse les deux coexister le temps que
     * les consommateurs migrent — c'est ce qui rend une évolution non bloquante.
     */
    name: { type: String, required: true, trim: true },

    aggregateType: { type: String, required: true, trim: true, default: "transaction" },
    aggregateId: { type: String, required: true, trim: true },

    /**
     * ⚠️ CHAMPS NOMMÉS UNIQUEMENT (règle B.4).
     *
     * Jamais le document interne brut : il porte des données personnelles, et
     * il change au gré des refactorisations. Un consommateur qui lit un
     * document interne se casse au premier renommage de champ ; un consommateur
     * qui lit un contrat ne se casse que si le contrat change, ce qui se voit.
     *
     * `contract.js` valide la charge utile à la publication. Le schéma reste
     * `Mixed` parce que chaque événement a sa forme — la contrainte est portée
     * par le contrat, en un seul endroit, pas dupliquée ici.
     */
    payload: { type: mongoose.Schema.Types.Mixed, required: true, default: {} },

    occurredAt: { type: Date, required: true, default: Date.now },

    /**
     * `publishedAt` non nul ⇒ l'événement est parti sur le bus.
     *
     * Il n'y a délibérément PAS d'énumération de statut : « publié ou non » est
     * un booléen déguisé en date, et la date sert à la rétention. Un état
     * intermédiaire « en cours » vit dans le bail (`claimedBy`/`claimedUntil`),
     * pas dans un statut — un statut « processing » laissé par un processus mort
     * bloque une file pour toujours, un bail expire.
     */
    publishedAt: { type: Date, default: null },

    claimedBy: { type: String, trim: true, default: "" },
    claimedUntil: { type: Date, default: null },

    attempts: { type: Number, default: 0, min: 0 },
    lastError: { type: String, trim: true, default: "", maxlength: 2000 },
  },
  {
    collection: "domain_events",
    timestamps: true,
  }
);

/**
 * L'index du relais : ce qu'il cherche, c'est « non publié, dont le bail est
 * expiré, le plus ancien d'abord ». Sans cet index, chaque tour du relais
 * balaie la collection entière.
 */
domainEventSchema.index(
  { publishedAt: 1, claimedUntil: 1, occurredAt: 1 },
  { name: "domain_events_relay_scan" }
);

/** Reconstitution de l'historique d'un agrégat — instruction d'un dossier. */
domainEventSchema.index({ aggregateType: 1, aggregateId: 1, occurredAt: -1 });

/** Rétention : 90 jours APRÈS publication. Un événement en attente ne meurt pas. */
domainEventSchema.index(
  { publishedAt: 1 },
  {
    name: "domain_events_ttl",
    expireAfterSeconds: 90 * 24 * 60 * 60,
    partialFilterExpression: { publishedAt: { $type: "date" } },
  }
);

module.exports = (conn = mongoose) =>
  conn.models.DomainEvent || conn.model("DomainEvent", domainEventSchema);
