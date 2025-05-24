const mongoose = require('mongoose');
const crypto = require('crypto');
const { Schema } = mongoose;

// Fonction d'initialisation du modèle Transaction sur une connexion donnée
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

  // Indexes for efficient queries
  transactionSchema.index({ sender: 1, createdAt: -1 });
  transactionSchema.index({ receiver: 1, status: 1 });

  // Transform output for toJSON/toObject
  transactionSchema.set('toJSON', {
    transform(doc, ret) {
      ret.id = ret._id;
      ret.amount = parseFloat(ret.amount.toString());
      ret.transactionFees = parseFloat(ret.transactionFees.toString());
      delete ret._id;
      delete ret.verificationToken;
      return ret;
    }
  });

  // Pre-validate hook: generate token for new transactions
  transactionSchema.pre('validate', function(next) {
    if (this.isNew) {
      this.verificationToken = crypto.randomBytes(32).toString('hex');
    }
    next();
  });

  // Static method: generateVerificationToken
  transactionSchema.statics.generateVerificationToken = function() {
    return crypto.randomBytes(32).toString('hex');
  };

  // Instance method: verifyToken
  transactionSchema.methods.verifyToken = function(token) {
    if (!token || !this.verificationToken) return false;
    try {
      const provided = Buffer.from(token, 'hex');
      const stored = Buffer.from(this.verificationToken, 'hex');
      return crypto.timingSafeEqual(provided, stored);
    } catch (err) {
      return false;
    }
  };

  conn.model('Transaction', transactionSchema);
};
