// // File: src/routes/transactionsRoutes.js

// const express          = require('express');
// const rateLimit        = require('express-rate-limit');
// const { body }         = require('express-validator');
// const asyncHandler     = require('express-async-handler');
// const {
//   listInternal,
//   initiateInternal,
//   confirmController,
//   cancelController,
//   getTransactionController,
//   refundController,
//   validateController,
//   reassignController,
//   archiveController,
//   relaunchController,
// } = require('../controllers/transactionsController');
// const { protect }      = require('../middleware/authMiddleware');
// const requireRole      = require('../middleware/requireRole');
// const requestValidator = require('../middleware/requestValidator');



// const router = express.Router();

// // Limiteur de requêtes pour les routes critiques (anti-brute-force)
// const limiter = rateLimit({
//   windowMs: 60 * 1000, // 1 minute
//   max: 10,
//   standardHeaders: true,
//   legacyHeaders: false,
//   message: { success: false, status: 429, message: 'Trop de requêtes, veuillez réessayer plus tard.' }
// });

// // Applique le limiter sur les routes POST critiques
// router.use(['/initiate', '/confirm', '/cancel'], limiter);

// /**
//  * GET /api/v1/transactions/:id
//  * Récupère une transaction par ID (mobile/web)
//  */
// router.get(
//   '/:id',
//   protect,
//   asyncHandler(getTransactionController)
// );

// /**
//  * GET /api/v1/transactions
//  * Liste toutes les transactions liées à l'utilisateur connecté
//  */
// router.get(
//   '/',
//   protect,
//   asyncHandler(listInternal)
// );

// /**
//  * POST /api/v1/transactions/initiate
//  * Crée une transaction interne (débit immédiat expéditeur)
//  */
// router.post(
//   '/initiate',
//   protect,
//   [
//     body('toEmail')
//       .isEmail().withMessage('Email du destinataire invalide')
//       .normalizeEmail(),
//     body('amount')
//       .isFloat({ gt: 0 }).withMessage('Le montant doit être supérieur à 0')
//       .toFloat(),
//     body('transactionFees')
//       .optional()
//       .isFloat({ min: 0 }).withMessage('Les frais doivent être un nombre positif')
//       .toFloat(),
//     body('funds')
//       .notEmpty().withMessage('Type de fonds requis')
//       .trim().escape(),
//     body('destination')
//       .notEmpty().withMessage('Destination requise')
//       .trim().escape(),
//     body('localCurrencySymbol')
//       .notEmpty().withMessage('Symbole de la devise locale requis')
//       .trim().escape(),
//     body('senderCurrencySymbol')
//       .notEmpty().withMessage('Symbole de la devise de l’expéditeur requis')
//       .trim().escape(),
//     body('country')
//       .notEmpty().withMessage('Pays de destination requis')
//       .trim().escape(),
//     body('description')
//       .optional().trim().escape(),
//     body('recipientInfo.name')
//       .optional().trim().escape(),
//     body('recipientInfo.email')
//       .isEmail().withMessage('Email du destinataire invalide')
//       .normalizeEmail(),
//     body('question')
//       .notEmpty().withMessage('Question de sécurité requise')
//       .trim().escape(),
//     body('securityCode')
//       .notEmpty().withMessage('Code de sécurité requis')
//       .trim().escape()
//   ],
//   requestValidator,
//   asyncHandler(initiateInternal)
// );

// /**
//  * POST /api/v1/transactions/confirm
//  * Confirme une transaction "pending" (crédite le destinataire après securityCode)
//  */
// router.post(
//   '/confirm',
//   protect,
//   [
//     body('transactionId')
//       .isMongoId().withMessage('ID de transaction invalide'),
//     body('securityCode')
//       .notEmpty().withMessage('Code de sécurité requis')
//       .trim().escape(),
//     body('provider')
//       .notEmpty().withMessage('Fournisseur requis')
//       .trim().escape()
//   ],
//   requestValidator,
//   asyncHandler(confirmController)
// );

// /**
//  * POST /api/v1/transactions/cancel
//  * Annule une transaction "pending" (remboursement)
//  */
// router.post(
//   '/cancel',
//   protect,
//   [
//     body('transactionId')
//       .isMongoId().withMessage('ID de transaction invalide'),
//     body('reason')
//       .optional().isString().withMessage('Motif invalide')
//       .trim().escape()
//   ],
//   requestValidator,
//   asyncHandler(cancelController)
// );

