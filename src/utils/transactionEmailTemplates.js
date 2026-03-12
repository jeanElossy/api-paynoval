// File: api-gateway/src/utils/transactionEmailTemplates.js
'use strict';

// --- Brand / URLs (alignés avec notificationHelpers.js) ---

const BRAND_PRIMARY = '#0d7e58';
const BRAND_BG      = '#f5f7fb';
const TEXT_DARK     = '#1f2933';
const TEXT_MUTED    = '#6b7280';

const LOGO_TOP_URL =
  'https://res.cloudinary.com/dbrqr0x6y/image/upload/v1763991998/defaultAvatarIcon_z7ibmh.png';

const LOGO_FOOTER_URL =
  'https://res.cloudinary.com/dbrqr0x6y/image/upload/v1763992135/defaultAvatar_cexeye.jpg';

// on utilise FRONTEND_URL si définie, sinon fallback site public
const WEBSITE_URL =
  process.env.FRONTEND_URL ||
  process.env.FRONT_URL ||
  'https://www.paynoval.com';

const FB_URL      = 'https://www.facebook.com/share/18TcDSZ2ww/?mibextid=wwXIfr';
const IG_URL      = 'https://www.instagram.com/paynoval_inc?igsh=YWc1c2owbnA1Nm96&utm_source=qr';
const TIKTOK_URL  = 'https://www.tiktok.com/@paynoval_inc';
const YT_URL      = 'https://www.youtube.com/@PayNovalInc';
const X_URL       = 'https://x.com/paynoval_inc?s=21&t=I9RXFXla5NVDnmMTf2x2xg';

const ICON_FB     = 'https://cdn-icons-png.flaticon.com/512/733/733547.png';
const ICON_IG     = 'https://cdn-icons-png.flaticon.com/512/2111/2111463.png';
const ICON_TIKTOK = 'https://cdn-icons-png.flaticon.com/512/3046/3046126.png';
const ICON_YT     = 'https://cdn-icons-png.flaticon.com/512/3670/3670147.png';
const ICON_X      = 'https://cdn-icons-png.flaticon.com/512/733/733579.png';

const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'support@paynoval.com';

// --- Header / Footer ---

function renderMailHeader({ label, title, variant = 'green' }) {
  const bg =
    variant === 'red'
      ? '#b91c1c'
      : 'linear-gradient(135deg,#0d7e58,#26b17b)';

  return `
    <div style="background:${bg};padding:22px 26px 18px 26px;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
        <tr>
          <td style="width:56px;vertical-align:middle;">
            <div style="width:48px;height:48px;border-radius:999px;background:#ffffff;display:inline-block;text-align:center;">
              <img src="${LOGO_TOP_URL}" alt="PayNoval" width="28" height="28" style="margin-top:10px;display:inline-block;" />
            </div>
          </td>
          <td style="vertical-align:middle;padding-left:10px;">
            ${
              label
                ? `<p style="margin:0 0 2px 0;font-size:11px;color:#e0f2f1;letter-spacing:0.08em;text-transform:uppercase;">${label}</p>`
                : ''
            }
            <h1 style="margin:0;font-size:20px;line-height:1.4;color:#ffffff;font-weight:700;">
              ${title || 'PayNoval'}
            </h1>
          </td>
        </tr>
      </table>
    </div>
  `;
}

