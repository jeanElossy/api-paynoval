"use strict";

/**
 * ============================================================================
 * L'INDEX DE DÉDUPLICATION EXISTE-T-IL VRAIMENT ?
 * ============================================================================
 *
 * `scripts/ensure-ledger-indexes.js` se lance À LA MAIN. Rien ne garantissait
 * qu'il l'ait été avant le déploiement qui commence à écrire `dedupKey`, et
 * l'inversion est coûteuse dans les deux sens :
 *
 *   - index absent → AUCUNE protection contre le double enregistrement d'un
 *     mouvement en mode dégradé, alors que le code se comporte comme s'il en
 *     avait une. C'est le pire des deux états : une garantie affichée que la
 *     base ne porte pas ;
 *   - pire encore, les doublons écrits pendant cette fenêtre feront ensuite
 *     ÉCHOUER la construction de l'index — la protection manquera précisément
 *     parce qu'elle a déjà été prise en défaut.
 *
 * D'où ce contrôle au démarrage. Il ne CRÉE rien : créer un index unique sans
 * qu'un humain ait choisi le moment est exactement ce que la politique de ce
 * dépôt refuse (voir l'en-tête de `scripts/ensure-ledger-indexes.js`). Il se
 * contente de dire la vérité, bruyamment.
 *
 * ⚠️ IL N'ARRÊTE PAS LE DÉMARRAGE, ET C'EST DÉLIBÉRÉ. Refuser de démarrer
 * priverait les utilisateurs du service entier pour une protection qui ne
 * concerne qu'un régime dégradé et un rejeu. Le bon arbitrage est un
 * avertissement que l'exploitation ne peut pas manquer, pas une panne.
 */

const INDEX_NAME = "dedupKey_unique_partial";
const COLLECTION = "ledgerentries";

/**
 * Les index qui sont des CONTRAINTES D'INTÉGRITÉ, pas des optimisations.
 *
 * Ils partagent la même propriété redoutable : leur absence ne se voit pas. Le
 * code continue de fonctionner, il se comporte simplement comme s'il avait une
 * protection qu'il n'a plus — et on ne s'en aperçoit qu'après le doublon.
 */
const CRITICAL_INDEXES = Object.freeze([
  {
    collection: "ledgerentries",
    name: "dedupKey_unique_partial",
    protects:
      "un rejeu en mode dégradé enregistrerait le même mouvement deux fois, " +
      "et le grand livre resterait ÉQUILIBRÉ — donc la balance de vérification " +
      "ne le signalerait pas",
  },
  {
    collection: "provider_webhook_events",
    name: "uniq_webhook_provider_event",
    protects:
      "un même rappel prestataire serait traité deux fois — or le rejeu est le " +
      "comportement NORMAL d'un prestataire, et un « paiement confirmé » traité " +
      "deux fois crédite le bénéficiaire deux fois",
  },
  {
    collection: "outboxes",
    name: "uniq_outbox_idempotency_key",
    /**
     * Ajouté le 2026-09-03. `models/Outbox.js:120-128` déclare cet index et son
     * propre commentaire DOUTE de sa présence en base : `autoIndex` est coupé
     * hors développement, et un index déclaré n'est pas un index créé.
     *
     * Or le dédoublonnage des événements de parrainage repose sur le `E11000`
     * qu'il produit. Sans lui, ce `E11000` ne se produit jamais et le
     * dédoublonnage est MUET — il croit dédoublonner, il ne dédoublonne rien.
     * C'est exactement la famille de défaut que ce contrôle existe pour rendre
     * visible au démarrage plutôt qu'au premier doublon.
     */
    protects:
      "le dédoublonnage des événements d'outbox repose sur le E11000 de cet " +
      "index : sans lui il ne se produit jamais, et un même événement de " +
      "parrainage peut être versé deux fois",
  },
]);

/**
 * Contrôle l'ensemble des contraintes d'intégrité. Ne lève jamais.
 *
 * @returns {Promise<Array<{collection, name, present, reason, protects}>>}
 */
