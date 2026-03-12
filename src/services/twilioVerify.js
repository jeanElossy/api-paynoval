
// File: services/twilioVerify.js
'use strict';

const twilio = require('twilio');

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || process.env.TWILIO_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_VERIFY_SERVICE_SID = process.env.TWILIO_VERIFY_SERVICE_SID;

if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_VERIFY_SERVICE_SID) {
  console.warn(
    '[TwilioVerify] Variables d’environnement manquantes. Vérifie TWILIO_ACCOUNT_SID (ou TWILIO_SID), TWILIO_AUTH_TOKEN, TWILIO_VERIFY_SERVICE_SID.'
  );
}

const client =
  TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN
    ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
    : null;

function assertConfigured() {
  if (!client || !TWILIO_VERIFY_SERVICE_SID) {
    throw new Error('Twilio Verify non configuré côté serveur');
  }
}

/**
 * Démarre l’envoi d’un OTP sur le numéro (SMS par défaut).
 * channel: 'sms' | 'whatsapp' | 'call' | 'email'
 */
async function startPhoneVerification(phone, channel = 'sms') {
  assertConfigured();

  if (!phone || typeof phone !== 'string' || !phone.startsWith('+')) {
    throw new Error('phone doit être au format E.164, ex: +2250700000001');
  }

  const verification = await client.verify.v2
    .services(TWILIO_VERIFY_SERVICE_SID)
    .verifications.create({ to: phone, channel });

  return verification;
}

/**
 * Vérifie le code saisi par l’utilisateur
 */
async function checkPhoneVerification(phone, code) {
  assertConfigured();

  if (!phone || typeof phone !== 'string' || !phone.startsWith('+')) {
    throw new Error('phone doit être au format E.164');
  }
  if (!code) throw new Error('code requis');

  const verificationCheck = await client.verify.v2
    .services(TWILIO_VERIFY_SERVICE_SID)
    .verificationChecks.create({ to: phone, code });

  return verificationCheck;
}

module.exports = {
  startPhoneVerification,
  checkPhoneVerification,
};
