"use strict";

/**
 * LECTURE DES MONTANTS D'UNE TRANSACTION — LOGIQUE PURE
 * -----------------------------------------------------------------------------
 * Extrait de `services/transactions/transactionNotificationService.js`, qui ne
 * peut pas être chargé hors d'un environnement complet (`dotenv-safe` exige
 * toutes les variables, et le module ouvre deux connexions Mongo au `require`).
 * Ces trois lectures, elles, ne dépendent de rien : les isoler ici les rend
 * testables sans serveur ni base — la propriété que toutes les suites du
 * projet partagent.
 *
 * ═══ LES TROIS CHAMPS, ET CE QU'ILS SIGNIFIENT VRAIMENT ═══════════════════
 *
 * La tarification (`services/transactions/shared/pricing.js`) écrit :
 *
 *     tx.amount           = grossFrom        → TOTAL débité, frais COMPRIS
 *     tx.transactionFees  = fee              → frais prélevés
 *     tx.netAmount        = grossFrom − fee  → montant réellement transféré
 *
 * C'est contre-intuitif : `amount` n'est PAS « le montant envoyé », c'est ce
 * que l'expéditeur paie. Un e-mail qui afficherait `amount` en « Montant »
 * puis ajouterait une ligne « Frais » compterait les frais deux fois.
 *
 * ⚠️ AUCUNE DE CES FONCTIONS NE CALCULE. Elles LISENT des valeurs arrêtées à
 * l'initiation de la transaction. Recalculer `net = amount − fee` au moment de
 * l'envoi ferait diverger l'e-mail du grand livre le jour où la tarification
 * change — et l'e-mail est la pièce que le client oppose au support.
 */

/**
 * Première valeur numériquement exploitable de la liste, ou `null`.
 *
 * `null` n'est pas `0`, et la distinction est tout l'intérêt : `0` affirme
 * qu'aucun frais n'a été prélevé, `null` dit qu'on l'ignore. Le gabarit masque
 * la ligne dans le second cas au lieu d'affirmer quelque chose de faux.
 *
 * Les montants sont stockés en `Decimal128` : `Number()` sur l'objet Mongoose
 * rend `NaN`, d'où le passage explicite par `toString()`.
 */
function readMoneyField(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;

    const raw =
      typeof value === "object" && typeof value.toString === "function"
        ? value.toString()
        : value;

    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }

  return null;
}

/** Frais prélevés à l'expéditeur, dans la devise source. */
function buildSenderFee(tx = {}) {
  return readMoneyField(
    tx?.transactionFees,
    tx?.feeSource,
    tx?.money?.feeSource?.amount,
    tx?.feeSnapshot?.fee
  );
}

/** Montant transféré après frais, dans la devise source. */
function buildSenderNet(tx = {}) {
  return readMoneyField(tx?.netAmount, tx?.feeSnapshot?.netAfterFees);
}

/** Total débité à l'expéditeur, frais compris. */
function buildSenderTotal(tx = {}) {
  return readMoneyField(tx?.amount, tx?.amountSource, tx?.money?.source?.amount);
}

module.exports = {
  readMoneyField,
  buildSenderFee,
  buildSenderNet,
  buildSenderTotal,
};
