"use strict";

/**
 * ============================================================================
 * NUMÉROS DE DÉPÔT DE CONFIANCE — UN CONTRÔLE DU CHEMIN DE L'ARGENT
 * ============================================================================
 *
 * ── Ce que ce registre empêche ──────────────────────────────────────────────
 *
 * Un encaissement mobile money crédite le portefeuille PayNoval de l'appelant à
 * partir d'un numéro qu'il désigne. Sans contrôle, n'importe qui peut désigner
 * le numéro de n'importe qui : soit pour tenter un débit sur un tiers, soit
 * — le cas réel — pour faire transiter des fonds par un compte qui n'est pas le
 * sien. Ce registre répond à une seule question : « cet utilisateur a-t-il
 * PROUVÉ par SMS qu'il contrôle ce numéro ? »
 *
 * ── Pourquoi cette collection vit dans TX Core ──────────────────────────────
 *
 * Elle vivait au bord (`api-gateway/src/models/TrustedDepositNumber.js`), avec
 * la décision qui la lit. Le bord ne possède aucun domaine : il fait du TLS, du
 * routage, de la vérification de jeton et de la limitation de débit. Un
 * contrôle qui AUTORISE UN MOUVEMENT D'ARGENT appartient au moteur qui déplace
 * l'argent — au même titre que l'AML, ramenée ici pour la même raison.
 *
 * ── Sur la connexion TRANSACTIONS, pas celle des utilisateurs ───────────────
 *
 * La donnée vit avec ce qu'elle contrôle. `AMLLog` a fait l'erreur inverse — il
 * est déclaré en `mongoose.model()` global et atterrit donc dans la base des
 * utilisateurs, loin des transactions qu'il décrit ; le rattraper demandera une
 * migration. On ne recommence pas.
 *
 * ── `userId` est une CHAÎNE, délibérément ──────────────────────────────────
 *
 * La version du bord déclarait `ObjectId` avec `ref: "User"`. La référence
 * n'avait déjà aucun sens — `User` vit dans une AUTRE base — et le typage strict
 * ferait caster les valeurs de requête par Mongoose. TX Core reçoit
 * l'identifiant depuis un en-tête (`x-user-id`), donc sous forme de chaîne : la
 * comparaison doit se faire sur la même forme des deux côtés, sinon la lecture
 * ne retrouve rien et le contrôle échoue en OUVERTURE, ce qui est le pire des
 * deux sens.
 *
 * ── Aucun TTL ───────────────────────────────────────────────────────────────
 *
 * La confiance est durable : c'est tout l'intérêt. Un numéro vérifié il y a six
 * mois reste vérifié — on ne redemande pas un SMS à chaque dépôt. La révocation
 * est un acte explicite (`status: "blocked"`), pas une expiration.
 */

const mongoose = require("mongoose");

const trustedDepositNumberSchema = new mongoose.Schema(
  {
    /**
     * Pas d'`index: true` ici : le composé `{ userId, phoneE164 }` couvre déjà
     * toute recherche par utilisateur (préfixe d'index). Un index simple en
     * plus ne servirait aucune lecture et coûterait une écriture de plus à
     * chaque `$inc` du compteur d'envois.
     */
    userId: { type: String, required: true, trim: true },

    /** Numéro au format E.164 (ex. `+2250700000000`). Jamais de forme locale. */
    phoneE164: { type: String, required: true, trim: true },

    /**
     * `pending`  — un code a été demandé, rien n'est prouvé ;
     * `trusted`  — le code a été validé, le dépôt est autorisé ;
     * `blocked`  — trop de tentatives, ou révocation. Voir `blockedUntil`.
     */
    status: {
      type: String,
      enum: ["pending", "trusted", "blocked"],
      default: "pending",
    },

    /* ── Anti-abus : chaque envoi abouti coûte un SMS réel ── */
    lastSentAt: { type: Date, default: null },

    /**
     * ⚠️ `sentCount` COMPTE LA FENÊTRE COURANTE, PAS LA VIE DU DOCUMENT.
     *
     * La version du bord n'avait pas `windowStartedAt` : elle incrémentait
     * `sentCount` sans jamais le remettre à zéro, et comparait `updatedAt` —
     * qui change à CHAQUE écriture — à une fenêtre de 15 minutes. Le compteur
     * étant cumulatif, tout utilisateur ayant demandé 5 codes DANS SA VIE
     * repassait en blocage au 6e, puis à chaque tentative suivante, pour
     * toujours. Vérifier cinq numéros sur un an suffisait à ne plus jamais
     * pouvoir en vérifier un sixième.
     *
     * Le défaut ne se voyait pas en essai : il faut cinq envois pour l'atteindre.
     */
    windowStartedAt: { type: Date, default: null },
    sentCount: { type: Number, default: 0 },

    /**
     * Date de fin de blocage. C'est ELLE qui fait foi, pas `status`.
     * Le bord posait `status: "blocked"` sans jamais le repasser à `pending` :
     * l'état affiché restait « bloqué » longtemps après l'expiration réelle.
     */
    blockedUntil: { type: Date, default: null },

    /**
     * ⚠️ COMPTEUR D'ÉCHECS DE SAISIE — ABSENT DE LA VERSION DU BORD.
     *
     * Celle-ci ne comptait que les ENVOIS. La saisie du code, elle, était
     * illimitée : un code à 6 chiffres se devine en 10^6 essais, et rien côté
     * PayNoval ne les bornait. La seule protection était le plafond de Twilio
     * (5 vérifications par code) — une garantie du FOURNISSEUR, sur laquelle on
     * ne bâtit pas un contrôle de sécurité. Changer d'offre ou de fournisseur
     * aurait retiré la protection sans que rien ne le signale.
     *
     * Remis à zéro par une saisie réussie ou un nouvel envoi.
     */
    failedCheckCount: { type: Number, default: 0 },

    /** Horodatage d'audit : QUAND la preuve a été apportée. */
    verifiedAt: { type: Date, default: null },
  },
  { collection: "trusted_deposit_numbers", timestamps: true }
);

/**
 * ⚠️ L'UNICITÉ EST UNE CONTRAINTE, PAS UNE VÉRIFICATION.
 *
 * Deux `/start` concurrents sur le même numéro passeraient tous deux le
 * « chercher puis créer » du contrôleur. Sans cet index, on obtiendrait deux
 * documents pour le même couple : le compteur d'envois serait réparti entre
 * les deux, et le quota anti-abus deviendrait deux fois plus permissif que
 * déclaré — silencieusement.
 *
 * `autoIndex` est coupé sur ce service : cet index doit être posé par
 * `scripts/ensureIndexes.js`. C'est pourquoi il est déclaré CRITIQUE.
 */
trustedDepositNumberSchema.index(
  { userId: 1, phoneE164: 1 },
  { unique: true, name: "uniq_trusted_deposit_number" }
);

trustedDepositNumberSchema.index(
  { userId: 1, status: 1, updatedAt: -1 },
  { name: "trusted_deposit_by_user_status" }
);

module.exports = (conn = mongoose) =>
  conn.models.TrustedDepositNumber ||
  conn.model("TrustedDepositNumber", trustedDepositNumberSchema);
