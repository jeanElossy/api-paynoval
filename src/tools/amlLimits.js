// File: tools/amlLimits.js
"use strict";

const { getCurrencyCodeByCountry } = require("./currency");

/**
 * PLAFONDS AML — la table est la POLITIQUE, et elle est CLOSE.
 *
 * ── Ce que ce fichier faisait avant le 2026-09-08, et pourquoi c'était grave ──
 *
 * Les deux résolutions se terminaient par un repli numérique :
 *
 *     return limits[symbol] ?? limits["$"] ?? 1_000_000;   // par envoi
 *     return limits[symbol] ?? limits["$"] ?? 5_000_000;   // journalier
 *
 * Trois défauts distincts s'y superposaient :
 *
 *   1. RAIL INCONNU → PLAFOND GÉANT. `AML_SINGLE_TX_LIMITS[rail] || {}` rendait
 *      une table vide pour tout rail absent, et le repli posait 1 000 000. Sur
 *      Tx Core, le rail vient de `req.body.provider` (le champ `req.routedProvider`
 *      n'est JAMAIS positionné dans ce service — sa seule occurrence est la ligne
 *      qui le lit). Mesuré le 2026-09-08 : rail « paynoval » en EUR → 5 000 ;
 *      rail « nimportequoi » en EUR → 1 000 000. Deux cents fois le plafond,
 *      choisi par le client.
 *
 *   2. RAILS LÉGITIMES SANS PLAFOND. Ce n'était même pas qu'une affaire de rail
 *      forgé : `visa_direct`, `card`, `stripe2momo` et `flutterwave` sont acceptés
 *      par le validateur du gateway et `visa_direct` porte DEUX flux ouverts
 *      (`paynoval → visa_direct` en `send` et en `withdraw`). Aucun des quatre
 *      n'avait de ligne ici. Le chemin normal des paiements par carte s'exécutait
 *      donc sous un plafond de 1 000 000, dans toutes les devises.
 *
 *   3. CONFUSION DE DEVISE. `?? limits["$"]` appliquait le NOMBRE prévu pour le
 *      dollar à n'importe quelle devise non listée. 5 000 « quelque chose » au
 *      lieu de 5 000 USD : selon la devise, un plafond absurdement bas ou
 *      absurdement haut, sans que rien ne le signale.
 *
 * ── La règle appliquée désormais ───────────────────────────────────────────
 *
 * Un plafond de conformité qu'on ne sait pas déterminer n'a pas de valeur par
 * défaut : il n'a pas de valeur du tout, et l'opération S'ARRÊTE (règle B.2 —
 * le chemin de l'argent échoue en FERMETURE). C'est la position de Stripe sur
 * les *capabilities* : une devise ou un rail n'existe pas tant qu'il n'a pas été
 * explicitement ouvert. Ne rien trouver n'autorise pas, ne rien trouver refuse.
 *
 * `getSingleTxLimit` et `getDailyLimit` LÈVENT donc une `AmlLimitUnavailableError`
 * plutôt que d'inventer un nombre. Les appelants la traduisent en 403.
 *
 * ── Le périmètre des rails, arrêté le 2026-09-08 ───────────────────────────
 *
 * PayNoval opère TROIS rails, et la table n'en connaît pas d'autre :
 *
 *   paynoval     portefeuille → portefeuille (interne, sans prestataire)
 *   mobilemoney  portefeuille ⇄ mobile money (Orange, MTN, Moov, Wave)
 *   card         portefeuille ⇄ carte (Visa, Mastercard, …)
 *
 * Quatre rails ont été RETIRÉS de la politique, et sont donc refusés comme
 * n'importe quelle valeur inconnue :
 *
 *   stripe        retiré du produit le 2026-09-08 (décision produit)
 *   stripe2momo   pont bâti sur Stripe, sans objet une fois Stripe retiré
 *   flutterwave   n'est pas un rail : c'est un OPÉRATEUR du rail mobile money,
 *                 et il y reste — c'est son entrée de rail autonome qui part
 *   bank          rail bancaire retiré le 2026-08-26 (`providerSelector.js`
 *                 lève dessus, `allowedFlows.js` n'a plus aucun flux bancaire)
 *
 * ⚠️ `bank` gardait ici les plafonds les plus GÉNÉREUX de toute la table —
 * 40 000 € et 10 000 000 F CFA par envoi — alors qu'aucun adapter ne le sert
 * depuis deux semaines. Un rail mort qui conserve la porte la plus large est un
 * piège : il n'attend que quelqu'un qui pense à la pousser.
 *
 * ── D'où viennent les chiffres du rail `card` ──────────────────────────────
 *
 * Le rail carte n'avait AUCUNE ligne dans cette table alors qu'il porte deux
 * flux ouverts sous le nom `visa_direct`. Ses plafonds ne sont pas inventés :
 * ils reprennent ceux de l'ancienne famille carte, et sont marqués
 * `inherited:card-family` dans
 * `LIMIT_PROVENANCE`. Ce sont des plafonds PROVISOIRES, à confirmer par la
 * conformité avant mise en production. La provenance est une donnée exportée
 * et testable, pas un commentaire qu'on oublie de relire.
 *
 * Les devises hors zone principale (NGN, GHS, INR, CNY, JPY, BRL, ZAR) sont
 * désormais couvertes EXPLICITEMENT pour les trois rails. Elles ne l'étaient que
 * pour `paynoval`, et seulement dans le gateway : côté Tx Core, un envoi en
 * nairas retombait sur la ligne « $ », donc sur un plafond pensé en dollars.
 */

