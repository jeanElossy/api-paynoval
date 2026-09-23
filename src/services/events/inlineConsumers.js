"use strict";

/**
 * ============================================================================
 * CONSOMMATEURS DU BUS DANS LE PROCESSUS WEB — le mode « un seul service »
 * ============================================================================
 *
 * ═══ POURQUOI CE MODE EXISTE ═════════════════════════════════════════════
 *
 * La conception d'origine fait tourner les consommateurs dans des processus
 * séparés (`workers/*.js`), pour qu'un consommateur qui sature ou plante
 * n'emporte pas le moteur d'argent. Elle suppose un service d'hébergement par
 * processus.
 *
 * La réalité du déploiement, constatée le 2026-09-23 : trois web services
 * Render (backend, Tx-Core, passerelle), et **aucun background worker**, ce
 * type de service étant payant. Résultat mesuré : les quatre consommateurs
 * n'avaient JAMAIS tourné. Une transaction avec les trois canaux de
 * notification activés n'a rien produit, et — moins visible mais plus grave —
 * la surveillance AML asynchrone n'avait jamais examiné un seul mouvement.
 *
 * Une séparation de processus qui n'existe pas en production ne protège rien.
 * Ce mode fait tourner les consommateurs là où ils peuvent tourner. C'est
 * exactement ce que fait déjà le backend principal, dont le worker de file de
 * notifications tourne dans le processus web (`server.js` du backend).
 *
 * ═══ CE QUI RESTE SÛR, ET POURQUOI ═══════════════════════════════════════
 *
 * • AUCUNE LECTURE BLOQUANTE. `stream.readGroup` n'envoie `BLOCK` que si une
 *   attente est demandée, et le cadre de consommation ne la demande pas : il
 *   sonde toutes les secondes. Partager le client Redis du serveur ne gèle donc
 *   aucune autre commande — une lecture `BLOCK` sur une connexion partagée
 *   aurait figé le relais et la limitation de débit.
 *
 * • AUCUN NOUVEAU CLIENT REDIS (invariant A8) : on réutilise celui que le
 *   serveur a posé dans l'accesseur partagé.
 *
 * • AUCUN DOUBLON si un worker dédié est ajouté plus tard : ce sont les GROUPES
 *   Redis qui répartissent. Deux consommateurs du même groupe se partagent les
 *   messages, chacun n'en reçoit qu'une copie ; `dejaTraite` absorbe le reste.
 *
 * • UNE BRANCHE QUI NE DÉMARRE PAS N'EMPÊCHE NI LES AUTRES, NI LE SERVEUR.
 *
 * ═══ CE QU'ON PERD, DIT FRANCHEMENT ══════════════════════════════════════
 *
 * L'isolement des pannes de processus : une fuite mémoire dans un consommateur
 * ferait redémarrer le moteur d'argent. Au volume actuel, le risque est faible
 * et chiffrable ; il ne le sera plus à fort volume. Le jour où un service
 * dédié existe, `EVENT_CONSUMERS_INLINE=false` rend le processus web à son seul
 * rôle — sans toucher au code.
 */

/**
 * Les branches, avec le nom court utilisable dans `EVENT_CONSUMERS_INLINE`.
 *
 * ⚠️ `workers/all.js` IMPORTE CETTE LISTE au lieu d'en tenir une copie : deux
 * listes de consommateurs finiraient par diverger, et une branche présente dans
 * l'une et absente de l'autre ne tournerait que selon le mode de déploiement.
 *
 * Les modules sont chargés À LA DEMANDE : les exiger au chargement de ce fichier
 * ferait monter les modèles Mongoose de quatre domaines dans un test pur.
 */
const BRANCHES = Object.freeze([
  {
    cle: "risk",
    titre: "🛡️  risque",
    charger: () => require("../risk/monitoringConsumer"),
  },
  {
    cle: "settlement",
    titre: "📒 réconciliation",
    charger: () => require("../reconciliation/settlementConsumer"),
  },
  {
    cle: "referral",
    titre: "🎁 parrainage",
    charger: () => require("../referral/referralConsumer"),
  },
  {
    cle: "notifications",
    titre: "🔔 notifications",
    charger: () => require("../notifications/notificationConsumer"),
  },
]);

const CLES = Object.freeze(BRANCHES.map((b) => b.cle));

const DESACTIVE = new Set(["false", "0", "no", "non", "off", "none", "aucun"]);
const TOUT = new Set(["true", "1", "yes", "oui", "on", "all", "tout", "tous"]);

