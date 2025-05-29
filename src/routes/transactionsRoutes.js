// // File: src/routes/transactionsRoutes.js

// const express       = require('express');
// const helmet        = require('helmet');
// const rateLimit     = require('express-rate-limit');
// const { body }      = require('express-validator');
// const asyncHandler  = require('express-async-handler');
// const {
//   initiateInternal,
//   confirmController,
//   listInternal
// } = require('../controllers/transactionsController');
// const { protect }   = require('../middleware/authMiddleware');
// const requestValidator = require('../middleware/requestValidator');
// const Notification  = require('../models/Notification');

// const router = express.Router();

// // Sécuriser les en-têtes HTTP
// router.use(helmet());

// // Limiteur de débit pour éviter les abus
// const limiter = rateLimit({
//   windowMs: 60 * 1000,
//   max: 10,
//   message: { success: false, status: 429, message: 'Trop de requêtes, veuillez réessayer plus tard.' }
// });
// router.use(['/initiate', '/confirm'], limiter);

// /**
//  * GET /api/v1/transactions
//  */
// router.get(
//   '/',
//   protect,
//   asyncHandler(listInternal)
// );

// /**
//  * POST /api/v1/transactions/initiate
//  */
// router.post(
//   '/initiate',
//   protect,
//   [
//     // Email destinataire
//     body('toEmail')
//       .isEmail().withMessage('Adresse email du destinataire invalide')
//       .normalizeEmail(),

//     // Montants
//     body('amount')
//       .isFloat({ gt: 0 }).withMessage('Le montant doit être supérieur à 0')
//       .toFloat(),
//     body('transactionFees')
//       .optional().isFloat({ min: 0 }).withMessage('Les frais doivent être un nombre positif')
//       .toFloat(),
//     body('localAmount')
//       .isFloat({ gt: 0 }).withMessage('Le montant local doit être supérieur à 0')
//       .toFloat(),

//     // Méthodes
//     body('funds')
//       .equals('Solde PayNoval').withMessage('Type de fonds invalide pour ce flux'),
//     body('destination')
//       .equals('PayNoval').withMessage('Destination invalide pour ce flux'),

//     // Devises
//     body('localCurrencySymbol')
//       .notEmpty().withMessage('Symbole de la devise locale requis')
//       .trim().escape(),
//     body('senderCurrencySymbol')
//       .notEmpty().withMessage('Symbole de la devise de l’expéditeur requis')
//       .trim().escape(),

//     // Pays de destination
//     body('country')
//       .notEmpty().withMessage('Pays de destination requis')
//       .trim().escape(),

//     // Description libre
//     body('description')
//       .optional().trim().escape(),

//     // Récupérer nom et email saisis
//     body('recipientInfo.name')
//       .optional().trim().escape(),
//     body('recipientInfo.email')
//       .isEmail().withMessage('Email du destinataire invalide')
//       .normalizeEmail(),
      
//     // Question de sécurité et code
//     body('question')
//       .notEmpty().withMessage('Question de sécurité requise')
//       .trim().escape(),
//     body('securityCode')
//       .notEmpty().withMessage('Code de sécurité requis')
//       .trim().escape(),
//   ],
//   requestValidator,
//   asyncHandler(initiateInternal)
// );

// /**
//  * POST /api/v1/transactions/confirm
//  */
// router.post(
//   '/confirm',
//   protect,
//   [
//     body('transactionId')
//       .isMongoId().withMessage('ID de transaction invalide'),
//     body('token')
//       .isLength({ min: 64, max: 64 }).withMessage('Token de confirmation invalide')
//       .trim().escape(),
//     body('senderCurrencySymbol')
//       .notEmpty().withMessage("Symbole de la devise de l’expéditeur requis")
//       .trim().escape()
//   ],
//   requestValidator,
//   asyncHandler(confirmController)
// );

// /**
//  * GET /api/v1/transactions/notifications
//  */
// router.get(
//   '/notifications',
//   protect,
//   asyncHandler(async (req, res) => {
//     const notifs = await Notification
//       .find({ recipient: req.user.id })
//       .sort({ createdAt: -1 });
//     res.json({ success: true, data: notifs });
//   })
// );

// module.exports = router;


// File: src/routes/transactionsRoutes.js

const express       = require('express');
const rateLimit     = require('express-rate-limit');
const { body }      = require('express-validator');
const asyncHandler  = require('express-async-handler');
const {
  initiateInternal,
  confirmController,
  listInternal
} = require('../controllers/transactionsController');
const { protect }   = require('../middleware/authMiddleware');
const requestValidator = require('../middleware/requestValidator');

const router = express.Router();

// Rate limiter pour endpoints critiques
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, status: 429, message: 'Trop de requêtes, veuillez réessayer plus tard.' }
});
router.use(['/initiate', '/confirm'], limiter);

/**
 * GET /api/v1/transactions
 * Liste les transactions de l'utilisateur connecté
 */
router.get('/', protect, asyncHandler(listInternal));

/**
 * POST /api/v1/transactions/initiate
 * Initie une nouvelle transaction interne
 */
router.post(
  '/initiate',
  protect,
  [
    body('toEmail').isEmail().withMessage('Email du destinataire invalide').normalizeEmail(),
    body('amount').isFloat({ gt: 0 }).withMessage('Montant doit être > 0').toFloat(),
    body('transactionFees').optional().isFloat({ min: 0 }).withMessage('Frais doivent être >= 0').toFloat(),
    body('localAmount').isFloat({ gt: 0 }).withMessage('Montant local doit être > 0').toFloat(),
    body('funds').equals('Solde PayNoval').withMessage('Type de fonds invalide'),
    body('destination').equals('PayNoval').withMessage('Destination invalide'),
    body('localCurrencySymbol').notEmpty().withMessage('Devise locale requise').trim().escape(),
    body('senderCurrencySymbol').notEmpty().withMessage('Devise expéditeur requise').trim().escape(),
    body('country').notEmpty().withMessage('Pays requis').trim().escape(),
    body('description').optional().trim().escape(),
    body('recipientInfo.name').optional().trim().escape(),
    body('recipientInfo.email').isEmail().withMessage('Email destinataire invalide').normalizeEmail(),
    body('question').notEmpty().withMessage('Question requise').trim().escape(),
    body('securityCode').notEmpty().withMessage('Code sécurité requis').trim().escape()
  ],
  requestValidator,
  asyncHandler(initiateInternal)
);

/**
 * POST /api/v1/transactions/confirm
 * Confirme une transaction existante
 */
router.post(
  '/confirm',
  protect,
  [
    body('transactionId').isMongoId().withMessage('ID de transaction invalide'),
    body('token').isLength({ min: 64, max: 64 }).withMessage('Token invalide').trim().escape(),
    body('senderCurrencySymbol').notEmpty().withMessage('Devise expéditeur requise').trim().escape()
  ],
  requestValidator,
  asyncHandler(confirmController)
);

module.exports = router;
