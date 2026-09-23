// File: models/TransactionReviewCase.js

"use strict";

/**
 * ============================================================================
 * LE DOSSIER DE REVUE — ce qu'on attend du client, et ce qu'on a décidé
 * ============================================================================
 *
 * ── CE QUE CE MODÈLE COMBLE ─────────────────────────────────────────────
 *
 * `pending_review` existait déjà : la transaction est créée, les fonds sont
 * réservés, un opérateur peut confirmer ou rejeter. Mais **le client n'était
 * prévenu de rien** et on ne lui demandait rien. Vérifié avant d'écrire ce
 * modèle : aucun lien entre `pending_review` et une notification, une demande
 * de pièce ou un quelconque KYC.
 *
 * Le virement restait donc en attente d'un opérateur qui n'avait, lui, aucune
 * pièce à examiner. Une revue sans instruction n'est pas une revue : c'est une
 * file d'attente.
 *
 * ── CE QUE FONT STRIPE ET PAYPAL ────────────────────────────────────────
 *
 * Ils ouvrent un DOSSIER : ce qui est demandé, à qui, pour quand, et ce qui a
 * été décidé. Le dossier survit à la transaction — c'est lui qu'un contrôle
 * réclame, et c'est lui qui permet de dire, deux ans plus tard, pourquoi ce
 * virement-là a été retenu.
 *
 * ── ⚠️ CE DOSSIER NE DÉPLACE AUCUN ARGENT ───────────────────────────────
 *
 * Il n'a ni solde, ni écriture, ni pouvoir sur la transaction. Il ENREGISTRE
 * une demande et une décision ; la transaction, elle, continue d'obéir à la
 * machine à états et aux gardes du grand livre. Le grand livre fait foi
 * (invariant A.2) : ce document n'est qu'un dossier d'instruction.
 *
 * ── ⚠️ LES MOTIFS INTERNES NE SONT JAMAIS MONTRÉS AU CLIENT ─────────────
 *
 * `riskReasons` porte les codes du moteur (`VELOCITY_COUNT_BURST`, …). Ils
 * servent à l'opérateur et au contrôle. Dire à un client QUELLE règle s'est
 * déclenchée lui apprend à l'éviter — c'est pourquoi aucun établissement
 * sérieux ne le fait. Le client reçoit `clientCategory`, volontairement
 * générique.
 *
 * ── ⚠️ AUCUN MONTANT, AUCUN BÉNÉFICIAIRE ICI ────────────────────────────
 *
 * Ils vivent sur la transaction, qui a ses propres gardes et son propre
 * `toJSON` d'expurgation. Les recopier ici en ferait une seconde source de
 * vérité financière — et une seconde surface à protéger (règle B.4).
 */

const mongoose = require("mongoose");

/**
 * Liste FERMÉE des pièces qu'on sait demander.
 *
 * Fermée délibérément : une chaîne libre permettrait à un opérateur de
 * réclamer n'importe quoi, sans que rien ne le contrôle ni ne le journalise de
 * façon comparable. C'est aussi ce qui rend les statistiques de conformité
 * possibles.
 */
const REQUIRED_DOCUMENTS = Object.freeze([
  "identity",
  "proof_of_address",
  "source_of_funds",
  "purpose_of_payment",
]);

/**
 * Catégories montrées au CLIENT. Génériques par construction.
 */
const CLIENT_CATEGORIES = Object.freeze([
  "verification_identite",
  "verification_operation",
  "verification_complementaire",
]);

const CASE_STATUSES = Object.freeze([
  /** Ouvert, le client a été prévenu, rien n'est encore arrivé. */
  "awaiting_customer",
  /** Le client a fourni quelque chose ; un opérateur doit l'examiner. */
  "awaiting_operator",
  /** Un opérateur a tranché : la transaction peut reprendre. */
  "approved",
  /** Un opérateur a tranché : la transaction ne reprendra pas. */
  "rejected",
  /** Le délai a expiré sans réponse du client. */
  "expired",
]);

