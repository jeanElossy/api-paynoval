"use strict";

const mongoose = require("mongoose");

/**
 * ============================================================================
 * RÈGLEMENT D'UNE PARTICIPATION PAR LIEN PUBLIC
 * ============================================================================
 *
 * Une cagnotte se partage par lien. Qui reçoit ce lien n'a pas forcément de
 * compte PayNoval : il paie par mobile money ou par carte, depuis l'extérieur.
 *
 * ── Pourquoi une collection SÉPARÉE de `tx_cagnotte_settlements` ────────────
 *
 * `CagnotteSettlement` déclare `userId` et `payer` **obligatoires**, et porte un
 * index unique `{userId, idempotencyKey}`. C'est correct pour son usage : un
 * utilisateur PayNoval dont on débite le portefeuille. Ça ne l'est pas ici — il
 * n'y a **aucun utilisateur** à nommer.
 *
 * Deux voies s'offraient. Rendre `userId` facultatif sur le modèle existant
 * aurait affaibli une contrainte d'unicité qui protège aujourd'hui une
 * collection vivante, et pour tous ses documents, pas seulement les nouveaux.
 * Un modèle distinct ne coûte rien et ne retire rien : c'est le motif déjà
 * retenu pour `CagnotteVaultWithdrawalSettlement`.
 *
 * ── L'unicité repose sur la RÉFÉRENCE, pas sur un utilisateur ───────────────
 *
 * Faute de `userId`, la clé d'idempotence ne peut pas être portée par le couple
 * `{userId, idempotencyKey}`. C'est `reference` qui est unique — et c'est plus
 * fort, pas moins : `settlementObjectIdFromReference()` DÉRIVE le `_id` du
 * document de cette même référence, si bien qu'un rejeu entre en collision sur
 * la clé primaire AVANT même d'atteindre l'index. Et le `dedupKey` du grand
 * livre, construit sur ce `_id`, reste stable d'une tentative à l'autre : les
 * écritures comptables sont refusées en double même lorsque la transaction
 * Mongo n'est pas disponible.
 *
 * On ne fait pas reposer un invariant financier sur la seule disponibilité d'un
 * jeu de réplicas.
 *
 * ── `providerReference` n'est pas décoratif ─────────────────────────────────
 *
 * C'est la clé de jointure avec le relevé du prestataire. Sans elle, le solde
 * de `system_clearing:PROVIDER_INBOUND:<RAIL>:<devise>` ne se rapproche de
 * rien : on saurait qu'on a encaissé, jamais si le prestataire l'a confirmé.
 */
