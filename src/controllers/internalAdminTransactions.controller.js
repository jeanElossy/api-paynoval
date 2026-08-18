// File: controllers/internalAdminTransactions.controller.js

"use strict";

const mongoose = require("mongoose");
const createError = require("http-errors");

const { Transaction } = require("../services/transactions/shared/runtime");
const { buildUserScopeQuery } = require("../utils/userScopeQuery");

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeSort(sort) {
  const allowedFields = new Set([
    "createdAt",
    "-createdAt",
    "updatedAt",
    "-updatedAt",
    "amount",
    "-amount",
    "netAmount",
    "-netAmount",
    "status",
    "-status",
    "provider",
    "-provider",
    "reference",
    "-reference",
  ]);

  const clean = String(sort || "-createdAt").trim();
  return allowedFields.has(clean) ? clean : "-createdAt";
}

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(String(id || ""));
}

function buildSearchQuery(search) {
  const safeSearch = escapeRegex(search);

  return [
    { reference: { $regex: safeSearch, $options: "i" } },
    { senderEmail: { $regex: safeSearch, $options: "i" } },
    { recipientEmail: { $regex: safeSearch, $options: "i" } },
    { toEmail: { $regex: safeSearch, $options: "i" } },
    { providerReference: { $regex: safeSearch, $options: "i" } },
    { verificationToken: { $regex: safeSearch, $options: "i" } },
    { "meta.reference": { $regex: safeSearch, $options: "i" } },
    { "meta.id": { $regex: safeSearch, $options: "i" } },
  ];
}

async function listInternalAdminTransactions(req, res, next) {
  try {
    const {
      search = "",
      status = "all",
      provider = "all",
      flow = "all",
      page = 1,
      limit = 100,
      sort = "-createdAt",
      archived = "all",
      userId = "",
      email = "",
      debug,
    } = req.query;

    const safePage = Math.max(Number(page) || 1, 1);
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 200);

    const query = {};

    // ⚠️ `search` et la portée utilisateur produisent tous deux un `$or`. Les
    // écrire l'un après l'autre sur `query.$or` ferait silencieusement gagner
    // le dernier : une recherche dans la fiche d'un client renverrait alors les
    // transactions de TOUS les clients. Ils sont donc combinés en `$and`, ce
    // qui exprime la seule lecture correcte — « ce compte ET ce terme ».
    const scopes = [];

    if (search) {
      scopes.push({ $or: buildSearchQuery(search) });
    }

    if (userId || email) {
      const userClauses = buildUserScopeQuery(userId, email);

      // Une portée demandée mais inexploitable (identifiant malformé) ne doit
      // pas se dégrader en « tout l'historique de la plateforme ».
      if (!userClauses.length) {
        return res.status(400).json({
          success: false,
          error: "Portée utilisateur invalide : userId ou email attendu.",
        });
      }

      scopes.push({ $or: userClauses });
    }

    if (scopes.length === 1) {
      Object.assign(query, scopes[0]);
    } else if (scopes.length > 1) {
      query.$and = scopes;
    }

    if (status && status !== "all") {
      query.status = String(status).trim();
    }

    if (provider && provider !== "all") {
      query.provider = String(provider).trim();
    }

    if (flow && flow !== "all") {
      query.flow = String(flow).trim();
    }

    if (archived === "true") {
      query.archived = true;
    }

    if (archived === "false") {
      query.archived = { $ne: true };
    }

    console.log(
      "[TX-CORE][INTERNAL ADMIN TX][LIST] Requête reçue",
      JSON.stringify({
        originalUrl: req.originalUrl,
        query: req.query,
        mongoQuery: query,
        dbName: Transaction.db?.name,
        collection: Transaction.collection?.name,
        modelName: Transaction.modelName,
      })
    );

    const total = await Transaction.countDocuments(query);

    const txs = await Transaction.find(query)
      .sort(normalizeSort(sort))
      .skip((safePage - 1) * safeLimit)
      .limit(safeLimit)
      .lean();

    console.log(
      "[TX-CORE][INTERNAL ADMIN TX][LIST] Résultat Mongo",
      JSON.stringify({
        total,
        returned: txs.length,
        page: safePage,
        limit: safeLimit,
        dbName: Transaction.db?.name,
        collection: Transaction.collection?.name,
      })
    );

    const payload = {
      success: true,
      total,
      page: safePage,
      limit: safeLimit,
      pages: Math.ceil(total / safeLimit),
      txs,
      data: {
        total,
        page: safePage,
        limit: safeLimit,
        pages: Math.ceil(total / safeLimit),
        txs,
      },
    };

    if (debug === "1" || debug === "true") {
      payload.debug = {
        query,
        dbName: Transaction.db?.name,
        collection: Transaction.collection?.name,
        modelName: Transaction.modelName,
        totalWithoutFilter: await Transaction.estimatedDocumentCount(),
      };
    }

    return res.status(200).json(payload);
  } catch (error) {
    console.error(
      "[TX-CORE][INTERNAL ADMIN TX][LIST] Erreur",
      JSON.stringify({
        message: error?.message,
        stack: error?.stack,
      })
    );

    next(error);
  }
}

