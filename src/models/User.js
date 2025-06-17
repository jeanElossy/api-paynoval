const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

/**
 * Schéma utilisateur (gère users sur plusieurs connexions)
 */
const userSchema = new mongoose.Schema({
  email: {
    type: String,
    required: [true, 'L\'email est requis'],
    unique: true,
    lowercase: true,
    trim: true,
    match: [/.+@.+\..+/, 'Format d\'email invalide']
  },
  password: {
    type: String,
    required: [true, 'Le mot de passe est requis'],
    select: false,
    minlength: [8, 'Le mot de passe doit contenir au moins 8 caractères']
  },
  balance: {
    type: mongoose.Schema.Types.Decimal128,
    required: true,
    default: mongoose.Types.Decimal128.fromString('0.00'),
    get: v => parseFloat(v.toString()),
    set: v => mongoose.Types.Decimal128.fromString(v.toString())
  },
  role: {
    type: String,
    enum: ['user', 'admin'],
    default: 'user'
  },
  fullName: { // Ajoute si besoin (nom complet)
    type: String,
    trim: true,
    maxlength: 100,
    default: ''
  },
  pushTokens: { // Pour notifications push
    type: [String],
    default: []
  },
  notificationSettings: { // Préférences notif
    type: Object,
    default: {}
  }
}, {
  timestamps: true,
  versionKey: '__v',
  optimisticConcurrency: true,
  toJSON: {
    getters: true,
    transform(doc, ret) {
      delete ret._id;
      delete ret.__v;
      delete ret.password;
      return ret;
    }
  }
});

userSchema.index({ email: 1 }, { unique: true });

userSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  try {
    const salt = await bcrypt.genSalt(12);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (err) {
    next(err);
  }
});

userSchema.methods.comparePassword = function(candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

/**
 * Export du modèle multi-connexion
 * - Sans paramètre => mongoose par défaut
 * - Avec paramètre (ex: txConn) => connexion custom
 */
module.exports = (conn = mongoose) =>
  conn.models.User || conn.model('User', userSchema);