/**
 * ── Pourquoi la table est indexée par CODE ISO et non par symbole ──────────
 *
 * Elle l'était par symbole jusqu'au 2026-09-08, et deux symboles sont ambigus :
 *
 *   "¥"     ← CNY *et* JPY
 *   "F CFA" ← XOF *et* XAF
 *
 * Le plafond journalier « ¥ 80 000 » valait donc environ 500 $ pour un envoi en
 * yens et 11 000 $ pour le même nombre en yuans — vingt fois l'écart, sur la
 * même ligne de table. Un plafond de conformité ne peut pas dépendre d'une
 * abréviation d'interface. La clé est maintenant le code ISO 4217, qui est
 * unique par construction ; le symbole ne sert plus qu'à l'affichage.
 */

/** Plafonds AML par envoi (une seule transaction), en unité de la devise. */
const AML_SINGLE_TX_LIMITS = Object.freeze({
  paynoval: Object.freeze({
    XOF: 2_000_000, XAF: 2_000_000,
    EUR: 5_000, USD: 5_000, CAD: 5_000, GBP: 3_000,
    NGN: 1_000_000, GHS: 20_000, INR: 300_000,
    CNY: 30_000, JPY: 500_000, BRL: 10_000, ZAR: 80_000,
  }),
  mobilemoney: Object.freeze({
    XOF: 750_000, XAF: 750_000,
    EUR: 1_000, USD: 1_000, CAD: 1_000, GBP: 800,
    NGN: 400_000, GHS: 8_000, INR: 60_000,
    CNY: 6_000, JPY: 100_000, BRL: 2_000, ZAR: 16_000,
  }),
  card: Object.freeze({
    XOF: 1_500_000, XAF: 1_500_000,
    EUR: 2_000, USD: 2_000, CAD: 2_000, GBP: 1_500,
    NGN: 800_000, GHS: 16_000, INR: 120_000,
    CNY: 12_000, JPY: 200_000, BRL: 4_000, ZAR: 32_000,
  }),
});

/** Plafonds AML journaliers (cumul glissant 24 h), en unité de la devise. */
const AML_DAILY_LIMITS = Object.freeze({
  paynoval: Object.freeze({
    XOF: 5_000_000, XAF: 5_000_000,
    EUR: 10_000, USD: 10_000, CAD: 10_000, GBP: 8_000,
    NGN: 2_500_000, GHS: 50_000, INR: 700_000,
    CNY: 80_000, JPY: 1_200_000, BRL: 40_000, ZAR: 200_000,
  }),
  mobilemoney: Object.freeze({
    XOF: 2_000_000, XAF: 2_000_000,
    EUR: 2_000, USD: 2_000, CAD: 2_000, GBP: 1_600,
    NGN: 1_000_000, GHS: 20_000, INR: 150_000,
    CNY: 15_000, JPY: 250_000, BRL: 5_000, ZAR: 40_000,
  }),
  card: Object.freeze({
    XOF: 3_000_000, XAF: 3_000_000,
    EUR: 10_000, USD: 10_000, CAD: 10_000, GBP: 8_000,
    NGN: 2_000_000, GHS: 40_000, INR: 300_000,
    CNY: 30_000, JPY: 500_000, BRL: 10_000, ZAR: 80_000,
  }),
});

