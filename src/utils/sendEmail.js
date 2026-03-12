// File: api-gateway/src/utils/sendEmail.js
'use strict';

const sgMail = require('@sendgrid/mail');

const {
  EMAIL_PROVIDER = 'sendgrid',
  SENDGRID_API_KEY,
  MAIL_FROM = 'no-reply@paynoval.com',
  EMAIL_FROM_NAME = 'PayNoval Services',
} = process.env;

if (EMAIL_PROVIDER === 'sendgrid') {
  if (!SENDGRID_API_KEY) {
    console.warn(
      '[Tx-core][sendEmail] SENDGRID_API_KEY manquant. Les emails ne pourront pas être envoyés.'
    );
  } else {
    sgMail.setApiKey(SENDGRID_API_KEY);
  }
}

/**
 * Envoie un email via SendGrid.
 *
 * @param {Object} params
 * @param {string|string[]} params.to
 * @param {string}          params.subject
 * @param {string} [params.html]
 * @param {string} [params.text]
 */
async function sendEmail({ to, subject, html, text }) {
  if (!to || !subject) {
    console.warn('[Tx-core][sendEmail] "to" ou "subject" manquant, email ignoré.');
    return;
  }

  if (EMAIL_PROVIDER !== 'sendgrid') {
    console.warn('[Tx-core][sendEmail] EMAIL_PROVIDER != sendgrid, email ignoré.');
    return;
  }

  if (!SENDGRID_API_KEY) {
    console.warn('[Tx-core][sendEmail] SENDGRID_API_KEY manquant, email ignoré.');
    return;
  }

  const msg = {
    to,
    from: {
      email: MAIL_FROM,
      name: EMAIL_FROM_NAME,
    },
    subject,
    text: text || 'Notification PayNoval',
    html: html || `<p>${text || 'Notification PayNoval'}</p>`,
  };

  try {
    const [resp] = await sgMail.send(msg);
    console.log(
      `✅ [Tx-core][sendEmail] Email envoyé à ${
        Array.isArray(to) ? to.join(', ') : to
      } — status ${resp.statusCode}`
    );
    return resp;
  } catch (err) {
    console.error(
      `❌ [Tx-core][sendEmail] Échec envoi email à ${
        Array.isArray(to) ? to.join(', ') : to
      }:`,
      err.response?.body || err.message || err
    );
    // NE PAS throw pour ne pas casser les flux appelants
  }
}

module.exports = {
  sendEmail,
};
