"use strict";

/**
 * ============================================================================
 * TX-CORE N'ÉCRIT PLUS DANS LES COLLECTIONS DU BACKEND
 * ============================================================================
 *
 * ── Le défaut refermé le 2026-09-10 ─────────────────────────────────────────
 *
 * `transactionNotificationService` écrivait DIRECTEMENT dans `notifications` et
 * `outboxes`, deux collections dont le backend principal déclare les schémas,
 * les index et la machine à états. Tx-Core y écrivait avec SA propre
 * déclaration.
 *
 * C'est la classe de défaut refermée sur `tx_wallet_balances` (R-06). Le
 * symptôme le plus parlant s'était déjà produit : le champ `priority`, absent
 * des documents écrits ici, triait en BSON comme `null` — donc AVANT les
 * alertes de sécurité `CRITICAL`. Une notification de virement passait devant
 * une alerte de sécurité parce qu'un service écrivait sans connaître le tri de
 * l'autre.
 *
 * ── Pourquoi ce test regarde une ABSENCE ET une PRÉSENCE ────────────────────
 *
 * ⚠️ Vérifier seulement que Tx-Core n'écrit plus laisserait passer une
 * suppression pure et simple : les notifications disparaîtraient, la suite
 * resterait verte, et personne ne saurait pourquoi les utilisateurs ne sont
 * plus prévenus. La preuve d'un déplacement est une PAIRE.
 *
 * Test **pur** : il lit des fichiers, n'ouvre aucune connexion.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const RACINE = path.join(__dirname, "..");
const BACKEND = path.resolve(RACINE, "..", "paynoval-backend");

const lire = (...s) => fs.readFileSync(path.join(RACINE, ...s), "utf8");

const sansCommentaires = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const SERVICE = sansCommentaires(
  lire("src", "services", "transactions", "transactionNotificationService.js")
);

/* ══════════════════════════════════════════════════════════════════════════ */
/* 1. ABSENCE — Tx-Core n'écrit plus chez le backend                        */
/* ══════════════════════════════════════════════════════════════════════════ */

test("Tx-Core ne résout plus les modèles Notification et Outbox du backend", () => {
  for (const interdit of ["models/Notification", "models/Outbox"]) {
    assert.ok(
      !SERVICE.includes(interdit),
      `transactionNotificationService résout de nouveau « ${interdit} » : ` +
        "Tx-Core écrit dans une collection dont le backend déclare le schéma"
    );
  }

  /**
   * Et il n'ouvre plus la connexion des utilisateurs pour ça. C'est la porte ;
   * la résolution de modèle n'est que le symptôme.
   */
  assert.ok(!SERVICE.includes("getUsersConnectionSafe"));
});

test("aucune écriture directe ne subsiste dans ce service", () => {
  for (const ecriture of [
    "notificationModel(",
    "outboxModel(",
    ".insertMany(",
    "Notification.create(",
    "Outbox.create(",
  ]) {
    assert.ok(
      !SERVICE.includes(ecriture),
      `écriture directe réintroduite : « ${ecriture} »`
    );
  }
});

/* ══════════════════════════════════════════════════════════════════════════ */
/* 2. PRÉSENCE — sans quoi ce fichier ne mesure rien                        */
/* ══════════════════════════════════════════════════════════════════════════ */

