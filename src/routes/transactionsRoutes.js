// // src/routes/transactionRouter.js

// const express = require('express');
// const { body } = require('express-validator');
// const asyncHandler      = require('express-async-handler');
// const { initiateController, confirmController } = require('../controllers/transactionController');
// const { protect }      = require('../middleware/authMiddleware');
// const requestValidator = require('../middleware/requestValidator');
// const Notification     = require('../models/Notification');

// const router = express.Router();

// /**
//  * POST /transactions/initiate
//  * Validation, protection et routage selon `funds` & `destination`
//  */
// router.post(
//   '/initiate',
//   protect,
//   [
//     body('toEmail')
//       .isEmail()
//       .withMessage('Email destinataire invalide'),
//     body('amount')
//       .isFloat({ gt: 0 })
//       .withMessage('Le montant doit être supérieur à 0'),
//     body('country')
//       .notEmpty()
//       .withMessage('Le pays est requis'),
//     body('funds')
//       .isIn(['Solde PayNoVal', 'Carte de crédit'])
//       .withMessage('Type de fonds invalide'),
//     body('destination')
//       .isIn(['PayNoVal', 'Banque', 'Mobile Money'])
//       .withMessage('Destination invalide'),
//   ],
//   requestValidator,
//   (req, res, next) => {
//     const { funds, destination } = req.body;

//     // Solde PayNoVal -> PayNoVal (API interne)
//     if (funds === 'Solde PayNoVal' && destination === 'PayNoVal') {
//       return asyncHandler(initiateController)(req, res, next);
//     }
//   }
// );

// /**
//  * POST /transactions/confirm
//  * Confirmation partagée pour tous les flux
//  */
// router.post(
//   '/confirm',
//   protect,
//   [
//     body('transactionId')
//       .isMongoId()
//       .withMessage('ID de transaction invalide'),
//     body('token')
//       .isLength({ min: 64, max: 64 })
//       .withMessage('Token de confirmation invalide'),
//   ],
//   requestValidator,
//   asyncHandler(confirmController)
// );

// /**
//  * GET /transactions/notifications
//  * Notifications in-app de l'utilisateur connecté
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

// src/routes/transactionRouter.js

const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { body } = require('express-validator');
const asyncHandler = require('express-async-handler');
const { initiateInternal, confirmController } = require('../controllers/transactionsController');
const { protect } = require('../middleware/authMiddleware');
const requestValidator = require('../middleware/requestValidator');
const Notification = require('../models/Notification');

const router = express.Router();

// Security: secure HTTP headers
router.use(helmet());

// Rate limiter for initiate and confirm endpoints
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // limit each IP to 10 requests per window
  message: { success: false, status: 429, message: 'Trop de requêtes, veuillez réessayer plus tard.' }
});
router.use(['/initiate', '/confirm'], limiter);

/**
 * POST /transactions/initiate
 * Internal flow: Solde PayNoval → PayNoval
 */
router.post(
  '/initiate',
  protect,
  [
    body('toEmail')
      .isEmail().withMessage("Email destinataire invalide")
      .normalizeEmail(),
    body('amount')
      .isFloat({ gt: 0 }).withMessage("Le montant doit être supérieur à 0")
      .toFloat(),
    body('transactionFees')
      .optional().isFloat({ min: 0 }).withMessage("Les frais doivent être ≥ 0")
      .toFloat(),
    body('localAmount')
      .isFloat({ gt: 0 }).withMessage("Le montant local doit être > 0")
      .toFloat(),
    body('funds')
      .equals('Solde PayNoval').withMessage("Type de fonds invalide pour ce flux"),
    body('destination')
      .equals('PayNoval').withMessage("Destination invalide pour ce flux"),
    body('localCurrencySymbol')
      .notEmpty().withMessage("Symbole de devise locale requis").trim().escape(),
    body('senderCurrencySymbol')
      .notEmpty().withMessage("Symbole de devise expéditeur requis").trim().escape(),
    body('description')
      .optional().trim().escape(),
    body('recipientInfo.name')
      .optional().trim().escape()
  ],
  requestValidator,
  asyncHandler(initiateInternal)
);

/**
 * POST /transactions/confirm
 * Confirmation flow for internal transactions
 */
router.post(
  '/confirm',
  protect,
  [
    body('transactionId')
      .isMongoId().withMessage("ID de transaction invalide"),
    body('token')
      .isLength({ min: 64, max: 64 }).withMessage("Token de confirmation invalide")
      .trim().escape(),
    body('senderCurrencySymbol')
      .notEmpty().withMessage("Symbole de devise expéditeur requis")
      .trim().escape()
  ],
  requestValidator,
  asyncHandler(confirmController)
);

/**
 * GET /transactions/notifications
 * In-app notifications for authenticated user
 */
router.get(
  '/notifications',
  protect,
  asyncHandler(async (req, res) => {
    const notifs = await Notification
      .find({ recipient: req.user.id })
      .sort({ createdAt: -1 });
    res.json({ success: true, data: notifs });
  })
);

module.exports = router;