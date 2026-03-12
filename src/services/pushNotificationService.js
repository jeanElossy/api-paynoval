"use strict";

const Joi = require("joi");
const { Expo } = require("expo-server-sdk");
const promiseRetry = require("promise-retry");

const {
  logger,
  getUsersConnectionSafe,
} = require("./shared/runtime");

const Device = require("../../../models/Device")(getUsersConnectionSafe());
const User = require("../../../models/User")(getUsersConnectionSafe());

const expo = new Expo();

const inputSchema = Joi.object({
  userId: Joi.string().hex().length(24).required(),
  title: Joi.string().trim().allow("").max(160).default("PayNoval"),
  message: Joi.string().trim().min(1).max(500).required(),
  data: Joi.object().default({}),
});

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim() !== "";
}

function uniqueStrings(arr = []) {
  return [...new Set(arr.filter(isNonEmptyString).map((v) => v.trim()))];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toUserIdString(userId) {
  if (!userId) return "";
  if (typeof userId === "string") return userId.trim();
  if (typeof userId?.toString === "function") return userId.toString().trim();
  return "";
}

function isTransactionMeta(meta = {}) {
  return meta?.category === "transaction";
}

async function getUserDevicePushTokens(userId) {
  const uid = toUserIdString(userId);
  if (!uid) return [];

  try {
    const devices = await Device.find({
      user: uid,
      status: { $ne: "blocked" },
      pushToken: { $exists: true, $nin: [null, ""] },
    })
      .select("pushToken status platform")
      .lean();

    return uniqueStrings(
      (devices || [])
        .map((d) => d?.pushToken)
        .filter((t) => isNonEmptyString(t) && Expo.isExpoPushToken(t))
    );
  } catch (err) {
    logger?.error?.(
      { err: err?.message || err, userId: uid },
      "[pushNotificationService] getUserDevicePushTokens failed"
    );
    return [];
  }
}

async function cleanupInvalidPushTokens(tokens = []) {
  const uniqueTokens = uniqueStrings(tokens);
  if (!uniqueTokens.length) return 0;

  try {
    const result = await Device.updateMany(
      { pushToken: { $in: uniqueTokens } },
      {
        $unset: { pushToken: "" },
        $set: { lastActive: new Date() },
      }
    );

    const cleaned = result?.modifiedCount ?? result?.nModified ?? 0;

    logger?.warn?.(
      { cleaned, tokens: uniqueTokens.length },
      "[pushNotificationService] invalid push tokens cleaned"
    );

    return cleaned;
  } catch (err) {
    logger?.error?.(
      { err: err?.message || err, tokenCount: uniqueTokens.length },
      "[pushNotificationService] cleanupInvalidPushTokens failed"
    );
    return 0;
  }
}

async function sendPushNotification(userId, message, title = "PayNoval", data = {}) {
  const userIdStr = toUserIdString(userId);

  const { error, value } = inputSchema.validate({
    userId: userIdStr,
    title,
    message,
    data,
  });

  if (error) {
    throw new Error(`Paramètres invalides: ${error.message}`);
  }

  const {
    userId: uid,
    title: pushTitle,
    message: pushMessage,
    data: pushData,
  } = value;

  const tokens = await getUserDevicePushTokens(uid);

  if (!tokens.length) {
    logger?.warn?.(
      { userId: uid },
      "[pushNotificationService] no active device push token found"
    );
    return {
      ok: false,
      reason: "NO_ACTIVE_PUSH_TOKEN",
      sent: 0,
    };
  }

  const notifications = tokens.map((token) => ({
    to: token,
    sound: "default",
    priority: "high",
    title: pushTitle || "PayNoval",
    body: pushMessage,
    data: {
      ...pushData,
      sentAt: new Date().toISOString(),
    },
  }));

  const chunks = expo.chunkPushNotifications(notifications);
  const invalidTokens = new Set();
  const receiptIds = [];
  const ticketToToken = new Map();
  let sentCount = 0;

  for (const chunk of chunks) {
    await promiseRetry(
      async (retry, attempt) => {
        try {
          const tickets = await expo.sendPushNotificationsAsync(chunk);

          tickets.forEach((ticket, index) => {
            const token = chunk[index]?.to;

            if (ticket?.status === "ok") {
              sentCount += 1;
              if (ticket?.id) {
                receiptIds.push(ticket.id);
                if (token) ticketToToken.set(ticket.id, token);
              }
              return;
            }

            if (ticket?.status === "error") {
              const expoErr = ticket?.details?.error || "";
              logger?.error?.(
                {
                  attempt,
                  token,
                  message: ticket?.message,
                  details: ticket?.details,
                },
                "[pushNotificationService] expo ticket error"
              );

              if (expoErr === "DeviceNotRegistered" && token) {
                invalidTokens.add(token);
              }
            }
          });

          logger?.info?.(
            { attempt, chunkSize: chunk.length },
            "[pushNotificationService] push chunk sent"
          );
        } catch (err) {
          logger?.error?.(
            { err: err?.message || err, attempt, chunkSize: chunk.length },
            "[pushNotificationService] push chunk failed, retrying"
          );
          retry(err);
        }
      },
      {
        retries: 3,
        factor: 2,
        minTimeout: 1000,
        maxTimeout: 4000,
      }
    );
  }

  if (receiptIds.length) {
    await sleep(1200);

    const receiptChunks = expo.chunkPushNotificationReceiptIds(receiptIds);

    for (const ids of receiptChunks) {
      try {
        const receipts = await expo.getPushNotificationReceiptsAsync(ids);

        for (const [receiptId, receipt] of Object.entries(receipts || {})) {
          if (receipt?.status !== "error") continue;

          const expoErr = receipt?.details?.error || "";
          const token = ticketToToken.get(receiptId);

          logger?.error?.(
            {
              receiptId,
              token,
              message: receipt?.message,
              details: receipt?.details,
            },
            "[pushNotificationService] expo receipt error"
          );

          if (expoErr === "DeviceNotRegistered" && token) {
            invalidTokens.add(token);
          }
        }
      } catch (err) {
        logger?.error?.(
          { err: err?.message || err },
          "[pushNotificationService] receipt fetch failed"
        );
      }
    }
  }

  if (invalidTokens.size > 0) {
    await cleanupInvalidPushTokens([...invalidTokens]);
  }

  return {
    ok: true,
    sent: sentCount,
    invalidated: invalidTokens.size,
  };
}

async function sendEmailNotification(userId, title, message, data = {}, meta = {}) {
  try {
    const user = await User.findById(userId)
      .select("email fullName")
      .lean();

    if (!user?.email) {
      return { ok: false, reason: "USER_EMAIL_MISSING" };
    }

    if (isTransactionMeta(meta)) {
      const { sendTransactionEmail } = require("./transactions/transactionEmailService");
      return await sendTransactionEmail({
        user,
        role: meta?.role || "receiver",
        status: meta?.status || "updated",
        data,
      });
    }

    const emailService = require("../../../utils/sendEmail");

    if (!emailService?.sendEmail) {
      return { ok: false, reason: "EMAIL_SERVICE_UNAVAILABLE" };
    }

    await emailService.sendEmail({
      to: user.email,
      subject: title,
      text: message,
      html: `<p>${message}</p>`,
    });

    return { ok: true };
  } catch (err) {
    logger?.error?.(
      { err: err?.message || err, userId },
      "[pushNotificationService] sendEmailNotification failed"
    );
    return { ok: false, reason: err?.message || "EMAIL_SEND_FAILED" };
  }
}

async function sendSmsNotification(userId, message) {
  try {
    const smsService = require("../../../utils/smsService");
    const user = await User.findById(userId).select("phone").lean();

    if (!smsService?.sendSMS) {
      return { ok: false, reason: "SMS_SERVICE_UNAVAILABLE" };
    }

    if (!user?.phone) {
      return { ok: false, reason: "USER_PHONE_MISSING" };
    }

    await smsService.sendSMS(user.phone, message);
    return { ok: true };
  } catch (err) {
    logger?.error?.(
      { err: err?.message || err, userId },
      "[pushNotificationService] sendSmsNotification failed"
    );
    return { ok: false, reason: err?.message || "SMS_SEND_FAILED" };
  }
}

async function deliverChannels({
  userId,
  title,
  message,
  data = {},
  meta = {},
  channels = ["push"],
}) {
  const results = {
    push: "skipped",
    email: "skipped",
    sms: "skipped",
  };

  if (channels.includes("push")) {
    try {
      const res = await sendPushNotification(userId, message, title, data);
      results.push = res?.ok ? "sent" : `skipped:${res?.reason || "UNKNOWN"}`;
    } catch (err) {
      results.push = `error:${err?.message || "PUSH_SEND_FAILED"}`;
    }
  }

  if (channels.includes("email")) {
    const res = await sendEmailNotification(userId, title, message, data, meta);
    results.email = res?.ok ? "sent" : `error:${res?.reason || "EMAIL_FAILED"}`;
  }

  if (channels.includes("sms")) {
    const res = await sendSmsNotification(userId, message);
    results.sms = res?.ok ? "sent" : `error:${res?.reason || "SMS_FAILED"}`;
  }

  return results;
}

module.exports = {
  getUserDevicePushTokens,
  cleanupInvalidPushTokens,
  sendPushNotification,
  sendEmailNotification,
  sendSmsNotification,
  deliverChannels,
};