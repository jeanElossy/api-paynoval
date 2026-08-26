"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveDeviceId,
  evaluateDeviceBinding,
  buildDeviceQuery,
} = require("../src/middleware/deviceBinding");

/* ==========================================================================
 * LIAISON À L'APPAREIL — LA RÉVOCATION DE SESSION S'ARRÊTAIT À LA PORTE
 * ======================================================================== */

test("le claim `did` PRIME sur l'en-tête", () => {
  /**
   * Ne contrôler que lorsqu'un en-tête `x-device-id` est présent laisserait
   * échapper au contrôle quiconque l'omet — c'est-à-dire exactement celui qui
   * a intérêt à l'omettre. Dès que le JETON est lié à un appareil, le contrôle
   * est obligatoire.
   */
  const r = resolveDeviceId({ payload: { did: "dev-A" }, headers: {} });

  assert.equal(r.deviceId, "dev-A");
  assert.equal(r.tokenDeviceId, "dev-A");
  assert.equal(r.mismatch, false);
});

test("un jeton lié à l'appareil A ne se rejoue pas avec l'en-tête B", () => {
  // Le scénario du jeton copié sur une autre machine.
  const r = resolveDeviceId({
    payload: { did: "dev-A" },
    headers: { "x-device-id": "dev-B" },
  });

  assert.equal(r.mismatch, true);
});

test("l'en-tête sert de repli quand le jeton ne porte pas d'appareil", () => {
  const r = resolveDeviceId({ payload: {}, headers: { "x-device-id": "dev-B" } });

  assert.equal(r.deviceId, "dev-B");
  assert.equal(r.mismatch, false);
});

test("aucun appareil désigné : pas de contrôle à faire", () => {
  // Les appels serveur à serveur et les jetons anciens n'en portent pas. Le
  // contrôle est additif, il ne casse pas ce qui n'est pas lié.
  assert.equal(resolveDeviceId({ payload: {}, headers: {} }).deviceId, null);
  assert.equal(resolveDeviceId({}).deviceId, null);
});

test("un appareil inconnu est REFUSÉ", () => {
  // Fail-closed : un jeton lié à un appareil qu'on ne retrouve pas est un
  // jeton qu'on ne peut pas valider.
  const v = evaluateDeviceBinding({ device: null, payloadIat: 1000 });

  assert.equal(v.ok, false);
  assert.equal(v.status, 401);
  assert.equal(v.code, "UNKNOWN_DEVICE");
});

test("un appareil bloqué est REFUSÉ", () => {
  const v = evaluateDeviceBinding({ device: { status: "blocked" }, payloadIat: 1000 });

  assert.equal(v.ok, false);
  assert.equal(v.status, 403);
  assert.equal(v.code, "DEVICE_BLOCKED");
});

test("un jeton émis AVANT la révocation est refusé", () => {
  /**
   * ══ LE CŒUR DU DISPOSITIF ══
   *
   * `sessionInvalidBefore` est la date de déconnexion à distance. Sans ce
   * contrôle, un jeton volé restait valable sur TX Core — le service qui
   * détient les soldes — alors que le backend le refusait déjà.
   *
   * `iat` est en SECONDES (norme JWT), la date en millisecondes. Confondre les
   * deux rendrait le contrôle inopérant sans que rien ne le signale.
   */
  const revocation = new Date("2026-08-26T10:00:00Z");

  const avant = evaluateDeviceBinding({
    device: { status: "active", sessionInvalidBefore: revocation },
    payloadIat: Math.floor(revocation.getTime() / 1000) - 60,
  });

  assert.equal(avant.ok, false);
  assert.equal(avant.code, "SESSION_REVOKED");
});

test("un jeton émis APRÈS la révocation passe", () => {
  // Sinon une reconnexion légitime resterait bloquée pour toujours.
  const revocation = new Date("2026-08-26T10:00:00Z");

  const apres = evaluateDeviceBinding({
    device: { status: "active", sessionInvalidBefore: revocation },
    payloadIat: Math.floor(revocation.getTime() / 1000) + 60,
  });

  assert.equal(apres.ok, true);
});

