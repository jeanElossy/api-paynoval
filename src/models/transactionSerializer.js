"use strict";

/**
 * SÉRIALISATION D'UNE TRANSACTION — SOURCE UNIQUE DE VÉRITÉ
 * ============================================================================
 *
 * Ce module existe parce que l'historique ne passe plus par des documents
 * Mongoose hydratés.
 *
 * `listInternal` lit désormais en `.lean()` : Mongo rend des objets simples,
 * sans méthode `toJSON()`. Or c'est précisément `toJSON()` qui, jusqu'ici,
 * **supprimait les secrets** de chaque transaction avant de l'envoyer au
 * client : `securityAnswerHash`, `verificationToken`, `securityCode`, et le
 * compteur de tentatives.
 *
 * Un `.lean()` posé sans y prendre garde n'aurait pas planté : il aurait
 * renvoyé l'objet brut, secrets compris, avec le même code HTTP 200. C'est la
 * pire forme de régression — silencieuse, et sur le chemin le plus fréquenté de
 * l'application.
 *
 * La règle qu'on applique ici est celle que le dépôt s'est déjà donnée ailleurs
 * (`utils/rateLimitKey.js`, `utils/redactSensitive.js`) : quand deux chemins
 * doivent produire le même résultat, la logique vit dans UN module pur, et les
 * deux chemins l'appellent. Le `toJSON` du schéma délègue à cette fonction ; la
 * lecture `.lean()` l'appelle directement. Ils ne peuvent plus diverger.
 *
 * Le précédent est documenté dans la mémoire du projet : le validateur de
 * `/confirm` portait `.escape()` et celui d'`/initiate` ne le portait pas. Deux
 * chemins censés calculer la même empreinte, une divergence d'un seul appel, et
 * toute réponse contenant une apostrophe devenait définitivement inconfirmable.
 * On ne refait pas cette erreur sur les secrets d'une transaction.
 */

/**
 * Champs jamais transmis au client.
 *
 * Cette liste est la reprise exacte des `delete` que portait le `toJSON` du
 * schéma. Ne rien y retirer sans vérifier ce qui consomme le champ : le retrait
 * d'une seule ligne suffit à exposer un secret sur `GET /api/v1/transactions`.
 */
const SECRET_FIELDS = Object.freeze([
  "securityCode",
  "securityAnswerHash",
  "verificationToken",
  "attemptCount",
  "lastAttemptAt",
  "lockedUntil",

  /**
   * ⚠️ `webhookHistory` SORTAIT DE L'API, ET IL PORTAIT LE CORPS BRUT DES
   * RAPPELS PRESTATAIRE.
   *
   * `appendWebhookHistory` y recopiait `payload.raw` — la charge telle que le
   * prestataire l'a envoyée. Selon le rail, elle contient le numéro de
   * téléphone et le nom du bénéficiaire, ou les quatre derniers chiffres d'une
   * carte. Ces cinquante dernières entrées partaient donc dans CHAQUE réponse
   * portant une transaction : application mobile, back-office, passerelle.
   *
   * C'est le même défaut que celui corrigé sur `provider_webhook_events`, en
   * pire : la collection avait au moins une rétention de 90 jours, alors qu'une
   * transaction ne s'efface jamais.
   *
   * Le champ reste EN BASE — c'est une trace d'exploitation utile au support et
   * à la réconciliation. Il n'a simplement rien à faire dans la représentation
   * publique : aucun client ne le lit (vérifié sur les cinq dépôts).
   */
  "webhookHistory",
]);

/**
 * Champs stockés en `Decimal128` et rendus en nombre.
 *
 * Decimal128 est le bon type en base — il ne perd pas de centimes. Mais il se
 * sérialise en `{ $numberDecimal: "…" }`, que le client ne sait pas lire.
 */
const DECIMAL_FIELDS = Object.freeze([
  "amount",
  "transactionFees",
  "netAmount",
  "exchangeRate",
  "localAmount",
  "amountSource",
  "amountTarget",
  "feeSource",
  "fxRateSourceToTarget",
]);

function decToNumber(v) {
  if (v == null) return v;

  try {
    return parseFloat(v.toString());
  } catch {
    return v;
  }
}

/**
 * Normalise le sous-objet `money`, qui porte ses propres montants.
 *
 * On recopie avant de muter : `ret.money` peut être l'objet du document en
 * mémoire (chemin `toJSON`), et le muter en place corromprait le document pour
 * tout ce qui le lirait ensuite dans la même requête.
 */
function normalizeMoney(money) {
  if (!money || typeof money !== "object") return money;

  const m = { ...money };

  if (m.source?.amount != null) {
    m.source = { ...m.source, amount: Number(m.source.amount) };
  }

  if (m.feeSource?.amount != null) {
    m.feeSource = { ...m.feeSource, amount: Number(m.feeSource.amount) };
  }

  if (m.target?.amount != null) {
    m.target = { ...m.target, amount: Number(m.target.amount) };
  }

  if (m.fxRateSourceToTarget != null) {
    m.fxRateSourceToTarget = Number(m.fxRateSourceToTarget);
  }

  return m;
}

/**
 * Applique la représentation publique d'une transaction.
 *
 * @param {object} ret  Objet à normaliser. Muté sur place — c'est le contrat
 *                      qu'attend le `transform` de Mongoose, qui reçoit `ret`
 *                      et le renvoie.
 * @returns {object}    Le même objet, normalisé.
 */
function serializeTransaction(ret) {
  if (!ret || typeof ret !== "object") return ret;

  if (ret._id != null) ret.id = ret._id;

  for (const field of DECIMAL_FIELDS) {
    if (field in ret) ret[field] = decToNumber(ret[field]);
  }

  if (ret.money && typeof ret.money === "object") {
    ret.money = normalizeMoney(ret.money);
  }

  delete ret._id;

  for (const field of SECRET_FIELDS) {
    delete ret[field];
  }

  /**
   * `__v` n'apparaissait pas dans la sortie hydratée — Mongoose ne l'expose pas
   * via `toJSON` par défaut, mais `.lean()` le rend tel quel. On l'écarte pour
   * que les deux chemins produisent réellement le même objet.
   */
  delete ret.__v;

  return ret;
}

/**
 * Variante non destructive, pour les objets `.lean()`.
 *
 * Mongo rend des objets qui n'appartiennent qu'à l'appelant, donc muter serait
 * sans conséquence ici. On copie quand même : cela rend la fonction sûre à
 * appeler sur n'importe quoi, y compris un objet partagé ou gelé, et le coût
 * d'une copie de surface est négligeable devant celui de la requête.
 */
function toPublicTransaction(doc) {
  if (!doc || typeof doc !== "object") return doc;

  return serializeTransaction({ ...doc });
}

module.exports = {
  serializeTransaction,
  toPublicTransaction,
  SECRET_FIELDS,
  DECIMAL_FIELDS,
};
