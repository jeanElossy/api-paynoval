"use strict";

/**
 * ============================================================================
 * `src/services/balance.js` NE DOIT PAS REVENIR
 * ============================================================================
 *
 * ── Ce qu'il contenait ───────────────────────────────────────────────────────
 * Trente-trois lignes, aucun appelant, et exactement le motif d'écriture que
 * l'analyse A3 a désigné comme le seul qui rouvrirait la question du verrou
 * distribué :
 *
 *     const balance = await Balance.findOne({ user: userId });
 *     if (balance.amount < amount) throw new Error('Solde insuffisant');
 *     balance.amount -= amount;
 *     await balance.save();
 *
 * **Lire un solde, le tester, puis l'écrire en deux temps.** Entre le `findOne`
 * et le `save`, une seconde requête peut lire le même solde et passer le même
 * test : deux débits accordés là où un seul était couvert.
 *
 * ── Pourquoi c'était particulièrement toxique ────────────────────────────────
 * A3 a été tranchée **sous mesure** le 2026-08-27 : aucun verrou distribué ne
 * sera ajouté sur `wallet`, parce que la condition de solde vit dans le FILTRE
 * du `findOneAndUpdate` — MongoDB l'évalue et applique l'incrément sous le même
 * verrou de document, il n'y a donc pas de fenêtre à fermer. 1000 réservations
 * simultanées sur un portefeuille qui en couvre 500 : exactement 500 accordées.
 *
 * Cette conclusion tient **tant qu'aucun chemin ne lit un solde puis l'écrit en
 * deux temps**. Ce fichier enseignait précisément le contraire, dans le même
 * dossier que le code correct. Un lecteur pressé y voyait un exemple.
 *
 * ── Il ne pouvait même pas fonctionner ──────────────────────────────────────
 * `models/TxWalletBalance.js` exporte une FABRIQUE qui exige une connexion
 * Mongoose, pas un modèle. `Balance.findOne` était donc `undefined` : le
 * fichier aurait planté au premier appel. Personne ne l'avait jamais appelé.
 *
 * ── Comment ce test tombe ───────────────────────────────────────────────────
 * Recréer `src/services/balance.js`.
 *
 * Test **pur** : il regarde le disque, n'ouvre aucune connexion.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SERVICES = path.join(__dirname, "..", "src", "services");

test("`services/balance.js` n'existe pas — il enseignait le motif interdit", () => {
  assert.equal(
    fs.existsSync(path.join(SERVICES, "balance.js")),
    false,
    "`src/services/balance.js` est revenu. Il lit un solde, le teste, puis " +
      "l'écrit en deux temps — le seul motif qui rouvrirait la question du " +
      "verrou distribué tranchée par A3. Les opérations de solde passent par " +
      "`models/TxWalletBalance.js`, dont la condition vit dans le FILTRE de " +
      "l'écriture."
  );
});

/**
 * Le contrôle ci-dessus ne protège qu'un nom de fichier. Celui-ci vise la
 * FORME, où qu'elle réapparaisse : une condition de solde évaluée en JavaScript
 * plutôt que dans le filtre de l'écriture.
 */
test("aucun service ne teste un solde en JavaScript avant de l'écrire", () => {
  const fautes = [];

  function balayer(dossier) {
    for (const entree of fs.readdirSync(dossier, { withFileTypes: true })) {
      const complet = path.join(dossier, entree.name);

      if (entree.isDirectory()) {
        balayer(complet);
        continue;
      }
      if (!entree.name.endsWith(".js")) continue;

      const lignes = fs.readFileSync(complet, "utf8").split("\n");

      for (let i = 0; i < lignes.length; i++) {
        const nue = lignes[i].trim();
        if (nue.startsWith("*") || nue.startsWith("//")) continue;

        // Motif visé : `X.amount -= …` ou `X.availableAmount -= …` suivi d'un
        // `save()` — la mutation en mémoire d'un solde chargé.
        if (/\.(amount|availableAmount|reservedAmount)\s*[-+]=/.test(nue)) {
          const suite = lignes.slice(i, i + 6).join(" ");
          if (/\.save\s*\(/.test(suite)) {
            fautes.push(
              `${path.relative(SERVICES, complet)}:${i + 1}  ${nue.slice(0, 90)}`
            );
          }
        }
      }
    }
  }

  balayer(SERVICES);

  assert.deepEqual(
    fautes,
    [],
    "Un solde est muté en mémoire puis sauvegardé. Entre la lecture et " +
      "l'écriture, une seconde requête peut lire le même solde et passer le " +
      "même test : deux débits accordés là où un seul était couvert. La " +
      "condition doit vivre dans le FILTRE du `findOneAndUpdate` — c'est ce qui " +
      "tient l'invariant, et ce qui a permis de trancher A3 sans verrou " +
      "distribué.\n\n  " + fautes.join("\n  ")
  );
});
