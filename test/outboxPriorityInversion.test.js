"use strict";

/**
 * L'INVERSION DE PRIORITÉ DE LA FILE DE NOTIFICATIONS.
 *
 * La collection `outboxes` (base des utilisateurs) est écrite par DEUX services
 * avec DEUX schémas distincts : celui de Tx Core (`models/Outbox.js`) et celui
 * du backend principal (`paynoval-backend/models/Outbox.js`). C'est le worker du
 * backend, `services/outboxPublisher.js`, qui la draine — en triant par
 * `{ priority: 1, createdAt: 1 }`.
 *
 * Le schéma de Tx Core ne déclarait AUCUN champ `priority`. Or en BSON, un champ
 * absent trie comme `null`, et `null` précède tout nombre en ordre croissant :
 * chaque notification de transaction se plaçait donc DEVANT les alertes de
 * sécurité `CRITICAL` (priorité 0), alors que le backend promet explicitement
 * qu'« une alerte de sécurité passe devant le marketing et les annonces ».
 *
 * Ces tests échouent si le champ disparaît, si un producteur cesse de le poser,
 * ou si les deux barèmes divergent.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src");
const BACKEND = path.join(__dirname, "..", "..", "paynoval-backend");

const lire = (p) => fs.readFileSync(p, "utf8");

test("le schéma Outbox de Tx Core déclare bien `priority`", () => {
  const src = lire(path.join(SRC, "models", "Outbox.js"));

  assert.match(
    src,
    /priority:\s*\{/,
    "le champ `priority` a disparu du schéma — la file se réinverse"
  );

  assert.match(src, /default:\s*5/, "le défaut doit rester NORMAL (5)");
  assert.match(src, /min:\s*0/);
  assert.match(src, /max:\s*9/);
});

test("les DEUX producteurs de Tx Core posent une priorité explicite", () => {
  const producteurs = [
    path.join(SRC, "services", "transactions", "transactionNotificationService.js"),
    path.join(SRC, "services", "transactions", "shared", "notifications.js"),
  ];

  for (const p of producteurs) {
    const src = lire(p);

    assert.ok(
      src.includes("insertMany"),
      `${path.basename(p)} n'écrit plus dans la file — ce test doit être revu`
    );

    assert.match(
      src,
      /priority:\s*2/,
      `${path.basename(p)} écrit dans la file sans poser de priorité : ses ` +
        "documents repasseront devant les alertes de sécurité"
    );
  }
});

test("le barème de Tx Core est celui du backend, pas un second barème", () => {
  const bareme = path.join(BACKEND, "services", "notifications", "priority.js");

  if (!fs.existsSync(bareme)) {
    // Le dépôt backend peut être absent d'une copie de travail isolée.
    return;
  }

  const src = lire(bareme);

  // Les valeurs citées dans les commentaires de Tx Core doivent rester vraies.
  assert.match(src, /CRITICAL:\s*0/);
  assert.match(src, /HIGH:\s*2/);
  assert.match(src, /NORMAL:\s*5/);
  assert.match(src, /BULK:\s*8/);
});

test("un document sans `priority` précède bien CRITICAL — le mécanisme du défaut", () => {
  /**
   * La démonstration du mécanisme, sans base de données : l'ordre BSON place
   * `null` (valeur d'un champ absent) avant tout nombre. C'est ce qui rendait
   * le défaut invisible — rien n'était « faux », le tri faisait exactement ce
   * qu'on lui demandait sur des documents incomplets.
   */
  const RANG_BSON = (v) => (v === null || v === undefined ? -1 : 0);

  const sansPriorite = RANG_BSON(undefined);
  const critique = RANG_BSON(0);

  assert.ok(
    sansPriorite < critique,
    "si ce test cesse d'être vrai, la justification du champ a changé"
  );
});
