"use strict";

const os = require("os");
const crypto = require("crypto");

const {
  logger,
  getUsersConnectionSafe,
} = require("./shared/runtime");

const Outbox = require("../../../models/Outbox")(getUsersConnectionSafe());

const { deliverChannels } = require("../pushNotificationService");

function buildWorkerId() {
  return `${os.hostname()}:${process.pid}:${crypto.randomBytes(4).toString("hex")}`;
}

function computeBackoffMs(attempts) {
  const n = Math.max(1, Number(attempts || 1));
  return Math.min(60000, 1000 * Math.pow(2, Math.min(n, 6)));
}

async function lockNextOutboxItem(workerId, service = "notifications") {
  const now = new Date();

  return Outbox.findOneAndUpdate(
    {
      service,
      status: { $in: ["pending", "retry"] },
      availableAt: { $lte: now },
      $or: [{ lockedAt: null }, { lockedAt: { $exists: false } }],
    },
    {
      $set: {
        status: "processing",
        lockedAt: now,
        lockedBy: workerId,
      },
    },
    {
      new: true,
      sort: { createdAt: 1 },
    }
  ).lean();
}

async function markProcessed(itemId) {
  await Outbox.updateOne(
    { _id: itemId },
    {
      $set: {
        status: "processed",
        processedAt: new Date(),
        lockedAt: null,
        lockedBy: "",
        lastError: "",
      },
    }
  );
}

async function markFailedOrRetry(item, err) {
  const attempts = Number(item?.attempts || 0) + 1;
  const maxAttempts = Number(item?.maxAttempts || 8);
  const willRetry = attempts < maxAttempts;

  await Outbox.updateOne(
    { _id: item._id },
    {
      $set: {
        status: willRetry ? "retry" : "failed",
        availableAt: new Date(Date.now() + computeBackoffMs(attempts)),
        lockedAt: null,
        lockedBy: "",
        lastError: String(err?.message || err || "OUTBOX_PROCESS_FAILED").slice(0, 4000),
      },
      $inc: { attempts: 1 },
    }
  );
}

function isSuccessfulResult(result = {}, channels = []) {
  if (!channels.length) return true;

  return channels.every((channel) => {
    const value = result?.[channel];
    return typeof value === "string" && value === "sent";
  });
}

async function processOutboxItem(item) {
  if (!item) return { ok: false, reason: "NO_ITEM" };

  const payload = item?.payload || {};
  const channels =
    Array.isArray(payload.channels) && payload.channels.length
      ? payload.channels
      : ["push"];

  if (item.event !== "notification.deliver") {
    throw new Error(`Unsupported outbox event: ${item.event}`);
  }

  if (!payload.userId || !payload.message) {
    throw new Error("Invalid outbox payload: userId/message missing");
  }

  const result = await deliverChannels({
    userId: payload.userId,
    title: payload.title || "PayNoval",
    message: payload.message,
    data: payload.data || {},
    meta: payload.meta || {},
    channels,
  });

  if (!isSuccessfulResult(result, channels)) {
    throw new Error(`Delivery incomplete: ${JSON.stringify(result)}`);
  }

  return {
    ok: true,
    result,
  };
}

async function processPendingOutbox({ limit = 50, workerId } = {}) {
  const wid = workerId || buildWorkerId();
  const max = Math.max(1, Number(limit || 50));

  let processed = 0;
  let failed = 0;

  for (let i = 0; i < max; i += 1) {
    const item = await lockNextOutboxItem(wid);

    if (!item) break;

    try {
      const res = await processOutboxItem(item);
      await markProcessed(item._id);

      processed += 1;

      logger?.info?.(
        {
          outboxId: item._id?.toString?.(),
          service: item.service,
          event: item.event,
          result: res?.result || {},
          targetDb: "users/main",
        },
        "[outboxPublisher] processed"
      );
    } catch (err) {
      failed += 1;

      logger?.error?.(
        {
          outboxId: item._id?.toString?.(),
          service: item.service,
          event: item.event,
          err: err?.message || err,
          targetDb: "users/main",
        },
        "[outboxPublisher] process failed"
      );

      await markFailedOrRetry(item, err);
    }
  }

  return {
    workerId: wid,
    processed,
    failed,
  };
}

function startOutboxWorker({
  intervalMs = 3000,
  batchSize = 50,
  workerId,
} = {}) {
  const wid = workerId || buildWorkerId();

  logger?.info?.(
    { workerId: wid, intervalMs, batchSize, targetDb: "users/main" },
    "[outboxPublisher] worker started"
  );

  const timer = setInterval(async () => {
    try {
      await processPendingOutbox({
        limit: batchSize,
        workerId: wid,
      });
    } catch (err) {
      logger?.error?.(
        { err: err?.message || err, workerId: wid, targetDb: "users/main" },
        "[outboxPublisher] worker tick failed"
      );
    }
  }, Math.max(1000, Number(intervalMs || 3000)));

  if (typeof timer.unref === "function") {
    timer.unref();
  }

  return {
    workerId: wid,
    stop() {
      clearInterval(timer);
      logger?.info?.({ workerId: wid }, "[outboxPublisher] worker stopped");
    },
  };
}

module.exports = {
  buildWorkerId,
  processOutboxItem,
  processPendingOutbox,
  startOutboxWorker,
};