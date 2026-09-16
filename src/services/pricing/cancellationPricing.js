"use strict";

/**
 * ============================================================================
 * FRAIS D'ANNULATION — LE MÊME MOTEUR QUE LE RESTE DES PRIX
 * ============================================================================
 *
 * ── Les trois sources qui coexistaient (mesuré le 2026-09-16) ───────────────
 *
 *   1. `config/cancellationFees.js` — table CODÉE EN DUR, deux pays (Canada
 *      2,99 CAD, Côte d'Ivoire 300 XOF) et un repli par devise. C'est elle qui
 *      PRÉLEVAIT réellement.
 *   2. la collection `Fee` — lue par `/fees/simulate?type=cancellation`, c'est
 *      elle qui AFFICHAIT le montant à l'utilisateur.
 *   3. un repli en dur dans ce même endpoint (2,99 / 300 / 2) quand aucun
 *      document `Fee` ne correspondait.
 *
 * Un utilisateur pouvait donc voir un montant d'annulation et s'en voir
 * prélever un autre — et modifier le barème affiché n'avait aucun effet sur ce
 * qui était prélevé. C'est la même famille de défaut que les taux
 * personnalisés : une surface d'administration qui répond succès sans rien
 * changer.
 *
 * ── Ce que ce module établit ────────────────────────────────────────────────
 *
 * Une source : les barèmes `PricingRule` de type `CANCELLATION`, gouvernés par
 * le circuit à quatre yeux, versionnés, historisés. L'affichage et le
 * prélèvement l'interrogent tous les deux.
 *
 * ── Le repli statique, et pourquoi il SUBSISTE ──────────────────────────────
 *
 * La règle générale du chemin de l'argent est de refuser en fermeture : sans
 * barème, pas de prix (c'est ce que font les cagnottes, qui répondent 503).
 * Ici, l'arbitrage est différent et il est délibéré :
 *
 *     refuser une ANNULATION, c'est retenir les fonds d'un utilisateur
 *     qui demande à les libérer.
 *
 * C'est pourquoi `/cancel` est déjà la seule route financière dispensée des
 * contrôles d'éligibilité et d'AML : un compte bloqué doit pouvoir récupérer
 * son argent. Refuser faute de barème produirait exactement ce qu'on cherche à
 * éviter.
 *
 * Le repli reste donc la table statique — mais il est **nommé, daté et
 * bruyant** : chaque recours est journalisé avec sa conséquence, de sorte que
 * « aucun barème d'annulation n'est publié » soit un fait visible et non une
 * découverte. Il disparaîtra le jour où les règles seront approuvées
 * (`npm run seed:cancellation-pricing`).
 */

const { getActiveRules } = require("./ruleCache");
const { pickBestRule, computeFee } = require("./pricingEngine");

const TX_TYPE = "CANCELLATION";

/**
 * Sélectionne le barème d'annulation applicable et calcule les frais.
 *
 * PUR : les règles sont fournies par l'appelant. C'est ce qui permet de tester
 * chaque corridor sans base.
 *
 * @param {object} params
 * @param {Array}  params.rules      Barèmes actifs.
 * @param {number} params.amount     Montant de la transaction annulée.
 * @param {string} params.currency   Devise de ce montant.
 * @param {string} [params.country]  Pays de l'expéditeur.
 * @param {string} [params.method]   Rail d'origine.
 * @param {string} [params.provider]
 * @param {number} [params.now]      Horloge injectable (fenêtre de validité).
 * @returns {{amount: number, currency: string, type: string, percent: number,
 *            source: string, label: string, resolvedBy: string,
 *            ruleId: *, ruleVersion: number, breakdown: object}|null}
 */
function resoudreDepuisBaremes({
  rules,
  amount,
  currency,
  country = null,
  method = null,
  provider = null,
  now,
}) {
  const devise = String(currency || "").trim().toUpperCase();
  const montant = Number(amount);

  if (!devise || !Number.isFinite(montant) || montant <= 0) return null;

  const regle = pickBestRule(rules, {
    txType: TX_TYPE,
    /**
     * Le rail et le fournisseur restent facultatifs : un barème d'annulation
     * s'écrit le plus souvent « toutes méthodes ». Les passer quand on les
     * connaît permet néanmoins d'en écrire un plus spécifique sans changer ce
     * code.
     */
    method: method || "",
    provider: provider || "",
    amount: montant,
    fromCurrency: devise,
    toCurrency: devise,
    country,
    fromCountry: country,
    toCountry: country,
    now,
  });

  if (!regle) return null;

  const { fee, breakdown } = computeFee(montant, regle.fee, devise);
  const version = Number(regle.currentVersion ?? regle.version ?? 1);

  return {
    amount: fee,
    currency: devise,
    type: String(breakdown?.mode || "").toLowerCase() === "percent" ? "percent" : "fixed",
    percent: Number(breakdown?.percent || 0),
    feeId: regle._id || null,
    source: `PRICING_RULE:${regle.code || regle._id}@v${version}`,
    label: `${fee} ${devise}`,
    resolvedBy: "pricing_rule",
    ruleId: regle._id || null,
    ruleVersion: version,
    breakdown,
  };
}

/**
 * Variante qui va chercher les barèmes actifs (servis par le cache).
 * Rend `null` quand aucun barème d'annulation ne couvre le cas — à l'appelant
 * de décider ce qu'il en fait, et de le DIRE.
 */
async function resolveCancellationFeeFromRules(params) {
  const rules = await getActiveRules();
  return resoudreDepuisBaremes({ ...params, rules });
}

module.exports = {
  TX_TYPE,
  resoudreDepuisBaremes,
  resolveCancellationFeeFromRules,
};
