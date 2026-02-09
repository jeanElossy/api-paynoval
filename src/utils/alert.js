const axios = require('axios');
const nodemailer = require('nodemailer');
const logger = require('../logger');

const ALERT_EMAIL = process.env.FRAUD_ALERT_EMAIL;
const ALERT_WEBHOOK_URL = process.env.FRAUD_ALERT_WEBHOOK_URL;

// -------- TEMPLATE HTML ALERT AML --------

const AML_EMAIL_TEMPLATE = `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>Alerte AML - PayNoval</title>
  <style>
    :root {
      color-scheme: light dark;
      supported-color-schemes: light dark;
    }
    body {
      font-family: 'Segoe UI', 'Roboto', Arial, sans-serif;
      background: #f5f6fa;
      color: #222;
      margin: 0;
      padding: 0;
      -webkit-font-smoothing: antialiased;
    }
    .container {
      background: #fff;
      max-width: 480px;
      margin: 40px auto;
      border-radius: 14px;
      box-shadow: 0 6px 24px rgba(32,45,90,0.07);
      padding: 32px 24px;
      border-top: 8px solid #0D7E58;
    }
    .logo {
      text-align: center;
      margin-bottom: 24px;
    }
    .logo img {
      width: 120px;
      height: auto;
      border-radius: 12px;
    }
    h2 {
      color: #0D7E58;
      margin-bottom: 10px;
      text-align: center;
      letter-spacing: 1px;
    }
    .meta {
      font-size: 14px;
      color: #8c98a4;
      text-align: center;
      margin-bottom: 24px;
    }
    .summary {
      background: #e6f5ee;
      border-left: 4px solid #0D7E58;
      padding: 12px 16px;
      border-radius: 6px;
      margin-bottom: 22px;
      font-size: 15px;
      line-height: 1.6;
      color: #124d38;
    }
    .details {
      font-family: 'Fira Mono', 'Menlo', 'Consolas', monospace;
      font-size: 13px;
      background: #f4faf7;
      border-radius: 8px;
      padding: 16px;
      margin: 18px 0 12px 0;
      color: #124d38;
      white-space: pre-wrap;
      word-break: break-all;
      border: 1px solid #e0eee8;
    }
    .footer {
      text-align: center;
      font-size: 12px;
      color: #8c98a4;
      margin-top: 28px;
    }
    @media (prefers-color-scheme: dark) {
      body { background: #171c23; color: #eceff4;}
      .container { background: #232b3a; box-shadow: 0 8px 32px rgba(10,16,42,0.24); border-top: 8px solid #0D7E58;}
      h2 { color: #53e6ad;}
      .summary { background: #183f2f; color: #53e6ad; border-left: 4px solid #0D7E58;}
      .details { background: #1c2b23; color: #a3f9ce; border: 1px solid #265646;}
      .footer { color: #616e8c;}
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">
      <img src="https://i.imgur.com/OZ6YQhC.png" alt="PayNoval Logo"/>
    </div>
    <h2>🚨 Alerte AML</h2>
    <div class="meta">
      <strong>PayNoval Compliance Monitor</strong><br>
      <span>{{date}}</span>
    </div>
    <div class="summary">
      <b>Type :</b> {{type}}<br>
      <b>Utilisateur :</b> {{user}}<br>
      <b>Montant :</b> {{amount}}<br>
      <b>Provider :</b> {{provider}}<br>
      <b>Flag :</b> {{flagReason}}
    </div>
    <div class="details">
      {{details}}
    </div>
    <div class="footer">
      Ceci est une alerte automatique.<br>
      © PayNoval AML System
    </div>
  </div>
</body>
</html>

`;

// Fonction utilitaire pour rendre le HTML email AML
function renderAmlAlertHtml(payload) {
  const details = JSON.stringify(payload, null, 2);

  const vars = {
    date: new Date().toLocaleString(),
    type: payload.type || 'Non spécifié',
    user: payload.user?.email || payload.user?.id || 'Inconnu',
    amount: payload.amount || '—',
    provider: payload.provider || '—',
    flagReason: payload.flagReason || payload.reason || '—',
    details,
  };
  // Simple remplacement {{var}}
  return AML_EMAIL_TEMPLATE.replace(/{{(\w+)}}/g, (_, k) => vars[k] || '');
}

// -------- ALERTE ENVOI --------

async function sendFraudAlert(payload) {
  logger.error('[AML-FRAUD-ALERT]', payload);

  // Webhook (Slack/Teams/Discord/SIEM/etc)
  if (ALERT_WEBHOOK_URL) {
    try {
      await axios.post(ALERT_WEBHOOK_URL, payload, { timeout: 5000 });
    } catch (e) {
      logger.error('[AML-FRAUD-ALERT][webhook] Fail', e);
    }
  }

  // Email (admin/compliance)
  if (ALERT_EMAIL) {
    try {
      const transport = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT, 10) || 587,
        secure: parseInt(process.env.SMTP_PORT, 10) === 465,
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS
        }
      });

      await transport.sendMail({
        from: `"PayNoval AML" <${process.env.SMTP_USER}>`,
        to: ALERT_EMAIL,
        subject: `[PayNoval AML ALERT] Transaction Suspect`,
        html: renderAmlAlertHtml(payload),
        text: [
          `Alerte AML PayNoval\n\n`,
          `Résumé : ${payload.type || 'Non spécifié'}`,
          `Utilisateur : ${payload.user ? (payload.user.email || payload.user.id) : 'Non spécifié'}`,
          `Détails :\n${JSON.stringify(payload, null, 2)}`
        ].join('\n'),
      });
    } catch (e) {
      logger.error('[AML-FRAUD-ALERT][email] Fail', e);
    }
  }
}

module.exports = { sendFraudAlert };
