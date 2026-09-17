"use strict";

/**
 * ============================================================================
 * SERVICE DE DEVIS — DÉPLACÉ DEPUIS L'API GATEWAY LE 2026-09-10
 * ============================================================================
 *
 * ── Le défaut d'architecture que ce déplacement ferme ───────────────────────
 *
 * Le calcul du prix vivait dans la passerelle. Tx-Core — le moteur d'argent —
 * lui demandait chaque devis EN HTTP :
 *
 *     Mobile ──► Gateway ──► Tx-Core ──► Gateway ──► base tarification
 *                                          ▲
 *                              le moteur rappelle le bord
 *
 * Tx-Core l'annonçait lui-même au démarrage : « GATEWAY_URL absente ⇒ toute
 * transaction nécessitant un devis échouera en 503 ». Autrement dit, une panne
 * de la passerelle n'empêchait pas seulement les clients d'entrer : **elle
 * arrêtait les virements depuis l'intérieur du moteur**, et la passerelle ne
 * pouvait plus être déployée ni redémarrée indépendamment.
 *
 * Stripe, PayPal et Adyen tiennent tous la même règle : les dépendances
 * DESCENDENT. Bord → services → moteur, jamais l'inverse. Le bord route,
 * authentifie et limite ; il ne possède aucun domaine et ne détient aucune
 * base — c'est la surface la plus exposée d'Internet.
 *
 * Le devis est donc devenu un APPEL DE FONCTION dans le processus qui en a
 * besoin. Un saut réseau de moins sur le chemin de l'argent, et un mode de
 * défaillance de moins.
 *
 * ── Ce fichier ne connaît pas HTTP ──────────────────────────────────────────
 *
 * Il rend des objets et LÈVE des erreurs portant un `status`. La traduction en
 * réponse HTTP appartient au contrôleur, et à lui seul : c'est ce qui permet à
 * `services/transactions/shared/pricing.js` d'appeler `computeFullQuote`
 * directement, sans fabriquer un faux `req`/`res`.
 *
 * ── Modèle résolu PARESSEUSEMENT ────────────────────────────────────────────
 *
 * `PricingQuote` était requis au chargement, ce qui marchait parce que la
 * passerelle liait ses modèles à la connexion Mongoose GLOBALE. Tx-Core ouvre
 * des connexions NOMMÉES, dont aucune n'existe au moment du `require`.
 *
 * ── `crypto.randomUUID` plutôt que le paquet `uuid` ─────────────────────────
 *
 * La passerelle dépendait de `uuid`. Tx-Core ne l'a pas, et Node 22 rend la
 * fonction nativement : ajouter une dépendance pour une ligne serait payer une
 * surface d'approvisionnement supplémentaire pour rien.
 */

const crypto = require("crypto");

const { getActiveRules } = require("./ruleCache");
const { recordCoverageGap } = require("./coverage");
const { getExchangeRate } = require("./exchangeRateService");

const {
  computeQuote,
  roundMoney,
  normalizeCountryISO2,
} = require("./pricingEngine");

const {
  construireFiltreConsommation,
  diagnostiquerEchec,
  quoteError,
} = require("./quoteConsumption");

const { getPricingModel } = require("../../config/db");

/** Résolu à l'appel : la connexion n'existe pas au chargement du module. */
const modelePricingQuote = () => getPricingModel("PricingQuote");

const uuidv4 = () => crypto.randomUUID();

/**
 * ⚠️ UN DEVIS CONSOMMÉ EST UNE PIÈCE, IL NE S'EFFACE PAS AVEC L'OFFRE.
 *
 * L'index TTL de `PricingQuote` porte sur `expiresAt`, qui est aussi la fin de
 * validité de l'OFFRE (10 min). Jusqu'au 2026-09-16, un devis utilisé
 * disparaissait donc dix minutes après son émission : la trace de « quel prix
 * l'utilisateur a accepté, quand, pour quelle transaction » (`usedAt`,
 * `usedByReference`) était détruite avant même qu'un litige puisse l'invoquer.
 *
 * À la consommation, `expiresAt` devient la fin de CONSERVATION. La validité de
 * l'offre n'a plus d'objet à ce stade : le filtre de consommation l'a vérifiée
 * à l'instant même. Défaut : 540 jours, la plus longue fenêtre de contestation
 * des réseaux de cartes. Aucun index n'est modifié.
 */
