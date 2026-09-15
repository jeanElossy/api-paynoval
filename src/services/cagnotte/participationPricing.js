"use strict";

/**
 * ============================================================================
 * PRIX D'UNE PARTICIPATION DE CAGNOTTE — TX-CORE EST SEUL À LE CALCULER
 * ============================================================================
 *
 * ── Le défaut que ce module ferme (R-14, 2026-09-10) ────────────────────────
 *
 * Le backend lisait dans le corps de la requête le montant débité
 * (`amountViewer`), la devise débitée (`viewerCurrencyCode`) ET le montant
 * crédité au coffre (`amount`). Le « taux » était leur quotient, fourni par le
 * client. Un appel direct à l'API — 1 CAD débité, 9 900 000 XOF crédités —
 * créait de la monnaie, retirable après clôture.
 *
 * Désormais : la devise source est lue sur le compte, la devise cible sur la
 * position du coffre, et montant, frais, taux et marge sortent du moteur de
 * tarification (`PricingRule`) — le même que les virements. Aucun appelant ne
 * fournit un taux ni un montant crédité.
 *
 * ── Deux parties ────────────────────────────────────────────────────────────
 *
 * `normalizeParticipationQuote` est PURE : elle vérifie les invariants du
 * devis rendu par le moteur (brut − frais = net ; même devise ⇒ aucun taux) et
 * lève sur toute incohérence. `computeCagnottePricing` l'alimente, avec des
 * dépendances injectables pour les tests.
 */

const { roundMoney, decimalsForCurrency } = require("../pricing/pricingEngine");

const TX_TYPES = Object.freeze({
  PARTICIPATION: "CAGNOTTE_PARTICIPATION",
  CLOSURE: "CAGNOTTE_CLOSURE",
});

function upper(v) {
  return String(v ?? "").trim().toUpperCase();
}

function pricingError(status, code, message, details) {
  const err = new Error(message);
  err.status = status;
  err.statusCode = status;
  err.code = code;
  if (details) err.details = details;
  return err;
}

function eps(currency) {
  return 0.5 / 10 ** decimalsForCurrency(currency);
}

/**
 * Traduit une erreur du moteur de tarification en refus nommé.
 *
 * ⚠️ « Aucune règle ne couvre ce corridor » devient `PRICING_UNAVAILABLE`, pas
 * une participation sans frais : un prix que personne n'a décidé ne s'applique
 * pas (règle B.2).
 */
function mapPricingError(err) {
  if (err?.code && /^(FX_|PRICING_|CAGNOTTE_|CURRENCY_)/.test(String(err.code))) {
    return err;
  }

  const status = Number(err?.status || err?.statusCode || 0);
  const message = String(err?.message || "");

  if (status === 404 || /No pricing rule matched/i.test(message)) {
    return pricingError(
      503,
      "PRICING_UNAVAILABLE",
      "Aucune règle tarifaire active ne couvre cette opération de cagnotte. " +
        "Elle est refusée plutôt que facturée à un prix que personne n'a décidé.",
      err?.details || null
    );
  }

  if (status === 503 || /FX rate unavailable/i.test(message)) {
    return pricingError(
      503,
      "FX_UNAVAILABLE",
      "Taux de change indisponible pour ce corridor. Aucune conversion n'est " +
        "appliquée à un taux deviné.",
      err?.details || null
    );
  }

  if (status === 400) {
    return pricingError(400, "PRICING_INVALID_REQUEST", message || "Requête de tarification invalide.");
  }

  return pricingError(
    502,
    "PRICING_FAILED",
    "Le calcul du prix a échoué ; aucune opération n'a été effectuée."
  );
}

/**
 * Vérifie et met en forme le devis du moteur. PURE.
 *
 * @param {object} p
 * @param {object} p.engineQuote     sortie de `pricingEngine.computeQuote`
 * @param {string} p.sourceCurrency
 * @param {string} p.targetCurrency
 * @param {number} p.requestedAmount montant demandé, en devise source
 * @param {object} [p.rate]          taux capturé ({provider, source, asOfDate})
 */
