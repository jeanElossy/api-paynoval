// src/utils/alert.js
"use strict";

const axios = require("axios");
const sgMail = require("@sendgrid/mail");
const logger = require("../logger");

const ALERT_EMAIL = process.env.FRAUD_ALERT_EMAIL;
const ALERT_WEBHOOK_URL = process.env.FRAUD_ALERT_WEBHOOK_URL;

/* ---------------- TEMPLATE HTML ALERT AML ---------------- */

const AML_EMAIL_TEMPLATE = `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>Alerte AML - PayNoval</title>
  <style>
    :root { color-scheme: light dark; supported-color-schemes: light dark; }
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
    .logo { text-align: center; margin-bottom: 24px; }
    .logo img { width: 120px; height: auto; border-radius: 12px; }
    h2 { color: #0D7E58; margin-bottom: 10px; text-align: center; letter-spacing: 1px; }
    .meta { font-size: 14px; color: #8c98a4; text-align: center; margin-bottom: 24px; }
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
    .footer { text-align: center; font-size: 12px; color: #8c98a4; margin-top: 28px; }
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
    <div class="details">{{details}}</div>
    <div class="footer">
      Ceci est une alerte automatique.<br>
      © PayNoval AML System
    </div>
  </div>
</body>
</html>
`;

// Rendu HTML AML
function renderAmlAlertHtml(payload = {}) {
  const details = JSON.stringify(payload, null, 2);

  const vars = {
    date: new Date().toLocaleString(),
    type: payload.type || "Non spécifié",
    user: payload.user?.email || payload.user?.id || "Inconnu",
    amount: payload.amount ?? "—",
    provider: payload.provider || "—",
    flagReason: payload.flagReason || payload.reason || "—",
    details,
  };

  return AML_EMAIL_TEMPLATE.replace(/{{(\w+)}}/g, (_, k) => {
    const v = vars[k];
    return v === undefined || v === null ? "" : String(v);
  });
}

/* ---------------- Transport e-mail — SENDGRID ---------------- */

/**
 * ⚠️ LA VOIE SMTP A ÉTÉ RETIRÉE LE 2026-09-02, ET CE N'ÉTAIT PAS DU MÉNAGE.
 *
 * Ce fichier construisait un transport `nodemailer` à partir de `SMTP_HOST`,
 * `SMTP_USER` et `SMTP_PASS`. **PayNoval n'envoie pas par SMTP** — la
 * production envoie par SendGrid (`utils/sendEmail.js` du backend principal a
 * déjà retiré sa voie SMTP pour la même raison). Ces variables n'existent donc
 * pas en production.
 *
 * Conséquence, jusqu'à aujourd'hui : `getSmtpTransport()` ne les trouvait pas,
 * journalisait un `warn` et rendait `null` — et **l'alerte de fraude AML ne
 * partait jamais par e-mail**. Le seul canal qui fonctionnait était le webhook,
 * s'il était configuré. Une alerte de conformité qui ne part pas est pire
 * qu'une absence d'alerte : on croit être averti.
 *
 * ⚠️ NE PAS REMETTRE DE VOIE SMTP ICI. Si un jour un second fournisseur est
 * nécessaire, il se choisit explicitement par variable d'environnement, avec un
 * démarrage qui ANNONCE lequel est actif — jamais par un repli silencieux.
 */
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || "";
const ALERT_FROM =
  process.env.ALERT_EMAIL_FROM ||
  process.env.SENDGRID_FROM ||
  process.env.EMAIL_FROM ||
  "";

let sendgridPret = false;

function preparerSendGrid() {
  if (sendgridPret) return true;

  if (!SENDGRID_API_KEY || !ALERT_FROM) {
    /**
     * B.6 : on dit la CONSÉQUENCE, pas seulement le manque. Une ligne
     * « SENDGRID_API_KEY absente » sans sa conséquence se lit comme un détail
     * de configuration ; celle-ci se lit comme ce qu'elle est.
     */
    logger.error(
      "[AML-FRAUD-ALERT][email] SENDGRID_API_KEY ou expéditeur absent — " +
        "AUCUNE alerte de fraude ne partira par e-mail. Seul le webhook, s'il " +
        "est configuré, reste. Renseigner SENDGRID_API_KEY et ALERT_EMAIL_FROM."
    );

    return false;
  }

  sgMail.setApiKey(SENDGRID_API_KEY);
  sendgridPret = true;

  return true;
}

/* ---------------- ALERTE ENVOI ---------------- */

async function sendFraudAlert(payload = {}) {
  // Toujours log en erreur (c'est une alerte)
  logger.error("[AML-FRAUD-ALERT]", { payload });

  // Webhook (Slack/Teams/Discord/SIEM/etc)
  if (ALERT_WEBHOOK_URL) {
    try {
      await axios.post(ALERT_WEBHOOK_URL, payload, { timeout: 5000 });
      logger.info("[AML-FRAUD-ALERT][webhook] sent");
    } catch (e) {
      logger.error("[AML-FRAUD-ALERT][webhook] fail", {
        message: e.message,
        code: e.code,
        status: e.response?.status,
        data: e.response?.data,
      });
    }
  }

  // Email (admin/compliance)
  if (ALERT_EMAIL) {
    try {
      if (!preparerSendGrid()) return;

      await sgMail.send({
        from: { email: ALERT_FROM, name: "PayNoval AML" },
        to: ALERT_EMAIL,
        subject: "[PayNoval AML ALERT] Transaction Suspect",
        html: renderAmlAlertHtml(payload),
        text: [
          "Alerte AML PayNoval",
          "",
          `Résumé : ${payload.type || "Non spécifié"}`,
          `Utilisateur : ${payload.user ? payload.user.email || payload.user.id : "Non spécifié"}`,
          "Détails :",
          JSON.stringify(payload, null, 2),
        ].join("\n"),
      });

      logger.info("[AML-FRAUD-ALERT][email] sent", { to: ALERT_EMAIL });
    } catch (e) {
      logger.error("[AML-FRAUD-ALERT][email] fail", {
        message: e.message,
        code: e.code,
      });
    }
  }
}

module.exports = { sendFraudAlert, renderAmlAlertHtml };
