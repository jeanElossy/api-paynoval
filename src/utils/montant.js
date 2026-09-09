"use strict";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * LA FRONTIÈRE MONÉTAIRE — ELLE ARRÊTE, ELLE NE REPLIE PAS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * RÈGLE B.2 du projet, citée mot pour mot :
 *
 *   « Une donnée financière absente, illisible ou incohérente ARRÊTE
 *     l'opération avec une erreur explicite ; elle ne prend jamais de valeur
 *     par défaut. `montant || 0` sur une frontière de tarification transforme
 *     une panne en perte silencieuse. »
 *
 * Ce module existe parce que le motif fautif était présent à **dix endroits**
 * du chemin de l'argent :
 *
 *     amount: Number(tx.amountTarget || tx.localAmount || 0)
 *     currency: tx.currencyTarget || tx.localCurrencySymbol || null
 *
 * Ce que produisait ce code, concrètement :
 *
 *   • un champ de montant absent — parce qu'un renommage l'a déplacé, parce
 *     qu'une tarification a échoué en amont, parce qu'un flux n'alimente pas
 *     `amountTarget` — donnait un ordre de paiement **à zéro**, accepté par
 *     l'opérateur, et une transaction qui paraît partie ;
 *   • une devise absente donnait `null`, que l'adapter transformait en défaut
 *     (`XOF` chez trois opérateurs) : un virement pouvait donc partir dans une
 *     devise que PERSONNE n'a choisie. C'est le pire des deux, parce qu'un
 *     montant nul finit par se voir et qu'une devise fausse, non.
 *
 * ═══ POURQUOI LEVER PLUTÔT QUE JOURNALISER ═══════════════════════════════
 *
 * Un journal d'avertissement suppose que quelqu'un le lise avant que l'argent
 * ne parte. Il ne part pas plus tard : il part dans la même milliseconde.
 * Le seul moment où l'on peut encore décider est AVANT l'appel prestataire —
 * donc ici, en levant.
 *
 * L'erreur porte `status = 422` : la requête est bien formée mais la donnée
 * financière est inexploitable. Ce n'est ni un 400 (le client n'a rien fait de
 * mal, le défaut est chez nous) ni un 500 (rien n'est cassé, une valeur
 * manque). Un 422 dit à l'appelant : ne rejoue pas tel quel.
 *
 * ⚠️ NE PAS AJOUTER DE VALEUR PAR DÉFAUT À CE MODULE, sous aucun prétexte de
 * robustesse. Un défaut « raisonnable » sur une frontière monétaire est
 * exactement ce que ce module a été écrit pour supprimer.
 */

/** Codes stables — une alerte peut s'y accrocher. Ne pas les reformuler. */
const CODES = Object.freeze({
  MONTANT_ABSENT: "MONTANT_ABSENT",
  MONTANT_INVALIDE: "MONTANT_INVALIDE",
  DEVISE_ABSENTE: "DEVISE_ABSENTE",
});

function erreurMonetaire(code, message, contexte) {
  const err = new Error(message);
  err.status = 422;
  err.code = code;
  err.contexte = contexte || null;
  return err;
}

/**
 * Rend un montant exploitable, ou LÈVE.
 *
 * Accepte un nombre ou une chaîne numérique. Refuse : `undefined`, `null`,
 * chaîne vide, `NaN`, `Infinity`, et tout montant négatif ou nul — un ordre de
 * paiement à zéro n'a pas de sens métier, et c'est précisément le symptôme que
 * produisait `|| 0`.
 *
 * @param {unknown} valeur
 * @param {string} contexte  d'où vient l'appel, pour le diagnostic
 * @returns {number}
 */
function exigerMontant(valeur, contexte) {
  if (valeur === undefined || valeur === null || valeur === "") {
    throw erreurMonetaire(
      CODES.MONTANT_ABSENT,
      `Montant absent (${contexte}) — l'ordre est refusé plutôt qu'émis à zéro.`,
      contexte
    );
  }

  const nombre = Number(valeur);

  if (!Number.isFinite(nombre) || nombre <= 0) {
    throw erreurMonetaire(
      CODES.MONTANT_INVALIDE,
      `Montant invalide (${contexte}) : ${JSON.stringify(valeur)}.`,
      contexte
    );
  }

  return nombre;
}

/**
 * Rend une devise exploitable, ou LÈVE.
 *
 * La normalisation des alias (`FCFA` → `XOF`) reste la responsabilité de
 * `utils/currency.js` ; ici on refuse seulement l'absence, qui est le cas où
 * l'adapter appliquerait son propre défaut.
 *
 * @param {unknown} valeur
 * @param {string} contexte
 * @returns {string}
 */
function exigerDevise(valeur, contexte) {
  const texte = String(valeur ?? "").trim();

  if (!texte) {
    throw erreurMonetaire(
      CODES.DEVISE_ABSENTE,
      `Devise absente (${contexte}) — l'ordre est refusé plutôt qu'émis dans ` +
        `la devise par défaut de l'adapter.`,
      contexte
    );
  }

  return texte;
}

module.exports = { exigerMontant, exigerDevise, CODES };
