"use strict";

/**
 * ============================================================================
 * CORRIDORS NON COUVERTS PAR UN BARÈME — DÉPLACÉ DEPUIS L'API GATEWAY LE 2026-09-10
 * ============================================================================
 *
 * ── Pourquoi ce fichier a changé de dépôt ───────────────────────────────────
 *
 * Le domaine des prix vivait dans la passerelle, et Tx-Core — le moteur
 * d'argent — lui demandait ses devis EN HTTP
 * (`services/transactions/shared/pricing.js` → GATEWAY_URL + /pricing/quote).
 *
 * La dépendance remontait donc du cœur vers le bord. Tx-Core l'annonçait
 * lui-même au démarrage : « GATEWAY_URL absente ⇒ toute transaction nécessitant
 * un devis échouera en 503 ». Une panne de la passerelle arrêtait les virements
 * **depuis l'intérieur du moteur**, et la passerelle ne pouvait plus être
 * déployée ni redémarrée seule.
 *
 * Stripe, PayPal et Adyen tiennent la même règle : les dépendances DESCENDENT.
 * Le bord route et authentifie ; il ne possède aucun domaine et ne détient
 * aucune base. Le devis est désormais un appel de fonction dans le processus
 * qui en a besoin.
 *
 * ── Résolution PARESSEUSE du modèle ─────────────────────────────────────────
 *
 * Le fichier d'origine faisait son `require` de modèle au chargement, ce qui
 * fonctionnait parce que la passerelle liait ses modèles à la connexion
 * Mongoose GLOBALE, déjà ouverte. Tx-Core ouvre des connexions NOMMÉES, et
 * aucune n'existe au moment où ce module est requis.
 *
 * Le modèle est donc résolu à l'APPEL, par `getPricingModel`, qui LÈVE une
 * erreur nommée si la base n'est pas là. Un `require` au chargement aurait
 * échoué au démarrage ; un accès optionnel aurait rendu `undefined`, puis un
 * devis vide, puis un prix de zéro (règle B.2).
 */
/**
 * ENREGISTREMENT DES CORRIDORS NON COUVERTS
 * -----------------------------------------------------------------------------
 * `recordCoverageGap` ne doit JAMAIS faire échouer un devis : elle est appelée
 * hors du chemin de réponse et absorbe ses propres erreurs. Un incident de
 * journalisation ne peut pas empêcher un client d'obtenir un prix.
 */

const { getPricingModel } = require("../../config/db");

/** Résolu à l'appel : la connexion n'existe pas au chargement du module. */
const modeleCoverageGap = () => getPricingModel("PricingCoverageGap");

const norm = (v, fallback = "ALL") => {
  const s = String(v ?? "").trim().toUpperCase();
  return s || fallback;
};

/**
 * Clé stable d'un périmètre. Le MONTANT n'y entre pas : ce qui manque est le
 * corridor, pas une tranche de montant.
 *
 * @returns {string}
 */
function coverageKey(request = {}) {
  return [
    norm(request.txType),
    norm(request.method),
    norm(request.provider),
    norm(request.fromCurrency),
    norm(request.toCurrency),
    norm(request.fromCountry),
    norm(request.toCountry),
  ].join("|");
}

/**
 * Consigne un échec de matching. Ne lève jamais.
 * @returns {Promise<void>}
 */
async function recordCoverageGap(request = {}) {
  try {
    const key = coverageKey(request);
    const now = new Date();

    await modeleCoverageGap().updateOne(
      { key },
      {
        $set: { request, lastSeenAt: now, resolvedAt: null },
        $setOnInsert: { firstSeenAt: now },
        $inc: { occurrences: 1 },
      },
      { upsert: true }
    );
  } catch (err) {
    // Volontairement silencieux : voir l'en-tête du fichier.
    console.warn(
      "[pricing] échec d'enregistrement d'un corridor non couvert :",
      err?.message
    );
  }
}

module.exports = { coverageKey, recordCoverageGap };