const RETENTION_JOURS_DEFAUT = 540;

function retentionDevisMs(env = process.env) {
  const n = Number(env.PRICING_QUOTE_RETENTION_DAYS);
  const jours = Number.isFinite(n) && n >= 1 ? n : RETENTION_JOURS_DEFAUT;
  return jours * 24 * 60 * 60 * 1000;
}

const LOCK_TTL_MIN_RAW = Number(process.env.PRICING_LOCK_TTL_MIN || 10);
const LOCK_TTL_MIN =
  Number.isFinite(LOCK_TTL_MIN_RAW) && LOCK_TTL_MIN_RAW > 0
    ? LOCK_TTL_MIN_RAW
    : 10;

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function pickBody(req) {
  return req.body && Object.keys(req.body).length ? req.body : req.query || {};
}

const normStr = (v) => String(v ?? "").trim();
const upper = (v) => normStr(v).toUpperCase();
const lower = (v) => normStr(v).toLowerCase();

function cleanId(v) {
  const s = normStr(v);
  return s || undefined;
}

function compactObject(obj = {}) {
  const out = {};

  for (const [key, value] of Object.entries(obj || {})) {
    if (value === undefined || value === null || value === "") continue;
    out[key] = value;
  }

  return out;
}

function normalizeTxType(v) {
  const raw = upper(v);
  if (!raw) return "";

  if (["TRANSFER", "DEPOSIT", "WITHDRAW"].includes(raw)) return raw;

  const low = lower(v);

  if (["send", "p2p", "transfer", "transfert"].includes(low)) {
    return "TRANSFER";
  }

  if (["deposit", "depot", "dépôt", "cashin", "topup"].includes(low)) {
    return "DEPOSIT";
  }

  if (
    ["withdraw", "withdrawal", "cashout", "retrait", "payout"].includes(low)
  ) {
    return "WITHDRAW";
  }

  return raw;
}

function normalizeMethod(v) {
  const raw = upper(v).replace(/[\s-]+/g, "_");
  if (!raw) return "";

  if (["MOBILEMONEY", "MOBILE_MONEY", "MOMO", "MM"].includes(raw)) {
    return "MOBILEMONEY";
  }

  if (["BANK", "WIRE", "TRANSFER_BANK", "VIREMENT"].includes(raw)) {
    return "BANK";
  }

  if (
    [
      "CARD",
      "VISA",
      "VISA_DIRECT",
      "MASTERCARD",
      "CARTE",
    ].includes(raw)
  ) {
    return "CARD";
  }

  if (["INTERNAL", "WALLET", "PAYNOVAL"].includes(raw)) {
    return "INTERNAL";
  }

  return raw;
}

function normalizeCountryForStore(country) {
  if (!country) return null;

  const iso2 = normalizeCountryISO2(country);
  return upper(iso2 || country);
}

function pickRequestId(req) {
  return (
    req.get("x-request-id") ||
    req.get("x-correlation-id") ||
    req.get("x-amzn-trace-id") ||
    null
  );
}

function pickCurrency(...values) {
  for (const value of values) {
    const s = upper(value);
    if (!s) continue;

    if (s === "€" || s.includes("EUR")) return "EUR";
    if (s === "$" || s.includes("USD")) return "USD";
    if (s.includes("CAD")) return "CAD";
    if (s.includes("GBP") || s.includes("£")) return "GBP";
    if (s.includes("XOF") || s.includes("FCFA") || s.includes("CFA")) {
      return "XOF";
    }
    if (s.includes("XAF")) return "XAF";

    const letters = s.replace(/[^A-Z]/g, "");
    if (letters.length === 3) return letters;
  }

  return "";
}

async function getMarketRateDirect(from, to, { requestId } = {}) {
  if (upper(from) === upper(to)) return 1;

  const out = await getExchangeRate(from, to, { requestId });
  const rate = Number(out?.rate ?? out);

  return Number.isFinite(rate) ? rate : null;
}

/**
 * Convertit un montant vers la devise admin CAD.
 */