function renderMailFooter(reason) {
  const safeReason =
    reason ||
    'Vous recevez ce message car vous utilisez les services PayNoval.';

  return `
    <div style="padding:18px 20px 22px 20px;background:#f9fafb;border-top:1px solid #e5e7eb;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
        <tr>
          <td align="center" style="padding-bottom:4px;">
            <a href="${WEBSITE_URL}" style="text-decoration:none;color:#0D7E58;font-size:13px;font-weight:600;">
              www.paynoval.com
            </a>
          </td>
        </tr>
        <tr>
          <td align="center" style="padding-bottom:4px;">
            <img src="${LOGO_FOOTER_URL}" alt="PayNoval" style="max-width:120px;height:auto;display:block;margin:0 auto 4px auto;" />
          </td>
        </tr>
        <tr>
          <td align="center" style="padding-bottom:8px;">
            <p style="margin:0;font-size:11px;color:#9ca3af;line-height:1.4;">
              &copy; ${new Date().getFullYear()} PayNoval • Tous droits réservés.<br/>
              Support :
              <a href="mailto:${SUPPORT_EMAIL}" style="color:#0D7E58;text-decoration:underline;">
                ${SUPPORT_EMAIL}
              </a>
            </p>
          </td>
        </tr>
        <tr>
          <td align="center" style="padding-bottom:6px;">
            <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="font-size:0;">
              <tr>
                <td style="padding:0 4px;">
                  <a href="${FB_URL}">
                    <img src="${ICON_FB}" alt="Facebook" width="22" height="22" style="display:block;border-radius:999px;" />
                  </a>
                </td>
                <td style="padding:0 4px;">
                  <a href="${IG_URL}">
                    <img src="${ICON_IG}" alt="Instagram" width="22" height="22" style="display:block;border-radius:999px;" />
                  </a>
                </td>
                <td style="padding:0 4px;">
                  <a href="${TIKTOK_URL}">
                    <img src="${ICON_TIKTOK}" alt="TikTok" width="22" height="22" style="display:block;border-radius:999px;" />
                  </a>
                </td>
                <td style="padding:0 4px;">
                  <a href="${YT_URL}">
                    <img src="${ICON_YT}" alt="YouTube" width="22" height="22" style="display:block;border-radius:999px;" />
                  </a>
                </td>
                <td style="padding:0 4px;">
                  <a href="${X_URL}">
                    <img src="${ICON_X}" alt="X" width="22" height="22" style="display:block;border-radius:999px;" />
                  </a>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td align="center">
            <p style="margin:0;font-size:10px;color:#9ca3af;line-height:1.4;">
              ${safeReason}
            </p>
          </td>
        </tr>
      </table>
    </div>
  `;
}

function wrapTransactionEmail({ title, label, bodyHtml, footerReason }) {
  return `
  <html>
    <body style="background-color:${BRAND_BG};margin:0;padding:0;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:${BRAND_BG};padding:24px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
        <tr>
          <td align="center">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:560px;background-color:#ffffff;border-radius:18px;overflow:hidden;box-shadow:0 14px 35px rgba(15,23,42,0.10);">
              <tr>
                <td>
                  ${renderMailHeader({ label, title })}
                </td>
              </tr>
              <tr>
                <td style="padding:22px 24px 18px 24px;">
                  ${bodyHtml}
                </td>
              </tr>
              <tr>
                <td>
                  ${renderMailFooter(footerReason)}
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </body>
  </html>
  `;
}

function detailsTable(rowsHtml) {
  return `
    <div style="margin:16px 0 0 0;">
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="border-radius:10px;border:1px solid #e5e7eb;background:#f9fafb;">
        ${rowsHtml}
      </table>
    </div>
  `;
}

function detailsRow(label, value) {
  return `
    <tr>
      <td style="padding:6px 10px;font-size:13px;color:${TEXT_MUTED};">${label}</td>
      <td style="padding:6px 10px;font-size:13px;color:${TEXT_DARK};text-align:right;font-weight:500;">${value}</td>
    </tr>
  `;
}

// ----------------- Templates transactionnels -----------------

function initiatedSenderTemplate(data) {
  const rows = [
    detailsRow('ID Transaction & Référence', `${data.transactionId} ${data.reference || ''}`),
    detailsRow('Montant', `${data.amount} ${data.currency}`),
    detailsRow('Expéditeur', data.senderEmail),
    detailsRow('Destinataire', data.receiverEmail),
    detailsRow('Date', data.date),
  ].join('');

  const body = `
    <p style="margin:0 0 12px 0;font-size:14px;color:${TEXT_DARK};">
      Bonjour <strong>${data.name}</strong>,
    </p>
    <p style="margin:0 0 16px 0;font-size:14px;color:${TEXT_DARK};line-height:1.6;">
      Votre transaction a été <strong>initiée avec succès</strong>. Les fonds seront débloqués une fois que le destinataire aura validé l’opération.
    </p>

    ${detailsTable(rows)}

    ${
      data.confirmLinkWeb
        ? `<p style="margin:18px 0 0 0;text-align:center;">
             <a href="${data.confirmLinkWeb}" style="display:inline-block;background:${BRAND_PRIMARY};color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:999px;font-size:14px;font-weight:600;">
               Voir la transaction
             </a>
           </p>`
        : ''
    }

    <p style="margin:16px 0 0 0;font-size:13px;color:${TEXT_MUTED};line-height:1.6;">
      Vos transactions en attente seront automatiquement <strong>annulées au bout de 10 jours</strong> si elles ne sont pas validées.
    </p>

    <div style="margin:16px 0 0 0;background:#ecfdf5;border-left:4px solid #16a34a;padding:10px 12px;font-size:12px;color:#166534;line-height:1.6;">
      ⚠️ Ne partagez jamais vos codes confidentiels ou mots de passe. PayNoval ne vous demandera jamais de les communiquer par email, SMS ou téléphone.
    </div>
  `;

  return wrapTransactionEmail({
    title: 'Transaction en attente',
    label: 'Transaction',
    bodyHtml: body,
    footerReason:
      "Vous recevez ce message car vous avez initié une transaction via PayNoval.",
  });
}

