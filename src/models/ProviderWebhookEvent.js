"use strict";

const mongoose = require("mongoose");

/**
 * ============================================================================
 * REGISTRE DES RAPPELS PRESTATAIRE — R5 DE L'AUDIT
 * ============================================================================
 *
 * ⚠️ AUCUNE DÉDUPLICATION N'EXISTAIT SUR LES WEBHOOKS.
 *
 * Le contrôleur vérifiait la signature, normalisait la charge utile, et
 * appelait le règlement. Rien ne se souvenait qu'un événement avait déjà été
 * traité — alors que **le rejeu est le comportement NORMAL d'un prestataire de
 * paiement** : tous réémettent tant qu'ils n'ont pas reçu un 2xx, et plusieurs
 * réémettent même après. L'audit le classait « probabilité élevée » ;
 * ce n'est pas un accident, c'est le protocole.
 *
 * Conséquence : un même « paiement confirmé » traité deux fois créditait le
 * bénéficiaire deux fois. Les drapeaux `beneficiaryCredited` protégeaient le
 * chemin nominal, mais toute divergence d'état — ou tout événement portant sur
 * une transaction dans un état inattendu — passait au travers.
 *
 * ⚠️ COLLECTION SÉPARÉE DE `idempotency_records`, ET C'EST DÉLIBÉRÉ.
 *
 * Celle-là porte un index TTL de **24 h** sur toute la collection : la fenêtre
 * d'un rejeu réseau. Les prestataires, eux, réessaient pendant des JOURS —
 * Stripe jusqu'à trois, certains opérateurs mobile money davantage. Un rejeu au
 * quatrième jour aurait retrouvé une collection vide et retraité l'événement.
 *
 * Ce registre a une seconde vie : c'est la trace durable de ce que le
 * prestataire nous a dit, et donc la matière première de la réconciliation
 * contre lui (§22). Une déduplication qui s'efface ne réconcilie rien.
 */

const RETENTION_DAYS = 90;

const schema = new mongoose.Schema(
  {
    /**
     * ⚠️ PAS D'`index: true` SUR `provider` — voir la note sur les index plus
     * bas. Il est déjà le préfixe de `uniq_webhook_provider_event`, qui sert
     * donc aussi pour une recherche sur le seul prestataire.
     */
    provider: { type: String, required: true, trim: true, lowercase: true },

    /** `rail` n'est préfixe d'aucun composé : son index simple est utile. */
    rail: { type: String, required: true, trim: true, lowercase: true, index: true },

    /**
     * Identifiant fourni PAR le prestataire. C'est la seule clé qui distingue
     * deux événements réellement différents portant sur la même transaction —
     * « paiement accepté » puis « paiement confirmé », par exemple.
     */
    eventId: { type: String, required: true, trim: true },

    /**
     * Empreinte déterministe de la charge utile normalisée, utilisée comme clé
     * de repli quand le prestataire n'envoie AUCUN identifiant d'événement.
     *
     * ⚠️ LIMITE ASSUMÉE : deux événements distincts mais rigoureusement
     * identiques seraient confondus. Pour un rappel de règlement, deux charges
     * identiques (même référence, même statut, même montant) DÉCRIVENT le même
     * fait — le repli est donc sûr ici, et il ne le serait pas pour un
     * événement porteur d'un compteur.
     */
    fingerprint: { type: String, required: true, trim: true },

    /**
     * `processing` distingue « jamais reçu » de « reçu puis interrompu ».
     * Sans cet état, un processus tué au milieu du règlement laisserait un
     * événement que rien ne permet de reprendre — ni de distinguer d'un
     * doublon.
     */
    /** Idem : préfixe de `{status, createdAt}`, déclaré plus bas. */
    status: {
      type: String,
      enum: ["processing", "processed", "failed"],
      default: "processing",
    },

    attempts: { type: Number, default: 1 },
    lastError: { type: String, default: null },

    /** Ce que le règlement a répondu — rejoué tel quel sur un doublon. */
    responseStatus: { type: Number, default: null },

    /**
     * ⚠️ LE LIEN VERS LA TRANSACTION DOIT ÊTRE INTERROGEABLE, PAS ENFOUI.
     *
     * Certains prestataires ne renvoient QUE notre identifiant technique, sans
     * la référence : `buildSettlementPayload` le récupère bien
     * (`pickTransactionId`), mais il n'était conservé que dans `payload`, un
     * `Mixed` sans index. Un événement rattaché à une transaction par ce seul
     * chemin était donc introuvable autrement qu'en balayant la collection —
     * et la réconciliation l'aurait compté comme « rappel jamais reçu ».
     *
     * `sparse` parce que la majorité des prestataires ne renvoient que la
     * référence : indexer les `null` n'apporterait rien.
     */
    transactionId: { type: mongoose.Schema.Types.ObjectId, default: null },

    transactionReference: { type: String, default: null, trim: true },
    providerReference: { type: String, default: null, trim: true, index: true },
    providerStatus: { type: String, default: null, trim: true },
    eventType: { type: String, default: null, trim: true },

    amount: { type: Number, default: null },
    currency: { type: String, default: null, trim: true, uppercase: true },

    /**
     * La charge NORMALISÉE, jamais la requête brute.
     *
     * ⚠️ CE COMMENTAIRE DÉCRIVAIT UNE INTENTION QUE LE CODE NE TENAIT PAS.
     * `buildSettlementPayload` recopie le corps brut du prestataire dans
     * `payload.raw`, et c'est cet objet entier qui arrivait ici — donc conservé
     * 90 jours. Le corps brut d'un rappel mobile money porte le numéro de
     * téléphone et le nom du bénéficiaire ; celui d'un rappel carte, les quatre
     * derniers chiffres et parfois l'empreinte du moyen de paiement. Rien de
     * tout cela n'est nécessaire pour rejouer une décision.
     *
     * `sanitizeStoredPayload` (dans `webhookEventStore`) ne garde désormais que
     * les champs normalisés qui DÉCRIVENT LE FAIT. La règle du projet vaut pour
     * ce qu'on conserve comme pour ce qu'on journalise.
     */
    payload: { type: mongoose.Schema.Types.Mixed, default: null },

    startedAt: { type: Date, default: Date.now },
    processedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    versionKey: false,
    collection: "provider_webhook_events",
    minimize: false,
  }
);

