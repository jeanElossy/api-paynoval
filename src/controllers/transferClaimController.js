"use strict";

/**
 * Réclamation d'un transfert par son destinataire — `/api/v1/transfer-claims`
 * (2026-11-04). Contrôleur mince : tout est dans `transferClaims/claimService`.
 *
 * Le jeton voyage dans le CORPS (jamais dans l'URL d'un appel d'API) : il vaut
 * autorisation, et une URL finit dans les journaux d'accès.
 *
 * `Cache-Control: no-store` partout : ces réponses portent une question de
 * sécurité ou un code de démonstration.
 */

const asyncHandler = require("express-async-handler");
const claimService = require("../services/transferClaims/claimService");

const token = (req) => String(req.body?.token || "");

function noStore(res) {
  res.set("Cache-Control", "no-store");
}

const inspect = asyncHandler(async (req, res) => {
  noStore(res);
  res.json({ success: true, data: await claimService.inspect(token(req)) });
});

const requestCode = asyncHandler(async (req, res) => {
  noStore(res);
  res.json({ success: true, data: await claimService.requestCode(token(req)) });
});

const claim = asyncHandler(async (req, res) => {
  noStore(res);
  const data = await claimService.claim({
    token: token(req),
    answer: String(req.body?.answer || ""),
    code: String(req.body?.code || ""),
  });
  res.json({ success: true, data });
});

const refuse = asyncHandler(async (req, res) => {
  noStore(res);
  res.json({ success: true, data: await claimService.refuse({ token: token(req), code: String(req.body?.code || "") }) });
});

module.exports = { inspect, requestCode, claim, refuse };
