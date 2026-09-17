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
/**
 * Un corridor ne s'enregistre que s'il a la FORME d'un corridor (2026-09-16).
 *
 * `/pricing/quote` est public (le simulateur du site en dépend). Chaque 404
 * écrivait en base, par `upsert`, une clé bâtie sur des champs que le visiteur
 * choisit librement : n'importe qui pouvait faire croître cette collection sans
 * borne, et remplir le bandeau « ce qui refuse faute de tarif » du back-office
 * de corridors qui n'existent pas — noyant les vrais. Un signal d'exploitation
 * qu'un anonyme peut fabriquer n'est plus un signal.
 *
 * On n'enregistre donc que des valeurs d'un vocabulaire fermé : types et
 * méthodes connus, devises ISO à trois lettres, pays ISO à deux lettres,
 * identifiants de prestataire courts. Le reste est ignoré — la réponse 404,
 * elle, reste servie.
 */
const TYPES_CONNUS = new Set(["TRANSFER", "DEPOSIT", "WITHDRAW", "CANCELLATION", "CAGNOTTE_PARTICIPATION", "CAGNOTTE_CLOSURE"]);
const METHODES_CONNUES = new Set(["INTERNAL", "MOBILEMONEY", "CARD"]);

function estCorridorEnregistrable(request = {}) {
  const facultatif = (v, motif) =>
    v === null || v === undefined || String(v).trim() === "" || motif.test(String(v).trim());

  return (
    TYPES_CONNUS.has(String(request.txType ?? "").trim().toUpperCase()) &&
    (String(request.method ?? "").trim() === "" ||
      METHODES_CONNUES.has(String(request.method).trim().toUpperCase())) &&
    /^[A-Z]{3}$/.test(String(request.fromCurrency ?? "").trim().toUpperCase()) &&
    /^[A-Z]{3}$/.test(String(request.toCurrency ?? "").trim().toUpperCase()) &&
    facultatif(request.fromCountry, /^[A-Za-z]{2}$/) &&
    facultatif(request.toCountry, /^[A-Za-z]{2}$/) &&
    facultatif(request.country, /^[A-Za-z]{2}$/) &&
    facultatif(request.provider, /^[a-z0-9_]{1,24}$/i) &&
    facultatif(request.operator, /^[a-z0-9_ -]{1,24}$/i)
  );
}

/** Seuls les champs du corridor sont stockés — jamais l'objet reçu tel quel. */
function champsDuCorridor(request = {}) {
  const out = {};
  for (const k of ["txType", "method", "provider", "operator", "fromCurrency", "toCurrency", "country", "fromCountry", "toCountry"]) {
    out[k] = request[k] ?? null;
  }
  return out;
}

async function recordCoverageGap(request = {}) {
  if (!estCorridorEnregistrable(request)) return;

  request = champsDuCorridor(request);

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

module.exports = { coverageKey, recordCoverageGap, estCorridorEnregistrable, champsDuCorridor };
