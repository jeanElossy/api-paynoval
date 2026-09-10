"use strict";

/**
 * ============================================================================
 * VÉRIFICATION D'UN NUMÉRO DE DÉPÔT — LE SEUL POINT D'ENTRÉE
 * ============================================================================
 *
 * ── Ce qu'il remplace ───────────────────────────────────────────────────────
 *
 * La même capacité existait TROIS fois avant ce fichier :
 *
 *   1. le backend principal, `/api/v1/verification/start-phone` — vivant, mais
 *      il vérifie le numéro DU COMPTE et écrit `users.phoneVerified` ;
 *   2. le bord, `controllers/phoneVerificationController.js` (353 l.) — la
 *      bonne capacité, montée NULLE PART ;
 *   3. l'application mobile, qui appelait la forme de (2) et prenait donc 404
 *      sur les trois routes.
 *
 * Deux capacités distinctes portant le même nom, dans deux dépôts, dont une
 * morte — et le client parlait à la morte. Aucun découpage en services n'aurait
 * évité ça ; un point d'entrée unique, si.
 *
 * ── La séparation des pouvoirs ─────────────────────────────────────────────
 *
 *   · TX Core (ici)     : décide, compte, bloque, conserve la preuve ;
 *   · backend principal : envoie et vérifie le SMS (il possède le canal) ;
 *   · bord              : relaie, et rien d'autre.
 *
 * ── Ce qui ne sort jamais d'ici ─────────────────────────────────────────────
 *
 * Le code OTP n'est ni journalisé, ni renvoyé, ni cité dans une erreur. Les
 * numéros ne paraissent dans les journaux que par leurs quatre derniers
 * chiffres (règle B.4).
 */

const { getTxConn } = require("../config/db");
const logger = require("../utils/logger");
const { toE164, last4 } = require("../utils/phone");
const { envoyerCode, verifierCode } = require("../services/notifications/phoneOtpClient");

let _Trusted = null;

/** Résolution paresseuse : la connexion n'existe qu'après le bootstrap. */
function modele() {
  if (!_Trusted) {
    _Trusted = require("../models/TrustedDepositNumber")(getTxConn());
  }
  return _Trusted;
}

/* ══════════════════════════════════════════════════════════════════════════
 * POLITIQUE ANTI-ABUS
 * ══════════════════════════════════════════════════════════════════════════ */

/** Délai entre deux envois. Un SMS met quelques secondes à arriver. */
const RENVOI_SECONDES = Number(process.env.DEPOSIT_OTP_RESEND_SECONDS || 30);

/** Envois autorisés par fenêtre glissante. Chacun coûte un SMS réel. */
const ENVOIS_MAX = Number(process.env.DEPOSIT_OTP_MAX_SENDS || 5);

/** Durée de la fenêtre, et durée du blocage qu'un dépassement déclenche. */
const FENETRE_MINUTES = Number(process.env.DEPOSIT_OTP_WINDOW_MINUTES || 15);

/**
 * Saisies fausses tolérées avant blocage.
 *
 * ⚠️ CE PLAFOND EST À NOUS, pas à Twilio. Twilio borne aussi les vérifications
 * par code, mais un contrôle de sécurité ne se délègue pas à la politique
 * tarifaire d'un fournisseur : le jour où l'on change d'offre ou de
 * prestataire, la protection disparaîtrait sans que rien ne le signale.
 */
const SAISIES_FAUSSES_MAX = Number(process.env.DEPOSIT_OTP_MAX_ATTEMPTS || 5);

function maintenant() {
  return new Date();
}

/**
 * `blockedUntil` fait foi, jamais la chaîne `status`.
 *
 * Le bord posait `status: "blocked"` sans jamais le repasser à `pending` : une
 * fois la date expirée, l'utilisateur était débloqué EN FAIT mais l'API
 * continuait d'annoncer « bloqué ». L'état affiché et l'état réel divergeaient.
 */
function estBloque(doc) {
  if (!doc?.blockedUntil) return false;
  return new Date(doc.blockedUntil).getTime() > Date.now();
}

/** L'état visible, dérivé — jamais lu tel quel dans le document. */
function statutEffectif(doc) {
  if (!doc) return "none";
  if (String(doc.status) === "trusted") return "trusted";
  if (estBloque(doc)) return "blocked";
  return "pending";
}

/**
 * La fenêtre est-elle encore ouverte ? Une fenêtre expirée remet le compteur à
 * zéro : c'est ce qui manquait au bord, dont `sentCount` était cumulatif à vie.
 */
function fenetreOuverte(doc) {
  if (!doc?.windowStartedAt) return false;
  const ecoule = Date.now() - new Date(doc.windowStartedAt).getTime();
  return ecoule < FENETRE_MINUTES * 60 * 1000;
}