function normalizeParticipationQuote({
  engineQuote,
  sourceCurrency,
  targetCurrency,
  requestedAmount,
  rate = null,
}) {
  const S = upper(sourceCurrency);
  const T = upper(targetCurrency);
  const r = engineQuote?.result || {};

  const gross = roundMoney(Number(r.grossFrom), S);
  const fee = roundMoney(Number(r.fee), S);
  const requested = roundMoney(Number(requestedAmount), S);

  if (!Number.isFinite(gross) || gross <= 0 || Math.abs(gross - requested) > eps(S)) {
    throw pricingError(
      500,
      "PRICING_INCONSISTENT",
      `Le devis ne porte pas le montant demandé (${gross} ≠ ${requested} ${S}).`
    );
  }

  if (!Number.isFinite(fee) || fee < 0) {
    throw pricingError(500, "PRICING_INCONSISTENT", `Frais illisibles (${r.fee}).`);
  }

  const netSource = roundMoney(gross - fee, S);

  if (netSource <= 0) {
    throw pricingError(
      400,
      "AMOUNT_TOO_LOW_AFTER_FEES",
      "Montant trop faible : les frais absorbent toute la participation."
    );
  }

  let destination;
  let appliedRate;
  let marketRate;
  let fxRevenue;

  if (S === T) {
    /**
     * Même devise ⇒ AUCUN taux, même si une règle déclare une stratégie de
     * change : `netFrom × appliedRate` avec un taux ≠ 1 serait un frais caché,
     * non affiché comme tel. Le montant reçu vaut le net source, à l'unité.
     */
    destination = netSource;
    appliedRate = 1;
    marketRate = 1;
    fxRevenue = 0;
  } else {
    appliedRate = Number(r.appliedRate);
    marketRate = r.marketRate == null ? null : Number(r.marketRate);
    destination = roundMoney(Number(r.netTo), T);
    fxRevenue = roundMoney(Number(r.fxRevenue?.amount || 0), T);

    if (!Number.isFinite(appliedRate) || appliedRate <= 0) {
      throw pricingError(500, "PRICING_INCONSISTENT", `Taux appliqué illisible (${r.appliedRate}).`);
    }

    if (!Number.isFinite(destination) || destination <= 0) {
      throw pricingError(
        400,
        "AMOUNT_TOO_LOW_AFTER_FEES",
        `Montant trop faible : rien n'arriverait dans la cagnotte en ${T}.`
      );
    }

    if (!Number.isFinite(fxRevenue) || fxRevenue < 0) {
      throw pricingError(500, "PRICING_INCONSISTENT", "Marge de change illisible.");
    }
  }

  return {
    source: { amount: gross, currency: S },
    fee: { amount: fee, currency: S },
    netSource,
    destination: { amount: destination, currency: T },
    fx: {
      required: S !== T,
      appliedRate,
      marketRate,
      revenue: { amount: fxRevenue, currency: T },
      provider: S === T ? null : rate?.provider || null,
      rateSource: S === T ? null : rate?.source || null,
      asOf: S === T ? null : rate?.asOfDate ? new Date(rate.asOfDate) : null,
    },
    rule: {
      ruleId: engineQuote?.ruleApplied?.ruleId ? String(engineQuote.ruleApplied.ruleId) : null,
      version: Number(engineQuote?.ruleApplied?.version ?? 0) || null,
    },
  };
}

function defaultDeps() {
  return {
    getActiveRules: require("../pricing/ruleCache").getActiveRules,
    computeQuote: require("../pricing/pricingEngine").computeQuote,
    getExchangeRate: require("../pricing/exchangeRateService").getExchangeRate,
  };
}

/**
 * Calcule le prix d'une opération de cagnotte. Réseau possible (taux en
 * direct) : ne JAMAIS appeler depuis une transaction Mongo.
 */
async function computeCagnottePricing({
  txType,
  method,
  provider = null,
  amount,
  sourceCurrency,
  targetCurrency,
  country = null,
  requestId = null,
  deps = null,
}) {
  const d = deps || defaultDeps();
  const S = upper(sourceCurrency);
  const T = upper(targetCurrency);
  let captured = null;

  try {
    const rules = await d.getActiveRules();

    const engineQuote = await d.computeQuote({
      req: {
        txType,
        method,
        provider,
        amount: Number(amount),
        fromCurrency: S,
        toCurrency: T,
        country,
      },
      rules,
      getMarketRate: async (from, to) => {
        if (upper(from) === upper(to)) {
          captured = { rate: 1, provider: "same", source: "same", asOfDate: new Date().toISOString() };
          return 1;
        }

        try {
          const out = await d.getExchangeRate(from, to, { requestId });
          captured = out && typeof out === "object" ? out : { rate: out };
          return Number(captured.rate);
        } catch (err) {
          if (err?.code === "FX_INVALID_CURRENCY") throw err;
          throw pricingError(
            503,
            "FX_UNAVAILABLE",
            `Taux ${upper(from)}→${upper(to)} indisponible : ${err?.message || "erreur inconnue"}.`
          );
        }
      },
    });

    return normalizeParticipationQuote({
      engineQuote,
      sourceCurrency: S,
      targetCurrency: T,
      requestedAmount: amount,
      rate: captured,
    });
  } catch (err) {
    throw mapPricingError(err);
  }
}

module.exports = {
  TX_TYPES,
  normalizeParticipationQuote,
  computeCagnottePricing,
  mapPricingError,
  pricingError,
};
