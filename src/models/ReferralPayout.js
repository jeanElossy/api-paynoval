"use strict";

/**
 * ============================================================================
 * REGISTRE DES VERSEMENTS DE PARRAINAGE — GARDE-FOU D'IDEMPOTENCE
 * ============================================================================
 *
 * Un document = un versement à un bénéficiaire, et UN SEUL, pour toujours.
 *
 * POURQUOI UNE COLLECTION DÉDIÉE PLUTÔT QU'UN INDEX SUR LA TRANSACTION
 * -------------------------------------------------------------------
 * C'est le choix que font Stripe, PayPal et Wise, pour trois raisons :
 *
 *   1. PERMANENCE. Une clé d'idempotence de paiement ne doit JAMAIS expirer.
 *      Le modèle `IdempotencyKey` du backend principal porte un index TTL de
 *      24 h : parfaitement adapté à une requête d'API rejouée, mortel pour un
 *      versement — un rejeu à J+2 recréditerait sans rien rencontrer. Aucun TTL
 *      ici, jamais. Ce registre est un livre de comptes, pas un cache.
 *
 *   2. INDÉPENDANCE. Adosser la garde financière à l'index unique d'un document
 *      de présentation (la transaction affichée à l'utilisateur) la casse
 *      silencieusement le jour où le format de référence change, où l'on ajoute
 *      un troisième bénéficiaire, ou où quelqu'un archive les vieilles
 *      transactions. La garde doit survivre à l'évolution de ce qu'elle garde.
 *
 *   3. REJEU FIDÈLE. Stripe renvoie à une requête rejouée la RÉPONSE D'ORIGINE,
 *      octet pour octet, et non un « déjà traité » laconique. L'appelant n'a
 *      donc aucun traitement particulier à écrire : il reçoit la même chose
 *      qu'au premier appel. `responseSnapshot` sert exactement à cela.
 *
 * L'EMPREINTE DES PARAMÈTRES
 * --------------------------
 * Même clé + paramètres différents = anomalie, pas doublon. Chez Stripe cela
 * renvoie une erreur explicite plutôt qu'un résultat trompeur. Ici, cela veut
 * dire qu'un appelant a réutilisé une clé de versement pour un montant ou un
 * bénéficiaire différent : c'est soit un bug, soit une tentative de
 * manipulation. Dans les deux cas il faut refuser bruyamment.
 *
 * LA MACHINE À ÉTATS
 * ------------------
 *   processing → succeeded   (l'argent est parti, définitif)
 *   processing → failed      (rien n'est parti, un rejeu est autorisé)
 *
 * `processing` est écrit DANS la transaction Mongo qui déplace l'argent. Si le
 * processus meurt entre les deux, la transaction Mongo est annulée et le
 * document disparaît avec elle : aucun état fantôme ne peut bloquer un
 * versement légitime.
 */

const mongoose = require("mongoose");

const referralPayoutSchema = new mongoose.Schema(
  {
    /**
     * Clé métier du versement, au format imposé par la spécification :
     *   REFERRAL_BONUS:{rewardId}:{beneficiaryId}
     *
     * Elle est déterministe : le même parrainage et le même bénéficiaire
     * produisent toujours la même clé, quel que soit le service qui la calcule,
     * quel que soit le nombre de tentatives.
     */
    idempotencyKey: {
      type: String,
      required: true,
      trim: true,
    },

    /**
     * Empreinte SHA-256 des paramètres financiers de la demande.
     * Voir l'explication en tête de fichier.
     */
    requestFingerprint: {
      type: String,
      required: true,
      trim: true,
    },

    rewardId: { type: String, required: true, trim: true, index: true },
    beneficiaryId: { type: String, required: true, trim: true, index: true },
    beneficiaryRole: {
      type: String,
      enum: ["sponsor", "referee"],
      required: true,
    },

    treasuryUserId: { type: String, required: true, trim: true },
    treasurySystemType: { type: String, required: true, trim: true },

    /** Montant crédité au bénéficiaire, dans SA devise. */
    creditedAmount: { type: Number, required: true, min: 0 },
    creditedCurrency: { type: String, required: true, trim: true },

    /** Montant débité de la trésorerie, dans la devise de la trésorerie. */
    treasuryDebitedAmount: { type: Number, required: true, min: 0 },
    treasuryCurrency: { type: String, required: true, trim: true },

    /**
     * Solde du bénéficiaire avant et après le crédit, capturés au moment exact
     * du mouvement, dans la même transaction Mongo. C'est ce qui permet
     * d'afficher « 45 000 → 50 000 » dans le détail du mouvement et de le
     * prouver a posteriori (§11).
     */
    balanceBefore: { type: Number, default: null },
    balanceAfter: { type: Number, default: null },

    status: {
      type: String,
      enum: ["processing", "succeeded", "failed"],
      default: "processing",
      required: true,
      index: true,
    },

    /** Référence de la transaction visible par l'utilisateur. */
    transactionReference: { type: String, trim: true, default: "" },
    transactionId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },

    /** Identifiant de corrélation traversant tout le parcours (§22). */
    correlationId: { type: String, trim: true, default: "", index: true },

    /** Transaction qualifiante ayant déclenché le versement. */
    triggerTxId: { type: String, trim: true, default: "" },

    /** Version du barème appliqué, pour l'audit rétrospectif. */
    programVersion: { type: String, trim: true, default: "" },

    /**
     * Réponse renvoyée au premier appel, rejouée telle quelle aux suivants.
     */
    responseSnapshot: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },

    failureCode: { type: String, trim: true, default: "" },
    failureMessage: { type: String, trim: true, default: "", maxlength: 2000 },

    completedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

/**
 * L'INDEX QUI PORTE TOUTE LA GARANTIE.
 *
 * C'est lui, et lui seul, qui rend le double crédit impossible. Deux workers,
 * deux instances, deux événements livrés en double : le second `insert` lève un
 * E11000 et la transaction Mongo est annulée dans son intégralité — le débit de
 * trésorerie compris.
 *
 * ⚠️ Ne jamais y ajouter de TTL, ni le rendre partiel, ni le passer en
 * non-unique. Sans son unicité, tout le dispositif d'idempotence tombe.
 */
referralPayoutSchema.index(
  { idempotencyKey: 1 },
  { unique: true, name: "uniq_referral_payout_idempotency_key" }
);

/** Supervision : les versements d'une récompense, dans l'ordre. */
referralPayoutSchema.index({ rewardId: 1, beneficiaryRole: 1 });

/** Réconciliation : retrouver les versements en cours ou en échec. */
referralPayoutSchema.index({ status: 1, createdAt: -1 });

module.exports = (conn = mongoose) =>
  conn.models.ReferralPayout ||
  conn.model("ReferralPayout", referralPayoutSchema);
