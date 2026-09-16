"use strict";

/**
 * ============================================================================
 * LA GRILLE TARIFAIRE PAR CORRIDOR — CONSTRUCTION PURE
 * ============================================================================
 *
 * ── Pourquoi une grille, et pas une règle « tous pays » ─────────────────────
 *
 * Les huit barèmes déposés le 2026-09-16 portaient `country: ALL` et
 * `fromCurrency/toCurrency: ALL` : un tarif unique pour tous les marchés. Cela
 * suffit à ouvrir un rail, pas à l'exploiter. Un dépôt Wave en Côte d'Ivoire et
 * un dépôt MTN au Cameroun n'ont pas la même commission prestataire, et un
 * corridor EUR→XOF n'a pas la même marge qu'un XOF→XOF — qui n'en a aucune,
 * faute de conversion.
 *
 * ── Les deux axes, et pourquoi ils diffèrent selon l'opération ──────────────
 *
 * VIREMENT INTERNE : l'axe qui commande est la PAIRE DE DEVISES. Le coût est
 * celui du change, pas celui d'un prestataire. Une grille par paire de PAYS
 * ferait 196 règles pour 14 marchés — et plusieurs milliers croisée avec les
 * devises. Personne n'approuve cela une par une, et l'immense majorité des
 * cases ne correspondrait à aucun produit réel.
 *
 * DÉPÔT / RETRAIT : la devise est la même des deux côtés (portefeuille XOF ↔
 * mobile money XOF). Ce qui varie est la COMMISSION DE L'OPÉRATEUR, qui diffère
 * par opérateur ET par pays. L'axe est donc `country × provider`.
 *
 * ── La spécificité rend l'ajout SÛR ─────────────────────────────────────────
 *
 * Mesuré dans `pricingEngine.computeSpecificity` : txType 60, method 50,
 * provider 45, fromCountry/toCountry 35, fromCurrency/toCurrency 25, country 20.
 * Une règle de cette grille écrase donc toujours la règle « tous pays »
 * correspondante, qui reste en place comme FILET. Aucune suppression, aucun
 * trou pendant la transition.
 *
 * ⚠️ Conséquence à connaître : `provider` (45) pèse plus que `fromCountry` (35).
 * Une règle épinglée sur un opérateur SANS pays battrait une règle pays. C'est
 * pourquoi chaque règle dépôt/retrait porte les DEUX dimensions ensemble, et
 * jamais l'une sans l'autre.
 *
 * Module PUR : aucune base, aucun réseau. Testable sans rien démarrer.
 */

/**
 * Les marchés servis, et la devise de chacun.
 *
 * ⚠️ HYPOTHÈSE DE DÉPART, À CONFIRMER — ce n'est pas une donnée mesurée.
 * Aucune liste de pays servis n'existe dans le code : `User.country` est du
 * texte libre sans énumération, et `countryRegion.js` côté mobile ne fait que
 * classer « Afrique / hors Afrique ». Cette liste vient des zones retenues en
 * séance le 2026-09-16, pas d'une source technique.
 */
const MARCHES = Object.freeze([
  { pays: "CI", devise: "XOF", zone: "UEMOA", nom: "Côte d'Ivoire" },
  { pays: "SN", devise: "XOF", zone: "UEMOA", nom: "Sénégal" },
  { pays: "BF", devise: "XOF", zone: "UEMOA", nom: "Burkina Faso" },
  { pays: "ML", devise: "XOF", zone: "UEMOA", nom: "Mali" },
  { pays: "TG", devise: "XOF", zone: "UEMOA", nom: "Togo" },
  { pays: "BJ", devise: "XOF", zone: "UEMOA", nom: "Bénin" },
  { pays: "CM", devise: "XAF", zone: "CEMAC", nom: "Cameroun" },
  { pays: "GA", devise: "XAF", zone: "CEMAC", nom: "Gabon" },
  { pays: "CG", devise: "XAF", zone: "CEMAC", nom: "Congo" },
  { pays: "TD", devise: "XAF", zone: "CEMAC", nom: "Tchad" },
  { pays: "FR", devise: "EUR", zone: "EUROPE", nom: "France" },
  { pays: "BE", devise: "EUR", zone: "EUROPE", nom: "Belgique" },
  { pays: "CA", devise: "CAD", zone: "AMNORD", nom: "Canada" },
  { pays: "US", devise: "USD", zone: "AMNORD", nom: "États-Unis" },
]);

/**
 * Quel opérateur mobile money sert quel pays.
 *
 * ⚠️⚠️ HYPOTHÈSE DE DÉPART, À CONFIRMER AVANT APPROBATION.
 *
 * Le code ne déclare NULLE PART cette correspondance : les quatre adaptateurs
 * de `src/providers/mobilemoney/` relaient `input.country` sans rien en savoir.
 * Ces listes sont donc une connaissance de marché, pas une mesure — et c'est
 * exactement en inventant des combinaisons qu'on a produit `DEPOSIT · INTERNAL`,
 * un barème pour une opération qui n'existe pas.
 *
 * Seuls les quatre opérateurs réellement intégrés figurent ici
 * (`RAILS` de `models/Transaction.js`). Un pays sans opérateur reste VIDE : la
 * grille l'annonce au lieu de lui fabriquer une couverture.
 */
const OPERATEURS_PAR_PAYS = Object.freeze({
  CI: ["orange", "mtn", "moov", "wave"],
  SN: ["orange", "wave"],
  BF: ["orange", "moov", "wave"],
  ML: ["orange", "moov"],
  TG: ["moov"],
  BJ: ["mtn", "moov"],
  CM: ["orange", "mtn"],
  CG: ["mtn"],
  GA: [],
  TD: [],
  FR: [],
  BE: [],
  CA: [],
  US: [],
});