// /**
//  * POST /api/v1/transactions/refund
//  * Rembourse une transaction confirmée (admin/superadmin ONLY)
//  */
// router.post(
//   '/refund',
//   protect,
//   requireRole(['admin', 'superadmin']),        // <--- Contrôle d'accès ici
//   [
//     body('transactionId').isMongoId().withMessage('ID de transaction invalide'),
//     body('reason').optional().trim().escape(),
//   ],
//   requestValidator,
//   asyncHandler(refundController)
// );

// /**
//  * POST /api/v1/transactions/validate
//  * Valide une transaction (admin/superadmin ONLY)
//  */
// router.post(
//   '/validate',
//   protect,
//   requireRole(['admin', 'superadmin']),
//   [
//     body('transactionId').isMongoId().withMessage('ID de transaction invalide'),
//     body('status').notEmpty().isString().withMessage('Nouveau statut requis'),
//     body('adminNote').optional().trim().escape(),
//   ],
//   requestValidator,
//   asyncHandler(validateController)
// );

// /**
//  * POST /api/v1/transactions/reassign
//  * Réassigne la transaction à un autre destinataire (admin/superadmin ONLY)
//  */
// router.post(
//   '/reassign',
//   protect,
//   requireRole(['admin', 'superadmin']),
//   [
//     body('transactionId').isMongoId().withMessage('ID de transaction invalide'),
//     body('newReceiverEmail').isEmail().withMessage('Email du nouveau destinataire invalide').normalizeEmail(),
//   ],
//   requestValidator,
//   asyncHandler(reassignController)
// );

// router.post(
//   '/archive',
//   protect,
//   requireRole(['admin', 'superadmin']),
//   [
//     body('transactionId').isMongoId().withMessage('ID de transaction invalide'),
//   ],
//   requestValidator,
//   asyncHandler(archiveController)
// );

// router.post(
//   '/relaunch',
//   protect,
//   requireRole(['admin', 'superadmin']),
//   [
//     body('transactionId').isMongoId().withMessage('ID de transaction invalide'),
//   ],
//   requestValidator,
//   asyncHandler(relaunchController)
// );

// module.exports = router;



// File: src/routes/transactionsRoutes.js
const express = require('express');
const rateLimit = require('express-rate-limit');
const { body } = require('express-validator');
const asyncHandler = require('express-async-handler');

const {
  listInternal,
  initiateInternal,
  confirmController,
  cancelController,
  getTransactionController,
  refundController,
  validateController,
  reassignController,
  archiveController,
  relaunchController,
} = require('../controllers/transactionsController');
const { protect } = require('../middleware/authMiddleware');
const requireRole = require('../middleware/requireRole');
const requestValidator = require('../middleware/requestValidator');

const router = express.Router();

// 🛡 Limiteur pour les routes critiques (anti brute-force)
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    status: 429,
    message: 'Trop de requêtes, veuillez réessayer plus tard.',
  },
});

// On applique le limiter uniquement sur les actions sensibles
router.use(['/initiate', '/confirm', '/cancel'], limiter);

/**
 * GET /api/v1/transactions/:id
 * Récupère une transaction par ID (mobile/web)
 */
router.get('/:id', protect, asyncHandler(getTransactionController));

/**
 * GET /api/v1/transactions
 * Liste toutes les transactions liées à l'utilisateur connecté
 */
router.get('/', protect, asyncHandler(listInternal));

/**
 * POST /api/v1/transactions/initiate
 * Crée une transaction interne (débit immédiat expéditeur)
 * → fees dynamiques via Gateway /fees/simulate
 */