async function convertToAdminCurrency({
  amount,
  fromCurrency,
  adminCurrency = "CAD",
  requestId,
}) {
  const safeAmount = Number(amount || 0);
  const from = upper(fromCurrency);
  const admin = upper(adminCurrency);

  if (!Number.isFinite(safeAmount) || safeAmount <= 0) {
    return {
      adminCurrency: admin,
      amountAdmin: 0,
      conversionRate: 0,
    };
  }

  if (from === admin) {
    return {
      adminCurrency: admin,
      amountAdmin: roundMoney(safeAmount, admin),
      conversionRate: 1,
    };
  }

  let rate = null;

  try {
    rate = await getMarketRateDirect(from, admin, { requestId });
  } catch (err) {
    rate = null;

    console.warn(
      `⚠️ [PRICING] conversion ${from}→${admin} indisponible (${err?.message || err}).`
    );
  }

  if (!Number.isFinite(rate) || rate <= 0) {
    /**
     * ⚠️ UN REVENU QU'ON NE SAIT PAS CONVERTIR N'EST PAS UN REVENU NUL.
     *
     * Ce bloc rendait `amountAdmin: 0`. Ce zéro ne restait pas un chiffre de
     * rapport : il descendait dans `feeRevenue.amountCAD`, devenait
     * `treasuryAmount` via le normalisateur, et `creditRevenueLineToTreasury`
     * SAUTAIT alors la ligne (« montant ≤ 0 »). Résultat : des frais bel et bien
     * prélevés à l'expéditeur, jamais portés à la trésorerie — un revenu perdu
     * en silence, et un grand livre où la contrepartie n'existe pas.
     *
     * Le cas n'est pas théorique : le corridor principal peut être coté (XOF→EUR)
     * pendant que la paire vers la devise de trésorerie (XOF→CAD) est
     * indisponible. Ce sont deux paires différentes.
     *
     * Le revenu reste donc libellé dans SA devise. Le grand livre équilibre PAR
     * DEVISE — la trésorerie détient déjà des soldes multidevises —, la
     * conversion se fera plus tard, et rien ne disparaît (règle B.2).
     */
    return {
      adminCurrency: from,
      amountAdmin: roundMoney(safeAmount, from),
      conversionRate: 1,
      converted: false,
    };
  }

  return {
    adminCurrency: admin,
    amountAdmin: roundMoney(safeAmount * rate, admin),
    conversionRate: Number(rate),
  };
}

function buildRequest(body = {}) {
  const txType = normalizeTxType(
    body.txType || body.transactionType || body.flow || body.type
  );

  const method = normalizeMethod(
    body.method || body.methodType || body.rail || body.paymentMethod
  );

  const amount = Number(
    body.amount ??
      body.amountSource ??
      body.grossFrom ??
      body.netFrom ??
      body.sourceAmount
  );

  const fromCurrency = pickCurrency(
    body.fromCurrency,
    body.currencySource,
    body.senderCurrencyCode,
    body.currency,
    body.sourceCurrency,
    body.selectedCurrency
  );

  const toCurrency =
    pickCurrency(
      body.toCurrency,
      body.currencyTarget,
      body.localCurrencyCode,
      body.targetCurrency,
      body.destinationCurrency,
      body.localCurrencySymbol
    ) || fromCurrency;

  return {
    txType,
    method,
    amount,
    fromCurrency,
    toCurrency,

    country: normalizeCountryForStore(
      body.country || body.destinationCountry || body.toCountry
    ),

    operator: body.operator
      ? lower(body.operator)
      : body.operatorName
      ? lower(body.operatorName)
      : body.mobileMoney
      ? lower(body.mobileMoney)
      : null,

    provider: body.provider ? lower(body.provider) : null,

    fromCountry: normalizeCountryForStore(
      body.fromCountry || body.sourceCountry
    ),

    toCountry: normalizeCountryForStore(
      body.toCountry || body.targetCountry || body.destinationCountry
    ),
  };
}

function validateRequest(request) {
  if (!request.txType) return "txType est requis";

  if (
    !request.amount ||
    !Number.isFinite(request.amount) ||
    request.amount <= 0
  ) {
    return "amount doit être un nombre > 0";
  }

  if (!request.fromCurrency) return "fromCurrency est requis";
  if (!request.toCurrency) return "toCurrency est requis";

  return null;
}

function buildPricingAliases(quoteId) {
  const id = cleanId(quoteId);

  return compactObject({
    quoteId: id,
    pricingId: id,
    pricingLockId: id,
    lockId: id,
    effectivePricingId: id,
  });
}