test("sans date de révocation, l'appareil actif passe", () => {
  const v = evaluateDeviceBinding({
    device: { status: "active", sessionInvalidBefore: null },
    payloadIat: 1000,
  });

  assert.equal(v.ok, true);
});

test("la recherche d'appareil est celle du backend, à l'identique", () => {
  /**
   * Les deux services DOIVENT retrouver le même appareil. S'ils divergent, l'un
   * révoque et l'autre non — ce qui est pire que pas de contrôle du tout,
   * puisqu'on croirait la session coupée.
   */
  const objectId = "6a7c569992f4881be52b4293";
  const parId = buildDeviceQuery(objectId, "user-1");

  assert.deepEqual(parId, { user: "user-1", _id: objectId });

  const parUid = buildDeviceQuery("installation-xyz", "user-1");

  assert.equal(parUid.user, "user-1");
  assert.deepEqual(
    parUid.$or.map((c) => Object.keys(c)[0]),
    ["deviceId", "uid", "deviceUid", "installationId"]
  );
});

/* ==========================================================================
 * IDENTITÉ PROUVÉE CONTRE IDENTITÉ ASSERTÉE
 * ======================================================================== */

const fs = require("node:fs");
const SOURCE = fs.readFileSync(
  require.resolve("../src/middleware/authMiddleware"),
  "utf8"
);

test("le JWT est examiné AVANT toute identité d'en-tête", () => {
  /**
   * ══ LA FAILLE FERMÉE ══
   *
   * L'ancienne première branche était : `x-internal-token` valide +
   * `x-user-id` ⇒ on charge cet utilisateur avec son RÔLE RÉEL, sans jamais
   * regarder `Authorization`. Un secret de service devenait une clé
   * d'usurpation universelle — superadmin compris.
   *
   * Désormais l'en-tête `Authorization` est lu en premier, et la branche
   * assertée ne s'ouvre que `if (isInternalCaller && !token)`.
   */
  assert.match(SOURCE, /if \(isInternalCaller && !token\)/);
});

test("une identité assertée ne porte AUCUN privilège", () => {
  /**
   * Le service peut agir POUR un compte — un virement doit être rattaché à
   * quelqu'un — mais personne n'a prouvé que le titulaire est à l'origine de
   * l'appel. Le rôle est donc ramené à `user` : ni validation, ni
   * remboursement, ni annulation au-delà de ce que le compte ferait lui-même.
   *
   * C'est le motif « on-behalf-of » : agir pour un client, jamais en tant que
   * personnel.
   */
  assert.match(SOURCE, /role: "user", assertedRole: true/);
  assert.match(SOURCE, /assertedIdentity: true/);
});

test("`x-user-id` doit être un identifiant valide", () => {
  // Sans ce contrôle, une valeur fantaisiste partait en requête Mongo.
  assert.match(SOURCE, /mongoose\.isValidObjectId\(uid\)/);
});

test("le jeton de service ne change plus ni l'utilisateur ni son rôle", () => {
  // Il ne marque plus qu'une confiance RÉSEAU.
  assert.match(SOURCE, /req\.isInternal = isInternalCaller;/);
});

test("le contrôle d'appareil est FAIL-CLOSED", () => {
  /**
   * Modèle indisponible ou panne base : on refuse. Un contrôle de sécurité dont
   * la panne ouvre la porte n'est pas un contrôle. C'est l'inverse de la
   * politique retenue sur la limitation de débit, et c'est délibéré : ici
   * l'enjeu est l'accès aux fonds.
   */
  const matches = SOURCE.match(/Vérification de l'appareil indisponible/g) || [];
  assert.equal(matches.length, 2, "les deux chemins d'échec doivent refuser");
  assert.match(SOURCE, /createError\(503, "Vérification de l'appareil indisponible"\)/);
});