/**
 * L'UNICITÉ EST LA GARANTIE — tout le reste est de l'ergonomie.
 *
 * La clé porte le PRESTATAIRE : deux prestataires peuvent parfaitement émettre
 * le même identifiant d'événement, et les confondre ferait ignorer un règlement
 * réel. C'est cet index qui rend impossible deux traitements concurrents du
 * même rappel, y compris depuis deux instances.
 */
schema.index(
  { provider: 1, eventId: 1 },
  { unique: true, name: "uniq_webhook_provider_event" }
);

/**
 * ═══ AUCUN CHAMP PRÉFIXE D'UN COMPOSÉ NE PORTE `index: true` ═══════════════
 *
 * Un index composé sert aussi pour son PRÉFIXE : `{provider, eventId}` répond
 * à une recherche sur `provider` seul, `{status, createdAt}` à une recherche
 * sur `status` seul. Déclarer en plus l'index simple crée DEUX index là où un
 * seul travaille.
 *
 * Ce n'est pas neutre : chaque index se met à jour à CHAQUE écriture, et occupe
 * la mémoire de travail que les index utiles se disputent. Sur une collection
 * dont l'écriture est le chemin critique — chaque rappel prestataire en fait
 * une — c'est du coût pur.
 *
 * Quatre index simples ont été retirés le 2026-08-26 pour cette raison :
 * `provider_1`, `status_1`, `transactionId_1`, `transactionReference_1`. Les
 * deux qui restent, `rail_1` et `providerReference_1`, ne sont préfixes
 * d'aucun composé : ils sont utiles.
 *
 * ⚠️ RETIRER LA DÉCLARATION NE SUFFIT PAS — et la raison a changé le
 * 2026-08-28. Ce commentaire disait « tant que `autoIndex` est actif » ; il est
 * coupé depuis `config/db.js:47`. La conclusion, elle, tient toujours, pour une
 * raison plus simple : **rien ne supprime jamais un index qui n'est plus
 * déclaré.** Ni Mongoose, ni `npm run indexes:apply` — qui pose et ne retire
 * rien, délibérément (voir l'en-tête de `scripts/ensureIndexes.js`). Le retrait
 * en base reste donc un acte séparé et explicite
 * (`scripts/dropRedundantWebhookIndexes.js`).
 */

/** Réconciliation : retrouver tous les rappels d'une transaction. */
schema.index({ transactionReference: 1, createdAt: -1 });

/**
 * Réconciliation, second chemin de rattachement. Voir `transactionId` plus
 * haut : sans cet index, un prestataire qui ne renvoie que notre identifiant
 * technique rendrait ses rappels invisibles à la réconciliation.
 */
schema.index({ transactionId: 1, createdAt: -1 }, { sparse: true });

/** Reprise : les événements restés en cours ou en échec. */
schema.index({ status: 1, createdAt: 1 });

/**
 * Rétention 90 jours — trois fois la fenêtre de rejeu la plus longue observée
 * chez les prestataires, et assez pour couvrir une réconciliation trimestrielle.
 */
schema.index(
  { createdAt: 1 },
  { expireAfterSeconds: RETENTION_DAYS * 86400, name: "webhook_events_ttl" }
);

module.exports = (conn = mongoose) =>
  conn.models.ProviderWebhookEvent ||
  conn.model("ProviderWebhookEvent", schema);

module.exports.RETENTION_DAYS = RETENTION_DAYS;
