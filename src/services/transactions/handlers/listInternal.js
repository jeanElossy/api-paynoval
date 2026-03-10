"use strict";

const { Transaction } = require("../shared/runtime");
const { pickAuthedUserId } = require("../shared/helpers");

async function listInternal(req, res, next) {
  try {
    const userId = pickAuthedUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, message: "Non autorisé" });
    }

    const skip = Math.max(parseInt(req.query.skip, 10) || 0, 0);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 100);

    const query = {
      $or: [
        { sender: userId },
        { receiver: userId },
        { receiverUserId: userId },
        { createdBy: userId },
        { ownerUserId: userId },
        { userId: userId },
      ],
    };

    const [txDocs, total] = await Promise.all([
      Transaction.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit),
      Transaction.countDocuments(query),
    ]);

    return res.json({
      success: true,
      count: txDocs.length,
      total,
      data: txDocs.map((t) => t.toJSON()),
      skip,
      limit,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { listInternal };