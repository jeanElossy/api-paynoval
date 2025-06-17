const mongoose = require('mongoose');
const { Schema } = mongoose;

const outboxSchema = new Schema({
  service: { type: String, required: true, trim: true },
  event: { type: String, required: true, trim: true },
  payload: { type: Schema.Types.Mixed, required: true },
  processed: { type: Boolean, default: false, index: true },
  retryCount: { type: Number, default: 0 },
  lastError: { type: String, select: false },
  processedAt: { type: Date }
}, {
  versionKey: false,
  timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' }
});

// Index to quickly find unprocessed events in order of creation
outboxSchema.index({ processed: 1, createdAt: 1 });

// TTL index to purge old entries after 30 days
outboxSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });

module.exports = (conn = mongoose) =>
  conn.models.Outbox || conn.model('Outbox', outboxSchema);
