// src/utils/emailTemplates.js

/**
 * Styles communs pour les emails
 */
const commonStyles = `
  <style>
    body { margin:0; padding:0; background-color:#f4f4f7; font-family:'Helvetica Neue',Arial,sans-serif; color:#333; }
    .wrapper { width:100%; background-color:#f4f4f7; padding:40px 40px; }
    table[role="presentation"] { width:100%; max-width:600px; margin:0 auto; border-radius:20px; overflow:hidden; box-shadow:0 5px 14px rgba(0,0,0,0.1); border-collapse:collapse; }
    .header { display:flex; align-items:center; justify-content:center; background-color:#0D7E58; padding:12px 20px; border-top-left-radius:20px; border-top-right-radius:20px; }
    .header img { display:block; margin-right:30px; height:70px; }
    .header h1 { margin-top: 21; color:#fff; font-size:40px; text-align:center;}
    .card { background:#fff; border-radius:12px; box-shadow:0 2px 8px rgba(0,0,0,0.1); margin:20px 0; padding:15px; }
    td { font-size:20px; line-height: 2; padding:0; }
    .button a { background-color:#0D7E58; color:#fff !important; text-decoration:none; padding:14px 27px; border-radius:4px; font-weight:600; display:inline-block; }
    .notice { background-color:#e8f5e9; border-left:4px solid #43a047; padding:15px; font-size: 18px; color:#2e7d32; margin-bottom:15px; line-height: 0.5; }
    h1 { margin:0; }
    .footer-text { background-color:#f0f4f8; text-align:center; padding:20px; font-size:17px; color:#777; }
    th, td { padding:14px 17px; }
    th { background-color:#f0f4f8; color:#555; font-weight:600; text-align:left;font-size:24px; }
    td.detail { background-color:#fafbfc;font-size:24px; }
  </style>
`;

/**
 * Génère le template table pour un email
 */
function buildTableTemplate({ title, headerLogoUrl, headerTitleHtml, bodyHtml, footerHtml }) {
  return `
  <!DOCTYPE html>
  <html lang="fr">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width,initial-scale=1.0">
    <title>${title}</title>
    ${commonStyles}
  </head>
  <body>
    <div class="wrapper">
      <table role="presentation">
        <tr>
          <td class="header">
            <img src="${headerLogoUrl}" alt="Logo PayNoval" />
            ${headerTitleHtml}
          </td>
        </tr>
        <tr>
          <td style="background:#fff;padding:30px;">
            ${bodyHtml}
          </td>
        </tr>
        <tr>
          <td class="footer-text">${footerHtml}</td>
        </tr>
      </table>
    </div>
  </body>
  </html>
  `;
}

/** Helper: wrapper pour tableau de détails en card */
function detailsTableHtml(rowsHtml) {
  return `
    <div class="card">
      <table role="presentation" style="width:100%;border-collapse:separate;border-spacing:0 8px;">
        ${rowsHtml}
      </table>
    </div>
  `;
}

/**
 * Template pour transaction initiée (expéditeur)
 */
function initiatedSenderTemplate(data) {
  const rows = `
    <tr><th>ID Transaction</th><td class="detail">${data.transactionId}</td></tr>
    <tr><th>Montant</th><td class="detail">${data.amount} ${data.currency}</td></tr>
    <tr><th>Expéditeur</th><td class="detail">${data.senderEmail}</td></tr>
    <tr><th>Destinataire</th><td class="detail">${data.receiverEmail}</td></tr>
    <tr><th>Date</th><td class="detail">${data.date}</td></tr>
  `;
  const bodyHtml = `
    <p style="font-size:26px;margin-bottom:20px;">Bonjour ${data.name || 'utilisateur'},</p>
    <p style="margin-bottom:24px; font-size:24px;line-height: 0.8;">Votre transaction a été initiée avec succès. Les fonds seront débloqués une fois que le destinataire aura validé.</p>
    ${detailsTableHtml(rows)}
    <div style="text-align:center;margin-bottom:30px;" class="button"><a href="${data.confirmLinkWeb}">Voir la transaction</a></div>
    <p style="margin-bottom:25px; font-size:25px;line-height: 0.8;">Vos transactions en attente seront automatiquement annulées au bout de 10 jours.</p>
    <div class="notice">⚠️ Ne partagez jamais vos codes confidentiels ou mots de passe. PayNoval ne vous contactera jamais pour vous les demander.</div>
  `;
  return buildTableTemplate({
    title: 'Transaction en attente',
    headerLogoUrl: 'https://i.imgur.com/vVCYZkM.png',
    headerTitleHtml: '<h1>Transaction en attente</h1>',
    bodyHtml,
    footerHtml: `&copy; ${new Date().getFullYear()} PayNoval. Tous droits réservés.`
  });
}

/**
 * Template pour transaction initiée (destinataire)
 */
function initiatedReceiverTemplate(data) {
  const rows = `
    <tr><th>ID Transaction</th><td class="detail">${data.transactionId}</td></tr>
    <tr><th>Montant</th><td class="detail">${data.amount} ${data.currency}</td></tr>
    <tr><th>Expéditeur</th><td class="detail">${data.senderEmail}</td></tr>
    <tr><th>Date</th><td class="detail">${data.date}</td></tr>
  `;
  const bodyHtml = `
    <p style="font-size:26px;margin-bottom:20px;">Bonjour ${data.name},</p>
    <p style="margin-bottom:25px;font-size:24px;line-height: 0.8;">Vous avez reçu une transaction en attente de validation.</p>
    ${detailsTableHtml(rows)}
    <div style="text-align:center;margin-bottom:30px;" class="button"><a href="${data.confirmLink}">Valider la transaction</a></div>
    <div class="notice">⚠️ PayNoval ne vous demandera jamais de codes confidentiels ou mots de passe par email. Ne partagez rien et signalez toute tentative de fraude.</div>
  `;
  return buildTableTemplate({
    title: 'Validation requise',
    headerLogoUrl: 'https://i.imgur.com/vVCYZkM.png',
    headerTitleHtml: '<h1>Validation requise</h1>',
    bodyHtml,
    footerHtml: `&copy; ${new Date().getFullYear()} PayNoval. Tous droits réservés.`
  });
}