function peutEnvoyer(doc) {
  if (estBloque(doc)) {
    return { ok: false, raison: "blocked", jusqua: doc.blockedUntil };
  }

  if (doc?.lastSentAt) {
    const secondes = Math.floor(
      (Date.now() - new Date(doc.lastSentAt).getTime()) / 1000
    );
    if (secondes < RENVOI_SECONDES) {
      return { ok: false, raison: "cooldown", dans: RENVOI_SECONDES - secondes };
    }
  }

  if (fenetreOuverte(doc) && Number(doc.sentCount || 0) >= ENVOIS_MAX) {
    return { ok: false, raison: "rate_limit" };
  }

  return { ok: true };
}

/* ══════════════════════════════════════════════════════════════════════════
 * HELPERS DE REQUÊTE
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * ⚠️ L'IDENTIFIANT VIENT DU JETON, JAMAIS DU CORPS.
 *
 * Le lire dans `req.body.userId` laisserait n'importe qui vérifier — ou
 * consulter — les numéros d'un autre compte. Toutes les lectures de ce fichier
 * sont filtrées par cette valeur.
 */
function identifiant(req) {
  return req.user?._id || req.user?.id || req.internalUserId || null;
}

function lirePhone(source) {
  const s = source || {};
  return {
    phone: s.phoneNumber || s.phone || s.to || "",
    country: s.country || "",
  };
}

function erreurNumero(res) {
  return res.status(400).json({
    success: false,
    error:
      "Numéro invalide. Format attendu : international (ex. +2250700000000) " +
      "ou numéro local accompagné du pays.",
    code: "PHONE_INVALID",
  });
}

/** Traduit une erreur du client OTP en réponse HTTP, sans jamais aplatir. */
function repondreEchecOtp(res, err, contexte) {
  const statut = Number(err?.statut) || 503;

  logger.error(`[deposit-otp] ${contexte}`, {
    code: err?.code || "INCONNU",
    statut,
  });

  return res.status(statut).json({
    success: false,
    error:
      statut === 422
        ? "Ce numéro ne peut pas recevoir de SMS."
        : "Service de vérification momentanément indisponible. Réessaie dans un instant.",
    code: err?.code || "OTP_UNAVAILABLE",
  });
}

/* ══════════════════════════════════════════════════════════════════════════
 * GET /status
 * ══════════════════════════════════════════════════════════════════════════ */

exports.status = async (req, res) => {
  const userId = identifiant(req);
  if (!userId) {
    return res.status(401).json({ success: false, error: "Non autorisé." });
  }

  const { phone, country } = lirePhone(req.query);
  const phoneE164 = toE164(phone, country).e164;
  if (!phoneE164) return erreurNumero(res);

  try {
    const doc = await modele()
      .findOne({ userId: String(userId), phoneE164 })
      .lean();

    const status = statutEffectif(doc);

    return res.json({
      success: true,
      data: {
        phoneE164,
        trusted: status === "trusted",
        status,
        verifiedAt: doc?.verifiedAt
          ? new Date(doc.verifiedAt).toISOString()
          : null,
        blockedUntil: estBloque(doc)
          ? new Date(doc.blockedUntil).toISOString()
          : null,
      },
    });
  } catch (err) {
    /**
     * ⚠️ 503, PAS `trusted: false`.
     *
     * Répondre « non vérifié » sur une panne de base ferait relancer un OTP à
     * un utilisateur dont le numéro est peut-être déjà de confiance — et le
     * dépôt échouerait quand même. Une panne se dit.
     */
    logger.error("[deposit-otp] statut illisible", {
      phone: last4(phoneE164),
      message: err?.message,
    });

    return res.status(503).json({
      success: false,
      error: "Vérification momentanément indisponible.",
      code: "TRUST_STORE_UNAVAILABLE",
    });
  }
};

/* ══════════════════════════════════════════════════════════════════════════
 * POST /start
 * ══════════════════════════════════════════════════════════════════════════ */