function buildDebugPayload({ request, quote, requestId }) {
  const fee = Number(quote?.result?.fee || 0);
  const grossFrom = Number(quote?.result?.grossFrom || request?.amount || 0);
  const netFrom = Number(quote?.result?.netFrom || 0);

  const marketRate =
    quote?.result?.marketRate != null ? Number(quote.result.marketRate) : null;

  const appliedRate =
    quote?.result?.appliedRate != null ? Number(quote.result.appliedRate) : null;

  const netTo = Number(quote?.result?.netTo || 0);

  const feeRevenueCAD = Number(quote?.result?.feeRevenue?.amountCAD || 0);
  const fxRevenueTo = Number(quote?.result?.fxRevenue?.amount || 0);
  const fxRevenueCAD = Number(quote?.result?.fxRevenue?.amountCAD || 0);

  return {
    requestId: requestId || null,

    requestNormalized: {
      txType: request?.txType || null,
      method: request?.method || null,
      amount: Number(request?.amount || 0),
      fromCurrency: request?.fromCurrency || null,
      toCurrency: request?.toCurrency || null,
      country: request?.country || null,
      fromCountry: request?.fromCountry || null,
      toCountry: request?.toCountry || null,
      provider: request?.provider || null,
      operator: request?.operator || null,
    },

    feeSource: fee,

    feeComputation: {
      grossFrom,
      fee,
      netFrom,
      formula:
        Number.isFinite(grossFrom) && Number.isFinite(fee)
          ? `${grossFrom} - ${fee} = ${netFrom}`
          : null,
    },

    feeRuleApplied: quote?.ruleApplied || null,
    fxRuleApplied: quote?.fxRuleApplied || null,

    feeRevenueCAD,

    fxComputation: {
      marketRate,
      appliedRate,
      spreadPerUnit:
        Number.isFinite(marketRate) && Number.isFinite(appliedRate)
          ? Math.max(0, marketRate - appliedRate)
          : null,
      marginDelta:
        Number.isFinite(marketRate) && Number.isFinite(appliedRate)
          ? appliedRate - marketRate
          : null,
      netTo,
      fxRevenueTo,
      fxRevenueToCurrency: quote?.result?.fxRevenue?.toCurrency || null,
      fxRevenueCAD,
      fxConversionRateToCAD: Number(
        quote?.result?.fxRevenue?.conversionRateToCAD || 0
      ),
      formula:
        Number.isFinite(netFrom) && Number.isFinite(appliedRate)
          ? `${netFrom} * ${appliedRate} = ${netTo}`
          : null,
      gainFormula:
        Number.isFinite(netFrom) &&
        Number.isFinite(marketRate) &&
        Number.isFinite(appliedRate)
          ? `${netFrom} * (${marketRate} - ${appliedRate}) = ${fxRevenueTo}`
          : null,
    },

    feeBreakdown: quote?.result?.feeBreakdown || null,
    feeRevenue: quote?.result?.feeRevenue || null,
    fxRevenue: quote?.result?.fxRevenue || null,
  };
}

