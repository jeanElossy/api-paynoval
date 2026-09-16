"use strict";

/**
 * ============================================================================
 * UNE MISE À JOUR NE PEUT PAS EFFACER CE QU'ELLE NE MENTIONNE PAS
 * ============================================================================
 *
 * ── Le défaut mesuré le 2026-09-16 ──────────────────────────────────────────
 *
 * Un administrateur a porté la marge de change d'un barème de 1,5 % à 3 %. La
 * demande enregistrée portait QUATRE changements :
 *
 *   code              "TRANSFER_MOBILEMONEY_DEFAULT" → null
 *   description       "Barème par défaut pour…"      → ""
 *   fx.markupPercent  1.5                            → 3        ← le seul voulu
 *   scope.provider    "all"                          → "wave"
 *
 * Trois champs perdus pour un champ modifié. Le formulaire n'émet ni `code`,
 * ni `description`, ni `notes` ; `normalizeProposed` transforme ces absences en
 * `null` et `""` ; `publish()` les écrit avec un `$set`. Personne n'a menti :
 * chaque couche a fait ce qu'on lui demandait.
 *
 * Conséquence concrète : la règle ayant perdu son code est devenue invisible
 * pour `scripts/seedRailPricingRules.js`, qui cherche par `code` — relancer le
 * seed aurait déposé un DOUBLON sur le plus gros rail du parc.
 *
 * ── Le remède : sémantique de FUSION (PATCH) ────────────────────────────────
 *
 * Un champ non transmis reste inchangé. C'est la sémantique de Stripe, et elle
 * supprime la classe entière de défauts plutôt que d'en protéger une liste :
 * aucun client — formulaire, script, partenaire, écran futur — ne peut plus
 * effacer par omission.
 *
 * Contrepartie assumée : pour VIDER un champ, il faut l'envoyer explicitement
 * (`{ code: null }`). C'est le bon sens du compromis — effacer devient un acte,
 * plus un effet de bord.
 *
 * ⚠️ La distinction « absent » / « transmis » ne peut se lire que sur le corps
 * BRUT. Une fois `normalizeProposed` passé, un champ jamais envoyé et un champ
 * envoyé à `null` sont devenus indiscernables. C'est pourquoi cette fonction
 * reçoit les deux.
 *
 * Module PUR : aucune base, aucun réseau.
 */

/**
 * Sous-objets fusionnés CHAMP PAR CHAMP. Sans cela, envoyer `fee: { percent: 2 }`
 * effacerait `minFee` et `maxFee` — le défaut d'origine, d'un cran plus bas.
 */
const OBJETS_FUSIONNABLES = Object.freeze(["scope", "fee", "fx", "amountRange"]);

/** `true` seulement si la clé est PRÉSENTE, même portant `null`. */
function aEteTransmis(objet, cle) {
  return (
    objet !== null &&
    typeof objet === "object" &&
    Object.prototype.hasOwnProperty.call(objet, cle)
  );
}

function estObjet(valeur) {
  return valeur !== null && typeof valeur === "object" && !Array.isArray(valeur);
}

/**
 * @param {object|null} base      snapshot de la règle existante (`buildSnapshot`),
 *                                `null` pour une création — rien à préserver.
 * @param {object} brut           le corps reçu, NON normalisé.
 * @param {object} normalise      le même corps après `normalizeProposed`.
 * @returns {object} l'état complet que la règle aura après publication.
 */
function fusionnerProposed({ base, brut, normalise }) {
  if (!base) return normalise;

  const resultat = { ...base };

  for (const cle of Object.keys(normalise)) {
    if (OBJETS_FUSIONNABLES.includes(cle)) continue;
    if (aEteTransmis(brut, cle)) resultat[cle] = normalise[cle];
  }

  for (const cle of OBJETS_FUSIONNABLES) {
    const sousBase = estObjet(base[cle]) ? base[cle] : {};
    const sousNormalise = estObjet(normalise[cle]) ? normalise[cle] : {};
    const sousBrut = brut?.[cle];

    const fusion = { ...sousBase };

    if (aEteTransmis(brut, cle)) {
      for (const sousCle of Object.keys(sousNormalise)) {
        if (aEteTransmis(sousBrut, sousCle)) fusion[sousCle] = sousNormalise[sousCle];
      }
    }

    resultat[cle] = fusion;
  }

  return resultat;
}

module.exports = { fusionnerProposed, OBJETS_FUSIONNABLES };
