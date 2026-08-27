"use strict";

/**
 * ============================================================================
 * LE HARNAIS DE CONCURRENCE
 * ============================================================================
 *
 * ── Pourquoi une suite séparée de `npm test`
 *
 * Les 567 tests de `npm test` n'ouvrent aucune connexion : ni Mongo, ni Redis,
 * ni serveur HTTP. C'est ce qui les garde sous 25 secondes et exécutables
 * partout. Cette propriété se PERD au premier test qui a besoin d'une base, et
 * elle ne se récupère pas.
 *
 * Ces tests-ci ont besoin d'une base — et pas de n'importe laquelle : d'un JEU
 * DE RÉPLICAS, parce que ce qu'ils vérifient est précisément le comportement
 * des transactions MongoDB sous conflit d'écriture. Ils vivent donc dans
 * `test-concurrency/`, derrière `npm run test:concurrency`, et `npm test` ne
 * les voit pas.
 *
 * ── Ce qui est exercé : le câblage RÉEL
 *
 * Le harnais appelle `connectTransactionsDB()`, le point d'entrée de
 * production. Il n'ouvre pas ses propres connexions avec ses propres options —
 * ce serait tester un montage qui n'existe nulle part ailleurs. Conséquence
 * directe : le mode « client partagé » et donc la disponibilité des
 * transactions Mongo sont ceux de la production, découverts et non supposés.
 *
 * ── Ce que la concurrence signifie ici, et sa limite
 *
 * `Promise.all` lance N tâches dans le même tick, mais le pilote MongoDB ne
 * peut avoir en vol que `maxPoolSize` opérations à la fois : au-delà, elles
 * font la queue. Une rafale de 1000 sur un pool de 250 n'est donc pas 1000
 * opérations simultanées — c'est une file de 1000 servie par 250.
 *
 * Ce n'est pas un défaut du test : c'est aussi ce qui se passe en production.
 * Mais ça doit être DIT, sinon on croit avoir prouvé une chose qu'on n'a pas
 * mesurée. La taille du pool est donc affichée avec chaque rafale.
 */

const assert = require("node:assert/strict");
const { exigerBanc } = require("./benchGuard");

const VARIABLES_REQUISES = ["MONGO_URI_USERS", "MONGO_URI_TRANSACTIONS"];

/**
 * Taille du pool — plafonne la concurrence réelle.
 *
 * ⚠️ La valeur par DÉFAUT de `src/config/db.js` est **15**
 * (`MONGO_MAX_POOL_SIZE`). Une instance de production n'a donc jamais plus de
 * 15 opérations Mongo en vol. On monte ici à 250 pour PROVOQUER les conflits
 * d'écriture : à 15, la file lisse la concurrence et le test passerait sans
 * jamais avoir rien éprouvé. Un test de concurrence qui ne produit aucun
 * conflit n'a pas démontré qu'il n'y en a pas — il a démontré qu'il n'a pas
 * regardé.
 */
const TAILLE_POOL = Number(process.env.BENCH_POOL_SIZE || 250);

let etat = null;

/**
 * Vérifie les cibles AVANT de charger quoi que ce soit qui pourrait se
 * connecter. L'ordre compte : `require("../../src/config/db")` déclenche la
 * lecture de la configuration, qui appelle `dotenv`. Si une variable manque à
 * ce moment-là, `dotenv` la comble avec le `.env` du dépôt — qui vise ailleurs.
 */
function verifierCibles(env = process.env) {
  const cibles = {};

  for (const nom of VARIABLES_REQUISES) {
    cibles[nom] = exigerBanc(env[nom], nom);
  }

  return cibles;
}

async function ouvrir() {
  if (etat) return etat;

  const cibles = verifierCibles();

  process.env.MONGO_MAX_POOL_SIZE = String(TAILLE_POOL);

  // Chargé APRÈS la barrière, jamais avant.
  const db = require("../../src/config/db");
  const { usersConn, txConn } = await db.connectTransactionsDB();

  etat = {
    cibles,
    usersConn,
    txConn,
    db,
    Wallet: txConn.models.TxWalletBalance,
    LedgerEntry: txConn.models.LedgerEntry,
    IdempotencyRecord: txConn.models.IdempotencyRecord,
    ProviderWebhookEvent: txConn.models.ProviderWebhookEvent,
    Transaction: txConn.models.Transaction,
  };

  return etat;
}

async function fermer() {
  if (!etat) return;

  const mongoose = require("mongoose");
  await mongoose.disconnect().catch(() => {});

  etat = null;
}

