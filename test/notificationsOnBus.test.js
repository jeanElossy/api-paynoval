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

test("un événement PAR CANAL — la clé d'idempotence resterait ambiguë sinon", () => {
  /**
   * Un seul événement portant tous les canaux forcerait à rejouer la poussée
   * quand seul le courriel a échoué. La clé est construite par canal, comme
   * l'était le document d'outbox.
   */
  assert.match(SERVICE, /for \(const channel of channels/);
  assert.match(SERVICE, /buildOutboxIdempotencyKey\(\s*txId,\s*recipient,\s*status,\s*channel/);
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