router.post(
  '/initiate',
  protect,
  [
    body('toEmail')
      .isEmail()
      .withMessage('Email du destinataire invalide')
      .normalizeEmail(),
    body('amount')
      .isFloat({ gt: 0 })
      .withMessage('Le montant doit être supérieur à 0')
      .toFloat(),
    body('transactionFees')
      .optional()
      .isFloat({ min: 0 })
      .withMessage('Les frais doivent être un nombre positif')
      .toFloat(),
    body('funds').notEmpty().withMessage('Type de fonds requis').trim().escape(),
    body('destination')
      .notEmpty()
      .withMessage('Destination requise')
      .trim()
      .escape(),
    body('localCurrencySymbol')
      .notEmpty()
      .withMessage('Symbole de la devise locale requis')
      .trim()
      .escape(),
    body('senderCurrencySymbol')
      .notEmpty()
      .withMessage("Symbole de la devise de l’expéditeur requis")
      .trim()
      .escape(),
    body('country')
      .notEmpty()
      .withMessage('Pays de destination requis')
      .trim()
      .escape(),
    body('description').optional().trim().escape(),
    body('recipientInfo.name').optional().trim().escape(),
    body('recipientInfo.email')
      .isEmail()
      .withMessage('Email du destinataire invalide')
      .normalizeEmail(),
    body('question')
      .notEmpty()
      .withMessage('Question de sécurité requise')
      .trim()
      .escape(),
    body('securityCode')
      .notEmpty()
      .withMessage('Code de sécurité requis')
      .trim()
      .escape(),
  ],
  requestValidator,
  asyncHandler(initiateInternal)
);

/**
 * POST /api/v1/transactions/confirm
 * Confirme une transaction "pending" (crédite le destinataire après securityCode)
 */
router.post(
  '/confirm',
  protect,
  [
    body('transactionId')
      .isMongoId()
      .withMessage('ID de transaction invalide'),
    body('securityCode')
      .notEmpty()
      .withMessage('Code de sécurité requis')
      .trim()
      .escape(),
    body('provider')
      .notEmpty()
      .withMessage('Fournisseur requis')
      .trim()
      .escape(),
  ],
  requestValidator,
  asyncHandler(confirmController)
);

/**
 * POST /api/v1/transactions/cancel
 * Annule une transaction "pending" (remboursement)
 */
router.post(
  '/cancel',
  protect,
  [
    body('transactionId')
      .isMongoId()
      .withMessage('ID de transaction invalide'),
    body('reason')
      .optional()
      .isString()
      .withMessage('Motif invalide')
      .trim()
      .escape(),
  ],
  requestValidator,
  asyncHandler(cancelController)
);

/**
 * POST /api/v1/transactions/refund
 * Rembourse une transaction confirmée (admin/superadmin ONLY)
 */
router.post(
  '/refund',
  protect,
  requireRole(['admin', 'superadmin']),
  [
    body('transactionId')
      .isMongoId()
      .withMessage('ID de transaction invalide'),
    body('reason').optional().trim().escape(),
  ],
  requestValidator,
  asyncHandler(refundController)
);

/**
 * POST /api/v1/transactions/validate
 * Valide une transaction (admin/superadmin ONLY)
 */
router.post(
  '/validate',
  protect,
  requireRole(['admin', 'superadmin']),
  [
    body('transactionId')
      .isMongoId()
      .withMessage('ID de transaction invalide'),
    body('status')
      .notEmpty()
      .isString()
      .withMessage('Nouveau statut requis'),
    body('adminNote').optional().trim().escape(),
  ],
  requestValidator,
  asyncHandler(validateController)
);

/**
 * POST /api/v1/transactions/reassign
 * Réassigne la transaction à un autre destinataire (admin/superadmin ONLY)
 */
router.post(
  '/reassign',
  protect,
  requireRole(['admin', 'superadmin']),
  [
    body('transactionId')
      .isMongoId()
      .withMessage('ID de transaction invalide'),
    body('newReceiverEmail')
      .isEmail()
      .withMessage('Email du nouveau destinataire invalide')
      .normalizeEmail(),
  ],
  requestValidator,
  asyncHandler(reassignController)
);

/**
 * POST /api/v1/transactions/archive
 */
router.post(
  '/archive',
  protect,
  requireRole(['admin', 'superadmin']),
  [
    body('transactionId')
      .isMongoId()
      .withMessage('ID de transaction invalide'),
  ],
  requestValidator,
  asyncHandler(archiveController)
);

/**
 * POST /api/v1/transactions/relaunch
 */
router.post(
  '/relaunch',
  protect,
  requireRole(['admin', 'superadmin']),
  [
    body('transactionId')
      .isMongoId()
      .withMessage('ID de transaction invalide'),
  ],
  requestValidator,
  asyncHandler(relaunchController)
);

module.exports = router;
