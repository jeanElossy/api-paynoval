"use strict";

const mongoose = require("mongoose");

/**
 * ============================================================================
 * LIAISON À L'APPAREIL — LA RÉVOCATION DE SESSION S'ARRÊTAIT À LA PORTE
 * ============================================================================
 *
 * Le backend principal impose ce contrôle depuis longtemps : dès qu'un jeton
 * porte un appareil, cet appareil doit exister, ne pas être bloqué, et le jeton
 * doit avoir été émis APRÈS `device.sessionInvalidBefore`. C'est le mécanisme
 * qui fait qu'une déconnexion à distance, un vol de téléphone ou un blocage
 * d'appareil coupent réellement l'accès.
 *
 * TX Core ne le faisait PAS. Il vérifiait la signature du jeton, chargeait
 * l'utilisateur, et s'arrêtait là. Conséquence directe : un jeton exfiltré
 * était refusé par le backend et **accepté par TX Core** — c'est-à-dire par le
 * service qui détient les soldes, le grand livre et les virements. La
 * révocation de session ne couvrait pas le seul service où elle compte
 * vraiment.
 *
 * ⚠️ LE CLAIM `did` PRIME SUR L'EN-TÊTE. Ne contrôler que lorsqu'un en-tête
 * `x-device-id` est présent laisserait échapper au contrôle quiconque l'omet.
 * Dès que le JETON est lié à un appareil, le contrôle est obligatoire.
 *
 * ⚠️ FAIL-CLOSED. Modèle indisponible, panne base, appareil inconnu : on
 * refuse. Un contrôle de sécurité dont la panne ouvre la porte n'est pas un
 * contrôle. C'est l'inverse de la politique retenue sur la limitation de débit,
 * et c'est délibéré : ici l'enjeu est l'accès aux fonds.
 *
 * Les deux fonctions décisionnelles sont PURES : aucune entrée/sortie, donc
 * testables sans base ni serveur — la contrainte des suites de ce dépôt.
 */

/**
 * Quel appareil ce jeton désigne-t-il, et l'en-tête le contredit-il ?
 *
 * @returns {{deviceId: string|null, tokenDeviceId: string|null, headerDeviceId: string|null, mismatch: boolean}}
 */
function resolveDeviceId({ payload = null, headers = {} } = {}) {
  const tokenDeviceId = payload?.did ? String(payload.did).trim() : null;

  const rawHeader =
    headers["x-device-id"] || headers["x-deviceid"] || headers["x-device_id"] || null;
  const headerDeviceId = rawHeader
    ? String(Array.isArray(rawHeader) ? rawHeader[0] : rawHeader).trim()
    : null;

  return {
    tokenDeviceId: tokenDeviceId || null,
    headerDeviceId: headerDeviceId || null,
    deviceId: tokenDeviceId || headerDeviceId || null,
    /**
     * Un jeton lié à l'appareil A ne peut pas être rejoué avec l'en-tête B.
     * C'est le scénario du jeton copié sur une autre machine.
     */
    mismatch: Boolean(
      tokenDeviceId && headerDeviceId && tokenDeviceId !== headerDeviceId
    ),
  };
}

/**
 * L'appareil trouvé autorise-t-il ce jeton ?
 *
 * @returns {{ok: boolean, status: number, code: string, message: string}}
 */
function evaluateDeviceBinding({ device = null, payloadIat = null } = {}) {
  if (!device) {
    return {
      ok: false,
      status: 401,
      code: "UNKNOWN_DEVICE",
      message: "Appareil inconnu pour ce compte",
    };
  }

  if (device.status === "blocked") {
    return {
      ok: false,
      status: 403,
      code: "DEVICE_BLOCKED",
      message: "Appareil bloqué",
    };
  }

  /**
   * `sessionInvalidBefore` est la date de révocation. Un jeton émis AVANT elle
   * a été invalidé — c'est ce qui rend effective une déconnexion à distance.
   *
   * `iat` est en SECONDES (norme JWT), la date en millisecondes.
   */
  const invalidBefore = device.sessionInvalidBefore
    ? new Date(device.sessionInvalidBefore).getTime()
    : null;

  if (
    invalidBefore &&
    typeof payloadIat === "number" &&
    payloadIat * 1000 < invalidBefore
  ) {
    return {
      ok: false,
      status: 401,
      code: "SESSION_REVOKED",
      message: "Session révoquée",
    };
  }

  return { ok: true, status: 200, code: "OK", message: "" };
}

/**
 * Un identifiant d'appareil peut être l'`_id` Mongo ou l'un des identifiants
 * fonctionnels posés par le mobile. Repris à l'identique du backend principal :
 * les deux services doivent trouver le MÊME appareil, sinon l'un révoque et
 * l'autre non.
 *
 * ⚠️ VÉRIFIÉ SUR LES DONNÉES RÉELLES (2026-08-26) : **aucun** des appareils
 * enregistrés ne porte `deviceId`, `uid`, `deviceUid` ni `installationId` —
 * 0 sur 13. La branche `$or` ne matche donc rien aujourd'hui : le seul chemin
 * vivant est celui de l'`_id`.
 *
 * C'est cohérent avec le reste de la chaîne, et ce n'est pas un hasard :
 * `deviceController` valide l'identifiant reçu contre `/^[a-f\d]{24}$/i`, et
 * le mobile persiste ce que `/devices/register` lui rend, c'est-à-dire
 * `String(device._id)` (`payNoval-master/services/deviceService.js`).
 *
 * La branche `$or` est CONSERVÉE malgré tout — la retirer d'ici sans la retirer
 * du backend recréerait exactement la divergence que ce commentaire met en
 * garde contre. Elle ne coûte rien : elle n'est atteinte que si l'identifiant
 * reçu n'est pas un ObjectId, cas qui n'existe pas dans le parc actuel.
 */
function buildDeviceQuery(deviceIdRaw, userId) {
  const deviceId = String(deviceIdRaw || "").trim();
  const base = { user: userId };

  if (mongoose.isValidObjectId(deviceId)) {
    return { ...base, _id: deviceId };
  }

  return {
    ...base,
    $or: [
      { deviceId },
      { uid: deviceId },
      { deviceUid: deviceId },
      { installationId: deviceId },
    ],
  };
}

module.exports = {
  resolveDeviceId,
  evaluateDeviceBinding,
  buildDeviceQuery,
};
