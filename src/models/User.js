/* src/models/User.js */
const mongoose = require('mongoose');
const { Schema } = mongoose;

const userSchema = new Schema({
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true
  },
  password: {
    type: String,
    required: true,
    select: false
  },
  balance: {
    type: Schema.Types.Decimal128,
    required: true,
    default: mongoose.Types.Decimal128.fromString('0.00'),
    get: v => parseFloat(v.toString()),
    set: v => mongoose.Types.Decimal128.fromString(v.toString())
  },
  role: {
    type: String,
    enum: ['user', 'admin'],
    default: 'user'
  }
}, {
  versionKey: false,
  timestamps: true
});

module.exports = mongoose.model('User', userSchema);