function initiatedReceiverTemplate(data) {
  const rows = [
    detailsRow('ID Transaction', data.transactionId),
    detailsRow('Montant', `${data.amount} ${data.currency}`),
    detailsRow('Expéditeur', data.senderEmail),
    detailsRow('Date', data.date),
  ].join('');

  const body = `
    <p style="margin:0 0 12px 0;font-size:14px;color:${TEXT_DARK};">
      Bonjour <strong>${data.name}</strong>,
    </p>
    <p style="margin:0 0 16px 0;font-size:14px;color:${TEXT_DARK};line-height:1.6;">
      Vous avez reçu une transaction en attente de <strong>votre validation</strong>.
    </p>

    ${detailsTable(rows)}

    ${
      data.confirmLink
        ? `<p style="margin:18px 0 0 0;text-align:center;">
             <a href="${data.confirmLink}" style="display:inline-block;background:${BRAND_PRIMARY};color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:999px;font-size:14px;font-weight:600;">
               Valider la transaction
             </a>
           </p>`
        : ''
    }

    <div style="margin:16px 0 0 0;background:#fef3c7;border-left:4px solid #f59e0b;padding:10px 12px;font-size:12px;color:#92400e;line-height:1.6;">
      ⚠️ PayNoval ne vous demandera jamais de partager des codes ou mots de passe par email. En cas de doute, contactez le support depuis l’application.
    </div>
  `;

  return wrapTransactionEmail({
    title: 'Validation requise',
    label: 'Transaction',
    bodyHtml: body,
    footerReason:
      "Vous recevez ce message car une transaction PayNoval requiert votre validation.",
  });
}

function confirmedSenderTemplate(data) {
  const rows = [
    detailsRow('ID Transaction', data.transactionId),
    detailsRow('Montant', `${data.amount} ${data.currency}`),
    detailsRow('Destinataire', data.receiverEmail),
    detailsRow('Date', data.date),
  ].join('');

  const body = `
    <p style="margin:0 0 12px 0;font-size:14px;color:${TEXT_DARK};">
      Bonjour <strong>${data.name}</strong>,
    </p>
    <p style="margin:0 0 16px 0;font-size:14px;color:${TEXT_DARK};line-height:1.6;">
      Nous vous confirmons que votre transaction a été <strong>validée avec succès</strong>.
    </p>

    ${detailsTable(rows)}

    <p style="margin:16px 0 0 0;font-size:13px;color:${TEXT_MUTED};line-height:1.6;">
      Merci d’avoir choisi PayNoval pour vos transferts sécurisés.
    </p>

    <div style="margin:16px 0 0 0;background:#ecfdf5;border-left:4px solid #16a34a;padding:10px 12px;font-size:12px;color:#166534;line-height:1.6;">
      ⚠️ Restez vigilant&nbsp;: vérifiez toujours l’adresse officielle de PayNoval avant de saisir vos identifiants.
    </div>
  `;

  return wrapTransactionEmail({
    title: 'Transaction confirmée',
    label: 'Transaction',
    bodyHtml: body,
    footerReason:
      "Vous recevez ce message car une transaction PayNoval a été confirmée.",
  });
}