exports.start = async (req, res) => {
  const userId = identifiant(req);
  if (!userId) {
    return res.status(401).json({ success: false, error: "Non autorisé." });
  }

  const { phone, country } = lirePhone(req.body);
  const phoneE164 = toE164(phone, country).e164;
  if (!phoneE164) return erreurNumero(res);

  const canal = String(req.body?.channel || "sms").trim().toLowerCase();

  let doc;
  try {
    /**
     * ⚠️ `upsert` PLUTÔT QUE « CHERCHER PUIS CRÉER ».
     *
     * Deux `/start` concurrents passaient tous deux le `findOne` du bord et
     * appelaient `create` : le second levait E11000 sur l'index unique, et le
     * contrôleur rendait 500 sur une situation parfaitement normale (double
     * appui). L'upsert la traite sans erreur.
     */
    doc = await modele().findOneAndUpdate(
      { userId: String(userId), phoneE164 },
      { $setOnInsert: { userId: String(userId), phoneE164, status: "pending" } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  } catch (err) {
    logger.error("[deposit-otp] registre inaccessible (start)", {
      phone: last4(phoneE164),
      message: err?.message,
    });
    return res.status(503).json({
      success: false,
      error: "Vérification momentanément indisponible.",
      code: "TRUST_STORE_UNAVAILABLE",
    });
  }

  /** Déjà prouvé : on ne facture pas un SMS pour reconfirmer un fait acquis. */
  if (String(doc.status) === "trusted") {
    return res.json({
      success: true,
      data: { phoneE164, status: "trusted", verifiedAt: doc.verifiedAt },
      message: "Numéro déjà vérifié.",
    });
  }

  const verdict = peutEnvoyer(doc);

  if (!verdict.ok) {
    if (verdict.raison === "cooldown") {
      return res.status(429).json({
        success: false,
        error: "Patiente avant de redemander un code.",
        code: "OTP_COOLDOWN",
        retryIn: verdict.dans,
      });
    }

    if (verdict.raison === "rate_limit") {
      const jusqua = new Date(Date.now() + FENETRE_MINUTES * 60 * 1000);

      await modele()
        .updateOne(
          { _id: doc._id },
          { $set: { status: "blocked", blockedUntil: jusqua } }
        )
        .catch(() => {});

      logger.warn("[deposit-otp] quota d'envois dépassé", {
        phone: last4(phoneE164),
        envois: doc.sentCount,
      });

      return res.status(429).json({
        success: false,
        error: "Trop de demandes. Réessaie plus tard.",
        code: "OTP_RATE_LIMIT",
        blockedUntil: jusqua.toISOString(),
      });
    }

    return res.status(429).json({
      success: false,
      error: "Vérification temporairement bloquée. Réessaie plus tard.",
      code: "OTP_BLOCKED",
      blockedUntil: new Date(verdict.jusqua).toISOString(),
    });
  }

  /**
   * ⚠️ ON ENVOIE AVANT DE COMPTER, ET ON NE COMPTE QUE CE QUI EST PARTI.
   *
   * Compter d'abord ferait consommer le quota d'un utilisateur pour des SMS
   * que Twilio a refusés : cinq pannes du fournisseur suffiraient à le bloquer
   * quinze minutes sans qu'aucun code ne lui soit jamais parvenu.
   */
  try {
    await envoyerCode({ phoneE164, channel: canal });
  } catch (err) {
    return repondreEchecOtp(res, err, "envoi impossible");
  }

  const t = maintenant();
  const nouvelleFenetre = !fenetreOuverte(doc);

  await modele()
    .updateOne(
      { _id: doc._id },
      nouvelleFenetre
        ? {
            $set: {
              status: "pending",
              lastSentAt: t,
              windowStartedAt: t,
              sentCount: 1,
              failedCheckCount: 0,
              blockedUntil: null,
            },
          }
        : {
            $set: { status: "pending", lastSentAt: t, failedCheckCount: 0 },
            $inc: { sentCount: 1 },
          }
    )
    .catch((err) => {
      /**
       * Le SMS est PARTI. Ne pas avoir su l'enregistrer est un défaut de
       * comptage, pas un échec d'envoi : rendre une erreur ferait recommencer
       * l'utilisateur et enverrait un second SMS. On signale et on continue.
       */
      logger.error("[deposit-otp] envoi réussi, comptage échoué", {
        phone: last4(phoneE164),
        message: err?.message,
      });
    });

  return res.json({
    success: true,
    data: { phoneE164, status: "pending", resendIn: RENVOI_SECONDES },
    message: "Code envoyé.",
  });
};

/* ══════════════════════════════════════════════════════════════════════════
 * POST /verify
 * ══════════════════════════════════════════════════════════════════════════ */

exports.verify = async (req, res) => {
  const userId = identifiant(req);
  if (!userId) {
    return res.status(401).json({ success: false, error: "Non autorisé." });
  }

  const { phone, country } = lirePhone(req.body);
  const phoneE164 = toE164(phone, country).e164;
  if (!phoneE164) return erreurNumero(res);

  const code = String(req.body?.code || "").trim();
  if (!code) {
    return res
      .status(400)
      .json({ success: false, error: "Code requis.", code: "OTP_REQUIRED" });
  }

  let doc;
  try {
    doc = await modele().findOne({ userId: String(userId), phoneE164 });
  } catch (err) {
    logger.error("[deposit-otp] registre inaccessible (verify)", {
      phone: last4(phoneE164),
      message: err?.message,
    });
    return res.status(503).json({
      success: false,
      error: "Vérification momentanément indisponible.",
      code: "TRUST_STORE_UNAVAILABLE",
    });
  }

  /**
   * Aucune demande en cours : on refuse SANS appeler le fournisseur. Laisser
   * passer permettrait de tester des codes sur un numéro pour lequel on n'a
   * jamais rien demandé — et chaque appel coûterait une vérification facturée.
   */
  if (!doc) {
    return res.status(404).json({
      success: false,
      error: "Aucune vérification en cours. Demande d'abord un code.",
      code: "OTP_NOT_STARTED",
    });
  }

  if (estBloque(doc)) {
    return res.status(429).json({
      success: false,
      error: "Vérification bloquée temporairement. Réessaie plus tard.",
      code: "OTP_BLOCKED",
      blockedUntil: new Date(doc.blockedUntil).toISOString(),
    });
  }

  let verdict;
  try {
    verdict = await verifierCode({ phoneE164, code });
  } catch (err) {
    return repondreEchecOtp(res, err, "vérification impossible");
  }

  if (!verdict?.approved) {
    /**
     * ⚠️ CHAQUE SAISIE FAUSSE EST COMPTÉE, ET LE COMPTEUR BLOQUE.
     *
     * Sans ce compteur — absent de la version du bord — un code à six chiffres
     * n'était borné que par la politique de Twilio. On ne délègue pas un
     * contrôle de sécurité au plafond commercial d'un fournisseur.
     */
    const echecs = Number(doc.failedCheckCount || 0) + 1;
    const trop = echecs >= SAISIES_FAUSSES_MAX;
    const jusqua = trop ? new Date(Date.now() + FENETRE_MINUTES * 60 * 1000) : null;

    await modele()
      .updateOne(
        { _id: doc._id },
        trop
          ? { $set: { failedCheckCount: echecs, status: "blocked", blockedUntil: jusqua } }
          : { $set: { failedCheckCount: echecs } }
      )
      .catch(() => {});

    if (trop) {
      logger.warn("[deposit-otp] saisies fausses répétées", {
        phone: last4(phoneE164),
        echecs,
      });

      return res.status(429).json({
        success: false,
        error: "Trop de codes erronés. Réessaie plus tard.",
        code: "OTP_BLOCKED",
        blockedUntil: jusqua.toISOString(),
      });
    }

    return res.status(401).json({
      success: false,
      error: "Code invalide.",
      code: "OTP_INVALID",
      attemptsLeft: Math.max(0, SAISIES_FAUSSES_MAX - echecs),
    });
  }

  const t = maintenant();

  try {
    await modele().updateOne(
      { _id: doc._id },
      {
        $set: {
          status: "trusted",
          verifiedAt: t,
          blockedUntil: null,
          failedCheckCount: 0,
        },
      }
    );
  } catch (err) {
    /**
     * ⚠️ 503, PAS 200.
     *
     * Le code était bon, mais la confiance n'est PAS enregistrée. Répondre
     * « vérifié » ferait tenter un dépôt qui serait refusé juste après, sans
     * que l'utilisateur comprenne pourquoi. On lui dit de recommencer.
     */
    logger.error("[deposit-otp] code validé, confiance non enregistrée", {
      phone: last4(phoneE164),
      message: err?.message,
    });

    return res.status(503).json({
      success: false,
      error: "Vérification acceptée mais non enregistrée. Recommence.",
      code: "TRUST_WRITE_FAILED",
    });
  }

  logger.info("[deposit-otp] numéro vérifié", { phone: last4(phoneE164) });

  return res.json({
    success: true,
    data: { phoneE164, status: "trusted", verifiedAt: t.toISOString() },
    message: "Numéro vérifié.",
  });
};

/* ══════════════════════════════════════════════════════════════════════════
 * GET /list
 * ══════════════════════════════════════════════════════════════════════════ */

exports.list = async (req, res) => {
  const userId = identifiant(req);
  if (!userId) {
    return res.status(401).json({ success: false, error: "Non autorisé." });
  }

  try {
    const liste = await modele()
      .find({ userId: String(userId), status: "trusted" })
      .select("phoneE164 verifiedAt -_id")
      .sort({ verifiedAt: -1 })
      .limit(50)
      .lean();

    return res.json({ success: true, data: liste || [] });
  } catch (err) {
    /**
     * Une liste vide sur panne ferait croire à l'utilisateur qu'il n'a vérifié
     * aucun numéro, et le pousserait à tout recommencer — cinq SMS pour rien.
     */
    logger.error("[deposit-otp] liste illisible", { message: err?.message });

    return res.status(503).json({
      success: false,
      error: "Liste momentanément indisponible.",
      code: "TRUST_STORE_UNAVAILABLE",
    });
  }
};