/**
 * GET /internal/admin/users/:id/stats
 *
 * Les indicateurs d'un compte, comptés PAR MONGO et non dans le navigateur.
 * Le back-office chargeait jusqu'ici 1 000 transactions pour les additionner
 * côté client : au-delà de mille opérations, les totaux devenaient faux sans
 * que rien ne le signale, et les comptes actifs sont précisément ceux qu'on
 * regarde le plus.
 *
 * Renvoie aussi la consommation du jour et du mois glissant, qui sert à
 * rapprocher les plafonds affichés dans la fiche (`User.limits`) de ce qui a
 * réellement été dépensé. Seules les transactions SORTANTES et abouties sont
 * comptées : un envoi annulé n'a rien consommé.
 */
async function getInternalAdminUserStats(req, res, next) {
  try {
    const { id } = req.params;
    const email = String(req.query.email || "").trim().toLowerCase();

    const clauses = buildUserScopeQuery(id, email);
    if (!clauses.length) {
      throw createError(400, "Identifiant utilisateur invalide");
    }

    const scope = { $or: clauses };
    const oid = isValidObjectId(id) ? new mongoose.Types.ObjectId(String(id)) : null;

    // Statuts considérés comme « aboutis » : eux seuls déplacent de l'argent.
    const SETTLED = ["confirmed", "refunded"];
    const FAILED = ["failed", "cancelled"];
    const PENDING = ["created", "pending", "pending_review", "processing", "locked", "relaunch"];

    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    // `amountSource` est le montant réellement débité au payeur ; `amount` est
    // le repli des transactions anciennes, antérieures au découpage
    // source/target. Prendre `amount` seul sous-estimerait les transferts
    // multi-devises.
    const amountExpr = { $ifNull: ["$amountSource", "$amount", 0] };
    const feeExpr = { $ifNull: ["$feeActual", "$feeSource", "$feeSnapshot", 0] };

    const isOutgoing = oid
      ? { $or: [{ $eq: ["$sender", oid] }, { $eq: ["$userId", oid] }] }
      : { $literal: false };

    const [facets] = await Transaction.aggregate([
      { $match: scope },
      {
        $facet: {
          byStatus: [{ $group: { _id: "$status", count: { $sum: 1 } } }],

          volumes: [
            { $match: { status: { $in: SETTLED } } },
            {
              $group: {
                _id: null,
                sent: { $sum: { $cond: [isOutgoing, amountExpr, 0] } },
                received: { $sum: { $cond: [isOutgoing, 0, amountExpr] } },
                fees: { $sum: { $cond: [isOutgoing, feeExpr, 0] } },
              },
            },
          ],

          usage: [
            {
              $match: {
                status: { $in: SETTLED },
                createdAt: { $gte: startOfMonth },
              },
            },
            {
              $group: {
                _id: null,
                monthly: { $sum: { $cond: [isOutgoing, amountExpr, 0] } },
                daily: {
                  $sum: {
                    $cond: [
                      { $and: [isOutgoing, { $gte: ["$createdAt", startOfDay] }] },
                      amountExpr,
                      0,
                    ],
                  },
                },
              },
            },
          ],

          last: [
            { $sort: { createdAt: -1 } },
            { $limit: 1 },
            {
              $project: {
                reference: 1,
                status: 1,
                flow: 1,
                provider: 1,
                amount: amountExpr,
                currency: { $ifNull: ["$currencySource", "$currency", null] },
                createdAt: 1,
              },
            },
          ],

          currencies: [
            { $group: { _id: { $ifNull: ["$currencySource", "$currency", null] }, count: { $sum: 1 } } },
            { $sort: { count: -1 } },
            { $limit: 5 },
          ],
        },
      },
    ]);

    const statusCounts = {};
    let total = 0;
    for (const row of facets?.byStatus || []) {
      statusCounts[row._id || "unknown"] = row.count;
      total += row.count;
    }

    const sumOf = (keys) =>
      keys.reduce((acc, key) => acc + (statusCounts[key] || 0), 0);

    const volumes = facets?.volumes?.[0] || { sent: 0, received: 0, fees: 0 };
    const usage = facets?.usage?.[0] || { daily: 0, monthly: 0 };

    return res.status(200).json({
      success: true,
      data: {
        counts: {
          total,
          succeeded: sumOf(SETTLED),
          failed: sumOf(FAILED),
          pending: sumOf(PENDING),
          byStatus: statusCounts,
        },
        volumes: {
          sent: volumes.sent || 0,
          received: volumes.received || 0,
          fees: volumes.fees || 0,
        },
        // Consommation à rapprocher de `User.limits` côté back-office. Le jour
        // et le mois sont calendaires (fuseau du serveur), pas glissants : c'est
        // ainsi que les plafonds sont lus par les clients.
        usage: {
          daily: usage.daily || 0,
          monthly: usage.monthly || 0,
          dayStart: startOfDay,
          monthStart: startOfMonth,
        },
        lastTransaction: facets?.last?.[0] || null,
        currencies: (facets?.currencies || [])
          .filter((c) => c._id)
          .map((c) => ({ currency: c._id, count: c.count })),
        computedAt: now,
      },
    });
  } catch (error) {
    console.error(
      "[TX-CORE][INTERNAL ADMIN TX][USER STATS] Erreur",
      JSON.stringify({ message: error?.message })
    );
    next(error);
  }
}

