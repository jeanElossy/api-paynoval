"use strict";

const createError = require("http-errors");

const runtime = require("./runtime");

const logger = runtime.logger;
/*
 * `axios`, `INTERNAL_TOKEN`, `GATEWAY_URL` et `getGatewayBase` ne sont plus
 * importés : ce module ne parle plus à la passerelle. Le devis se calcule dans
 * le processus depuis le 2026-09-10 — c'est la disparition de ces quatre
 * symboles qui MESURE le correctif. Tant qu'ils étaient là, l'inversion de
 * dépendance pouvait revenir en une ligne.
 */
const normalizePricingSnapshot = runtime.normalizePricingSnapshot;
const buildTreasuryRevenueBreakdown = runtime.buildTreasuryRevenueBreakdown;

if (typeof buildTreasuryRevenueBreakdown !== "function") {
  throw new Error(
    "Aucun helper de breakdown treasury disponible dans runtime"
  );
}

const {
  toFloat,
  roundMoney,
  normalizeTxTypeValue,
  inferMethodValue,
  pickCurrency,
} = require("./helpers");

const { validatePricingQuote } = require("./pricingValidation");

function pickBodyPricingInput(reqBody = {}) {
  const amount = toFloat(reqBody.amount ?? reqBody.amountSource, 0);

  const fromCurrency = pickCurrency(
    reqBody.senderCurrencyCode,
    reqBody.currencySource,
    reqBody.currencyCode,
    reqBody.fromCurrency,
    reqBody.senderCurrencySymbol,
    reqBody.currency
  );

  const toCurrency =
    pickCurrency(
      reqBody.localCurrencyCode,
      reqBody.currencyTarget,
      reqBody.toCurrency,
      reqBody.localCurrencySymbol,
      reqBody.receiverCurrency,
      reqBody.destinationCurrency
    ) || fromCurrency;

  const txTypeRaw =
    reqBody.txType ||
    (String(reqBody.action || "").toLowerCase() === "deposit"
      ? "DEPOSIT"
      : String(reqBody.action || "").toLowerCase() === "withdraw"
      ? "WITHDRAW"
      : "TRANSFER");

  return {
    txType: normalizeTxTypeValue(txTypeRaw),
    method: inferMethodValue(reqBody),
    amount,
    fromCurrency,
    toCurrency,
    country: reqBody.country || null,
    fromCountry: reqBody.fromCountry || reqBody.country || null,
    toCountry:
      reqBody.toCountry ||
      reqBody.destinationCountry ||
      reqBody.country ||
      null,
    provider: String(reqBody.provider || "paynoval").toLowerCase(),
    operator: reqBody.operator || null,
  };
}

/**
 * ============================================================================
 * LE DEVIS EST UN APPEL DE FONCTION, PLUS UN APPEL RÉSEAU
 * ============================================================================
 *
 * ── Ce que cette fonction faisait ───────────────────────────────────────────
 *
 * Elle postait sur `${GATEWAY_URL}/pricing/quote` — c'est-à-dire que **le
 * moteur d'argent appelait le bord** :
 *
 *     Mobile ──► Gateway ──► Tx-Core ──► Gateway ──► base tarification
 *                                          ▲
 *                                  dépendance qui REMONTE
 *
 * Quatre conséquences, toutes constatées :
 *
 *   1. une panne de la passerelle arrêtait les virements DEPUIS L'INTÉRIEUR du
 *      moteur — ce service l'annonçait lui-même au démarrage : « GATEWAY_URL
 *      absente ⇒ toute transaction nécessitant un devis échouera en 503 » ;
 *   2. la passerelle ne pouvait plus être redéployée ni redémarrée seule ;
 *   3. un saut réseau de 12 s de délai maximal était posé au milieu du chemin
 *      de l'argent, pour une lecture ;
 *   4. la base de tarification vivait sur la surface la plus exposée
 *      d'Internet.
 *
 * ── Ce qui la remplace ──────────────────────────────────────────────────────
 *
 * Le domaine des prix appartient désormais à Tx-Core
 * (`services/pricing/`, base `MONGO_URI_PRICING`). Le devis se calcule dans le
 * processus. Plus de réseau, plus de jeton à porter, plus de délai d'attente,
 * et plus d'inversion de dépendance : bord → services → moteur, jamais
 * l'inverse — la règle que tiennent Stripe, PayPal et Adyen.
 *
 * ── Ce qui NE change pas, et c'est important ────────────────────────────────
 *
 * Le contrat de retour, et surtout `extractPricingBundle`, qui
 * VALIDE le devis avant de s'en servir. Un devis calculé sur place n'est pas
 * plus digne de confiance qu'un devis reçu par le réseau : un barème absent ou
 * un taux indisponible doivent toujours arrêter l'opération, jamais produire un
 * prix de zéro (règle B.2).
 *
 * ── Le nom, corrigé le 2026-09-10 ──────────────────────────────────────────
 *
 * Elle s'est appelée `fetchPricingQuoteFromGateway` jusqu'à cette date, bien
 * après avoir cessé d'appeler quoi que ce soit. Ce nom a réellement induit en
 * erreur : à sa lecture, on conclut que le moteur appelle le bord sur le
 * chemin de l'argent — un défaut d'architecture majeur, qui n'existe pas.
 *
 * Un nom périmé ne se contente pas d'être inexact : il fait porter à celui qui
 * le lit une conclusion fausse, avec assurance.
 *
 * `authHeader` a disparu de la signature dans le même mouvement. Le paramètre
 * était accepté et ignoré ; les deux appelants continuent d'exiger un jeton
 * `Bearer` avant d'appeler — cette vérification-là n'a pas bougé.
 */
