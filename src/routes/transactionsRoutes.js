const express = require('express');
const { body } = require('express-validator');
const asyncHandler     = require('express-async-handler');
const { initiateController, confirmController } = require('../controllers/transactionController');
const { protect }     = require('../middleware/authMiddleware');
const requestValidator = require('../middleware/requestValidator');

const router = express.Router();

// Validation + protection pour INITIATE
router.post(
  '/initiate',
  protect,
  [
    body('toEmail')
      .isEmail()
      .withMessage('Email destinataire invalide'),
    body('amount')
      .isFloat({ gt: 0 })
      .withMessage('Le montant doit être supérieur à 0'),
    body('country')
      .notEmpty()
      .withMessage('Le pays est requis'),
    body('destination')
      .isIn(['PayNoval', 'Banque', 'Mobile Money'])
      .withMessage('Mode de réception invalide'),
  ],
  requestValidator,
  asyncHandler(initiateController)
);

// Validation + protection pour CONFIRM
router.post(
  '/confirm',
  protect,
  [
    body('transactionId')
      .isMongoId()
      .withMessage('ID de transaction invalide'),
    body('token')
      .isLength({ min: 64, max: 64 })
      .withMessage('Token de confirmation invalide'),
  ],
  requestValidator,
  asyncHandler(confirmController)
);

module.exports = router;
