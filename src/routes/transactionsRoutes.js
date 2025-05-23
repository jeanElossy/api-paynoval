// src/routes/transactionsRoutes.js
const express = require('express');
const { body, validationResult } = require('express-validator');
const asyncHandler = require('express-async-handler');

const {
  initiateTransaction,
  confirmTransaction
} = require('../controllers/transactionController');
const { protect } = require('../middleware/authMiddleware');

const router = express.Router();

// Validation et protection pour l’initiation de transaction
const validateInitiate = [
  protect,
  body('receiver')
    .isMongoId()
    .withMessage('Receiver invalide'),
  body('amount')
    .isFloat({ gt: 0 })
    .withMessage('Le montant doit être supérieur à 0')
];

// Validation et protection pour la confirmation de transaction
const validateConfirm = [
  protect,
  body('transactionId')
    .isMongoId()
    .withMessage('Transaction invalide'),
  body('token')
    .isLength({ min: 64, max: 64 })
    .withMessage('Token de confirmation invalide')
];

// POST /api/v1/transactions/initiate
router.post(
  '/initiate',
  validateInitiate,
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res
        .status(422)
        .json({ success: false, errors: errors.array().map(e => e.msg) });
    }
    await initiateTransaction(req, res);
  })
);

// POST /api/v1/transactions/confirm
router.post(
  '/confirm',
  validateConfirm,
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res
        .status(422)
        .json({ success: false, errors: errors.array().map(e => e.msg) });
    }
    await confirmTransaction(req, res);
  })
);

module.exports = router;
