// File: src/models/User.js

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

// Définition du schéma User avec des validations et protection de champs sensibles
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
    // Convertit Decimal128 en Number à la lecture
    get: v => parseFloat(v.toString()),
    // Convertit Number ou string en Decimal128 à l'écriture
    set: v => mongoose.Types.Decimal128.fromString(v.toString())
  },
  role: {
    type: String,
    enum: ['user', 'admin'],
    default: 'user'
  }
}, {
  timestamps: true,              // createdAt & updatedAt
  versionKey: '__v',             // Version clé pour optimistic concurrency
  optimisticConcurrency: true,
  toJSON: {
    getters: true,
    transform(doc, ret) {
      // Supprimer les champs techniques
      delete ret._id;
      delete ret.__v;
      delete ret.password;
      return ret;
    }
  }
});

// Index unique sur l'email
userSchema.index({ email: 1 }, { unique: true });

// Hook avant sauvegarde pour hasher le mot de passe
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

// Méthode pour comparer le mot de passe en entrée avec le hash stocké
userSchema.methods.comparePassword = function(candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

module.exports = mongoose.model('User', userSchema);
