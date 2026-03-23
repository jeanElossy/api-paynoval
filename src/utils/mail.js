// src/utils/mail.js
const nodemailer = require('nodemailer');
const config = require('../config');
const {
  initiatedSenderTemplate: initiatedTemplate,
  confirmedSenderTemplate: confirmedTemplate,
  cancelledSenderTemplate: cancelledTemplate
} = require('./emailTemplates');

// Configuration du transporteur SMTP
const transporter = nodemailer.createTransport({
  host: config.email.host,
  port: config.email.port,
  secure: config.email.secure,
  auth: {
    user: config.email.auth.user,
    pass: config.email.auth.pass,
  },
  // Ajoutez ici d'autres options si besoin (TLS, timeouts, etc.)
});

/**
 * Envoie un email via le transporteur configuré.
 * Accepte texte brut ou HTML selon les paramètres fournis.
 * @param {Object} options
 * @param {string} options.to - Destinataire
 * @param {string} options.subject - Sujet du mail
 * @param {string} [options.text] - Contenu en texte brut
 * @param {string} [options.html] - Contenu HTML
 */
exports.sendEmail = async ({ to, subject, text, html }) => {
  try {
    // Si on n'a pas de HTML explicite, on peut générer un template selon le sujet
    let contentHtml = html;
    if (!contentHtml) {
      const now = new Date().toLocaleString('fr-FR');
      // Choix du template en fonction du sujet
      if (/en attente/i.test(subject) || /initiée/i.test(subject)) {
        contentHtml = initiatedTemplate({
          transactionId: '', // à compléter lors de l'appel
          amount: '',
          senderEmail: '',
          receiverEmail: '',
          date: now
        });
      } else if (/confirmée/i.test(subject)) {
        contentHtml = confirmedTemplate({
          transactionId: '',
          amount: '',
          senderEmail: '',
          receiverEmail: '',
          date: now
        });
      } else if (/annulée/i.test(subject)) {
        contentHtml = cancelledTemplate({
          transactionId: '',
          amount: '',
          senderEmail: '',
          receiverEmail: '',
          date: now,
          reason: ''
        });
      }
    }

    const mailOptions = {
      from: config.email.auth.user,
      to,
      subject,
      ...(text && { text }),
      ...(contentHtml && { html: contentHtml })
    };

    const info = await transporter.sendMail(mailOptions);
    console.log(`✅ Email envoyé à ${to} (ID: ${info.messageId})`);
    return info;
  } catch (err) {
    console.error(`❌ Échec envoi email à ${to} :`, err);
    throw err;
  }
};
