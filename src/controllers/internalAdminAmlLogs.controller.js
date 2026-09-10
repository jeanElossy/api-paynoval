"use strict";

/**
 * ============================================================================
 * JOURNAL AML BRUT — LECTURE ADMIN
 * ============================================================================
 *
 * ── D'où vient cette route ──────────────────────────────────────────────────
 *
 * `api-gateway/routes/aml.js` faisait, en onze lignes :
 *
 *     AMLLog.find().sort({ createdAt: -1 }).limit(100)
 *
 * sur l'`AMLLog` de la base de la PASSERELLE. Depuis que l'AML vit dans
 * Tx-Core, ce journal-là ne reçoit plus rien : la route aurait continué de
 * répondre 200 avec des entrées de plus en plus anciennes, sans que rien
 * n'indique qu'elle regarde un journal mort. C'est la forme de panne la plus
 * chère — celle qui a l'air de marcher.
 *
 * ── Ce qui change par rapport aux onze lignes ───────────────────────────────
 *
 * · pagination explicite plutôt qu'un `limit(100)` muet ;
 * · fenêtre de dates annoncée dans la réponse ;
 * · base indisponible ⇒ 503, jamais une liste vide (une surface d'audit qui
 *   rend « rien » quand elle veut dire « je ne sais pas » fait classer des
 *   dossiers qu'on n'a pas vus) ;
 * · `ip` retirée de la projection : elle n'apporte rien à l'instruction et
 *   c'est une donnée de localisation (règle B.4).
 */

const mongoose = require("mongoose");
const AMLLog = require("../models/AMLLog");
const logger = require("../utils/logger");

function entier(valeur, defaut, min, max) {
  const n = Number.parseInt(valeur, 10);
  if (!Number.isFinite(n)) return defaut;
  return Math.min(max, Math.max(min, n));
}

const FENETRE_DEFAUT_JOURS = 30;

exports.listAmlLogs = async function listAmlLogs(req, res) {
  const page = entier(req.query.page, 1, 1, 100000);
  const limit = entier(req.query.limit, 100, 1, 500);

  const jusqu = String(req.query.to || "").trim();
  const depuis = String(req.query.from || "").trim();

  const fin = jusqu ? new Date(jusqu) : new Date();
  const debut = depuis
    ? new Date(depuis)
    : new Date(fin.getTime() - FENETRE_DEFAUT_JOURS * 24 * 3600 * 1000);

  if (Number.isNaN(debut.getTime()) || Number.isNaN(fin.getTime()) || debut > fin) {
    return res.status(400).json({
      success: false,
      code: "INVALID_DATE_RANGE",
      error: "Plage de dates invalide.",
    });
  }

  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({
      success: false,
      code: "AML_STORE_UNAVAILABLE",
      error:
        "Journal AML indisponible. Aucune conclusion ne peut être tirée de " +
        "cette réponse.",
    });
  }

  const filtre = { createdAt: { $gte: debut, $lte: fin } };

  if (String(req.query.flagged || "").toLowerCase() === "true") {
    filtre.flagged = true;
  }

  try {
    const [entrees, total] = await Promise.all([
      AMLLog.find(filtre)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      AMLLog.countDocuments(filtre),
    ]);

    const data = entrees.map((e) => ({
      _id: e._id,
      userId: e.userId || null,
      type: e.type,
      provider: e.provider,
      amount: e.amount,
      currency: e.currency || null,
      toEmail: e.toEmail || "",
      details: e.details || null,
      flagged: Boolean(e.flagged),
      flagReason: e.flagReason || "",
      reviewed: Boolean(e.reviewed),
      reviewedBy: e.reviewedBy || null,
      reviewComment: e.reviewComment || null,
      transactionId: e.transactionId || null,
      createdAt: e.createdAt,
      loggedAt: e.loggedAt,
    }));

    return res.status(200).json({
      success: true,
      data,
      items: data,
      total,
      page,
      limit,
      window: {
        from: debut.toISOString(),
        to: fin.toISOString(),
        isDefault: !depuis && !jusqu,
        defaultDays: FENETRE_DEFAUT_JOURS,
      },
    });
  } catch (err) {
    logger.error("[aml] lecture du journal impossible", {
      message: err?.message || String(err),
    });

    return res.status(503).json({
      success: false,
      code: "AML_STORE_UNAVAILABLE",
      error: "Journal AML illisible.",
    });
  }
};
