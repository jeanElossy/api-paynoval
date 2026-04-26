// File: controllers/internalAdminTransactions.controller.js

"use strict";

const mongoose = require("mongoose");
const createError = require("http-errors");

const { Transaction } = require("../services/transactions/shared/runtime");

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

/**
 * GET /api/v1/internal/admin/transactions
 *
 * Route interne tx-core utilisée par le backend principal.
 */
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
      debug,
    } = req.query;

    const safePage = Math.max(Number(page) || 1, 1);
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 200);

    const query = {};

    if (search) {
      query.$or = buildSearchQuery(search);
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

    const total = await Transaction.countDocuments(query);

    const txs = await Transaction.find(query)
      .sort(normalizeSort(sort))
      .skip((safePage - 1) * safeLimit)
      .limit(safeLimit)
      .lean();

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
    next(error);
  }
}

/**
 * GET /api/v1/internal/admin/transactions/:id
 *
 * Récupération par _id, reference, providerReference ou meta.reference.
 */
async function getInternalAdminTransactionById(req, res, next) {
  try {
    const { id } = req.params;

    if (!id) {
      throw createError(400, "Identifiant transaction requis");
    }

    const cleanId = String(id).trim();

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
    next(error);
  }
}

module.exports = {
  listInternalAdminTransactions,
  getInternalAdminTransactionById,
};