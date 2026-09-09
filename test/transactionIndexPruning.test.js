"use strict";

/**
 * A5.3 — LES 10 INDEX REDONDANTS NE DOIVENT PAS REVENIR
 * -----------------------------------------------------------------------------
 * Le retrait en base ne tient que si le schéma cesse de les déclarer. Tant que
 * `models/Transaction.js` portait `index: true` sur ces dix champs, le prochain
 * `npm run indexes:apply` les recréait — et le retrait s'annulait tout seul,
 * sans le moindre message. On aurait cru l'avoir fait.
 *
 * Ce test lit le SCHÉMA, pas la base : il tient dans `npm test`, sans Mongo,
 * et attrape la régression au moment où elle est écrite plutôt que six mois
 * plus tard sur une collection à 64 index.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(
  path.join(__dirname, "..", "src", "models", "Transaction.js"),
  "utf8"
);

/** champ simple retiré → composé qui le couvre (sa PREMIÈRE clé est le champ). */
const RETIRES = Object.freeze({
  userId: { userId: 1, createdAt: -1 },
  flow: { flow: 1, status: 1, createdAt: -1 },
  sender: { sender: 1, createdAt: -1 },
  receiver: { receiver: 1, createdAt: -1 },
  provider: { provider: 1, providerStatus: 1, createdAt: -1 },
  status: { status: 1, createdAt: -1 },
  archived: { archived: 1, createdAt: -1 },
  context: { context: 1, status: 1, createdAt: -1 },
  treasuryRevenueCredited: { treasuryRevenueCredited: 1, createdAt: -1 },
  treasuryUserId: { treasuryUserId: 1, treasurySystemType: 1, createdAt: -1 },
});

/** Le bloc de définition d'un champ de premier niveau, sans ses commentaires. */
function blocDuChamp(champ) {
  const lignes = SRC.split("\n");
  const debut = lignes.findIndex((l) => new RegExp(`^\\s{4}${champ}:\\s*\\{`).test(l));

  assert.notEqual(debut, -1, `champ « ${champ} » introuvable dans le schéma`);

  const bloc = [];

  for (let i = debut + 1; i < lignes.length; i += 1) {
    if (/^\s{4}\},?\s*$/.test(lignes[i])) break;
    bloc.push(lignes[i]);
  }

  return bloc
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");
}

for (const champ of Object.keys(RETIRES)) {
  test(`A5.3 — le champ « ${champ} » ne redéclare pas d'index simple`, () => {
    const bloc = blocDuChamp(champ);

    assert.ok(
      !/^\s*index:\s*true,?\s*$/m.test(bloc),
      `« ${champ} » redéclare \`index: true\`. Cet index simple est couvert par ` +
        `le composé ${JSON.stringify(RETIRES[champ])} — le remettre le fait ` +
        `recréer au prochain \`npm run indexes:apply\`, ce qui annule le retrait ` +
        `d'A5.3 (−23,0 % de coût d'écriture) sans aucun message.`
    );
  });
}

test("A5.3 — chaque composé qui couvre un retrait est bien déclaré, et commence par le champ", () => {
  /**
   * Instance Mongoose ISOLÉE : `require(...)(conn)` construit le modèle sans
   * toucher à la connexion globale et sans ouvrir la moindre socket. C'est ce
   * qui garde ce test dans `npm test` — la suite ne doit jamais ouvrir Mongo.
   */
  const mongoose = require("mongoose");
  const conn = new mongoose.Mongoose();
  const Transaction = require("../src/models/Transaction")(conn);

  const declares = Transaction.schema.indexes();

  /**
   * ⚠️ DEUX SOURCES, ET LA SECONDE N'EST PAS UN OUBLI.
   *
   * Ce test a d'abord échoué sur `context` : son composé
   * `{ context, status, createdAt }` n'est PAS déclaré au schéma — il vit dans
   * `scripts/ensure-ledger-indexes.js`, l'un des HUIT index délibérément hors
   * schéma (voir l'avertissement de `ensureIndexes.js`). L'échec était juste :
   * sur une base neuve, `npm run indexes:apply` seul ne pose pas ce composé, et
   * `context` se retrouverait alors SANS AUCUN index.
   *
   * La couverture est donc cherchée dans les deux endroits — et c'est aussi
   * pour ce cas que `dropRedundantTransactionIndexes.js` vérifie l'existence du
   * composé EN BASE avant chaque retrait, et non dans une déclaration.
   */
  const horsSchema = fs.readFileSync(
    path.join(__dirname, "..", "scripts", "ensure-ledger-indexes.js"),
    "utf8"
  );

  for (const [champ, attendu] of Object.entries(RETIRES)) {
    const trouve = declares.find(
      ([cle]) => JSON.stringify(cle) === JSON.stringify(attendu)
    );

    const cles = Object.keys(attendu);

    // Forme telle qu'écrite dans le script hors schéma : `{ a: 1, b: 1, c: -1 }`
    const motif = new RegExp(
      "keys:\\s*\\{\\s*" +
        cles.map((k) => `${k}:\\s*${attendu[k]}`).join(",\\s*") +
        "\\s*\\}"
    );

    const dansScript = motif.test(horsSchema);

    assert.ok(
      trouve || dansScript,
      `le composé ${JSON.stringify(attendu)} n'est déclaré NULLE PART — ni au ` +
        `schéma, ni dans \`scripts/ensure-ledger-indexes.js\`. Sans lui, ` +
        `« ${champ} » n'a PLUS AUCUN index sur une base neuve : le retrait ` +
        `d'A5.3 devient une perte de performance, pas un gain.`
    );

    // La condition du préfixe : le champ doit être la PREMIÈRE clé.
    assert.equal(
      cles[0],
      champ,
      `${JSON.stringify(attendu)} ne commence pas par « ${champ} » : il ne le ` +
        `couvre donc pas. Un index composé ne sert que pour son préfixe.`
    );

    if (trouve) {
      assert.equal(Object.keys(trouve[0])[0], champ);
    }
  }
});

test("A5.3 — le script de retrait porte sa garde d'ordre", () => {
  const script = fs.readFileSync(
    path.join(__dirname, "..", "scripts", "dropRedundantTransactionIndexes.js"),
    "utf8"
  );

  // La garde qui REFUSE de tourner si le schéma déclare encore les index.
  assert.match(script, /schemaEncoreFautif/);

  // Le refus de toucher aux contraintes, vérifié EN BASE et non sur une liste.
  assert.match(script, /index\.unique/);
  assert.match(script, /partialFilterExpression/);
  assert.match(script, /expireAfterSeconds/);

  // Le défaut est la simulation.
  assert.match(script, /--apply/);
});
