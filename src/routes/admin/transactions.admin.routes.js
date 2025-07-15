// src/routes/admin/transactions.admin.routes.js

const express = require('express');
const router = express.Router();
const { protect } = require('../../middleware/authMiddleware');
const { requireRole } = require('../../middleware/authz');
const adminTxCtrl = require('../../controllers/adminTransactionsController');

// Middleware global (protect & requireRole admin/superadmin)
router.use(protect, requireRole(['admin', 'superadmin']));

// LIST: GET /api/v1/admin/transactions?search=...&status=...&provider=...&page=...&limit=...
router.get('/', adminTxCtrl.listTransactions);

// GET ONE: GET /api/v1/admin/transactions/:id
router.get('/:id', adminTxCtrl.getTransactionById);

// REFUND: POST /api/v1/admin/transactions/:id/refund
router.post('/:id/refund', adminTxCtrl.refundTransaction);

// VALIDATE: POST /api/v1/admin/transactions/:id/validate
router.post('/:id/validate', adminTxCtrl.validateTransaction);

// REASSIGN: POST /api/v1/admin/transactions/:id/reassign
router.post('/:id/reassign', adminTxCtrl.reassignTransaction);

// ARCHIVE: PUT /api/v1/admin/transactions/:id/archive
router.put('/:id/archive', adminTxCtrl.archiveController);

// RELAUNCH: PUT /api/v1/admin/transactions/:id/relaunch
router.put('/:id/relaunch', adminTxCtrl.relaunchController);

// CANCEL: POST /api/v1/admin/transactions/:id/cancel
router.post('/:id/cancel', adminTxCtrl.cancelTransaction);


// UPDATE: PUT /api/v1/admin/transactions/:id (modifier statut, assignation, etc.)
router.put('/:id', adminTxCtrl.updateTransaction);

// SOFT DELETE: DELETE /api/v1/admin/transactions/:id (marquer comme supprimée ou AML-flag)
router.delete('/:id', adminTxCtrl.softDeleteTransaction);

// (Optionnel) EXPORT: GET /api/v1/admin/transactions/export/csv
router.get('/export/csv', adminTxCtrl.exportTransactionsCsv);

module.exports = router;
