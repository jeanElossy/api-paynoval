// models/Transaction.js

const mongoose = require('mongoose');
const crypto   = require('crypto');

const transactionSchema = new mongoose.Schema({
  sender:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  receiver:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  reference: { type: String, required: true, unique: true, trim: true },
  amount:    { type: mongoose.Schema.Types.Decimal128, required: true, validate: { validator: v => parseFloat(v.toString()) >= 0.01, message: props => `Le montant doit être ≥ 0.01, reçu ${props.value}` } },
  transactionFees: { type: mongoose.Schema.Types.Decimal128, required: true, default: mongoose.Types.Decimal128.fromString('0.00'), validate: { validator: v => parseFloat(v.toString()) >= 0.00, message: props => `Les frais doivent être ≥ 0.00, reçus ${props.value}` } },
  netAmount: { type: mongoose.Schema.Types.Decimal128, required: true, validate: { validator: v => parseFloat(v.toString()) >= 0.00, message: props => `Le net à créditer doit être ≥ 0.00, reçu ${props.value}` } },
  senderName:        { type: String, required: true, trim: true, maxlength: 100 },
  senderEmail:       { type: String, required: true, trim: true, lowercase: true, maxlength: 100, match: /.+@.+\..+/ },
  senderCurrencySymbol: { type: String, required: true, trim: true, maxlength: 5 },
  exchangeRate:      { type: mongoose.Schema.Types.Decimal128, required: true },
  localAmount:       { type: mongoose.Schema.Types.Decimal128, required: true },
  localCurrencySymbol: { type: String, required: true, trim: true, maxlength: 5 },
  nameDestinataire:  { type: String, required: true, trim: true, maxlength: 100 },
  recipientEmail:    { type: String, required: true, trim: true, lowercase: true, match: /.+@.+\..+/ },
  country:           { type: String, required: true, trim: true, maxlength: 100 },
  securityQuestion:  { type: String, required: true, trim: true, maxlength: 200 },
  securityCode:      { type: String, required: true, select: false },
  destination:       { type: String, required: true, enum: ['PayNoval','Banque','Mobile Money'] },
  funds:             { type: String, required: true, enum: ['Solde PayNoval','Carte de crédit'] },
  status:            { type: String, enum: ['pending','confirmed','cancelled'], default: 'pending' },
  verificationToken: { type: String, required: true, select: false, unique: true },
  confirmedAt:       { type: Date, default: null },
  cancelledAt:       { type: Date, default: null },
  cancelReason:      { type: String, default: null },

  // E-commerce / Facture / Audit fields
  description:    { type: String, default: null },     // description du paiement (facultatif)
  orderId:        { type: String, default: null },     // orderId, référence e-commerce/facture
  metadata:       { type: Object, default: null },     // Objet libre pour données custom du marchand

  // PATCH brute-force protection (anti-brute-force security code)
  attemptCount:    { type: Number, default: 0 },
  lastAttemptAt:   { type: Date, default: null },
  lockedUntil:     { type: Date, default: null }
}, {
  versionKey: false,
  timestamps: true
});

transactionSchema.index({ sender: 1, createdAt: -1 });
transactionSchema.index({ receiver: 1, status: 1 });
transactionSchema.index({ verificationToken: 1 });

transactionSchema.set('toJSON', {
  transform(doc, ret) {
    ret.id              = ret._id;
    ret.reference       = ret.reference;
    ret.amount          = parseFloat(ret.amount.toString());
    ret.transactionFees = parseFloat(ret.transactionFees.toString());
    ret.netAmount       = parseFloat(ret.netAmount.toString());
    ret.exchangeRate    = parseFloat(ret.exchangeRate.toString());
    ret.localAmount     = parseFloat(ret.localAmount.toString());
    delete ret._id;
    delete ret.securityCode;
    delete ret.verificationToken;
    // Supprime les infos brute-force du JSON API
    delete ret.attemptCount;
    delete ret.lastAttemptAt;
    delete ret.lockedUntil;
    return ret;
  }
});

transactionSchema.pre('validate', function(next) {
  if (this.isNew) {
    this.verificationToken = crypto.randomBytes(32).toString('hex');
  }
  next();
});

module.exports = mongoose.model('Transaction', transactionSchema);