async function computePricingQuote({ pricingInput }) {
  const {
    buildRequest,
    validateRequest,
    computeFullQuote,
    buildQuoteResponsePayload,
  } = require("../../pricing/quoteService");

  try {
    const request = buildRequest(pricingInput || {});
    const erreurDeForme = validateRequest(request);

    if (erreurDeForme) {
      throw createError(400, erreurDeForme);
    }

    const devis = await computeFullQuote({
      request,
      requestId: String(pricingInput?.requestId || ""),
    });

    /**
     * On rend la MÊME forme que l'ancienne réponse HTTP. `extractPricingBundle`
     * en aval lit `request`, `result`, `ruleApplied`, `fxRuleApplied` et
     * `debug` : changer la forme ici aurait obligé à toucher la validation dans
     * le même mouvement, et une correction d'architecture ne se mêle pas à une
     * correction de contrat.
     */
    return buildQuoteResponsePayload({ quote: devis });
  } catch (err) {
    /**
     * Les erreurs du service de devis portent déjà un `status` (404 corridor
     * non couvert, 503 taux indisponible). On le préserve : le remplacer par un
     * 502 générique ferait perdre l'information qui permet à l'appelant de
     * distinguer « ce corridor n'est pas tarifé » de « le service de change est
     * en panne ».
     */
    const status =
      err?.status || err?.statusCode || (err?.expose ? err.status : null);

    logger?.error?.("[TX-CORE][PRICING][ERREUR]", {
      status: status || 502,
      message: err?.message,
      pricingInput,
    });

    throw createError(
      status && status >= 400 && status < 600 ? status : 502,
      err?.message || "Calcul de tarification impossible"
    );
  }
}

function extractPricingBundle(pricingPayload, pricingInput = {}) {
  const pricingSnapshot = normalizePricingSnapshot({
    request: pricingPayload?.request || pricingInput || {},
    result: pricingPayload?.result || {},
    ruleApplied: pricingPayload?.ruleApplied || null,
    fxRuleApplied: pricingPayload?.fxRuleApplied || null,
    debug: pricingPayload?.debug || null,
  });

  /**
   * ⚠️ ON VALIDE LE DEVIS AVANT DE S'EN SERVIR — ON NE COMBLE PLUS SES TROUS.
   *
   * Chaque champ était auparavant lu avec une valeur de repli silencieuse :
   * frais à 0, montant reçu à 0, taux à 0, et devise repliée en dur sur « CAD ».
   * Une réponse incomplète ne produisait donc pas une erreur, elle produisait un
   * virement — sans frais, ou dans une monnaie que personne n'avait demandée.
   *
   * Un devis qu'on ne sait pas lire n'est pas un devis à zéro : c'est une
   * absence de devis. Le raisonnement complet est en tête de
   * `pricingValidation.js`.
   */
  const controle = validatePricingQuote(
    { request: pricingSnapshot?.request, result: pricingSnapshot?.result },
    pricingInput
  );

  if (!controle.ok) {
    logger?.error?.("[TX-CORE][PRICING_QUOTE][INVALIDE]", {
      errors: controle.errors,
      pricingInput,
    });

    /**
     * 502 et non 400 : la requête de l'utilisateur est valide, c'est la réponse
     * du service de tarification qui ne l'est pas. Même code que lorsque la
     * passerelle est injoignable — dans les deux cas, nous n'avons pas de prix.
     */
    throw createError(
      502,
      `Devis de tarification inexploitable : ${controle.errors.join(" ; ")}`
    );
  }

  const { fromCurrency, toCurrency } = controle.values;

  const fee = roundMoney(controle.values.fee, fromCurrency);
  const grossFrom = roundMoney(controle.values.grossFrom, fromCurrency);
  const netFrom = roundMoney(controle.values.netFrom, fromCurrency);
  const netTo = roundMoney(controle.values.netTo, toCurrency);

  // Un taux n'est pas un montant : `round2` écrasait à 0,00 tout corridor dont
  // le taux est inférieur à 0,01 — XOF → EUR vaut ~0,001524. Les montants,
  // eux, restent arrondis à la devise via `roundMoney`.
  const appliedRate = controle.values.appliedRate;

  /**
   * `marketRate` reste tolérant, et c'est délibéré : quand une règle impose un
   * taux (`fx.overrideRate`), il n'existe aucun taux de marché à citer et la
   * passerelle renvoie `null`. L'exiger casserait tous les corridors à taux
   * imposé. Il ne sert qu'au calcul de la marge de change, jamais au montant
   * remis au bénéficiaire.
   */
  const marketRate = toFloat(pricingSnapshot?.result?.marketRate, 0);

  const treasuryRevenue = buildTreasuryRevenueBreakdown(pricingSnapshot);

  return {
    pricingSnapshot,
    grossFrom,
    fee,
    netFrom,
    netTo,
    appliedRate,
    marketRate,
    treasuryRevenue,
  };
}

