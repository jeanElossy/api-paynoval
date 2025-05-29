// models/Transaction.js
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
      type: Schema.Types.Decimal128,
      required: true,
      validate: {
        validator: v => parseFloat(v.toString()) >= 0.01,
        message: props => `Le montant doit être ≥ 0.01, reçu ${props.value}`
      }
    },
    transactionFees: {
      type: Schema.Types.Decimal128,
      required: true,
      default: mongoose.Types.Decimal128.fromString('0.00'),
      validate: {
        validator: v => parseFloat(v.toString()) >= 0.00,
        message: props => `Les frais doivent être ≥ 0.00, reçus ${props.value}`
      }
    },
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
    nameDestinataire: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100
    },
    recipientEmail: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      match: /.+@.+\..+/
    },
    country: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100
    },
    securityQuestion: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200
    },
    securityCode: {
      type: String,
      required: true,
      select: false
    },
    destination: {
      type: String,
      required: true,
      enum: ['PayNoval','Banque','Mobile Money']
    },
    funds: {
      type: String,
      required: true,
      enum: ['Solde PayNoval','Carte de crédit']
    },
    status: {
      type: String,
      enum: ['pending','confirmed','cancelled'],
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
    timestamps: true
  });

  // Indexes
  transactionSchema.index({ sender: 1, createdAt: -1 });
  transactionSchema.index({ receiver: 1, status: 1 });
  transactionSchema.index({ verificationToken: 1 });

  // toJSON / toObject : formate et supprime les champs sensibles
  transactionSchema.set('toJSON', {
    transform(doc, ret) {
      ret.id = ret._id;
      ret.amount          = parseFloat(ret.amount.toString());
      ret.transactionFees = parseFloat(ret.transactionFees.toString());
      ret.localAmount     = parseFloat(ret.localAmount.toString());
      delete ret._id;
      delete ret.securityCode;
      delete ret.verificationToken;
      return ret;
    }
  });

  // Génération automatique d’un token si nouveau document
  transactionSchema.pre('validate', function(next) {
    if (this.isNew) {
      this.verificationToken = crypto.randomBytes(32).toString('hex');
    }
    next();
  });

  // Méthodes statiques / d’instance
  transactionSchema.statics.generateVerificationToken = function() {
    return crypto.randomBytes(32).toString('hex');
  };
  transactionSchema.methods.verifyToken = function(token) {
    if (!token || !this.verificationToken) return false;
    const provided = Buffer.from(token, 'hex');
    const stored   = Buffer.from(this.verificationToken, 'hex');
    return crypto.timingSafeEqual(provided, stored);
  };

  conn.model('Transaction', transactionSchema);
};