/**
 * D'où vient chaque plafond. `"policy"` = chiffre décidé pour ce rail ;
 * `"inherited:<rail>"` = repris d'un rail de la même famille en attendant que
 * la conformité tranche. Exporté pour que l'écart soit AUDITABLE et testable,
 * et non enfoui dans un commentaire que personne ne relit.
 */
const LIMIT_PROVENANCE = Object.freeze({
  paynoval: "policy",
  mobilemoney: "policy",
  card: "inherited:card-family",
});

/** Les rails qui portent une politique AML. Tout autre valeur est REFUSÉE. */
const KNOWN_RAILS = Object.freeze(Object.keys(AML_SINGLE_TX_LIMITS));

/**
 * Levée quand aucun plafond ne peut être déterminé. Porte un `code` exploitable
 * par l'appelant HTTP et un `details` sans donnée personnelle.
 */
class AmlLimitUnavailableError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "AmlLimitUnavailableError";
    this.code = code;
    this.statusCode = 403;
    this.details = details;
  }
}

/**
 * Contrôle de cohérence au CHARGEMENT du module, pas à la première requête.
 *
 * Les deux tables doivent couvrir exactement les mêmes rails : un rail présent
 * dans l'une et absent de l'autre passerait le plafond par envoi puis lèverait
 * sur le journalier, en pleine requête. Mieux vaut refuser de démarrer.
 */
(function assertTablesAreConsistent() {
  const single = Object.keys(AML_SINGLE_TX_LIMITS).sort();
  const daily = Object.keys(AML_DAILY_LIMITS).sort();

  if (single.join(",") !== daily.join(",")) {
    throw new Error(
      "[amlLimits] Tables incohérentes — par envoi: [" +
        single.join(", ") +
        "] / journalier: [" +
        daily.join(", ") +
        "]. Tout rail doit porter les DEUX plafonds."
    );
  }

  for (const rail of single) {
    if (!LIMIT_PROVENANCE[rail]) {
      throw new Error(
        `[amlLimits] Le rail « ${rail} » n'a pas de provenance déclarée. ` +
          "Tout plafond doit dire s'il est décidé ou hérité."
      );
    }

    const cs = Object.keys(AML_SINGLE_TX_LIMITS[rail]).sort().join(",");
    const cd = Object.keys(AML_DAILY_LIMITS[rail]).sort().join(",");

    if (cs !== cd) {
      throw new Error(
        `[amlLimits] Rail « ${rail} » : devises couvertes différentes entre le ` +
          `plafond par envoi (${cs}) et le journalier (${cd}).`
      );
    }

    for (const [iso, valeur] of Object.entries(AML_SINGLE_TX_LIMITS[rail])) {
      if (!Number.isFinite(valeur) || valeur <= 0) {
        throw new Error(
          `[amlLimits] Plafond par envoi invalide pour ${rail}/${iso}: ${valeur}`
        );
      }

      if (AML_DAILY_LIMITS[rail][iso] < valeur) {
        throw new Error(
          `[amlLimits] ${rail}/${iso} : le plafond journalier ` +
            `(${AML_DAILY_LIMITS[rail][iso]}) est INFÉRIEUR au plafond par envoi ` +
            `(${valeur}) — un envoi unique passerait le contrôle par envoi puis ` +
            "échouerait toujours sur le cumul."
        );
      }
    }
  }
})();

/* -------------------------------------------------------------------------- */
/* Normalisation                                                              */
/* -------------------------------------------------------------------------- */

