"use strict";

/**
 * ============================================================================
 * REGISTRE DE DÉDOUBLONNAGE — CE QUI REND « AU MOINS UNE FOIS » VIVABLE
 * ============================================================================
 *
 * ── À quoi ça sert ──────────────────────────────────────────────────────────
 *
 * Le bus livre au moins une fois : un redéploiement, une réclamation de message
 * abandonné ou un rejeu du relais font arriver deux fois le même événement. Ce
 * registre répond à « ce groupe a-t-il déjà traité cet événement ? ».
 *
 * ── Pourquoi la clé est `{ group, eventId }` et non `eventId` seul ──────────
 *
 * Chaque groupe de consommateurs traite le MÊME événement pour son propre
 * compte : la surveillance de conformité et le calcul des primes de parrainage
 * lisent tous deux `transaction.confirmed.v1`. Dédoublonner sur `eventId` seul
 * ferait que le premier groupe à traiter empêcherait tous les autres — un
 * défaut qui ne se manifesterait qu'en ajoutant le second consommateur, donc
 * longtemps après avoir écrit le code.
 *
 * ── Pourquoi l'unicité est une CONTRAINTE, pas une vérification ─────────────
 *
 * Deux instances du même groupe peuvent traiter en parallèle un message
 * réclamé au même moment. Un « lire puis écrire » laisse une fenêtre entre les
 * deux. L'index unique la referme : la seconde écriture lève un E11000, et le
 * consommateur sait qu'il a perdu la course — sans verrou et sans coordination.
 *
 * ⚠️ `autoIndex` est coupé sur ce service (`config/db.js`). Cet index doit donc
 * être créé par `scripts/ensure-*-indexes.js` : sans lui, le dédoublonnage
 * repose sur la seule lecture préalable, et la fenêtre de concurrence est
 * ROUVERTE — silencieusement. Vérifié au démarrage par `checkCriticalIndexes`.
 *
 * ── Rétention ───────────────────────────────────────────────────────────────
 *
 * 30 jours. Au-delà, l'entrée du flux Redis a été taillée depuis longtemps : un
 * doublon ne peut plus arriver, et garder la trace ne protège plus de rien.
 */

const mongoose = require("mongoose");

const processedEventSchema = new mongoose.Schema(
  {
    group: { type: String, required: true, trim: true },
    eventId: { type: String, required: true, trim: true },
    eventName: { type: String, trim: true, default: "" },

    processedAt: { type: Date, required: true, default: Date.now },

    /**
     * Résultat, pour l'instruction d'un dossier : un événement « traité sans
     * effet » et un événement « ayant ouvert un cas » ne se relisent pas de la
     * même façon.
     */
    outcome: { type: String, trim: true, default: "" },
  },
  { collection: "processed_events", timestamps: false }
);

processedEventSchema.index(
  { group: 1, eventId: 1 },
  { unique: true, name: "uniq_processed_event" }
);

processedEventSchema.index(
  { processedAt: 1 },
  { name: "processed_events_ttl", expireAfterSeconds: 30 * 24 * 60 * 60 }
);

module.exports = (conn = mongoose) =>
  conn.models.ProcessedEvent || conn.model("ProcessedEvent", processedEventSchema);