function confirmedReceiverTemplate(data) {
  const rows = [
    detailsRow('ID Transaction & Référence', `${data.transactionId} ${data.reference || ''}`),
    detailsRow('Montant', `${data.amount} ${data.currency}`),
    detailsRow('Date', data.date),
  ].join('');

  const body = `
    <p style="margin:0 0 12px 0;font-size:14px;color:${TEXT_DARK};">
      Cher(e) <strong>${data.name}</strong>,
    </p>
    <p style="margin:0 0 16px 0;font-size:14px;color:${TEXT_DARK};line-height:1.6;">
      Votre transaction a été <strong>validée avec succès</strong>. Merci pour votre confiance.
    </p>

    ${detailsTable(rows)}

    <div style="margin:16px 0 0 0;background:#fef3c7;border-left:4px solid #f59e0b;padding:10px 12px;font-size:12px;color:#92400e;line-height:1.6;">
      ⚠️ PayNoval n’enverra jamais de liens non sécurisés pour vous demander des paiements ou codes de validation. Vérifiez toujours l’URL de votre navigateur.
    </div>
  `;

  return wrapTransactionEmail({
    title: 'Transaction confirmée',
    label: 'Transaction',
    bodyHtml: body,
    footerReason:
      "Vous recevez ce message car une transaction PayNoval à votre destination a été confirmée.",
  });
}

function cancelledSenderTemplate(data) {
  const rows = [
    detailsRow('ID Transaction', data.transactionId),
    detailsRow('Montant', `${data.amount} ${data.currency}`),
    detailsRow('Date', data.date),
  ].join('');

  const reasonText = data.reason ? ` : ${data.reason}` : '.';

  const body = `
    <p style="margin:0 0 12px 0;font-size:14px;color:${TEXT_DARK};">
      Bonjour <strong>${data.name}</strong>,
    </p>
    <p style="margin:0 0 16px 0;font-size:14px;color:${TEXT_DARK};line-height:1.6;">
      Votre transaction a été <strong>annulée</strong>${reasonText}
    </p>

    ${detailsTable(rows)}

    <div style="margin:16px 0 0 0;background:#fee2e2;border-left:4px solid #ef4444;padding:10px 12px;font-size:12px;color:#b91c1c;line-height:1.6;">
      ⚠️ Si vous n’êtes pas à l’origine de cette opération, connectez-vous à votre compte PayNoval et contactez immédiatement le support.
    </div>
  `;

  return wrapTransactionEmail({
    title: 'Transaction annulée',
    label: 'Transaction',
    bodyHtml: body,
    footerReason:
      "Vous recevez ce message car une transaction PayNoval que vous avez initiée a été annulée.",
  });
}

function cancelledReceiverTemplate(data) {
  const rows = [
    detailsRow('ID Transaction', data.transactionId),
    detailsRow('Montant', `${data.amount} ${data.currency}`),
    detailsRow('Date', data.date),
  ].join('');

  const reasonText = data.reason ? ` : ${data.reason}` : '.';

  const body = `
    <p style="margin:0 0 12px 0;font-size:14px;color:${TEXT_DARK};">
      Bonjour <strong>${data.name}</strong>,
    </p>
    <p style="margin:0 0 16px 0;font-size:14px;color:${TEXT_DARK};line-height:1.6;">
      La transaction à votre destination a été <strong>annulée</strong>${reasonText}
    </p>

    ${detailsTable(rows)}

    <div style="margin:16px 0 0 0;background:#fef3c7;border-left:4px solid #f59e0b;padding:10px 12px;font-size:12px;color:#92400e;line-height:1.6;">
      ⚠️ Ne cliquez jamais sur des liens suspects parlant de “récupérer” une transaction annulée. Utilisez uniquement les canaux officiels PayNoval.
    </div>
  `;

  return wrapTransactionEmail({
    title: 'Transaction annulée',
    label: 'Transaction',
    bodyHtml: body,
    footerReason:
      "Vous recevez ce message car une transaction PayNoval à votre destination a été annulée.",
  });
}

module.exports = {
  initiatedSenderTemplate,
  initiatedReceiverTemplate,
  confirmedSenderTemplate,
  confirmedReceiverTemplate,
  cancelledSenderTemplate,
  cancelledReceiverTemplate,
};
