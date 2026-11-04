"use strict";

/**
 * Réclamation d'un transfert par son destinataire — `/api/v1/transfer-claims`
 * (2026-11-04).
 *
 * Le destinataire n'a pas de compte : pas de JWT. Seule la PASSERELLE appelle
 * ces routes (jeton de service), comme la page 3-D Secure ; c'est elle qui
 * expose la page publique et limite par adresse IP. Ici, une seconde limite
 * par LIEN (empreinte du jeton) : changer d'adresse ne donne pas d'essais en
 * plus. Le nombre d'essais faux est, lui, compté en base (cinq, puis blocage).
 */

const express = require("express");
const rateLimit = require("express-rate-limit");
const requireInternalAuth = require("../middleware/internalAuth");
const controller = require("../controllers/transferClaimController");
const { hashClaimToken } = require("../services/transferClaims/claimRules");

const router = express.Router();

const perLink = (name, max) =>
  rateLimit({
    name,
    windowMs: 10 * 60 * 1000,
    max,
    keyGenerator: (req) => `claim:${hashClaimToken(String(req.body?.token || ""))}`,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, status: 429, message: "Trop de tentatives sur ce lien, réessayez plus tard." },
  });

router.use(requireInternalAuth("gateway"));
router.use(express.json({ limit: "4kb" }));

router.post("/inspect", perLink("claim-inspect", 30), controller.inspect);
router.post("/code", perLink("claim-code", 6), controller.requestCode);
router.post("/claim", perLink("claim-submit", 10), controller.claim);
router.post("/refuse", perLink("claim-refuse", 10), controller.refuse);

module.exports = router;
