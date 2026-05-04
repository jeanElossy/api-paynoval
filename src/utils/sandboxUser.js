"use strict";

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function normalizeId(id) {
  return String(id || "").trim();
}

function getAppleReviewUserId() {
  return normalizeId(process.env.APPLE_REVIEW_USER_ID);
}

function getAppleReviewEmail() {
  return normalizeEmail(process.env.APPLE_REVIEW_EMAIL || "reviewer@paynoval.com");
}

function isAppleReviewUserId(userId) {
  const expected = getAppleReviewUserId();
  const current = normalizeId(userId);

  return Boolean(expected && current && expected === current);
}

function isAppleReviewEmail(email) {
  const expected = getAppleReviewEmail();
  const current = normalizeEmail(email);

  return Boolean(expected && current && expected === current);
}

function resolveUserId(user) {
  return (
    user?._id ||
    user?.id ||
    user?.userId ||
    user?.sub ||
    user?.user?._id ||
    user?.user?.id ||
    null
  );
}

function isSandboxUser(user) {
  if (!user) return false;

  const userId = resolveUserId(user);

  return Boolean(
    user.isSandbox === true ||
      user.isReviewerAccount === true ||
      isAppleReviewUserId(userId) ||
      isAppleReviewEmail(user.email)
  );
}

function assertNotSandboxUser(user, message) {
  if (isSandboxUser(user)) {
    const error = new Error(
      message || "Compte sandbox : appel provider réel interdit."
    );
    error.status = 403;
    error.statusCode = 403;
    error.code = "SANDBOX_REAL_PROVIDER_FORBIDDEN";
    throw error;
  }
}

module.exports = {
  normalizeEmail,
  normalizeId,
  getAppleReviewUserId,
  getAppleReviewEmail,
  isAppleReviewUserId,
  isAppleReviewEmail,
  resolveUserId,
  isSandboxUser,
  assertNotSandboxUser,
};