async function checkCriticalIndexes(conn) {
  const resultats = [];

  for (const cible of CRITICAL_INDEXES) {
    try {
      const indexes = await conn.collection(cible.collection).indexes();
      const noms = (indexes || []).map((ix) => ix.name);
      resultats.push({ ...cible, present: noms.includes(cible.name), reason: "ok" });
    } catch (err) {
      const message = String(err?.message || err);

      // Collection absente : elle n'a évidemment pas l'index, et ce n'est pas
      // une panne — c'est un service qui n'a encore rien reçu.
      const absente = /ns does not exist|NamespaceNotFound/i.test(message);

      resultats.push({
        ...cible,
        present: false,
        reason: absente ? "collection-absente" : `indisponible: ${message}`,
      });
    }
  }

  return resultats;
}

/** Lignes de journal pour l'ensemble. Pure. */
function formatCriticalIndexesReport(resultats = []) {
  const lignes = [];

  for (const r of resultats) {
    if (r.present) {
      lignes.push(`✅ [integrite] ${r.collection}.${r.name} présent`);
      continue;
    }

    if (r.reason === "collection-absente") {
      lignes.push(
        `⚠️ [integrite] ${r.collection} n'existe pas encore — l'index « ${r.name} » ` +
          "sera à créer avant le premier événement."
      );
      continue;
    }

    if (r.reason !== "ok" && r.reason !== "absent") {
      lignes.push(
        `⚠️ [integrite] impossible de vérifier ${r.collection}.${r.name} (${r.reason}).`
      );
      continue;
    }

    lignes.push(
      `❌ [integrite] ${r.collection}.${r.name} ABSENT — ${r.protects}.`,
      "   Lancer : node scripts/ensure-ledger-indexes.js"
    );
  }

  return lignes;
}

/**
 * @returns {Promise<{present: boolean, reason: string, indexes?: string[]}>}
 *   Ne lève jamais : un contrôle de démarrage qui casse le démarrage est un
 *   défaut, pas une sécurité.
 */
async function checkDedupIndex(conn) {
  try {
    const indexes = await conn.collection(COLLECTION).indexes();
    const names = (indexes || []).map((ix) => ix.name);

    return {
      present: names.includes(INDEX_NAME),
      reason: "ok",
      indexes: names,
    };
  } catch (err) {
    // Collection absente sur une base neuve, droits insuffisants, réseau : on
    // ne peut pas conclure. Dire « absent » serait aussi faux que dire
    // « présent ».
    return { present: false, reason: `indisponible: ${err?.message || err}` };
  }
}

/**
 * Pure : construit les lignes de journal à partir du résultat. Séparée du
 * contrôle pour rester testable sans base — la contrainte des suites de ce
 * dépôt.
 */
function formatDedupIndexReport(result) {
  if (result?.present) {
    return [`✅ [ledger] index de déduplication « ${INDEX_NAME} » présent`];
  }

  if (result?.reason && result.reason !== "ok" && result.reason !== "absent") {
    return [
      `⚠️ [ledger] impossible de vérifier l'index « ${INDEX_NAME} » ` +
        `(${result.reason}). La déduplication des écritures n'est pas confirmée.`,
    ];
  }

  return [
    `❌ [ledger] index « ${INDEX_NAME} » ABSENT de ${COLLECTION}.`,
    "   Le grand livre écrit des clés de déduplication qu'AUCUNE contrainte " +
      "n'observe : un rejeu en mode dégradé enregistrera le même mouvement " +
      "deux fois, et le grand livre restera équilibré — donc la balance de " +
      "vérification ne le signalera pas.",
    "   Lancer : node scripts/ensure-ledger-indexes.js",
    "   ⚠️ Chaque minute qui passe peut écrire un doublon, et un doublon fera " +
      "ensuite ÉCHOUER la construction de l'index.",
  ];
}

module.exports = {
  CRITICAL_INDEXES,
  checkCriticalIndexes,
  formatCriticalIndexesReport,
  INDEX_NAME,
  COLLECTION,
  checkDedupIndex,
  formatDedupIndexReport,
};