async function computeFullQuote({ request, requestId }) {
  // Lecture servie par le cache, invalidé à chaque publication tarifaire.
  const rules = await getActiveRules();

  const quote = await computeQuote({
    req: request,
    rules,
    getMarketRate: async (from, to) =>
      getMarketRateDirect(from, to, { requestId }),
  });

  quote.result = quote.result || {};

  const feeRevenueAdmin = await convertToAdminCurrency({
    amount: Number(quote?.result?.fee || 0),
    fromCurrency: request.fromCurrency,
    adminCurrency: "CAD",
    requestId,
  });

  quote.result.feeRevenue = {
    sourceCurrency: request.fromCurrency,
    amount: Number(quote?.result?.fee || 0),
    adminCurrency: feeRevenueAdmin.adminCurrency,
    amountCAD: feeRevenueAdmin.amountAdmin,
    conversionRateToCAD: feeRevenueAdmin.conversionRate,
    calculatedAt: new Date().toISOString(),
  };

  const fxRevenueTo = Number(quote?.result?.fxRevenue?.amount || 0);
  const fxRevenueToCurrency =
    quote?.result?.fxRevenue?.toCurrency || request.toCurrency;

  const fxRevenueAdmin = await convertToAdminCurrency({
    amount: fxRevenueTo,
    fromCurrency: fxRevenueToCurrency,
    adminCurrency: "CAD",
    requestId,
  });

  quote.result.fxRevenue = {
    ...(quote.result.fxRevenue || {}),
    adminCurrency: fxRevenueAdmin.adminCurrency,
    amountCAD: fxRevenueAdmin.amountAdmin,
    conversionRateToCAD: fxRevenueAdmin.conversionRate,
    calculatedAt: new Date().toISOString(),
  };

  /**
   * Règle B.1 — une perte de change ou une marge non mesurée ne passe pas en
   * silence. Le devis la porte (`fxRevenue.favorsCustomer`, `measured`), et le
   * journal la signale au moment où elle se forme, avec la règle qui l'a
   * produite : c'est elle qu'il faudra corriger.
   */
  const fx = quote.result.fxRevenue || {};

  if (fx.favorsCustomer === true || fx.measured === false) {
    console.warn(
      fx.favorsCustomer === true
        ? "⚠️ [PRICING] marge de change NÉGATIVE : le client reçoit plus que le marché"
        : "⚠️ [PRICING] marge de change NON MESURÉE : taux du marché indisponible",
      {
        requestId: requestId || null,
        fromCurrency: request.fromCurrency,
        toCurrency: request.toCurrency,
        signedAmount: fx.signedAmount ?? null,
        ruleId: quote?.ruleApplied?.ruleId ? String(quote.ruleApplied.ruleId) : null,
        ruleVersion: quote?.ruleApplied?.currentVersion ?? null,
      }
    );
  }

  quote.debug = buildDebugPayload({
    request,
    quote,
    requestId,
  });

  return quote;
}

function buildQuoteResponsePayload({ quote, mode = "QUOTE" }) {
  return {
    success: true,
    ok: true,
    mode,
    request: quote.request,
    result: quote.result,
    feeSource: quote.debug?.feeSource ?? Number(quote?.result?.fee || 0),
    ruleApplied: quote.ruleApplied || null,
    fxRuleApplied: quote.fxRuleApplied || null,
    debug: quote.debug || null,
  };
}

/**
 * ============================================================================
 * LE DEVIS PUBLIC — CE QU'UN VISITEUR ANONYME A LE DROIT DE VOIR
 * ============================================================================
 *
 * `/pricing/quote` est ouvert sans session : le simulateur du site et l'écran
 * de saisie de l'application l'appellent avant toute authentification. Jusqu'au
 * 2026-09-16 il rendait la réponse INTERNE complète : identifiant et version de
 * la règle appliquée, revenus de PayNoval convertis en CAD (`feeRevenue`,
 * `fxRevenue`), et le bloc `debug` avec ses formules.
 *
 * C'est la grille de marge de PayNoval, règle par règle, servie à qui la
 * demande. Wise affiche au client ses frais, son taux et le taux du marché —
 * ce qu'il paie et ce qu'il reçoit —, pas sa comptabilité. On fait de même :
 * une projection par LISTE BLANCHE, pour qu'un champ interne ajouté demain au
 * moteur ne devienne pas public par défaut.
 */
function buildPublicQuotePayload({ quote }) {
  const r = quote?.result || {};
  const q = quote?.request || {};
  const fb = r.feeBreakdown || {};

  return {
    success: true,
    ok: true,
    mode: "QUOTE",
    request: {
      txType: q.txType ?? null,
      method: q.method ?? null,
      amount: q.amount ?? null,
      fromCurrency: q.fromCurrency ?? null,
      toCurrency: q.toCurrency ?? null,
      country: q.country ?? null,
      fromCountry: q.fromCountry ?? null,
      toCountry: q.toCountry ?? null,
      provider: q.provider ?? null,
      operator: q.operator ?? null,
    },
    result: {
      marketRate: r.marketRate ?? null,
      appliedRate: r.appliedRate ?? null,
      fee: r.fee ?? null,
      feeBreakdown: {
        mode: fb.mode ?? null,
        percent: fb.percent ?? null,
        fixed: fb.fixed ?? null,
        minFee: fb.minFee ?? null,
        maxFee: fb.maxFee ?? null,
      },
      grossFrom: r.grossFrom ?? null,
      netFrom: r.netFrom ?? null,
      netTo: r.netTo ?? null,
    },
  };
}

