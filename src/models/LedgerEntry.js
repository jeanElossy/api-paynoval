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
  // ⚠️ Mouvement entre deux comptes système (entrée prestataire → coffre de
  // cagnotte). `ledgerService` l'écrivait depuis le 2026-09-10 sans qu'il
  // figure ici : la validation du modèle refusait donc CHAQUE règlement de
  // participation par lien public — le chemin était structurellement mort.
  "SYSTEM_TRANSFER",
  // Conversion de devise d'une participation de cagnotte : le lot en devise
  // cible, qui vide la position de change vers le coffre.
  "FX_CONVERSION",
  // REPRISE DE SOLDE (2026-09-22). Un solde qui existait AVANT que le grand
  // livre ne le suive — comptes internes hérités d'une base antérieure — est
  // porté par une écriture d'ouverture, en contrepartie de
  // `system_clearing:OPENING_BALANCE:<DEVISE>`. C'est ce que fait toute reprise
  // comptable : on n'invente pas l'historique, on déclare le point de départ,
  // daté et motivé, et il reste annulable par contre-écriture.
  "OPENING_BALANCE",
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
 * ⚠️ CE COMMENTAIRE A ÉTÉ CORRIGÉ LE 2026-08-28 : il affirmait « `autoIndex`
 * n'est pas désactivé sur cette connexion ». **C'est faux depuis
 * `config/db.js:47`**, qui l'a coupé pour toutes les connexions du service.
 * La raison invoquée avait donc cessé d'être vraie ; la DÉCISION, elle, reste
 * bonne, et c'est pour ça qu'on la réécrit au lieu de l'effacer.
 *
 * La vraie raison aujourd'hui : cet index vit avec les trois autres index hors
 * schéma de `ledgerentries` dans un script qu'on lance **quand on le décide**,
 * en heure creuse, en suivant la construction. C'est la politique générale du
 * service depuis que `autoIndex` est coupé — mais elle vaut **doublement** pour
 * un index UNIQUE : si sa construction échoue, elle échoue en silence sur un
 * événement de connexion que personne ne lit, et le schéma affiche alors une
 * garantie que la base ne porte pas.
 *
 * ⚠️ Il ne se pose PAS par `npm run indexes:apply` — qui ne couvre que les index
 * déclarés aux schémas — mais par **`npm run indexes:ledger`**. Constaté le
 * 2026-08-28 : sur une base neuve, `ledgerentries` portait 11 index sur 15 et
 * l'unicité du grand livre était absente. Voir `BENCHMARKS.md` §8.2.
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
 * ── Ce qui est réellement couvert — MESURÉ le 2026-09-03 ──────────────────
 *
 * Ce paragraphe affirmait que « ces gardes ne couvrent pas
 * `updateOne`/`updateMany` appelés sur le modèle — Mongoose ne peut pas les
 * intercepter de façon fiable ». **C'était inexact dans les deux sens**, et
 * cette inexactitude a coûté cher : on croyait ouverte une porte fermée, et
 * fatal un trou qui se bouchait en un mot.
 *
 * Vérifié opération par opération sur le `mongoose@7.8.12` installé :
 *
 *   COUVERT : save (document existant), updateOne, updateMany, replaceOne,
 *             findOneAndUpdate, findOneAndReplace, deleteOne (document ET
 *             requête), deleteMany, findOneAndDelete.
 *
 *   NON COUVERT, et hors de portée d'une garde applicative : `bulkWrite`, le
 *             pilote natif (`Model.collection.*`) et le shell Mongo.
 *
 * `updateMany` et `findOneAndReplace` ont été AJOUTÉS ce jour-là — ils
 * manquaient simplement de la liste. Et `deleteOne` est passé en
 * `{ document: true, query: true }` : `doc.deleteOne()` filait au travers,
 * alors que `doc.remove()` ayant disparu en Mongoose 7, c'est LE geste
 * idiomatique de suppression.
 *
 * `test/ledgerImmutability.test.js` exerce les dix opérations et échoue si
 * l'une d'elles redevient possible.
 *
 * Le filet pour ce qui reste hors de portée est la balance de vérification
 * (`services/ledger/doubleEntry.js`) — qui, depuis le 2026-09-03, SIGNALE ce
 * qu'elle ne sait pas lire au lieu de le compter pour zéro.
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