/**
 * ── Les index NE SONT PAS CRÉÉS PAR LES TESTS ────────────────────────────
 *
 * `autoIndex: false` est posé sur les deux connexions depuis le 2026-08-26 :
 * plus aucun index ne se construit tout seul au démarrage. Les garanties
 * d'unicité dont dépend cette suite — portefeuille unique par devise,
 * déduplication du grand livre, clé d'idempotence, événement prestataire —
 * n'existent donc en base QUE si quelqu'un les a posées.
 *
 * Le harnais les VÉRIFIE et refuse de continuer. Il ne les crée pas.
 *
 * La tentation inverse est forte et elle est piégeuse : un test qui répare
 * lui-même sa précondition passe au vert sur une base où l'index manque — et
 * c'est exactement la situation de production qu'il fallait détecter. Le test
 * dirait « pas de double débit » à propos d'une base qui n'a rien pour
 * l'empêcher.
 */
const INDEX_REQUIS = [
  {
    modele: "Wallet",
    cles: { user: 1, currency: 1 },
    pourquoi:
      "un seul portefeuille par devise — sans lui, deux upserts simultanés " +
      "créent deux documents et l'argent se répartit entre eux",
  },
  {
    modele: "LedgerEntry",
    cles: { dedupKey: 1 },
    pourquoi:
      "déduplication du grand livre — sans lui, un rejeu en mode dégradé " +
      "écrit deux fois le même mouvement, ÉQUILIBRÉ, donc invisible à la balance",
  },
  {
    modele: "IdempotencyRecord",
    cles: { scope: 1, key: 1 },
    pourquoi: "une clé d'idempotence ne peut être réservée deux fois",
  },
  {
    modele: "ProviderWebhookEvent",
    cles: { provider: 1, eventId: 1 },
    pourquoi: "un rappel prestataire rejoué ne rejoue pas l'argent",
  },
];

function memeCles(a, b) {
  const ca = Object.keys(a);
  const cb = Object.keys(b);

  // L'ORDRE des champs fait partie de l'identité d'un index composé :
  // {user, currency} et {currency, user} sont deux index différents.
  if (ca.length !== cb.length) return false;

  return ca.every((k, i) => cb[i] === k && String(a[k]) === String(b[k]));
}

async function verifierIndex() {
  const e = await ouvrir();
  const manquants = [];

  for (const requis of INDEX_REQUIS) {
    const modele = e[requis.modele];

    /**
     * Une collection inexistante n'a pas d'index — et `indexes()` ne rend pas
     * une liste vide, il LÈVE « ns does not exist ». Traiter cette levée comme
     * une erreur du harnais masquerait le vrai message : l'index manque.
     */
    let existants = [];
    try {
      existants = await modele.collection.indexes();
    } catch (err) {
      if (!/ns does not exist/i.test(String(err?.message))) throw err;
    }

    const trouve = existants.find(
      (ix) => ix.unique === true && memeCles(requis.cles, ix.key)
    );

    if (!trouve) {
      manquants.push(requis);
    }
  }

  if (manquants.length) {
    const detail = manquants
      .map(
        (m) =>
          `    • ${m.modele} ${JSON.stringify(m.cles)} UNIQUE\n` +
          `      ${m.pourquoi}`
      )
      .join("\n");

    throw new Error(
      `\n  ⛔ INDEX UNIQUES ABSENTS — la suite s'arrête ici.\n\n` +
        `${detail}\n\n` +
        `  Ces tests prouveraient l'absence de double débit sur une base qui\n` +
        `  n'a rien pour l'empêcher. Poser les index d'abord :\n\n` +
        `    npm run indexes:apply\n` +
        `    node scripts/ensure-ledger-indexes.js\n`
    );
  }

  return true;
}

/**
 * Lance N tâches dans le même tick et classe les issues.
 *
 * ⚠️ `Promise.allSettled`, jamais `Promise.all` : sous concurrence, l'ÉCHEC
 * d'une partie des tâches est le résultat ATTENDU (fonds insuffisants, clé déjà
 * prise). `Promise.all` rejetterait au premier échec et on ne saurait rien du
 * reste — or ce qu'on veut mesurer, c'est justement la répartition.
 */
