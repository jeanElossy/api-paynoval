"use strict";

const TransactionRaw = require("../models/Transaction");
const Transaction = typeof TransactionRaw === "function" ? TransactionRaw() : TransactionRaw;

exports.importTransaction = async (req, res) => {
  try {
    const {
      reference,
      userId,
      provider = "paynoval",
      status = "confirmed",
      amount,
      currency,
      country,
      operator,
      meta = {},
      createdAt,
    } = req.body || {};

    if (!reference || !userId) {
      return res.status(400).json({ success: false, error: "reference et userId requis." });
    }

    const numAmount = Number(amount);
    if (!Number.isFinite(numAmount) || numAmount <= 0) {
      return res.status(400).json({ success: false, error: "amount invalide." });
    }

    const now = new Date();
    const doc = await Transaction.findOneAndUpdate(
      { userId, reference },               // ✅ idempotent
      {
        $setOnInsert: {
          userId,
          provider,
          amount: numAmount,
          status,
          currency: String(currency || "").trim().toUpperCase() || undefined,
          country: country || undefined,
          operator: operator || undefined,
          reference,
          meta: typeof meta === "object" && meta ? meta : {},
          createdAt: createdAt ? new Date(createdAt) : now,
        },
        $set: { updatedAt: now },
      },
      { upsert: true, new: true }
    );

    return res.status(201).json({ success: true, data: doc });
  } catch (e) {
    return res.status(500).json({ success: false, error: e?.message || "import failed" });
  }
};