const normalizeIso = (v) => {
  const s0 = String(v || "").trim().toUpperCase();
  if (!s0) return "";

  const s = s0.replace(/\u00A0/g, " ");

  if (s.includes("CFA") || s === "FCFA" || s === "F CFA") return "XOF";
  if (s === "XAF") return "XAF";
  if (s === "XOF") return "XOF";

  if (s === "€") return "EUR";
  if (s === "£") return "GBP";
  if (s === "$") return "USD";

  const letters = s.replace(/[^A-Z]/g, "");

  if (letters === "CAD") return "CAD";
  if (letters === "USD") return "USD";
  if (letters === "EUR") return "EUR";
  if (letters === "GBP") return "GBP";
  if (letters === "XOF") return "XOF";
  if (letters === "XAF") return "XAF";

  if (/^[A-Z]{3}$/.test(letters)) return letters;
  if (/^[A-Z]{3}$/.test(s)) return s;

  return "";
};

/**
 * Alias de RAIL, et rien d'autre.
 *
 * Un plafond AML porte sur un RAIL — le chemin que l'argent emprunte — jamais
 * sur le prestataire qui le sert. « Visa Direct » et « Mastercard Send » sont
 * deux réseaux du MÊME rail carte, et le partenaire qui les opère changera
 * sans que la politique de conformité ait à bouger. Les nommer un par un dans
 * la table aurait garanti qu'on oublie le suivant : c'est exactement ainsi que
 * `visa_direct` s'est retrouvé sans aucun plafond alors qu'il portait deux flux
 * ouverts.
 *
 * La table d'alias est CLOSE : ce qui n'y figure pas n'est pas normalisé, donc
 * n'est pas trouvé, donc est refusé. Elle élargit la reconnaissance, jamais
 * l'autorisation.
 */
const RAIL_ALIASES = Object.freeze({
  // Rail carte — quel que soit le réseau et quel que soit le partenaire.
  card: "card",
  cards: "card",
  visa: "card",
  visa_direct: "card",
  "visa-direct": "card",
  visadirect: "card",
  mastercard: "card",
  "mastercard-send": "card",
  mastercard_send: "card",

  // Rail mobile money — les opérateurs (orange, mtn, moov, wave) sont des
  // PRESTATAIRES de ce rail, pas des rails ; ils ne sont pas listés ici.
  mobilemoney: "mobilemoney",
  mobile_money: "mobilemoney",
  "mobile-money": "mobilemoney",
  momo: "mobilemoney",

  // Rail interne.
  paynoval: "paynoval",
  internal: "paynoval",
  wallet: "paynoval",
});

/**
 * Ramène une valeur de rail à sa forme canonique. Une valeur non listée est
 * rendue TELLE QUELLE (minuscules) : elle ne correspondra à aucune ligne de la
 * table et sera refusée. Normaliser ne doit jamais fabriquer une correspondance.
 */
const normalizeRail = (v) => {
  const brut = String(v || "").trim().toLowerCase();
  return RAIL_ALIASES[brut] || brut;
};

/**
 * Résout la devise AML depuis le corps de la requête.
 *
 * ⚠️ Le repli final sur "USD" est CONSERVÉ ici, et c'est délibéré : il ne
 * choisit pas un plafond, il choisit une devise de lecture. Si cette devise
 * n'est pas couverte par le rail, la résolution du plafond refusera juste
 * après — le repli ne peut donc plus ouvrir de porte à lui seul.
 */
function resolveAmlCurrency(body = {}) {
  const iso =
    normalizeIso(body.currencySource) ||
    normalizeIso(body.senderCurrencyCode) ||
    normalizeIso(body.currencyCode) ||
    normalizeIso(body.currencySender) ||
    normalizeIso(body.currency) ||
    normalizeIso(body.selectedCurrency);

  if (iso) return iso;

  const ctry =
    body.senderCountry || body.originCountry || body.fromCountry || body.country || "";

  const byCountry = normalizeIso(getCurrencyCodeByCountry(ctry));
  return byCountry || "USD";
}

/**
 * Résout le montant AML.
 *
 * ⚠️ Rendait 0 sur une entrée illisible jusqu'au 2026-09-08. Zéro passe TOUS
 * les plafonds : un montant qu'on ne sait pas lire devenait donc une
 * transaction que l'AML laissait filer sans contrôle. Règle B.2 — une donnée
 * financière illisible arrête l'opération, elle ne prend pas de valeur par
 * défaut.
 */
