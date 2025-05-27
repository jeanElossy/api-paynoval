// File: src/routes/transactionsRoutes.js

const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { body } = require('express-validator');
const asyncHandler = require('express-async-handler');
const { initiateInternal, confirmController, listInternal } = require('../controllers/transactionsController');
const { protect } = require('../middleware/authMiddleware');
const requestValidator = require('../middleware/requestValidator');
const Notification = require('../models/Notification');

const router = express.Router();

// Sécuriser les en-têtes HTTP
router.use(helmet());

// Limiteur de débit pour éviter les abus
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10,             // 10 requêtes par IP et par fenêtre
  message: { success: false, status: 429, message: 'Trop de requêtes, veuillez réessayer plus tard.' }
});
router.use(['/initiate', '/confirm'], limiter);

/**
 * GET /api/v1/transactions
 * Liste les transactions internes de l’utilisateur connecté
 */
router.get(
  '/',
  protect,
  asyncHandler(listInternal)
);

/**
 * POST /api/v1/transactions/initiate
 * Flux interne : Solde PayNoval → PayNoval
 */
router.post(
  '/initiate',
  protect,
  [
    body('toEmail')
      .isEmail().withMessage('Adresse email du destinataire invalide')
      .normalizeEmail(),
    body('amount')
      .isFloat({ gt: 0 }).withMessage('Le montant doit être supérieur à 0')
      .toFloat(),
    body('transactionFees')
      .optional().isFloat({ min: 0 }).withMessage('Les frais doivent être un nombre positif')
      .toFloat(),
    body('localAmount')
      .isFloat({ gt: 0 }).withMessage('Le montant local doit être supérieur à 0')
      .toFloat(),
    body('funds')
      .equals('Solde PayNoval').withMessage('Type de fonds invalide pour ce flux'),
    body('destination')
      .equals('PayNoval').withMessage('Destination invalide pour ce flux'),
    body('localCurrencySymbol')
      .notEmpty().withMessage('Symbole de la devise locale requis')
      .trim().escape(),
    body('senderCurrencySymbol')
      .notEmpty().withMessage('Symbole de la devise de l’expéditeur requis')
      .trim().escape(),
    body('description')
      .optional().trim().escape(),
    body('recipientInfo.name')
      .optional().trim().escape()
  ],
  requestValidator,
  asyncHandler(initiateInternal)
);

/**
 * POST /api/v1/transactions/confirm
 * Confirmation pour les transactions internes
 */
router.post(
  '/confirm',
  protect,
  [
    body('transactionId')
      .isMongoId().withMessage('ID de transaction invalide'),
    body('token')
      .isLength({ min: 64, max: 64 }).withMessage('Token de confirmation invalide')
      .trim().escape(),
    body('senderCurrencySymbol')
      .notEmpty().withMessage("Symbole de la devise de l’expéditeur requis")
      .trim().escape()
  ],
  requestValidator,
  asyncHandler(confirmController)
);

/**
 * GET /api/v1/transactions/notifications
 * Récupère les notifications in-app de l'utilisateur connecté
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