module.exports = (conn = mongoose) => {
  if (conn.models.TransactionReviewCase) return conn.models.TransactionReviewCase;

  const Schema = mongoose.Schema;

  const reviewCaseSchema = new Schema(
    {
      transactionId: {
        type: String,
        required: true,
        trim: true,
      },

      reference: {
        type: String,
        default: null,
        trim: true,
        index: true,
      },

      userId: {
        type: String,
        required: true,
        trim: true,
        index: true,
      },

      status: {
        type: String,
        enum: CASE_STATUSES,
        default: "awaiting_customer",
        index: true,
      },

      /* ── Ce que le moteur a vu — INTERNE, jamais montré au client ─────── */

      riskScore: { type: Number, default: null },

      /**
       * Les CODES seulement, pas les détails.
       *
       * ⚠️ Les détails contiennent des chiffres (« 5000 > 1000 », « 12.4×
       * l'habitude »). Un code se compare, s'agrège et se journalise sans rien
       * divulguer ; un détail est une donnée financière.
       */
      riskReasonCodes: {
        type: [String],
        default: [],
      },

      /* ── Ce qu'on demande au client ──────────────────────────────────── */

      requiredDocuments: {
        type: [String],
        enum: REQUIRED_DOCUMENTS,
        default: [],
      },

      clientCategory: {
        type: String,
        enum: CLIENT_CATEGORIES,
        default: "verification_complementaire",
      },

      openedAt: { type: Date, default: Date.now, index: true },

      /**
       * ⚠️ UN DÉLAI EXPLICITE, ET IL N'EST PAS DÉCORATIF. Sans lui, un dossier
       * sans réponse retient des fonds réservés indéfiniment — le client ne
       * peut ni dépenser ni récupérer son argent, et personne ne s'en aperçoit
       * parce que rien n'échoue.
       */
      deadlineAt: { type: Date, default: null, index: true },

      /* ── Ce qui s'est passé ensuite ──────────────────────────────────── */

      customerNotifiedAt: { type: Date, default: null },
      remindedAt: { type: Date, default: null },
      submittedAt: { type: Date, default: null },

      decidedAt: { type: Date, default: null },
      /** Identifiant de l'opérateur. Jamais son nom ni son adresse. */
      decidedBy: { type: String, default: null, trim: true },

      /**
       * Note d'instruction, écrite par un opérateur.
       *
       * ⚠️ Bornée en longueur : un champ de texte libre non borné dans une
       * collection financière finit par contenir des copier-coller de pièces
       * d'identité.
       */
      operatorNote: { type: String, default: null, maxlength: 2000 },
    },
    { timestamps: true, minimize: false }
  );

  /**
   * ⚠️ UN SEUL DOSSIER PAR TRANSACTION.
   *
   * Sans cet index unique, deux passages concurrents — un rejeu de requête,
   * deux instances — ouvriraient deux dossiers pour le même virement. Le
   * client recevrait deux demandes de pièces, et l'opérateur trancherait sur
   * l'un pendant que l'autre resterait ouvert.
   */
  reviewCaseSchema.index(
    { transactionId: 1 },
    { unique: true, name: "uniq_review_case_per_transaction" }
  );

  /** File de travail des opérateurs : les dossiers à instruire, les plus vieux d'abord. */
  reviewCaseSchema.index({ status: 1, openedAt: 1 });

  /** Balayage des dossiers échus. */
  reviewCaseSchema.index({ status: 1, deadlineAt: 1 });

  return conn.model("TransactionReviewCase", reviewCaseSchema);
};

module.exports.REQUIRED_DOCUMENTS = REQUIRED_DOCUMENTS;
module.exports.CLIENT_CATEGORIES = CLIENT_CATEGORIES;
module.exports.CASE_STATUSES = CASE_STATUSES;
