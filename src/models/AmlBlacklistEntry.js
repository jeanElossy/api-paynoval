"use strict";

const mongoose = require("mongoose");
const { TYPES } = require("../services/risk/normalizeIdentifiers");

/**
 * ============================================================================
 * LISTE NOIRE EN BASE — ELLE VIVAIT DANS UN FICHIER JSON
 * ============================================================================
 *
 * `src/aml/blacklist.json` était chargé par `require()` **une seule fois, au
 * démarrage du module**. Trois conséquences :
 *
 *   1. inscrire un compte frauduleux exigeait un COMMIT et un DÉPLOIEMENT ;
 *   2. `require` met en cache : réécrire le fichier sur le disque en production
 *      ne changeait rien tant que le processus vivait ;
 *   3. à plusieurs instances, chacune gardait sa propre copie figée à l'instant
 *      de son démarrage — deux instances pouvaient donc répondre différemment
 *      au même virement.
 *
 * Pendant ce temps, la fraude se déplace en minutes.
 *
 * `expiresAt` n'est PAS un index TTL Mongo : on ne veut pas que l'entrée
 * DISPARAISSE. Une inscription qui s'efface toute seule fait perdre la trace de
 * la décision et de son motif — exactement ce qu'un contrôle demandera. Elle
 * devient simplement inactive, et le magasin l'ignore.
 */
const entrySchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: TYPES,
      required: true,
      index: true,
    },

    /**
     * TOUJOURS la valeur NORMALISÉE (voir `normalizeIdentifiers.js`). Inscrire
     * une valeur brute produirait une entrée que le contrôle ne retrouve
     * jamais — et une liste noire qui ne bloque rien ressemble en tout point à
     * une liste noire vide.
     */
    value: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },

    /** Ce que le contrôle demandera en premier. Obligatoire, donc. */
    reason: {
      type: String,
      required: true,
      trim: true,
      maxlength: 500,
    },

    addedBy: { type: String, default: null, trim: true },
    active: { type: Boolean, default: true, index: true },
    expiresAt: { type: Date, default: null },

    metadata: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  {
    timestamps: true,
    versionKey: false,
    collection: "aml_blacklist_entries",
  }
);

/**
 * Une valeur ne s'inscrit qu'une fois par type. Sans cette contrainte, deux
 * opérateurs inscrivant le même compte créeraient deux entrées, et lever la
 * première laisserait le blocage actif sans que personne comprenne pourquoi.
 */
entrySchema.index({ type: 1, value: 1 }, { unique: true, name: "aml_blacklist_type_value" });

/** Le chargement du magasin ne lit que les entrées actives. */
entrySchema.index({ active: 1, type: 1 });

module.exports = (conn = mongoose) =>
  conn.models.AmlBlacklistEntry ||
  conn.model("AmlBlacklistEntry", entrySchema);
