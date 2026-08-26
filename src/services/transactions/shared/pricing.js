"use strict";

const axios = require("axios");
const createError = require("http-errors");

const runtime = require("./runtime");

const logger = runtime.logger;
const INTERNAL_TOKEN = runtime.INTERNAL_TOKEN;
const GATEWAY_URL = runtime.GATEWAY_URL;
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
  getGatewayBase,
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

async function fetchPricingQuoteFromGateway({ authHeader, pricingInput }) {
  const gatewayBase = getGatewayBase(GATEWAY_URL);
  const url = `${gatewayBase}/pricing/quote`;

  const headers = {
    "Content-Type": "application/json",
    ...(authHeader ? { Authorization: authHeader } : {}),
    ...(INTERNAL_TOKEN ? { "x-internal-token": INTERNAL_TOKEN } : {}),
  };

  logger?.info?.("[TX-CORE][PRICING_CALL]", {
    url,
    hasAuthHeader: !!authHeader,
    hasInternalToken: !!INTERNAL_TOKEN,
    pricingInput,
  });

  try {
    const response = await axios.post(url, pricingInput, {
      headers,
      timeout: 12000,
    });

    const payload = response?.data || {};
    if (payload.ok === false || payload.success === false) {
      throw createError(
        502,
        payload.error || payload.message || "Erreur pricing gateway"
      );
    }

    return payload;
  } catch (err) {
    const status = err?.response?.status;
    const payloadMessage =
      err?.response?.data?.error ||
      err?.response?.data?.message ||
      err?.message ||
      "Erreur pricing gateway";

    logger?.error?.("[TX-CORE][PRICING_CALL][ERROR]", {
      status: status || 502,
      message: payloadMessage,
      responseData: err?.response?.data || null,
    });

    throw createError(
      status && status >= 400 && status < 600 ? status : 502,
      payloadMessage
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

module.exports = {
  pickBodyPricingInput,
  fetchPricingQuoteFromGateway,
  extractPricingBundle,
};