test("la notification est DEMANDÉE par un événement, sous la session", () => {
  assert.match(SERVICE, /publishDomainEvent\(/);
  assert.match(SERVICE, /notification\.requested\.v1/);

  /**
   * ⚠️ SOUS LA SESSION. Sans cela, l'événement sort de la transaction et
   * l'équivalence « la transaction est confirmée ⟺ la notification est
   * demandée » tombe : un virement pourrait aboutir sans que personne n'en soit
   * prévenu.
   */
  assert.match(SERVICE, /sessOpts\?\.session \|\| null/);
});

/* ══════════════════════════════════════════════════════════════════════════ */
/* 2 bis. TX-CORE NE DÉCIDE PLUS DES CANAUX — 2026-09-23                      */
/* ══════════════════════════════════════════════════════════════════════════ */

/**
 * ⚠️ CE TEST A REMPLACÉ « un événement PAR CANAL ».
 *
 * L'ancien vérifiait la présence de `for (const channel of channels` et d'une
 * clé suffixée par canal. Cette conception était juste TANT QUE Tx-Core
 * choisissait les canaux — la clé devait alors les distinguer, sinon un échec
 * e-mail aurait forcé à rejouer le push.
 *
 * Elle est devenue fausse le 2026-09-23, parce que la raison qui la justifiait a
 * disparu : Tx-Core ne choisit plus. Il choisissait en lisant
 * `notificationPreferences` et `wantsEmail`, **deux champs qui n'existent dans
 * aucun schéma** — les deux lectures retombaient donc toujours sur `?? true`, et
 * chaque notification de transaction partait en push ET en e-mail quelles que
 * soient les préférences réelles de l'utilisateur.
 *
 * La séparation par canal existe toujours, exactement où elle doit être : dans
 * la file du backend, un item par canal retenu, avec sa propre clé suffixée par
 * `enqueue.channelIdempotencyKey()`.
 */
test("Tx-Core n'impose AUCUN canal : il ne lit plus aucune préférence", () => {
  /**
   * Les deux lectures fautives ne doivent jamais revenir. Les chercher par leur
   * nom de champ, pas par le nom de la fonction : quelqu'un qui « répare » le
   * nom du champ (`notificationSettings` au lieu de `notificationPreferences`)
   * recréerait la seconde implémentation des préférences, dans le dépôt qui ne
   * peut pas la tenir à jour.
   */
  assert.doesNotMatch(
    SERVICE,
    /notificationPreferences/,
    "Tx-Core relit des préférences : la décision appartient au backend"
  );

  assert.doesNotMatch(
    SERVICE,
    /wantsEmail/,
    "Tx-Core relit des préférences : la décision appartient au backend"
  );

  assert.doesNotMatch(
    SERVICE,
    /notificationSettings/,
    "Tx-Core relit les préférences du backend : deuxième implémentation interdite"
  );

  /** Aucune boucle de canaux, et aucun `channels:` posé dans la charge utile. */
  assert.doesNotMatch(SERVICE, /for \(const channel of channels/);
  assert.doesNotMatch(
    SERVICE,
    /channels:\s*\[/,
    "poser `channels` dans l'événement le transforme en RESTRICTION côté " +
      "backend : Tx-Core se remettrait à décider, par une autre porte"
  );
});

test("le type annoncé vient du catalogue partagé, pas d'une chaîne libre", (t) => {
  assert.match(SERVICE, /resolveTransactionType/);
  assert.match(SERVICE, /notificationType:\s*resolved\.type/);

  /**
   * `transactionTypes.js` doit être la COPIE STRICTE de celui du backend : une
   * divergence ne lève aucune erreur, elle produit deux services qui ne
   * s'accordent plus sur le type d'une même transaction — donc deux préférences
   * différentes appliquées au même fait.
   */
  const ici = path.join(RACINE, "src", "services", "notifications", "transactionTypes.js");
  const la = path.join(BACKEND, "services", "notifications", "transactionTypes.js");

  assert.ok(fs.existsSync(ici), "transactionTypes.js manque dans Tx-Core");

  if (fs.existsSync(la)) {
    assert.strictEqual(
      fs.readFileSync(ici, "utf8"),
      fs.readFileSync(la, "utf8"),
      "transactionTypes.js a divergé entre les deux dépôts — toute modification " +
        "doit être portée dans les deux, dans le même commit"
    );
  } else {
    /**
     * Dépôt cloné seul : la comparaison est impossible. On le DIT, comme le
     * fait déjà la garde de réplication d'`appEnv.test.js` — un test qui se
     * tait quand il ne vérifie rien est indiscernable d'un test qui passe.
     */
    t.diagnostic(
      "⚠️ NON VÉRIFIÉ : paynoval-backend absent de ce disque (dépôts Git " +
        "indépendants). La copie stricte de transactionTypes.js n'a PAS été " +
        "contrôlée par cette exécution."
    );
  }
});

test("la clé d'idempotence ne porte PLUS de suffixe de canal", () => {
  /**
   * C'est `enqueue.channelIdempotencyKey()` qui suffixe, côté backend. Suffixer
   * ici produirait `<hash>:push:push` : inoffensif pour la file, mais
   * `NotificationLog.idempotencyKey` ne se raccrocherait plus à l'item — la
   * jointure entre le journal et la file casse en silence.
   */
  assert.match(
    SERVICE,
    /buildOutboxIdempotencyKey\(txId, recipient, status, scope\)/,
    "la clé doit désigner le FAIT (transaction, destinataire, statut), pas sa livraison"
  );

  /**
   * `scope` n'est pas décoratif : il préserve le préfixe `settlement:` des clés
   * déjà écrites par l'ancien chemin direct des règlements externes. Sans lui,
   * un rappel prestataire rejoué renotifierait une confirmation déjà envoyée.
   */
  assert.match(SERVICE, /const prefix = scope \? `\$\{scope\}:` : "";/);
});

test("le consommateur existe et appelle l'API interne du backend", () => {
  const consommateur = sansCommentaires(
    lire("src", "services", "notifications", "notificationConsumer.js")
  );

  assert.match(consommateur, /notification\.requested\.v1/);
  assert.match(consommateur, /\/api\/v1\/internal\/notifications\/enqueue/);

  /** Il déclare comment il dédoublonne — le cadre refuserait sinon. */
  assert.match(consommateur, /async function dejaTraite/);
});

test("le backend expose bien le point d'entrée appelé", {
  skip: !fs.existsSync(BACKEND) ? "dépôt paynoval-backend absent" : false,
}, () => {
  /**
   * Un déplacement se prouve à la destination. Sans cette assertion, retirer
   * la route côté backend laisserait la suite de Tx-Core verte pendant que plus
   * aucune notification n'arrive.
   */
  const serveur = fs.readFileSync(path.join(BACKEND, "server.js"), "utf8");

  assert.match(serveur, /app\.use\("\/api\/v1\/internal\/notifications"/);

  const route = fs.readFileSync(
    path.join(BACKEND, "routes", "internalNotificationsRoutes.js"),
    "utf8"
  );

  assert.match(route, /router\.post\('\/enqueue'/);
  assert.match(route, /internalProtect/);

  const controleur = fs.readFileSync(
    path.join(BACKEND, "controllers", "internalNotificationsController.js"),
    "utf8"
  );

  /** L'idempotence est exigée, pas inventée. */
  assert.match(controleur, /IDEMPOTENCY_KEY_REQUIRED/);
  assert.match(controleur, /enqueueNotification\(/);

  /**
   * ⚠️ Et un échec rend 5xx. Un 200 sur échec ferait acquitter le message par
   * le consommateur : la notification serait perdue définitivement.
   */
  assert.match(controleur, /status\(503\)/);
});
