// src/controllers/adminTransactionsController.js

const Transaction = require('../models/Transaction');
const Balance     = require('../models/Balance');
const User        = require('../models/User');
const logger      = require('../utils/logger');
const createError = require('http-errors');

/**
 * LIST /api/v1/admin/transactions
 * Query params : ?search=&status=&provider=&page=&limit=
 */
exports.listTransactions = async (req, res, next) => {
  try {
    const {
      search = '',
      status,
      provider,
      page = 1,
      limit = 20,
      sort = '-createdAt'
    } = req.query;
    const query = {};

    // Recherche libre
    if (search) {
      query.$or = [
        { reference: { $regex: search, $options: 'i' } },
        { toEmail:   { $regex: search, $options: 'i' } },
        { recipientEmail: { $regex: search, $options: 'i' } },
        { 'meta.reference': { $regex: search, $options: 'i' } },
        { 'meta.id': { $regex: search, $options: 'i' } }
      ];
    }
    if (status) query.status = status;
    if (provider) query.provider = provider;

    const total = await Transaction.countDocuments(query);
    const txs = await Transaction.find(query)
      .sort(sort)
      .skip((page - 1) * limit)
      .limit(Number(limit))
      .lean();

    res.json({ success: true, total, page: Number(page), limit: Number(limit), txs });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/v1/admin/transactions/:id
 */
exports.getTransactionById = async (req, res, next) => {
  try {
    const tx = await Transaction.findById(req.params.id).lean();
    if (!tx) return res.status(404).json({ success: false, error: 'Transaction introuvable' });
    res.json({ success: true, tx });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/v1/admin/transactions/:id/refund
 */
exports.refundTransaction = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    const tx = await Transaction.findById(id);
    if (!tx) return res.status(404).json({ success: false, error: 'Transaction introuvable' });
    if (tx.status !== 'confirmed') return res.status(400).json({ error: 'Non remboursable' });
    if (tx.refundedAt) return res.status(400).json({ error: 'Déjà remboursée' });

    const amount = tx.localAmount || tx.amount;
    if (amount <= 0) throw createError(400, 'Montant de remboursement invalide');

    // Débiter bénéficiaire, créditer expéditeur
    const debited = await Balance.findOneAndUpdate(
      { user: tx.receiver },
      { $inc: { amount: -amount } },
      { new: true }
    );
    if (!debited || debited.amount < 0) throw createError(400, 'Solde bénéficiaire insuffisant');

    await Balance.findOneAndUpdate(
      { user: tx.sender },
      { $inc: { amount } },
      { new: true, upsert: true }
    );
    tx.status = 'refunded';
    tx.refundedAt = new Date();
    tx.refundReason = reason || 'Admin refund';
    await tx.save();

    logger.info(`[ADMIN][REFUND] ${req.user.email} refund ${id} (${amount})`);
    res.json({ success: true, refunded: amount });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/v1/admin/transactions/:id/validate
 */
exports.validateTransaction = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status, adminNote } = req.body;
    const tx = await Transaction.findById(id);
    if (!tx) return res.status(404).json({ success: false, error: 'Transaction introuvable' });
    tx.status = status;
    if (adminNote) tx.adminNote = adminNote;
    tx.validatedBy = req.user.email;
    tx.validatedAt = new Date();
    await tx.save();
    logger.info(`[ADMIN][VALIDATE] ${req.user.email} validated ${id} (${status})`);
    res.json({ success: true, id, status });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/v1/admin/transactions/:id/reassign
 */
exports.reassignTransaction = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { newReceiverEmail } = req.body;
    const tx = await Transaction.findById(id);
    if (!tx || !['pending','confirmed'].includes(tx.status)) {
      return res.status(400).json({ error: 'Transaction non réassignable' });
    }
    const newReceiver = await User.findOne({ email: newReceiverEmail });
    if (!newReceiver) return res.status(404).json({ error: 'Destinataire introuvable' });
    if (String(newReceiver._id) === String(tx.receiver)) {
      return res.status(400).json({ error: 'Déjà affectée à ce destinataire' });
    }
    tx.receiver = newReceiver._id;
    tx.nameDestinataire = newReceiver.fullName;
    tx.recipientEmail = newReceiver.email;
    tx.reassignedAt = new Date();
    await tx.save();
    logger.info(`[ADMIN][REASSIGN] ${req.user.email} reassign ${id} to ${newReceiverEmail}`);
    res.json({ success: true, newReceiver: { id: newReceiver._id, email: newReceiver.email } });
  } catch (err) {
    next(err);
  }
};

/**
 * PUT /api/v1/admin/transactions/:id
 * Met à jour tout le document (assignation, note, custom fields, ...)
 */
exports.updateTransaction = async (req, res, next) => {
  try {
    const { id } = req.params;
    const updateFields = req.body;
    const tx = await Transaction.findByIdAndUpdate(id, updateFields, { new: true });
    if (!tx) return res.status(404).json({ success: false, error: 'Transaction introuvable' });
    logger.info(`[ADMIN][UPDATE] ${req.user.email} updated tx ${id}`);
    res.json({ success: true, tx });
  } catch (err) {
    next(err);
  }
};

/**
 * DELETE /api/v1/admin/transactions/:id
 * Soft delete: mark AML-flag or archived, ne supprime jamais physiquement.
 */
exports.softDeleteTransaction = async (req, res, next) => {
  try {
    const { id } = req.params;
    const tx = await Transaction.findById(id);
    if (!tx) return res.status(404).json({ success: false, error: 'Transaction introuvable' });
    tx.amlFlagged = true;
    tx.amlFlaggedAt = new Date();
    tx.amlFlaggedBy = req.user.email;
    await tx.save();
    logger.warn(`[ADMIN][DELETE/AMLFLAG] ${req.user.email} AML-flag tx ${id}`);
    res.json({ success: true, amlFlagged: true });
  } catch (err) {
    next(err);
  }
};

/**
 * (Optionnel) GET /api/v1/admin/transactions/export/csv
 * Exporte un CSV rapide de toutes les transactions
 */
exports.exportTransactionsCsv = async (req, res, next) => {
  try {
    const fields = [
      'reference', 'provider', 'status', 'amount', 'currency', 'sender', 'receiver', 'toEmail', 'createdAt'
    ];
    const txs = await Transaction.find({}).select(fields.join(' ')).lean();
    let csv = fields.join(',') + '\n';
    for (const tx of txs) {
      csv += fields.map(f => `"${(tx[f] ?? '').toString().replace(/"/g, '""')}"`).join(',') + '\n';
    }
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="transactions_export.csv"');
    res.send(csv);
  } catch (err) {
    next(err);
  }
};



/**
 * PUT /api/v1/admin/transactions/:id/archive
 * Archive une transaction (admin/superadmin ONLY)
 */
exports.archiveController = async (req, res, next) => {
  try {
    const { id } = req.params;
    const tx = await Transaction.findById(id);
    if (!tx) return res.status(404).json({ success: false, error: 'Transaction non trouvée' });
    if (tx.archived) return res.status(400).json({ success: false, error: 'Déjà archivée' });

    tx.archived = true;
    tx.archivedAt = new Date();
    tx.archivedBy = req.user?.email || req.user?.id || null;
    await tx.save();

    logger.info(`[ADMIN][ARCHIVE] ${req.user.email} a archivé la transaction ${id}`);
    res.json({ success: true, archived: true });
  } catch (err) {
    next(err);
  }
};

/**
 * PUT /api/v1/admin/transactions/:id/relaunch
 * Relance une transaction (admin/superadmin ONLY)
 */
exports.relaunchController = async (req, res, next) => {
  try {
    const { id } = req.params;
    const tx = await Transaction.findById(id);
    if (!tx) return res.status(404).json({ success: false, error: 'Transaction non trouvée' });
    // Adapter la logique métier selon tes besoins
    if (!['pending', 'cancelled'].includes(tx.status)) {
      return res.status(400).json({ success: false, error: 'Seules les transactions en attente ou annulées peuvent être relancées' });
    }

    tx.status = 'relaunch';
    tx.relaunchedAt = new Date();
    tx.relaunchedBy = req.user?.email || req.user?.id || null;
    tx.relaunchCount = (tx.relaunchCount || 0) + 1;
    await tx.save();

    logger.info(`[ADMIN][RELAUNCH] ${req.user.email} a relancé la transaction ${id}`);
    res.json({ success: true, relaunched: true, txId: tx._id });
  } catch (err) {
    next(err);
  }
};


/**
 * POST /api/v1/admin/transactions/:id/cancel
 * Annule une transaction (admin/superadmin)
 */
exports.cancelTransaction = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { reason } = req.body; // facultatif
    const tx = await Transaction.findById(id);
    if (!tx) return res.status(404).json({ success: false, error: 'Transaction introuvable' });

    if (['cancelled', 'refunded', 'archived'].includes(tx.status))
      return res.status(400).json({ error: 'Déjà annulée ou clôturée' });

    tx.status = 'cancelled';
    tx.cancelledAt = new Date();
    tx.cancelledBy = req.user.email;
    if (reason) tx.cancelReason = reason;
    await tx.save();

    logger.info(`[ADMIN][CANCEL] ${req.user.email} cancelled ${id}`);
    res.json({ success: true, cancelled: true, id });
  } catch (err) {
    next(err);
  }
};
