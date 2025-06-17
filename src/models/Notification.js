const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  recipient: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type:      { type: String, required: true },        // ex. "transaction_initiated"
  data:      { type: Object, default: {} },           // payload de la notif
  read:      { type: Boolean, default: false },
}, { timestamps: true });

module.exports = (conn = mongoose) =>
  conn.models.Notification || conn.model('Notification', notificationSchema);