function buildLockResponsePayload({ doc }) {
  const aliases = buildPricingAliases(doc.quoteId);

  const base = {
    success: true,
    ok: true,
    mode: "LOCKED",

    ...aliases,

    expiresAt: doc.expiresAt,
    request: doc.request,
    result: doc.result,
    feeSource: doc.debug?.feeSource ?? Number(doc?.result?.fee || 0),
    ruleApplied: doc.ruleApplied || null,
    fxRuleApplied: doc.fxRuleApplied || null,
    debug: doc.debug || null,
  };

  return {
    ...base,

    /**
     * Compat front :
     * - axios normalizeResponse peut retourner {...data}
     * - certains appels lisent lockRes.data
     * - d'autres lisent lockRes.data.data
     */
    data: {
      ...base,
    },
  };
}

/**
 * ============================================================================
 * VERROU DE PRIX
 * ============================================================================
 *
 * Fige un devis pour `PRICING_LOCK_TTL_MIN` minutes. C'est ce qui garantit que
 * le prix affiché au client est celui qui sera prélevé : sans verrou, le taux
 * peut bouger entre l'écran de confirmation et l'écriture comptable, et
 * l'utilisateur paie autre chose que ce qu'il a accepté.
 *
 * ⚠️ `userId` est OBLIGATOIRE : un verrou est un engagement de prix envers
 * quelqu'un. Un verrou anonyme serait réutilisable par n'importe qui, ce qui en
 * ferait un moyen de figer un taux favorable et de l'appliquer à un autre.
 */
async function lockQuote({ request, requestId, userId }) {
  if (!userId) {
    const err = new Error("Unauthorized");
    err.status = 401;
    throw err;
  }

  const computed = await computeFullQuote({ request, requestId });

  const quoteId = uuidv4();
  const expiresAt = new Date(Date.now() + LOCK_TTL_MIN * 60 * 1000);

  const doc = await modelePricingQuote().create({
    quoteId,
    userId,
    status: "ACTIVE",
    request: {
      txType: computed.request.txType,
      method: computed.request.method || null,
      amount: Number(computed.request.amount),
      fromCurrency: upper(computed.request.fromCurrency),
      toCurrency: upper(computed.request.toCurrency),
      country: normalizeCountryForStore(computed.request.country),
      fromCountry: normalizeCountryForStore(computed.request.fromCountry),
      toCountry: normalizeCountryForStore(computed.request.toCountry),
      operator: computed.request.operator
        ? lower(computed.request.operator)
        : null,
      provider: computed.request.provider
        ? lower(computed.request.provider)
        : null,
    },
    result: computed.result,
    ruleApplied: computed.ruleApplied || null,
    fxRuleApplied: computed.fxRuleApplied || null,
    debug: computed.debug || null,
    expiresAt,
  });

  return doc;
}

/**
 * ============================================================================
 * CONSOMMATION DU DEVIS — CE QUI REND LE VERROU CONTRAIGNANT
 * ============================================================================
 *
 * Jusqu'au 2026-09-16, `lockQuote` écrivait un devis que PERSONNE ne relisait :
 * l'initiation recalculait le prix et ne faisait que recopier `quoteId` en
 * métadonnée. Le verrou ne verrouillait rien.
 *
 * ── Trois propriétés, et aucune n'est négociable ────────────────────────────
 *
 * 1. **Une seule fois.** `ACTIVE → USED` est une mise à jour conditionnelle sur
 *    un document unique : Mongo la rend atomique sans transaction
 *    multi-documents — ce qui compte, car la base de tarification ne partage
 *    pas forcément le client Mongo du grand livre (`config/db.js`).
 * 2. **Pour celui à qui il a été promis.** `userId` est dans le filtre. Un
 *    devis réutilisable par un autre serait un moyen de figer un taux favorable
 *    et de l'appliquer au virement de quelqu'un d'autre.
 * 3. **Pour CE virement-là.** Les champs de prix sont dans le filtre : un devis
 *    obtenu pour 10 000 XOF ne peut pas servir à en envoyer 1 000 000.
 *
 * ── Le rejeu, distinct du second usage ──────────────────────────────────────
 *
 * Un rejeu porteur de la MÊME clé d'idempotence n'est pas une seconde
 * transaction : c'est la même, dont la réponse s'est perdue. Il retrouve donc
 * son devis au lieu de se voir opposer « déjà consommé ». C'est ce que fait
 * Stripe d'une requête rejouée, et c'est ce qui évite qu'une coupure réseau
 * coûte son prix à l'utilisateur.
 */
