"use strict";

/**
 * ============================================================================
 * DEUX DÉCLARATIONS D'INDEX SUR LA MÊME CLÉ — MONGODB N'EN POSERA QU'UNE
 * ============================================================================
 *
 * Un champ peut être indexé de deux façons dans un schéma Mongoose : en ligne
 * (`{ type: String, index: true }`) et par `schema.index({ champ: 1 }, {...})`.
 * Rien n'interdit d'écrire les deux. MongoDB, lui, n'accepte **qu'un index par
 * clé** : la seconde création échoue sur « An equivalent index already exists
 * with a different name and options ».
 *
 * ── Pourquoi c'est un défaut silencieux et pas une erreur bruyante
 *
 * Sous `autoIndex: true`, Mongoose crée les index sur un événement de connexion
 * dont personne ne lit le résultat : l'échec de la seconde création ne remonte
 * nulle part. Le schéma affiche alors une garantie que la base ne porte pas — et
 * c'est celle qui a perdu la course, donc on ne sait même pas laquelle.
 *
 * ── Ce que ça a réellement coûté ici, découvert le 2026-08-27
 *
 *   • `ReconciliationRun.startedAt` — `index: true` en ligne ET un index TTL.
 *     C'est le TTL qui perdait : les exécutions de réconciliation
 *     n'expiraient jamais.
 *
 *   • `Transaction.verificationToken` — `unique + sparse` en ligne ET un index
 *     unique PARTIEL. Les deux tiennent l'unicité, mais pas sur le même
 *     ensemble : `sparse` ignore les champs absents, **pas** les champs à
 *     `null`. Avec `default: null`, la variante sparse aurait refusé la
 *     deuxième transaction sans jeton — seul un `pre("save")` la sauvait.
 *
 *   • `Transaction.providerReference` — `index: true` en ligne ET un `sparse`.
 *
 * Aucun n'a été trouvé par relecture. Tous les trois sont sortis d'une
 * comparaison mécanique entre le déclaré et le réel.
 *
 * ── Pourquoi ce contrôle est ici et pas dans `test-concurrency/`
 *
 * Il est PUR : il ne lit que des schémas, n'ouvre ni base ni serveur. Il
 * appartient donc à `npm test`, où il s'exécute à chaque fois — c'est là qu'un
 * garde-fou doit vivre, pas dans une suite qu'on lance les jours de campagne.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const { empreinteIndex } = require("../src/services/indexAudit");
const { registerTransactionModels } = require("../src/config/db");

/**
 * Enregistre les modèles sur l'objet mongoose lui-même. L'enregistrement d'un
 * modèle ne demande AUCUNE connexion : c'est une déclaration, pas une requête.
 * La suite reste donc sans base.
 */
registerTransactionModels(mongoose);

function collisions(schema) {
  const parCle = new Map();

  for (const [cle, options] of schema.indexes()) {
    // La clé SEULE — c'est elle que MongoDB considère comme l'identité.
    const identite = empreinteIndex(cle);
    if (!identite) continue;

    if (!parCle.has(identite)) parCle.set(identite, []);
    parCle.get(identite).push(empreinteIndex(cle, options));
  }

  return [...parCle.entries()].filter(([, variantes]) => variantes.length > 1);
}

test("aucun schéma ne déclare deux index sur la même clé", () => {
  const fautifs = [];

  for (const nom of Object.keys(mongoose.models)) {
    for (const [cle, variantes] of collisions(mongoose.models[nom].schema)) {
      fautifs.push(`${nom} · clé ${cle} · déclarée ${variantes.length}× : ${variantes.join(" ET ")}`);
    }
  }

  assert.deepEqual(
    fautifs,
    [],
    "Deux index déclarés sur une même clé : MongoDB n'en posera qu'un, et " +
      "l'échec de l'autre est silencieux sous autoIndex.\n  - " +
      fautifs.join("\n  - ") +
      "\n\nRetirer la déclaration EN LIGNE (`index: true` / `unique` / `sparse` " +
      "sur le champ) et ne garder que le `schema.index(...)`, qui porte les " +
      "options complètes."
  );
});

test("l'empreinte distingue un index TTL d'un index ordinaire de même clé", () => {
  // C'est LE défaut qui rendait l'audit d'index faussement vert : un
  // `startedAt_1` ordinaire satisfaisait une déclaration TTL sur la même clé.
  const ordinaire = empreinteIndex({ startedAt: 1 }, {});
  const ttl = empreinteIndex({ startedAt: 1 }, { expireAfterSeconds: 3600 });

  assert.notEqual(ordinaire, ttl);
});

test("l'empreinte distingue unique, partiel et sparse", () => {
  const cle = { token: 1 };

  const nu = empreinteIndex(cle, {});
  const unique = empreinteIndex(cle, { unique: true });
  const uniqueSparse = empreinteIndex(cle, { unique: true, sparse: true });
  const uniquePartiel = empreinteIndex(cle, {
    unique: true,
    partialFilterExpression: { token: { $exists: true } },
  });

  assert.equal(new Set([nu, unique, uniqueSparse, uniquePartiel]).size, 4);
});

test("l'empreinte ignore la DURÉE du TTL — un collMod n'est pas un index manquant", () => {
  // Inclure la valeur ferait apparaître le même index comme « manquant » ET
  // « en trop », ce qui envoie chercher un problème d'index là où il n'y a
  // qu'un réglage à ajuster par `collMod`.
  assert.equal(
    empreinteIndex({ createdAt: 1 }, { expireAfterSeconds: 3600 }),
    empreinteIndex({ createdAt: 1 }, { expireAfterSeconds: 86400 })
  );
});

test("l'empreinte ignore le nom et le mode de construction", () => {
  assert.equal(
    empreinteIndex({ a: 1 }, { name: "un_nom", background: true }),
    empreinteIndex({ a: 1 }, { name: "un_autre", background: false })
  );
});
