// File: src/routes/internalPaymentsRoutes.js
'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const { body } = require('express-validator');
const asyncHandler = require('express-async-handler');

const requireInternalAuth = require('../middleware/internalAuth');
const requestValidator = require('../middleware/requestValidator');
const {
  createInternalPayment,
} = require('../controllers/internalPaymentsController');

const router = express.Router();

const internalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    status: 429,
    message: 'Trop de requêtes internes, merci de réessayer plus tard.',
  },
});

// Toutes les routes ici sont internes
router.use(internalLimiter);
router.use(requireInternalAuth);

/**
 * POST /api/v1/internal-payments
 */
router.post(
  '/',
  [
    body('kind')
      .isString()
      .trim()
      .isIn([
        'bonus',
        'cashback',
        'purchase',
        'adjustment_credit',
        'adjustment_debit',
        'cagnotte_participation',
        'cagnotte_withdrawal',
        'generic',
      ])
      .withMessage('Type d’opération interne invalide.'),
    body('amount')
      .isFloat({ gt: 0 })
      .withMessage('Le montant doit être strictement positif.')
      .toFloat(),
    body('currencySymbol')
      .isString()
      .trim()
      .isLength({ min: 1, max: 5 })
      .withMessage('Symbole de devise invalide.'),
    body('fromUserId')
      .optional({ nullable: true })
      .isMongoId()
      .withMessage('fromUserId doit être un ObjectId Mongo valide.'),
    body('toUserId')
      .optional({ nullable: true })
      .isMongoId()
      .withMessage('toUserId doit être un ObjectId Mongo valide.'),

    body('reason')
      .optional()
      .isString()
      .trim()
      .isLength({ max: 200 })
      .withMessage('Raison trop longue (max 200 caractères).'),
    body('description')
      .optional()
      .isString()
      .trim()
      .isLength({ max: 500 })
      .withMessage('Description trop longue (max 500 caractères).'),
    body('country')
      .optional()
      .isString()
      .trim()
      .isLength({ max: 100 })
      .withMessage('Pays invalide.'),
    body('context')
      .optional()
      .isString()
      .trim()
      .isLength({ max: 100 })
      .withMessage('Context trop long.'),
    body('contextId')
      .optional()
      .isString()
      .trim()
      .isLength({ max: 200 })
      .withMessage('ContextId trop long.'),
    body('orderId')
      .optional()
      .isString()
      .trim()
      .isLength({ max: 200 })
      .withMessage('orderId trop long.'),

    // 🔐 Infos optionnelles pour tracer un vault comme receiver
    body('targetVaultId')
      .optional({ nullable: true })
      .isMongoId()
      .withMessage('targetVaultId doit être un ObjectId Mongo valide.'),
    body('targetVaultName')
      .optional({ nullable: true })
      .isString()
      .trim()
      .isLength({ max: 200 })
      .withMessage('targetVaultName trop long (max 200 caractères).'),

    body('metadata')
      .optional()
      .isObject()
      .withMessage('metadata doit être un objet JSON.'),
  ],
  requestValidator,
  asyncHandler(createInternalPayment)
);

module.exports = router;