/** Le seul opérateur carte intégré — `stripe` a été retiré le 2026-09-08. */
const OPERATEUR_CARTE = "visa_direct";

/** Devises distinctes présentes dans les marchés, triées pour un ordre stable. */
function devisesServies(marches = MARCHES) {
  return [...new Set(marches.map((m) => m.devise))].sort();
}

function paysSansOperateur(carte = OPERATEURS_PAR_PAYS, marches = MARCHES) {
  return marches
    .filter((m) => !(carte[m.pays] || []).length)
    .map((m) => m.pays);
}

/**
 * Une règle de change : la marge ne s'applique QUE s'il y a conversion.
 *
 * Le validateur refuse une marge non nulle en mode `PASS_THROUGH`, et le moteur
 * impose un taux de 1 quand les deux devises sont identiques. Poser une marge
 * sur un corridor en devise identique serait un frais caché — il n'apparaîtrait
 * sur aucune ligne de frais, donc ni sur le reçu ni dans la ventilation.
 */
function changePour(deviseSource, deviseCible, markupPercent) {
  if (deviseSource === deviseCible) {
    return { mode: "PASS_THROUGH", markupPercent: 0 };
  }

  return { mode: "MARKUP_PERCENT", markupPercent };
}

/** Virement interne : une règle par PAIRE DE DEVISES, tous pays. */
function reglesVirementInterne({ feePercent, markupPercent, devises }) {
  const regles = [];

  for (const de of devises) {
    for (const vers of devises) {
      regles.push({
        name: `Virement interne — ${de} → ${vers}`,
        code: `TRANSFER_INTERNAL_${de}_${vers}`,
        description:
          `Virement PayNoval → PayNoval, corridor ${de} → ${vers}. ` +
          (de === vers
            ? "Aucune conversion, donc aucune marge de change."
            : `Marge de change de ${markupPercent} % à AJUSTER selon le corridor.`),
        active: true,
        priority: 0,
        category: "pricing",
        scope: {
          txType: "TRANSFER",
          method: "INTERNAL",
          provider: "paynoval",
          country: "ALL",
          fromCountry: "ALL",
          toCountry: "ALL",
          fromCurrency: de,
          toCurrency: vers,
        },
        fee: { mode: "PERCENT", percent: feePercent },
        fx: changePour(de, vers, markupPercent),
        amountRange: { min: 0, max: null },
      });
    }
  }

  return regles;
}

/**
 * Dépôt et retrait : une règle par (pays × opérateur), en devise identique.
 *
 * Les deux sens sont générés séparément parce qu'ils n'ont PAS le même coût :
 * une collecte (dépôt) et un versement (retrait) sont facturés différemment par
 * tous les opérateurs mobile money.
 */
function reglesDepotRetrait({ feePercent, marches, operateursParPays }) {
  const regles = [];

  for (const { pays, devise, nom } of marches) {
    const operateurs = operateursParPays[pays] || [];

    for (const provider of operateurs) {
      for (const txType of ["DEPOSIT", "WITHDRAW"]) {
        const libelle = txType === "DEPOSIT" ? "Dépôt" : "Retrait";

        regles.push({
          name: `${libelle} — ${provider} ${nom}`,
          code: `${txType}_MOBILEMONEY_${pays}_${provider.toUpperCase()}`,
          description:
            `${libelle} mobile money ${provider} en ${nom}, en ${devise}. ` +
            "À AJUSTER : la commission de l'opérateur diffère selon le sens " +
            "(collecte ou versement) et selon le pays.",
          active: true,
          priority: 0,
          category: "pricing",
          scope: {
            txType,
            method: "MOBILEMONEY",
            provider,
            country: pays,
            fromCountry: "ALL",
            toCountry: "ALL",
            fromCurrency: devise,
            toCurrency: devise,
          },
          fee: { mode: "PERCENT", percent: feePercent },
          fx: changePour(devise, devise),
          amountRange: { min: 0, max: null },
        });
      }
    }

    for (const txType of ["DEPOSIT", "WITHDRAW"]) {
      const libelle = txType === "DEPOSIT" ? "Dépôt" : "Retrait";

      regles.push({
        name: `${libelle} — carte ${nom}`,
        code: `${txType}_CARD_${pays}`,
        description:
          `${libelle} par carte en ${nom}, en ${devise}. ` +
          "À AJUSTER : les frais d'acquisition carte diffèrent par pays.",
        active: true,
        priority: 0,
        category: "pricing",
        scope: {
          txType,
          method: "CARD",
          provider: OPERATEUR_CARTE,
          country: pays,
          fromCountry: "ALL",
          toCountry: "ALL",
          fromCurrency: devise,
          toCurrency: devise,
        },
        fee: { mode: "PERCENT", percent: feePercent },
        fx: changePour(devise, devise),
        amountRange: { min: 0, max: null },
      });
    }
  }

  return regles;
}

/**
 * @param {object} options
 * @param {number} options.feePercent    frais de calage, identiques partout.
 * @param {number} options.markupPercent marge de calage, sur les corridors convertis.
 * @returns {Array<object>} la grille complète, prête pour `validateProposedRule`.
 */
function construireGrille({
  feePercent = 1,
  markupPercent = 1.5,
  marches = MARCHES,
  operateursParPays = OPERATEURS_PAR_PAYS,
} = {}) {
  const devises = devisesServies(marches);

  return [
    ...reglesVirementInterne({ feePercent, markupPercent, devises }),
    ...reglesDepotRetrait({ feePercent, marches, operateursParPays }),
  ];
}

module.exports = {
  MARCHES,
  OPERATEURS_PAR_PAYS,
  OPERATEUR_CARTE,
  devisesServies,
  paysSansOperateur,
  construireGrille,
};