/**
 * Template pour transaction confirmée (expéditeur)
 */
function confirmedSenderTemplate(data) {
  const rows = `
    <tr><th>ID Transaction</th><td class="detail">${data.transactionId}</td></tr>
    <tr><th>Montant</th><td class="detail">${data.amount} ${data.currency}</td></tr>
    <tr><th>Date</th><td class="detail">${data.date}</td></tr>
  `;
  const bodyHtml = `
    <p style="font-size:26px;margin-bottom:20px;">Bonjour ${data.name},</p>
    <p style="margin-bottom:25px; font-size:24px;line-height: 0.8;">Votre transaction a été validée par le destinataire.</p>
    ${detailsTableHtml(rows)}
    <div class="notice">⚠️ Pour votre sécurité, ne communiquez jamais vos données sensibles. En cas de doute, vérifiez auprès de PayNoval.</div>
  `;
  return buildTableTemplate({
    title: 'Transaction confirmée',
    headerLogoUrl: 'https://i.imgur.com/vVCYZkM.png',
    headerTitleHtml: '<h1>Transaction confirmée</h1>',
    bodyHtml,
    footerHtml: `&copy; ${new Date().getFullYear()} PayNoval. Tous droits réservés.`
  });
}

/**
 * Template pour transaction confirmée (destinataire)
 */
function confirmedReceiverTemplate(data) {
  const rows = `
    <tr><th>ID Transaction</th><td class="detail">${data.transactionId}</td></tr>
    <tr><th>Montant</th><td class="detail">${data.amount} ${data.currency}</td></tr>
    <tr><th>Date</th><td class="detail">${data.date}</td></tr>
  `;
  const bodyHtml = `
    <p style="font-size:26px;margin-bottom:20px;">Bonjour ${data.name},</p>
    <p style="margin-bottom:25px; font-size:24px;line-height: 0.8;">Vous avez validé la transaction avec succès.</p>
    ${detailsTableHtml(rows)}
    <div class="notice">⚠️ Soyez vigilant : PayNoval n’enverra jamais de liens non sécurisés. Vérifiez toujours l’URL.</div>
  `;
  return buildTableTemplate({
    title: 'Transaction confirmée',
    headerLogoUrl: 'https://i.imgur.com/vVCYZkM.png',
    headerTitleHtml: '<h1>Transaction confirmée</h1>',
    bodyHtml,
    footerHtml: `&copy; ${new Date().getFullYear()} PayNoval. Tous droits réservés.`
  });
}

/**
 * Template pour transaction annulée (expéditeur)
 */
function cancelledSenderTemplate(data) {
  const rows = `
    <tr><th>ID Transaction</th><td class="detail">${data.transactionId}</td></tr>
    <tr><th>Montant</th><td class="detail">${data.amount} ${data.currency}</td></tr>
    <tr><th>Date</th><td class="detail">${data.date}</td></tr>
  `;
  const bodyHtml = `
    <p style="font-size:26px;margin-bottom:20px;">Bonjour ${data.name},</p>
    <p style="margin-bottom:25px;font-size:24px;line-height: 0.8;">Votre transaction a été annulée${data.reason ? ` : ${data.reason}` : '.'}</p>
    ${detailsTableHtml(rows)}
    <div class="notice">⚠️ Méfiez-vous des faux emails demandant une annulation. Contactez-nous via l’application.</div>
  `;
  return buildTableTemplate({
    title: 'Transaction annulée',
    headerLogoUrl: 'https://i.imgur.com/vVCYZkM.png',
    headerTitleHtml: '<h1>Transaction annulée</h1>',
    bodyHtml,
    footerHtml: `&copy; ${new Date().getFullYear()} PayNoval. Tous droits réservés.`
  });
}


/**
 * Template pour transaction annulée (destinataire)
 */
function cancelledReceiverTemplate(data) {
  const rows = `
    <tr><th>ID Transaction</th><td class="detail">${data.transactionId}</td></tr>
    <tr><th>Montant</th><td class="detail">${data.amount} ${data.currency}</td></tr>
    <tr><th>Date</th><td class="detail">${data.date}</td></tr>
  `;
  const bodyHtml = `
    <p style="font-size:26px;margin-bottom:20px;">Bonjour ${data.name},</p>
    <p style="margin-bottom:25px;font-size:24px;line-height: 0.8;">La transaction a été annulée${data.reason ? ` : ${data.reason}` : '.'}</p>
    ${detailsTableHtml(rows)}
    <div class="notice">⚠️ Ne jamais cliquer sur des liens suspects. Vérifiez toujours l’expéditeur.</div>
  `;
  return buildTableTemplate({
    title: 'Transaction annulée',
    headerLogoUrl: 'https://i.imgur.com/vVCYZkM.png',
    headerTitleHtml: '<h1>Transaction annulée</h1>',
    bodyHtml,
    footerHtml: `&copy; ${new Date().getFullYear()} PayNoval. Tous droits réservés.`
  });
}

module.exports = {
  initiatedSenderTemplate,
  initiatedReceiverTemplate,
  confirmedSenderTemplate,
  confirmedReceiverTemplate,
  cancelledSenderTemplate,
  cancelledReceiverTemplate
};
