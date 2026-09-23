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

/**
 * ⚠️ CE TEST A ÉTÉ REVU LE 2026-09-23 — IL LE DEMANDAIT LUI-MÊME.
 *
 * Il exigeait que les DEUX producteurs de Tx-Core contiennent `insertMany`, et
 * son propre message d'échec disait : « n'écrit plus dans la file — ce test doit
 * être revu ». C'est arrivé : `shared/notifications.js` n'écrit plus rien, il
 * délègue à `transactionNotificationService`, qui publie un événement de domaine.
 *
 * L'invariant protégé ne change pas d'un iota : **une notification de
 * transaction ne doit jamais passer devant une alerte de sécurité**. Ce qui
 * change, c'est où la priorité doit être posée — dans la charge utile de
 * l'événement, puisque c'est elle que le backend recopie dans l'item d'outbox.
 *
 * Le test est plus strict qu'avant sur un point : il vérifie AUSSI qu'aucun
 * producteur n'est revenu à l'écriture directe. L'ancienne version exigeait
 * l'inverse.
 */
test("Tx-Core pose une priorité explicite dans l'événement publié", () => {
  const src = lire(
    path.join(SRC, "services", "transactions", "transactionNotificationService.js")
  );

  assert.match(
    src,
    /priority:\s*2/,
    "l'événement part sans priorité : le backend écrira un item sans `priority`, " +
      "qui trie en BSON comme `null` — donc AVANT les alertes de sécurité CRITICAL"
  );

  /** La priorité doit voyager DANS l'événement, pas rester une variable locale. */
  assert.match(src, /publishDomainEvent\(/);
});

test("plus AUCUN producteur de Tx-Core n'écrit directement dans la file", () => {
  /**
   * C'est la contrainte inverse de celle que ce test portait avant, et c'est
   * voulu : deux services écrivant `outboxes` avec deux schémas est le défaut
   * refermé ici. `shared/notifications.js` était le dernier — il écrivait des
   * items sans `title`, sans `message` et sans `channels`, ce qui produisait un
   * push « PayNoval / Nouvelle notification » et jamais d'e-mail.
   */
  const producteurs = [
    path.join(SRC, "services", "transactions", "transactionNotificationService.js"),
    path.join(SRC, "services", "transactions", "shared", "notifications.js"),
  ];

  /**
   * ⚠️ COMMENTAIRES DÉPOUILLÉS AVANT L'ASSERTION.
   *
   * Les deux fichiers DÉCRIVENT en commentaire l'écriture directe qu'ils ne font
   * plus (« `outboxes` → `Outbox.insertMany([...])` »). Chercher la chaîne dans
   * le source brut fait donc échouer le test sur sa propre documentation — et la
   * seule façon de le faire passer serait de supprimer l'explication qui empêche
   * la faute de revenir. Même dépouillement que `notificationsOnBus.test.js`.
   */
  const sansCommentaires = (src) =>
    src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  for (const p of producteurs) {
    const src = sansCommentaires(lire(p));

    for (const ecriture of [".insertMany(", "Notification.create(", "Outbox.create("]) {
      assert.ok(
        !src.includes(ecriture),
        `${path.basename(p)} est revenu à l'écriture directe (« ${ecriture} ») : ` +
          "il écrit dans une collection dont le backend déclare le schéma, donc " +
          "sans ses préférences, ses gabarits ni son journal"
      );
    }
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
