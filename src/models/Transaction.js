/* src/models/Transaction.js */
const mongoose = require('mongoose');
const crypto = require('crypto');
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
    min: 0.01
  },
  status: {
    type: String,
    enum: ['pending', 'confirmed', 'cancelled'],
    default: 'pending'
  },
  verificationToken: {
    type: String,
    required: true,
    select: false // Never return token by default
  },
  confirmedAt: {
    type: Date
  }
}, {
  versionKey: false,
  timestamps: true // createdAt & updatedAt
});

// Compound indexes for efficient queries
transactionSchema.index({ sender: 1, createdAt: -1 });
transactionSchema.index({ receiver: 1, status: 1 });

// Static method to generate a cryptographically secure token
transactionSchema.statics.generateVerificationToken = function() {
  return crypto.randomBytes(32).toString('hex');
};

// Instance method to verify a provided token
transactionSchema.methods.verifyToken = function(token) {
  if (!token || !this.verificationToken) return false;
  const provided = Buffer.from(token);
  const stored = Buffer.from(this.verificationToken);
  try {
    return crypto.timingSafeEqual(provided, stored);
  } catch (err) {
    return false;
  }
};

module.exports = mongoose.model('Transaction', transactionSchema);
