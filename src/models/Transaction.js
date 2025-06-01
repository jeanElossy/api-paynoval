// File: src/models/Transaction.js

const mongoose = require('mongoose');
const crypto   = require('crypto');

module.exports = conn => {
  const { Schema } = mongoose;

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
      // Montant brut saisi par l’expéditeur
      type: Schema.Types.Decimal128,
      required: true,
      validate: {
        validator: v => parseFloat(v.toString()) >= 0.01,
        message: props => `Le montant doit être ≥ 0.01, reçu ${props.value}`
      }
    },
    transactionFees: {
      // 1 % du montant brut, calculé au controller
      type: Schema.Types.Decimal128,
      required: true,
      default: mongoose.Types.Decimal128.fromString('0.00'),
      validate: {
        validator: v => parseFloat(v.toString()) >= 0.00,
        message: props => `Les frais doivent être ≥ 0.00, reçus ${props.value}`
      }
    },
    netAmount: {
      // montant net à créditer au destinataire = amount – transactionFees
      type: Schema.Types.Decimal128,
      required: true,
      validate: {
        validator: v => parseFloat(v.toString()) >= 0.00,
        message: props => `Le net à créditer doit être ≥ 0.00, reçu ${props.value}`
      }
    },

    // === nouveaux champs « senderName » + « senderEmail » ===
    senderName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100
    },
    senderEmail: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 100,
      match: /.+@.+\..+/
    },

    // ☑️ devise de l’expéditeur
    senderCurrencySymbol: {
      type: String,
      required: true,
      trim: true,
      maxlength: 5
    },
    // ☑️ taux de change
    exchangeRate: {
      type: Schema.Types.Decimal128,
      required: true
    },
    // ☑️ montant converti pour le destinataire (pour info seulement)
    localAmount: {
      type: Schema.Types.Decimal128,
      required: true
    },
    localCurrencySymbol: {
      type: String,
      required: true,
      trim: true,
      maxlength: 5
    },

    // ☑️ nom affiché du destinataire
    nameDestinataire: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100
    },
    // ☑️ email fourni du destinataire
    recipientEmail: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      match: /.+@.+\..+/
    },

    // ☑️ pays
    country: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100
    },
    // ☑️ question de sécurité
    securityQuestion: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200
    },
    // ☑️ code secret (non exposé en JSON)
    securityCode: {
      type: String,
      required: true,
      select: false
    },
    // ☑️ méthode de transfert
    destination: {
      type: String,
      required: true,
      enum: ['PayNoval','Banque','Mobile Money']
    },
    // ☑️ source des fonds
    funds: {
      type: String,
      required: true,
      enum: ['Solde PayNoval','Carte de crédit']
    },
    // ☑️ statut
    status: {
      type: String,
      enum: ['pending','confirmed','cancelled'],
      default: 'pending'
    },
    // ☑️ token de vérification
    verificationToken: {
      type: String,
      required: true,
      select: false,
      unique: true
    },
    confirmedAt: {
      type: Date,
      default: null
    },
    cancelledAt: {
      type: Date,
      default: null
    },
    cancelReason: {
      type: String,
      default: null
    }
  }, {
    versionKey: false,
    timestamps: true
  });

  // Indexes pour accélérer les recherches
  transactionSchema.index({ sender: 1, createdAt: -1 });
  transactionSchema.index({ receiver: 1, status: 1 });
  transactionSchema.index({ verificationToken: 1 });

  // toJSON : convertir Decimal128 en nombre et exposer les nouveaux champs
  transactionSchema.set('toJSON', {
    transform(doc, ret) {
      ret.id              = ret._id;
      ret.amount          = parseFloat(ret.amount.toString());
      ret.transactionFees = parseFloat(ret.transactionFees.toString());
      ret.netAmount       = parseFloat(ret.netAmount.toString());
      ret.exchangeRate    = parseFloat(ret.exchangeRate.toString());
      ret.localAmount     = parseFloat(ret.localAmount.toString());
      delete ret._id;
      delete ret.securityCode;
      delete ret.verificationToken;
      return ret;
    }
  });

  // Génération automatique du token de vérification
  transactionSchema.pre('validate', function(next) {
    if (this.isNew) {
      this.verificationToken = crypto.randomBytes(32).toString('hex');
    }
    next();
  });

  conn.model('Transaction', transactionSchema);
};
