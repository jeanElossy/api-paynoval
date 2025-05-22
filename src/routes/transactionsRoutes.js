/* src/routes/transactions.js */
const express = require('express');
const { body, validationResult } = require('express-validator');
const asyncHandler = require('express-async-handler');

const {
  initiateTransaction,
  confirmTransaction
} = require('../controllers/transactionController');
const { protect } = require('../middleware/authMiddleware');

const router = express.Router();

// Validation middleware for initiate transaction
const validateInitiate = [
  protect,
  body('receiver')
    .isMongoId()
    .withMessage('Receiver invalide'),
  body('amount')
    .isFloat({ gt: 0 })
    .withMessage('Le montant doit être supérieur à 0')
];

// Validation middleware for confirm transaction
const validateConfirm = [
  protect,
  body('transactionId')
    .isMongoId()
    .withMessage('Transaction invalide'),
  body('token')
    .isLength({ min: 64, max: 64 })
    .withMessage('Token de confirmation invalide')
];

// Initiate a new transaction
router.post(
  '/initiate',
  validateInitiate,
  asyncHandler(async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(422).json({ success: false, errors: errors.array().map(e => e.msg) });
    }
    await initiateTransaction(req, res, next);
  })
);

// Confirm an existing transaction
router.post(
  '/confirm',
  validateConfirm,
  asyncHandler(async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(422).json({ success: false, errors: errors.array().map(e => e.msg) });
    }
    await confirmTransaction(req, res, next);
  })
);

module.exports = router;
