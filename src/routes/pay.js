// src/routes/pay.js

const express = require('express');
const router = express.Router();
const {
  findUserByEmail,
  debitUser,
  creditUserByEmail,
  findBalanceByUserId
} = require('../services/transactions');
const { protect } = require('../middleware/authMiddleware');
const Transaction = require('../models/Transaction'); // pour enregistrer l'audit

router.post('/', protect, async (req, res) => {
  const {
    toEmail,
    amount,
    description, // facultatif
    reference,   // référence/facture/commande facultative
    metadata     // objet facultatif, infos libres du marchand
  } = req.body;
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

    // 3️⃣ Effectuer le débit et le crédit avec contexte pour audit
    await debitUser(user._id, amount, 'Paiement marchand', {
      description,
      reference,
      metadata,
      to: toEmail
    });

    await creditUserByEmail(toEmail, amount, 'Paiement marchand', {
      description,
      reference,
      metadata,
      from: user.email
    });

    // 4️⃣ Historiser dans la collection Transaction (optionnel, mais recommandé)
    await Transaction.create({
      sender: user._id,
      receiver: destUser._id,
      reference: reference || (Math.random().toString(36).substring(2, 12)), // fallback référence unique
      amount,
      transactionFees: 0,
      netAmount: amount,
      senderName: user.fullName || user.email,
      senderEmail: user.email,
      senderCurrencySymbol: 'F CFA', // ou adapte selon ton contexte devise
      exchangeRate: 1,
      localAmount: amount,
      localCurrencySymbol: 'F CFA',
      nameDestinataire: destUser.fullName || destUser.email,
      recipientEmail: destUser.email,
      country: user.selectedCountry || '',
      securityQuestion: '',
      securityCode: '', // Pas de code pour paiement direct
      destination: 'PayNoval',
      funds: 'Solde PayNoval',
      status: 'confirmed',
      description,
      orderId: reference || null,
      metadata: metadata || null,
      confirmedAt: new Date()
    });

    return res.json({ success: true, message: 'Paiement effectué avec succès' });

  } catch (err) {
    console.error('[PAY] error:', err);
    return res.status(500).json({ success: false, error: err.message || 'Erreur interne' });
  }
});

module.exports = router;
