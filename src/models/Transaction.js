// src/models/Transaction.js

const mongoose = require('mongoose');
const crypto = require('crypto');
const { Schema } = mongoose;

/**
 * Initialise le modèle Transaction sur la connexion passée en paramètre.
 */
module.exports = conn => {
  const transactionSchema = new Schema({
    sender: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    receiver: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    amount: {
      type: Schema.Types.Decimal128,
      required: true,
      validate: {
        validator: v => parseFloat(v.toString()) >= 0.01,
        message: props => `Le montant doit être au moins 0.01, reçu ${props.value}`
      }
    },
    transactionFees: {
      type: Schema.Types.Decimal128,
      required: true,
      default: mongoose.Types.Decimal128.fromString('0.00'),
      validate: {
        validator: v => parseFloat(v.toString()) >= 0.00,
        message: props => `Les frais doivent être au moins 0.00, reçus ${props.value}`
      }
    },
    // Nouveau champ pour stocker le montant converti
    localAmount: {
      type: Schema.Types.Decimal128,
      required: true
    },
    // Nouveau champ pour la devise locale
    localCurrencySymbol: {
      type: String,
      required: true
    },
    // Nouveau champ pour stocker le nom saisi du destinataire
    nameDestinataire: {
      type: String,
      required: true
    },
    status: {
      type: String,
      enum: ['pending', 'confirmed', 'cancelled'],
      default: 'pending'
    },
    verificationToken: {
      type: String,
      required: true,
      select: false,
      unique: true
    },
    confirmedAt: {
      type: Date,
      default: null
    }
  }, {
    versionKey: false,
    timestamps: true // createdAt & updatedAt
  });

  // Indexes pour accélérer certaines requêtes
  transactionSchema.index({ sender: 1, createdAt: -1 });
  transactionSchema.index({ receiver: 1, status: 1 });

  // Transformation lors de toJSON/toObject
  transactionSchema.set('toJSON', {
    transform(doc, ret) {
      ret.id                  = ret._id;
      ret.amount              = parseFloat(ret.amount.toString());
      ret.transactionFees     = parseFloat(ret.transactionFees.toString());
      ret.localAmount         = parseFloat(ret.localAmount.toString());
      ret.localCurrencySymbol = ret.localCurrencySymbol;
      ret.nameDestinataire    = ret.nameDestinataire;
      delete ret._id;
      delete ret.verificationToken;
      return ret;
    }
  });

  // Avant validation, génère un token si nouveau document
  transactionSchema.pre('validate', function(next) {
    if (this.isNew) {
      this.verificationToken = crypto.randomBytes(32).toString('hex');
    }
    next();
  });

  // Méthode statique pour générer un token à la demande
  transactionSchema.statics.generateVerificationToken = function() {
    return crypto.randomBytes(32).toString('hex');
  };

  // Méthode d'instance pour vérifier le token
  transactionSchema.methods.verifyToken = function(token) {
    if (!token || !this.verificationToken) return false;
    try {
      const provided = Buffer.from(token, 'hex');
      const stored   = Buffer.from(this.verificationToken, 'hex');
      return crypto.timingSafeEqual(provided, stored);
    } catch {
      return false;
    }
  };

  conn.model('Transaction', transactionSchema);
};
