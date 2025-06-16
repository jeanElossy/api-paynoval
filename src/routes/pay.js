// src/routes/pay.js

const express = require('express');
const router = express.Router();
const {
  findUserByEmail,
  debitUser,
  creditUserByEmail,
  findBalanceByUserId
} = require('../services/transactions');
const { protect } = require('../middlewares/authMiddleware');

router.post('/', protect, async (req, res) => {
  const { toEmail, amount } = req.body;
  const user = req.user; // déjà auth via middleware

  // Vérif basique des champs
  if (!toEmail || typeof amount !== 'number' || amount <= 0) {
    return res.status(400).json({ success: false, error: 'Paramètres invalides' });
  }

  if (user.email === toEmail) {
    return res.status(400).json({ success: false, error: 'Vous ne pouvez pas vous payer vous-même' });
  }

  try {
    // 1️⃣ Vérifier la balance de l'expéditeur
    const senderBalance = await findBalanceByUserId(user._id);
    if (!senderBalance) {
      return res.status(404).json({ success: false, error: 'Solde introuvable' });
    }
    if (senderBalance.amount < amount) {
      return res.status(402).json({ success: false, error: 'Fonds insuffisants' });
    }

    // 2️⃣ Vérifie que le destinataire existe
    const destUser = await findUserByEmail(toEmail);
    if (!destUser) {
      return res.status(404).json({ success: false, error: "Destinataire introuvable" });
    }

    // 3️⃣ Effectuer le débit et le crédit
    await debitUser(user._id, amount);
    await creditUserByEmail(toEmail, amount);

    // (optionnel) Historique, notifications...

    return res.json({ success: true, message: 'Paiement effectué avec succès' });

  } catch (err) {
    console.error('[PAY] error:', err);
    return res.status(500).json({ success: false, error: err.message || 'Erreur interne' });
  }
});

module.exports = router;
