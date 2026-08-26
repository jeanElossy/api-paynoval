"use strict";

const mongoose = require("mongoose");

function normCurrency(v) {
  return String(v || "").trim().toUpperCase();
}

const ACCOUNT_TYPES = [
  "USER_WALLET",
  "TREASURY",
  "SYSTEM_CLEARING",
  "SYSTEM_RESERVE",
];

const ENTRY_TYPES = [
  "RESERVE",
  "RESERVE_RELEASE",
  "RESERVE_CAPTURE",
  "USER_DEBIT",
  "USER_CREDIT",
  "FEE_REVENUE",
  "FX_REVENUE",
  "REFUND",
  "REVERSAL",
  "ADJUSTMENT",
  // Bonus de parrainage payé depuis REFERRAL_TREASURY. Type dédié plutôt
  // qu'`ADJUSTMENT` : c'est une dépense récurrente et prévue, qu'on doit
  // pouvoir isoler dans l'analytique de trésorerie.
  "REFERRAL_PAYOUT",
];

const ledgerEntrySchema = new mongoose.Schema(
  {
    transactionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Transaction",
      required: true,
      index: true,
    },

    reference: {
      type: String,
      default: null,
      trim: true,
      index: true,
    },

    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },

    accountType: {
      type: String,
      enum: ACCOUNT_TYPES,
      required: true,
      index: true,
    },

    accountId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },

    direction: {
      type: String,
      enum: ["DEBIT", "CREDIT"],
      required: true,
      index: true,
    },

    entryType: {
      type: String,
      enum: ENTRY_TYPES,
      required: true,
      index: true,
    },

    amount: {
      type: mongoose.Schema.Types.Decimal128,
      required: true,
    },

    currency: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      maxlength: 6,
      index: true,
    },

    status: {
      type: String,
      enum: ["PENDING", "POSTED", "REVERSED"],
      default: "POSTED",
      index: true,
    },

    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },

    /**
     * Clé de déduplication — voir `services/ledger/doubleEntry.js`.
     *
     * `default: undefined` est ESSENTIEL : avec `default: null`, Mongoose
     * écrirait le champ sur toutes les écritures qui n'en ont pas, et l'index
     * partiel ci-dessous — comme tout index unique — traiterait ces `null`
     * comme une valeur. La première écriture sans portée passerait, la seconde
     * serait refusée. Le champ doit être ABSENT, pas vide.
     */
    dedupKey: {
      type: String,
      default: undefined,
      trim: true,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

ledgerEntrySchema.index(
  {
    transactionId: 1,
    accountId: 1,
    entryType: 1,
    direction: 1,
    currency: 1,
  },
  { unique: false }
);

/**
 * ============================================================================
 * L'INDEX UNIQUE DE DÉDUPLICATION N'EST PAS DÉCLARÉ ICI — C'EST VOULU
 * ============================================================================
 *
 * Il vit dans `scripts/ensure-ledger-indexes.js`, sous le nom
 * `dedupKey_unique_partial`, et se crée à la main.
 *
 * `autoIndex` n'est pas désactivé sur cette connexion : déclarer l'index au
 * schéma le ferait construire au prochain démarrage, sur la première instance
 * qui démarre, sans qu'on choisisse ni le moment ni la machine. C'est la
 * politique déjà retenue pour les quatre autres index de `ledgerentries`, et
 * elle vaut doublement pour un index UNIQUE : si sa construction échoue, elle
 * échoue en silence sur un événement de connexion que personne ne lit — et le
 * schéma affiche alors une garantie que la base ne porte pas.
 *
 * ⚠️ ORDRE DE MISE EN SERVICE. Créer l'index AVANT (ou avec) le déploiement qui
 * commence à écrire `dedupKey`. Dans l'autre sens, un doublon écrit entre les
 * deux ferait échouer la construction — et la protection resterait absente
 * précisément parce qu'elle a déjà été prise en défaut.
 */

ledgerEntrySchema.pre("validate", function (next) {
  this.currency = normCurrency(this.currency);
  next();
});

/**
 * ============================================================================
 * IMMUABILITÉ — UNE ÉCRITURE PASSÉE NE SE MODIFIE PAS
 * ============================================================================
 *
 * Rien n'empêchait un `findOneAndUpdate` sur une écriture déjà enregistrée. Le
 * grand livre est pourtant la SOURCE DE VÉRITÉ financière : une ligne modifiée
 * après coup rend tout l'historique invérifiable, et la modification ne laisse
 * aucune trace.
 *
 * La règle comptable est universelle et ne souffre pas d'exception : pour
 * corriger, on écrit une CONTRE-ÉCRITURE (`REVERSAL`, `ADJUSTMENT`,
 * `REFUND`) — jamais on ne réécrit l'originale. Les primitives correspondantes
 * existent déjà dans `ledgerService.js`.
 *
 * ⚠️ CES GARDES NE COUVRENT PAS `updateOne`/`updateMany` APPELÉS SUR LE MODÈLE
 * avec un filtre ne portant pas sur un document chargé — Mongoose ne peut pas
 * les intercepter de façon fiable. Elles ferment le chemin ORDINAIRE (charger,
 * muter, sauvegarder), qui est celui par lequel la faute arrive réellement.
 * Un contournement délibéré reste possible ; c'est le propre d'une garde
 * applicative, et c'est pourquoi elle est doublée par la balance de
 * vérification (`services/ledger/doubleEntry.js`).
 */
function refuseMutation(next) {
  const err = new Error(
    "Une écriture du grand livre est IMMUABLE. Pour corriger, écrire une " +
      "contre-écriture (REVERSAL / ADJUSTMENT / REFUND) — jamais modifier " +
      "l'originale."
  );
  err.code = "LEDGER_ENTRY_IMMUTABLE";
  err.status = 500;
  return next(err);
}

ledgerEntrySchema.pre("save", function (next) {
  // `isNew` distingue la création — seule écriture autorisée — de la mutation.
  if (this.isNew) return next();
  return refuseMutation(next);
});

for (const op of ["updateOne", "findOneAndUpdate", "replaceOne"]) {
  ledgerEntrySchema.pre(op, function (next) {
    return refuseMutation(next);
  });
}

/**
 * La SUPPRESSION est refusée pour la même raison, et elle est pire : une
 * modification laisse au moins une trace dans `updatedAt`, une suppression ne
 * laisse rien du tout.
 */
for (const op of ["deleteOne", "deleteMany", "findOneAndDelete"]) {
  ledgerEntrySchema.pre(op, function (next) {
    const err = new Error(
      "Une écriture du grand livre ne se SUPPRIME pas. Utiliser une " +
        "contre-écriture."
    );
    err.code = "LEDGER_ENTRY_IMMUTABLE";
    err.status = 500;
    return next(err);
  });
}

ledgerEntrySchema.set("toJSON", {
  transform(_doc, ret) {
    ret.id = ret._id;
    ret.amount = Number(ret.amount?.toString?.() || 0);
    delete ret._id;
    return ret;
  },
});

module.exports = (conn = mongoose) =>
  conn.models.LedgerEntry || conn.model("LedgerEntry", ledgerEntrySchema);