/**
 * Quelles branches démarrer dans ce processus ? **Fonction pure.**
 *
 * ⚠️ PAR DÉFAUT : TOUTES. C'est le choix qui compte, et il est délibéré.
 *
 * Un défaut « aucune » reproduirait exactement l'incident : un déploiement qui
 * ne pose pas la variable — c'est-à-dire tous les déploiements existants — ne
 * ferait tourner aucun consommateur, en silence. Le défaut doit être l'état
 * qui fonctionne ; c'est le retrait qui doit être explicite.
 *
 * Une valeur non reconnue n'est PAS interprétée comme « aucune » : elle est
 * signalée, et les clés valides qu'elle contient s'appliquent. Couper la
 * surveillance AML à cause d'une faute de frappe serait la pire lecture.
 *
 * @returns {{cles: string[], source: string, inconnues: string[]}}
 */
function lireReglage(env = process.env) {
  const brut = String(env?.EVENT_CONSUMERS_INLINE ?? "").trim().toLowerCase();

  if (!brut) return { cles: [...CLES], source: "default", inconnues: [] };
  if (DESACTIVE.has(brut)) return { cles: [], source: "env", inconnues: [] };
  if (TOUT.has(brut)) return { cles: [...CLES], source: "env", inconnues: [] };

  const demandees = brut
    .split(/[\s,;]+/)
    .map((c) => c.trim())
    .filter(Boolean);

  const inconnues = demandees.filter((c) => !CLES.includes(c));
  const cles = CLES.filter((c) => demandees.includes(c));

  /**
   * Rien de valide du tout (ex. `EVENT_CONSUMERS_INLINE=notifs`) : on retombe
   * sur toutes les branches plutôt que sur aucune. Même raisonnement que le
   * défaut — l'erreur de configuration ne doit pas produire le silence.
   */
  if (!cles.length) return { cles: [...CLES], source: "default", inconnues };

  return { cles, source: "env", inconnues };
}

/**
 * Démarre les branches retenues DANS ce processus.
 *
 * Suppose que le serveur a déjà ouvert Mongo et posé son client Redis dans
 * l'accesseur partagé — ce qui est vrai à l'endroit où `server.js` l'appelle,
 * juste après le relais.
 *
 * ⚠️ NE LÈVE JAMAIS : le moteur d'argent ne doit pas refuser de démarrer parce
 * qu'un consommateur n'a pas pu s'abonner.
 *
 * @returns {Promise<{demarres: string[], echecs: string[], stop: Function}>}
 */
async function start({ logger = console, env = process.env, branches = BRANCHES } = {}) {
  const reglage = lireReglage(env);
  const poignees = [];
  const demarres = [];
  const echecs = [];

  if (reglage.inconnues.length) {
    logger.warn?.(
      `⚠️ EVENT_CONSUMERS_INLINE contient des noms inconnus ` +
        `(${reglage.inconnues.join(", ")}) — ignorés. Noms valides : ` +
        `${CLES.join(", ")}, ou « all » / « false ».`
    );
  }

  if (!reglage.cles.length) {
    logger.info?.(
      "ℹ️ Consommateurs du bus : AUCUN dans ce processus (EVENT_CONSUMERS_INLINE=false). " +
        "CONSÉQUENCE : ils doivent tourner dans un service dédié " +
        "(`npm run workers:all`) — sinon aucune notification de transaction " +
        "n'arrive et la surveillance AML est aveugle. `event_consumer_present` " +
        "le signale."
    );

    return { demarres, echecs, stop() {} };
  }

  for (const branche of branches) {
    if (!reglage.cles.includes(branche.cle)) continue;

    try {
      const module = branche.charger();

      module.annoncer?.(logger);

      const consommateur = module.build({ logger });

      poignees.push(await consommateur.start());
      demarres.push(branche.cle);

      logger.info?.(
        `   ✅ ${branche.titre} — groupe « ${consommateur.groupe} » (dans ce processus)`
      );
    } catch (err) {
      echecs.push(branche.cle);

      logger.error?.(
        `   ❌ ${branche.titre} NON DÉMARRÉ — cette branche n'écoute rien`,
        { message: err?.message || String(err) }
      );
    }
  }

  const niveau = echecs.length ? "warn" : "info";

  logger[niveau]?.(
    `📨 Consommateurs du bus DANS le processus web : ${demarres.length}/` +
      `${reglage.cles.length} en écoute (${demarres.join(", ") || "aucun"}). ` +
      `Mode « un seul service » — retirer avec EVENT_CONSUMERS_INLINE=false ` +
      `le jour où un service dédié existe.`
  );

  return {
    demarres,
    echecs,
    stop() {
      for (const p of poignees) {
        try {
          p?.stop?.();
        } catch {}
      }
    },
  };
}

module.exports = { BRANCHES, CLES, lireReglage, start };
