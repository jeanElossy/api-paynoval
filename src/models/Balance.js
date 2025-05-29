// File: src/models/Balance.js

const mongoose = require('mongoose');
const logger   = require('../utils/logger');

// Schéma de la balance utilisateur
const balanceSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, "L'identifiant utilisateur est requis"]
  },
  amount: {
    type: Number,
    required: [true, "Le montant du solde est requis"],
    default: 0,
    min: [0, "Le montant du solde ne peut pas être négatif"]
  }
}, {
  timestamps: true,
  versionKey: '__v',
  optimisticConcurrency: true
});

// Index unique sur l’utilisateur
balanceSchema.index({ user: 1 }, { unique: true });

/**
 * Ajoute un montant au solde de l’utilisateur (upsert si n’existe pas)
 */
balanceSchema.statics.addToBalance = async function(userId, amount) {
  if (amount <= 0) throw new Error('Le montant à ajouter doit être positif');
  const result = await this.findOneAndUpdate(
    { user: userId },
    { $inc: { amount } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  logger.info(`Balance mise à jour pour user=${userId}, new amount=${result.amount}`);
  return result;
};

/**
 * Retire un montant du solde de l’utilisateur (avec transaction)
 */
balanceSchema.statics.withdrawFromBalance = async function(userId, amount) {
  if (amount <= 0) throw new Error('Le montant à retirer doit être positif');
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const bal = await this.findOne({ user: userId }).session(session);
    if (!bal || bal.amount < amount) {
      throw new Error('Fonds insuffisants pour le retrait');
    }
    bal.amount -= amount;
    await bal.save({ session });
    await session.commitTransaction();
    logger.info(`Retrait de ${amount} pour user=${userId}, remaining=${bal.amount}`);
    return bal;
  } catch (err) {
    await session.abortTransaction();
    logger.error(`Erreur retrait balance pour user=${userId}: ${err.message}`);
    throw err;
  } finally {
    session.endSession();
  }
};

// Hooks de logging
balanceSchema.post('save', function(doc) {
  logger.info(`Balance sauvegardée pour user=${doc.user}, amount=${doc.amount}`);
});
balanceSchema.post('remove', function(doc) {
  logger.info(`Balance supprimée pour user=${doc.user}`);
});

module.exports = mongoose.model('Balance', balanceSchema);