/**
 * ============================================================================
 * LE PRIX APPLIQUÉ VIENT DU DEVIS ACCEPTÉ, PAS D'UN NOUVEAU CALCUL
 * ============================================================================
 *
 * Point d'entrée UNIQUE des chemins d'initiation depuis le 2026-09-16. Avant
 * lui, chaque handler appelait `computePricingQuote()` directement : le prix
 * montré à l'utilisateur et le prix écrit au grand livre étaient deux calculs
 * distincts, séparés par le temps de réflexion de l'utilisateur. Rien ne
 * comparait les deux.
 *
 * Trois situations, trois réponses :
 *
 *   · un `quoteId` est fourni  → on CONSOMME le devis, et on écrit SES montants
 *   · aucun devis, exigence active (`PRICING_QUOTE_REQUIRED=true`) → 400
 *   · aucun devis, exigence souple → on calcule, et on le JOURNALISE
 *
 * La troisième branche est une TRANSITION, pas un mode de fonctionnement : elle
 * existe le temps que le parc mobile installé envoie tous un devis. Elle se
 * ferme par variable d'environnement, sans redéploiement — même motif que
 * `IDEMPOTENCY_REQUIRED`. Ce qu'elle ne fait pas : se taire.
 */
async function resolvePricingPayload({
  pricingInput,
  quoteId,
  userId,
  reference,
  idempotencyKey,
  contexte = "",
}) {
  const {
    buildRequest,
    validateRequest,
    consumeQuote,
    buildPayloadFromQuote,
  } = require("../../pricing/quoteService");

  const { devisEstExige } = require("../../pricing/quoteConsumption");

  const identifiantDevis = String(quoteId || "").trim();

  if (identifiantDevis) {
    /**
     * La demande est normalisée EXACTEMENT comme elle l'a été à l'émission du
     * devis — sinon « CI » et « Côte d'Ivoire » désigneraient deux corridors
     * différents et tout devis serait refusé pour divergence.
     */
    const request = buildRequest(pricingInput || {});
    const erreurDeForme = validateRequest(request);

    if (erreurDeForme) {
      throw createError(400, erreurDeForme);
    }

    const devis = await consumeQuote({
      quoteId: identifiantDevis,
      userId,
      request,
      reference,
      idempotencyKey,
    });

    logger?.info?.("[TX-CORE][PRICING][DEVIS_CONSOMMÉ]", {
      quoteId: identifiantDevis,
      contexte,
      reference: reference || null,
    });

    return buildPayloadFromQuote(devis);
  }

  if (devisEstExige()) {
    throw createError(
      400,
      "Un devis est exigé pour initier une transaction. Demandez un prix, " +
        "puis initiez avec son identifiant.",
      { code: "QUOTE_REQUIRED" }
    );
  }

  /**
   * ⚠️ On ne se tait pas (règle B.1). Cette ligne est la seule façon de savoir
   * quand `PRICING_QUOTE_REQUIRED=true` deviendra sans risque : tant qu'elle
   * apparaît, des clients initient encore sans devis, et pour ceux-là le prix
   * affiché n'engage PayNoval à rien.
   */
  logger?.warn?.("[TX-CORE][PRICING][SANS_DEVIS]", {
    contexte,
    userId: userId || null,
    raison:
      "initiation sans devis — le prix est recalculé, il peut différer de " +
      "celui qui a été affiché à l'utilisateur",
  });

  return computePricingQuote({ pricingInput });
}

module.exports = {
  pickBodyPricingInput,
  computePricingQuote,
  resolvePricingPayload,
  extractPricingBundle,
};