/**
 * ⚠️ `updateMany` et `findOneAndReplace` ont été AJOUTÉS le 2026-09-03.
 *
 * Mesuré sur le `mongoose@7.8.12` installé, opération par opération : les deux
 * filaient jusqu'à la couche base sans qu'aucun hook ne les intercepte.
 * `findOneAndReplace` est la plus destructrice de toutes — elle remplace le
 * document ENTIER.
 *
 * Le commentaire ci-dessus affirmait que Mongoose « ne peut pas intercepter de
 * façon fiable » les mises à jour au niveau modèle. C'était inexact dans les
 * DEUX sens, et cette inexactitude coûtait cher :
 *
 *   • `updateOne` EST intercepté — mesuré. On croyait ouverte une porte fermée.
 *   • `updateMany` ne l'était pas, non par incapacité de l'outil mais parce
 *     qu'il ne figurait pas dans cette liste. Mongoose 7 le documente lui-même
 *     (`node_modules/mongoose/lib/model.js`) : « updateMany will _not_ fire
 *     update middleware. Use `pre('updateMany')` instead. » Un trou présenté
 *     comme fatal se fermait en un mot.
 *
 * Un défaut décrit comme inévitable ne se corrige jamais. C'est le vrai coût
 * d'une limite mal cadrée.
 *
 * Ce qui reste réellement hors de portée — et le restera : `bulkWrite`, le
 * pilote natif (`Model.collection.*`) et le shell Mongo. Le filet pour ceux-là
 * est la balance de vérification (`services/ledger/doubleEntry.js`).
 */
for (const op of [
  "updateOne",
  "updateMany",
  "findOneAndUpdate",
  "replaceOne",
  "findOneAndReplace",
]) {
  ledgerEntrySchema.pre(op, function (next) {
    return refuseMutation(next);
  });
}

/**
 * La SUPPRESSION est refusée pour la même raison, et elle est pire : une
 * modification laisse au moins une trace dans `updatedAt`, une suppression ne
 * laisse rien du tout.
 */
function refuseSuppression(next) {
  const err = new Error(
    "Une écriture du grand livre ne se SUPPRIME pas. Utiliser une " +
      "contre-écriture."
  );
  err.code = "LEDGER_ENTRY_IMMUTABLE";
  err.status = 500;
  return next(err);
}

/**
 * ⚠️ `deleteOne` est enregistré en `{ document: true, query: true }` depuis le
 * 2026-09-03.
 *
 * Par défaut, Mongoose 7 enregistre `pre("deleteOne")` comme middleware de
 * REQUÊTE. `Model.deleteOne({...})` était donc bien refusé — mais
 * `doc.deleteOne()`, sur un document déjà chargé, passait au travers. Mesuré.
 *
 * Or `doc.remove()` a disparu en Mongoose 7 : `doc.deleteOne()` EST le geste
 * idiomatique de suppression. Autrement dit, le chemin le plus probable était
 * précisément celui qui n'était pas gardé, sur l'objet dont l'immutabilité est
 * l'invariant 4.
 *
 * `deleteMany` et `findOneAndDelete` n'existent qu'au niveau requête : les
 * enregistrer en document serait sans objet.
 */
ledgerEntrySchema.pre(
  "deleteOne",
  { document: true, query: true },
  function (next) {
    return refuseSuppression(next);
  }
);

for (const op of ["deleteMany", "findOneAndDelete"]) {
  ledgerEntrySchema.pre(op, function (next) {
    return refuseSuppression(next);
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