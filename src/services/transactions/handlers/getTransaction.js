"use strict";

const { mongoose, Transaction } = require("../shared/runtime");
const { pickAuthedUserId } = require("../shared/helpers");

async function getTransactionController(req, res, next) {
  try {
    const { id } = req.params;
    const userId = pickAuthedUserId(req);

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "ID invalide" });
    }

    if (!userId) {
      return res.status(401).json({ success: false, message: "Non autorisé" });
    }

    const txDoc = await Transaction.findById(id);
    if (!txDoc) {
      return res.status(404).json({ success: false, message: "Transaction non trouvée" });
    }

    const tx = txDoc.toJSON();

    const isSender = String(tx.sender || "") === userId;
    const isReceiver =
      String(tx.receiver || "") === userId ||
      String(tx.receiverUserId || "") === userId ||
      String(tx.createdBy || "") === userId ||
      String(tx.ownerUserId || "") === userId ||
      String(tx.userId || "") === userId;

    if (!isSender && !isReceiver) {
      return res.status(404).json({ success: false, message: "Transaction non trouvée" });
    }

    return res.status(200).json({ success: true, data: tx });
  } catch (err) {
    next(err);
  }
}

module.exports = { getTransactionController };