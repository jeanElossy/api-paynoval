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
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const { body } = require('express-validator');
const asyncHandler = require('express-async-handler');
const { initiateInternal, confirmController } = require('../controllers/transactionsController');
const { protect } = require('../middleware/authMiddleware');
const requestValidator = require('../middleware/requestValidator');
const Notification = require('../models/Notification');

const router = express.Router();

// Security: secure HTTP headers
router.use(helmet());

// Rate limiter to prevent brute-force or DoS
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // max 10 requests per IP per window
  message: { success: false, message: 'Too many requests, please try again later.' }
});
router.use(['/initiate', '/confirm'], limiter);

/**
 * POST /transactions/initiate
 * Internal flow: PayNoVal balance → PayNoVal
 */
router.post(
  '/initiate',
  protect,
  [
    body('toEmail')
      .isEmail().withMessage('Invalid recipient email')
      .normalizeEmail(),
    body('amount')
      .isFloat({ gt: 0 }).withMessage('Amount must be > 0')
      .toFloat(),
    body('transactionFees')
      .optional().isFloat({ min: 0 }).withMessage('Fees must be ≥ 0')
      .toFloat(),
    body('localAmount')
      .isFloat({ gt: 0 }).withMessage('Local amount must be > 0')
      .toFloat(),
    body('funds')
      .equals('Solde PayNoVal').withMessage('Invalid funds type for this flow'),
    body('destination')
      .equals('PayNoVal').withMessage('Invalid destination for this flow'),
    body('localCurrencySymbol')
      .notEmpty().withMessage('Local currency symbol is required').trim().escape(),
    body('senderCurrencySymbol')
      .notEmpty().withMessage('Sender currency symbol is required').trim().escape(),
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
      .isMongoId().withMessage('Invalid transaction ID'),
    body('token')
      .isLength({ min: 64, max: 64 }).withMessage('Invalid confirmation token')
      .trim().escape(),
    body('senderCurrencySymbol')
      .notEmpty().withMessage('Sender currency symbol is required')
      .trim().escape()
  ],
  requestValidator,
  asyncHandler(confirmController)
);

/**
 * GET /transactions/notifications
 * In-app notifications for the authenticated user
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