async function getInternalAdminTransactionById(req, res, next) {
  try {
    const { id } = req.params;

    if (!id) {
      throw createError(400, "Identifiant transaction requis");
    }

    const cleanId = String(id).trim();

    console.log(
      "[TX-CORE][INTERNAL ADMIN TX][DETAIL] Requête reçue",
      JSON.stringify({
        originalUrl: req.originalUrl,
        id: cleanId,
        dbName: Transaction.db?.name,
        collection: Transaction.collection?.name,
      })
    );

    let tx = null;

    if (isValidObjectId(cleanId)) {
      tx = await Transaction.findById(cleanId).lean();
    }

    if (!tx) {
      tx = await Transaction.findOne({
        $or: [
          { reference: cleanId },
          { providerReference: cleanId },
          { verificationToken: cleanId },
          { "meta.reference": cleanId },
          { "meta.id": cleanId },
        ],
      }).lean();
    }

    console.log(
      "[TX-CORE][INTERNAL ADMIN TX][DETAIL] Résultat Mongo",
      JSON.stringify({
        found: !!tx,
        txId: tx?._id || null,
      })
    );

    if (!tx) {
      throw createError(404, "Transaction introuvable");
    }

    return res.status(200).json({
      success: true,
      tx,
      data: {
        tx,
      },
    });
  } catch (error) {
    console.error(
      "[TX-CORE][INTERNAL ADMIN TX][DETAIL] Erreur",
      JSON.stringify({
        message: error?.message,
        stack: error?.stack,
      })
    );

    next(error);
  }
}

module.exports = {
  listInternalAdminTransactions,
  getInternalAdminTransactionById,
  getInternalAdminUserStats,
};