module.exports = function buildCagnotteExternalSettlementModel(conn) {
  if (!conn) {
    throw new Error(
      "CagnotteExternalSettlement : connexion Mongoose requise (base transactions)."
    );
  }

  const modelName = "CagnotteExternalSettlement";

  if (conn.models[modelName]) return conn.models[modelName];

  const montantSchema = new mongoose.Schema(
    {
      amount: { type: Number, required: true, min: 0 },
      currency: {
        type: String,
        required: true,
        uppercase: true,
        trim: true,
        maxlength: 4,
      },
    },
    { _id: false }
  );

  const schema = new mongoose.Schema(
    {
      reference: {
        type: String,
        required: true,
        unique: true,
        index: true,
        trim: true,
      },

      idempotencyKey: {
        type: String,
        required: true,
        index: true,
        trim: true,
      },

      /**
       * Rail d'encaissement. Table CLOSE : il désigne le compte de compensation
       * d'entrée (`PROVIDER_INBOUND:<RAIL>`) et donc le relevé auquel ce
       * règlement devra être rapproché. Un rail inventé rendrait le
       * rapprochement impossible sans qu'aucune erreur ne le signale.
       */
      rail: {
        type: String,
        required: true,
        enum: ["mobilemoney", "card"],
        index: true,
      },

      /** Opérateur exact : wave, orange, mtn, moov, visa_direct. */
      provider: {
        type: String,
        required: true,
        lowercase: true,
        trim: true,
        index: true,
      },

      /**
       * Référence côté prestataire — clé de jointure du rapprochement.
       *
       * ⚠️ PAS de `index: true` ici. L'index de ce champ est PARTIEL et déclaré
       * plus bas par `schema.index(...)`. Le déclarer aux deux endroits en
       * produit deux sur la même clé : MongoDB n'en pose qu'un, et l'échec de
       * l'autre est silencieux — d'autant plus qu'`autoIndex` est coupé.
       * Verrouillé par `test/schemaIndexCollisions.test.js`, qui a attrapé
       * cette faute à l'écriture.
       */
      providerReference: {
        type: String,
        default: "",
        trim: true,
      },

      cagnotteId: { type: String, required: true, index: true },
      vaultId: { type: String, default: "", trim: true, index: true },

      /**
       * Ce que le participant a effectivement payé, dans la devise
       * d'encaissement. C'est le montant qui entre par le compte prestataire.
       */
      collected: { type: montantSchema, required: true },

      /** Frais PayNoval prélevés, si prélevés. Peut être dans une autre devise. */
      feeCredit: {
        amount: { type: Number, default: 0, min: 0 },
        currency: { type: String, uppercase: true, trim: true, default: "" },
      },

      /** Ce qui reste pour le coffre : `collected.amount` moins les frais. */
      netToVault: { type: montantSchema, required: true },

      treasuryUserId: { type: String, default: "", trim: true, index: true },
      treasurySystemType: { type: String, default: "", trim: true, index: true },
      treasuryLabel: { type: String, default: "", trim: true },

      status: {
        type: String,
        enum: ["confirmed"],
        default: "confirmed",
        index: true,
      },

      /**
       * ⚠️ AUCUNE DONNÉE PERSONNELLE DU PAYEUR ICI, et surtout aucun corps de
       * rappel brut (règle B.4). Un participant anonyme n'a pas de compte : ce
       * qu'on sait de lui vient du prestataire, et un numéro de téléphone ou un
       * nom porteur de carte n'a rien à faire dans un document de règlement.
       * Ce qui est nécessaire au rapprochement, c'est `providerReference`.
       */
      treasuryWalletAfter: {
        type: mongoose.Schema.Types.Mixed,
        default: null,
      },

      meta: { type: mongoose.Schema.Types.Mixed, default: null },

      /**
       * v2 (2026-09-10) : frais et conversion calculés PAR TX-CORE au
       * règlement — le backend ne transmet plus que ce que le prestataire a
       * encaissé. `netToVault` est libellé dans la devise de la CAGNOTTE.
       */
      schemaVersion: { type: Number, default: 1 },
      netSource: { type: Number, default: null, min: 0 },
      fx: {
        required: { type: Boolean, default: false },
        appliedRate: { type: Number, default: null },
        marketRate: { type: Number, default: null },
        revenue: { type: Number, default: 0, min: 0 },
        provider: { type: String, default: null },
        rateSource: { type: String, default: null },
        asOf: { type: Date, default: null },
      },
      /** Crédit arrivé après la clôture : argent encaissé, jamais refusé. */
      lateCredit: { type: Boolean, default: false },
      /**
       * Cumul remboursé à l'invité (2026-09-15), en devise source et cible.
       * Sert de garde de concurrence : un remboursement ne part que du cumul
       * qu'il a lu, et un versement refusé le rétablit.
       */
      refunded: {
        source: { type: Number, default: 0, min: 0 },
        target: { type: Number, default: 0, min: 0 },
      },
    },
    {
      timestamps: true,
      collection: "tx_cagnotte_external_settlements",
    }
  );

  schema.index({ cagnotteId: 1, createdAt: -1 });
  schema.index({ rail: 1, provider: 1, createdAt: -1 });

  /**
   * Le rapprochement prestataire interroge par référence externe. L'index est
   * partiel : `providerReference` vaut `""` tant que le prestataire n'en a pas
   * fourni, et indexer des milliers de chaînes vides ne sert à rien.
   */
  schema.index(
    { providerReference: 1 },
    {
      partialFilterExpression: {
        providerReference: { $type: "string", $gt: "" },
      },
    }
  );

  return conn.model(modelName, schema);
};