function resolveAmlAmount(body = {}) {
  const raw = body.amountSource ?? body.amount;

  if (raw === null || raw === undefined || raw === "") {
    throw new AmlLimitUnavailableError(
      "AML_AMOUNT_MISSING",
      "Montant absent : le contrôle AML ne peut pas s'appliquer à un montant inconnu."
    );
  }

  const n =
    typeof raw === "number"
      ? raw
      : parseFloat(String(raw).replace(/\s/g, "").replace(",", "."));

  if (!Number.isFinite(n) || n < 0) {
    throw new AmlLimitUnavailableError(
      "AML_AMOUNT_UNREADABLE",
      "Montant illisible : le contrôle AML est interrompu plutôt que d'être " +
        "appliqué à une valeur inventée."
    );
  }

  return n;
}

/* -------------------------------------------------------------------------- */
/* Résolution des plafonds — FERMÉE                                           */
/* -------------------------------------------------------------------------- */

function resoudrePlafond(table, libelle, provider, currencyISO) {
  const rail = normalizeRail(provider);

  if (!rail) {
    throw new AmlLimitUnavailableError(
      "AML_RAIL_MISSING",
      `Aucun rail fourni : impossible de déterminer le plafond ${libelle}.`,
      { knownRails: KNOWN_RAILS }
    );
  }

  const limits = table[rail];

  if (!limits) {
    throw new AmlLimitUnavailableError(
      "AML_UNKNOWN_RAIL",
      `Rail « ${rail} » inconnu de la politique AML : aucun plafond ${libelle} ` +
        "ne lui est associé. La transaction est refusée — un rail sans plafond " +
        "n'est pas un rail sans limite.",
      { rail, knownRails: KNOWN_RAILS }
    );
  }

  const iso = normalizeIso(currencyISO);

  if (!iso) {
    throw new AmlLimitUnavailableError(
      "AML_CURRENCY_MISSING",
      `Devise absente ou illisible : impossible de déterminer le plafond ${libelle} ` +
        `pour le rail « ${rail} ».`,
      { rail }
    );
  }

  const valeur = limits[iso];

  if (!Number.isFinite(valeur)) {
    throw new AmlLimitUnavailableError(
      "AML_UNSUPPORTED_CURRENCY",
      `Le rail « ${rail} » n'a pas de plafond ${libelle} défini pour la devise ` +
        `${iso}. Aucun plafond d'une autre devise n'est substitué — ce serait ` +
        "appliquer un nombre pensé pour une monnaie à une autre.",
      { rail, currency: iso, supported: Object.keys(limits) }
    );
  }

  return valeur;
}

/**
 * Plafond par envoi. LÈVE `AmlLimitUnavailableError` si le couple rail/devise
 * n'est pas couvert — ne rend jamais de valeur par défaut.
 */
function getSingleTxLimit(provider, currencyISO) {
  return resoudrePlafond(AML_SINGLE_TX_LIMITS, "par envoi", provider, currencyISO);
}

/**
 * Plafond journalier. LÈVE `AmlLimitUnavailableError` dans les mêmes conditions.
 */
function getDailyLimit(provider, currencyISO) {
  return resoudrePlafond(AML_DAILY_LIMITS, "journalier", provider, currencyISO);
}

/**
 * Le couple rail/devise est-il couvert ? Pour les usages d'AFFICHAGE (barème,
 * écran de sélection) où lever serait disproportionné. À ne JAMAIS utiliser
 * pour décider de laisser passer de l'argent.
 */
function isRailSupported(provider) {
  return Boolean(AML_SINGLE_TX_LIMITS[normalizeRail(provider)]);
}

module.exports = {
  AML_SINGLE_TX_LIMITS,
  AML_DAILY_LIMITS,
  LIMIT_PROVENANCE,
  KNOWN_RAILS,
  RAIL_ALIASES,
  AmlLimitUnavailableError,
  getSingleTxLimit,
  getDailyLimit,
  isRailSupported,
  resolveAmlCurrency,
  resolveAmlAmount,
  normalizeIso,
  normalizeRail,
};