async function rafale(n, tache) {
  const debut = Date.now();

  const issues = await Promise.allSettled(
    Array.from({ length: n }, (_, i) => tache(i))
  );

  const reussites = issues.filter((r) => r.status === "fulfilled");
  const echecs = issues.filter((r) => r.status === "rejected");

  const parCause = new Map();
  for (const e of echecs) {
    const cause = normaliserCause(e.reason);
    parCause.set(cause, (parCause.get(cause) || 0) + 1);
  }

  return {
    n,
    taillePool: TAILLE_POOL,
    dureeMs: Date.now() - debut,
    reussites: reussites.map((r) => r.value),
    nbReussites: reussites.length,
    nbEchecs: echecs.length,
    parCause,
    echecsBruts: echecs.map((e) => e.reason),
  };
}

/**
 * Réduit un message d'erreur à sa CLASSE, pour que dix échecs identiques ne
 * comptent pas pour dix causes différentes. Les identifiants et les montants
 * sont gommés — ils varient d'une tâche à l'autre sans rien changer à la cause.
 */
function normaliserCause(err) {
  if (err && (err.code === 11000 || err.code === 11001)) return "E11000 doublon";
  if (err && err.code === 112) return "WriteConflict";

  const msg = String(err?.message || err || "inconnu");

  return msg
    .replace(/[0-9a-f]{24}/gi, "<id>")
    .replace(/\d+/g, "<n>")
    .slice(0, 120);
}

/**
 * La balance de vérification : Σ DEBIT − Σ CREDIT = 0, PAR DEVISE.
 *
 * C'est le seul contrôle qui n'a pas besoin de connaître le bogue à l'avance —
 * il attrape une écriture perdue, une écriture en double, un montant erroné.
 */
async function assertBalanceFerme(filtre = {}, contexte = "") {
  const e = await ouvrir();
  const { computeTrialBalance } = require("../../src/services/ledger/doubleEntry");

  const ecritures = await e.LedgerEntry.find(filtre).lean();
  const bilan = computeTrialBalance(ecritures);

  assert.equal(
    bilan.balanced,
    true,
    `Balance de vérification NON FERMÉE ${contexte}\n` +
      `  par devise : ${JSON.stringify(bilan.byCurrency, null, 2)}\n` +
      `  écritures considérées : ${bilan.consideredEntries}\n` +
      `  écritures héritées ignorées : ${bilan.skippedLegacyEntries}`
  );

  return bilan;
}

/** Remet à zéro ce que la suite a écrit. Jamais un `drop()` de base. */
async function nettoyer({ userIds = [], transactionIds = [], scopes = [] } = {}) {
  const e = await ouvrir();

  if (userIds.length) {
    await e.Wallet.deleteMany({ user: { $in: userIds } });
  }

  if (transactionIds.length) {
    /**
     * ⚠️ `.collection.deleteMany`, PAS `Model.deleteMany`.
     *
     * `LedgerEntry` refuse la suppression — le hook `pre` lève
     * `LEDGER_ENTRY_IMMUTABLE` : « une écriture du grand livre ne se SUPPRIME
     * pas, utiliser une contre-écriture ». C'est la bonne règle, et elle est
     * plus large que ce que ce fichier affirmait d'abord (il ne lui prêtait que
     * la protection des mises à jour).
     *
     * Passer par le pilote contourne ce garde-fou. Ce n'est acceptable que
     * pour UNE raison : `benchGuard` a déjà prouvé que la base porte un préfixe
     * `bench_`. Ce sont des écritures fabriquées par la suite elle-même, pas un
     * historique. Aucun autre code du dépôt ne doit reprendre ce geste.
     */
    await e.LedgerEntry.collection.deleteMany({
      transactionId: { $in: transactionIds },
    });
    await e.Transaction.deleteMany({ _id: { $in: transactionIds } });
  }

  if (scopes.length) {
    await e.IdempotencyRecord.deleteMany({ scope: { $in: scopes } });
    await e.ProviderWebhookEvent.deleteMany({ provider: { $in: scopes } });
  }
}

function resumer(r, titre) {
  const causes = [...r.parCause.entries()]
    .map(([c, n]) => `${n}× ${c}`)
    .join(" · ");

  return (
    `  ${titre}\n` +
    `    rafale ${r.n} (pool ${r.taillePool}) en ${r.dureeMs} ms — ` +
    `${r.nbReussites} réussites, ${r.nbEchecs} échecs` +
    (causes ? `\n    causes : ${causes}` : "")
  );
}

module.exports = {
  TAILLE_POOL,
  INDEX_REQUIS,
  verifierCibles,
  memeCles,
  normaliserCause,
  ouvrir,
  fermer,
  verifierIndex,
  rafale,
  assertBalanceFerme,
  nettoyer,
  resumer,
};