function quoteDocToPlain(doc) {
  if (!doc) return null;
  return typeof doc.toObject === "function" ? doc.toObject() : doc;
}

/**
 * Rend un devis figé sous la MÊME forme qu'une réponse de calcul, pour que
 * `extractPricingBundle` le valide exactement comme il valide un devis calculé.
 *
 * ⚠️ Un devis relu en base n'est pas plus digne de confiance qu'un devis
 * calculé : il a pu être écrit par une version antérieure du moteur. Il passe
 * donc par la même validation arithmétique (règle B.2).
 */
function buildPayloadFromQuote(doc) {
  const devis = quoteDocToPlain(doc) || {};

  return {
    success: true,
    ok: true,
    mode: "QUOTE_CONSUMED",
    quoteId: devis.quoteId || null,
    expiresAt: devis.expiresAt || null,
    request: devis.request || {},
    result: devis.result || {},
    feeSource: Number(devis?.result?.fee ?? 0),
    ruleApplied: devis.ruleApplied || null,
    fxRuleApplied: devis.fxRuleApplied || null,
    debug: devis.debug || null,
  };
}

/**
 * @param {object} params
 * @param {string} params.quoteId
 * @param {string} params.userId         Propriétaire attendu du devis.
 * @param {object} params.request        Sortie de `buildRequest` pour la demande.
 * @param {string} [params.reference]    Référence de la transaction qui le consomme.
 * @param {string} [params.idempotencyKey]
 * @param {object} [params.model]        Injection pour les tests.
 * @returns {Promise<object>} le devis consommé
 */
async function consumeQuote({
  quoteId,
  userId,
  request,
  reference,
  idempotencyKey,
  model,
}) {
  const id = String(quoteId || "").trim();

  if (!id) {
    throw quoteError(400, "QUOTE_REQUIRED", "Aucun devis fourni.");
  }

  if (!String(userId || "").trim()) {
    /**
     * Sans identité, la propriété du devis ne peut pas être vérifiée — et un
     * devis consommable par n'importe qui n'est plus un engagement de prix.
     */
    throw quoteError(401, "UNAUTHORIZED", "Identité absente.");
  }

  const Quote = model || modelePricingQuote();
  const maintenant = new Date();

  const consomme = await Quote.findOneAndUpdate(
    construireFiltreConsommation({
      quoteId: id,
      userId,
      requete: request,
      maintenant,
    }),
    {
      $set: {
        status: "USED",
        usedAt: maintenant,
        expiresAt: new Date(maintenant.getTime() + retentionDevisMs()),
        usedByReference: reference ? String(reference) : null,
        usedByIdempotencyKey: idempotencyKey ? String(idempotencyKey) : null,
      },
    },
    { new: true }
  );

  if (consomme) return quoteDocToPlain(consomme);

  /**
   * Relecture pour EXPLIQUER l'échec — le devis n'a pas été touché.
   * `lean()` n'existe pas sur un modèle injecté en test : on s'en passe alors,
   * plutôt que d'imposer aux tests de simuler toute l'API d'une requête Mongoose.
   */
  const requete = Quote.findOne({ quoteId: id });
  const devis = quoteDocToPlain(
    await (typeof requete?.lean === "function" ? requete.lean() : requete)
  );

  /* Rejeu de la MÊME intention : on rend le devis déjà consommé. */
  const cle = String(idempotencyKey || "").trim();

  if (
    cle &&
    devis &&
    devis.status === "USED" &&
    String(devis.userId || "") === String(userId) &&
    String(devis.usedByIdempotencyKey || "") === cle
  ) {
    return devis;
  }

  throw diagnostiquerEchec(devis, { userId, requete: request, maintenant });
}

module.exports = {
  buildRequest,
  validateRequest,
  computeFullQuote,
  lockQuote,
  consumeQuote,
  buildPayloadFromQuote,
  buildQuoteResponsePayload,
  buildPublicQuotePayload,
  buildLockResponsePayload,
  recordCoverageGap,
  normalizeCountryForStore,
  LOCK_TTL_MIN,
  retentionDevisMs,
};
