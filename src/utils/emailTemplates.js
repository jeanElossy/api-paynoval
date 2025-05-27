// // src/utils/emailTemplates.js

// /**
//  * Styles communs pour les emails
//  */
// const commonStyles = `
//   <style>
//     body { margin:0; padding:0; background-color:#f4f4f7; font-family: 'Helvetica Neue', Arial, sans-serif; color:#333; }
//     .wrapper { width:100%; table-layout:fixed; background-color:#f4f4f7; padding: 40px 0; border-radius: 5px; }
//     .container {
//       background-color:#fff;
//       width:90%; max-width:600px;
//       margin:0 auto;
//       border-radius:20px;
//       overflow:hidden;
//       box-shadow:0 5px 14px rgba(0,0,0,0.1);
//       /* Empêche la séparation du conteneur en plusieurs blocs */
//       page-break-inside: avoid;
//       -webkit-column-break-inside: avoid;
//       -moz-column-break-inside: avoid;
//     }
//     .header, .content, .footer {
//       /* Empêche la séparation des sections en plusieurs blocs */
//       page-break-inside: avoid;
//       -webkit-column-break-inside: avoid;
//       -moz-column-break-inside: avoid;
//     }
//     .header {
//       background-color:#0D7E58;
//       display:flex;
//       align-items:center;
//       justify-content:center;
//       padding:20px;
//     }
//     .logo {
//       height:50px;
//       margin:0 30px 0 0;
//     }
//     .header h1 {
//       margin:0;
//       color:#fff;
//       font-size:25px;
//       margin-top:13px;
//     }
//     .content { padding: 30px; }
//     .greeting { font-size:18px; margin-bottom:20px; }
//     .message { font-size:16px; line-height:1.5; margin-bottom:25px; }
//     .details { width:100%; margin-bottom:30px; border-collapse:separate; border-spacing:0 8px; }
//     .details th, .details td { padding:12px 15px; text-align:left; }
//     .details th { background-color:#f0f4f8; color:#555; font-weight:600; border-radius:4px 0 0 4px; }
//     .details td { background-color:#fafbfc; border-radius:0 4px 4px 0; }
//     .button-wrap { text-align:center; margin-bottom:30px; }
//     .button, .button a { background-color:#0D7E58; color:#fff !important; text-decoration:none; padding:12px 25px; border-radius:4px; font-weight:600; display:inline-block; }
//     a { color:#0D7E58; text-decoration:none; }
//     .notice { background-color:#e8f5e9; border-left:4px solid #43a047; padding:15px; margin-bottom:30px; font-size:14px; color:#2e7d32; }
//     .footer { background-color:#f0f4f8; text-align:center; padding:20px; font-size:12px; color:#777; }
//   </style>
// `;

// /**
//  * Template pour l'expéditeur lors d'une transaction initiée
//  */
// function initiatedSenderTemplate({ amount, currency, name, transactionId, date, senderEmail, receiverEmail, confirmLinkWeb }) {
//   return `
//   <!DOCTYPE html>
//   <html lang="fr">
//   <head>
//     <meta charset="UTF-8">
//     <meta name="viewport" content="width=device-width, initial-scale=1.0">
//     <title>Transaction en attente</title>
//     ${commonStyles}
//   </head>
//   <body>
//     <div class="wrapper">
//       <div class="container">
//         <div class="header">
//           <img src="https://i.imgur.com/vVCYZkM.png" alt="PayNoval Logo" class="logo" />
//           <h1>Transaction en attente</h1>
//         </div>
//         <div class="content">
//           <p class="greeting">Bonjour ${name || 'utilisateur'},</p>
//           <p class="message">Votre transaction a été initiée avec succès. Les fonds seront débloqués une fois que le destinataire aura validé.</p>
//           <table class="details">
//             <tr><th>ID Transaction</th><td>${transactionId}</td></tr>
//             <tr><th>Montant</th><td>${amount} ${currency}</td></tr>
//             <tr><th>Expéditeur</th><td>${senderEmail}</td></tr>
//             <tr><th>Destinataire</th><td>${receiverEmail}</td></tr>
//             <tr><th>Date</th><td>${date}</td></tr>
//           </table>
//           <div class="button-wrap"><a href="${confirmLinkWeb}" class="button">Voir la transaction</a></div>
//           <p class="message">Vos transactions en attente seront automatiquement annulées au bout de 10 jours.</p>
//           <div class="notice">⚠️ Ne partagez jamais vos codes confidentiels ou mots de passe. PayNoval ne vous contactera jamais pour vous les demander. En cas de doute, contactez notre support immédiatement.</div>
//         </div>
//         <div class="footer">&copy; ${new Date().getFullYear()} PayNoval. Tous droits réservés.</div>
//       </div>
//     </div>
//   </body>
//   </html>
//   `;
// }

// /**
//  * Template moderne pour le destinataire lors d'une transaction initiée
//  */
// function initiatedReceiverTemplate({ amount, currency, name, senderEmail, transactionId, date, confirmLink }) {
//   return `
//   <!DOCTYPE html>
//   <html lang="fr">
//   <head>
//     <meta charset="UTF-8">
//     <meta name="viewport" content="width=device-width, initial-scale=1.0">
//     <title>Validation requise</title>
//     ${commonStyles}
//   </head>
//   <body>
//     <div class="wrapper">
//       <div class="container">
//         <div class="header">
//           <img src="https://i.imgur.com/vVCYZkM.png" alt="PayNoval Logo" class="logo" />
//           <h1>Validation requise</h1>
//         </div>
//         <div class="content">
//           <p class="greeting">Bonjour ${name},</p>
//           <p class="message">Vous avez reçu une transaction en attente de validation.</p>
//           <table class="details">
//             <tr><th>ID Transaction</th><td>${transactionId}</td></tr>
//             <tr><th>Montant</th><td>${amount} ${currency}</td></tr>
//             <tr><th>Expéditeur</th><td>${senderEmail}</td></tr>
//             <tr><th>Date</th><td>${date}</td></tr>
//           </table>
//           <div class="button-wrap"><a href="${confirmLink}" class="button">Valider la transaction</a></div>
//           <div class="notice">⚠️ PayNoval ne vous demandera jamais de codes confidentiels ou mots de passe par email. Ne partagez rien et signalez toute tentative de fraude.</div>
//         </div>
//         <div class="footer">&copy; ${new Date().getFullYear()} PayNoval. Tous droits réservés.</div>
//       </div>
//     </div>
//   </body>
//   </html>
//   `;
// }

// /**
//  * Templates confirmés et annulés
//  */
// function confirmedSenderTemplate({ amount, currency, name, transactionId, date }) {
//   return `
//   <!DOCTYPE html>
//   <html lang="fr">
//   <head>
//     <meta charset="UTF-8">
//     <meta name="viewport" content="width=device-width, initial-scale=1.0">
//     <title>Transaction confirmée</title>
//     ${commonStyles}
//   </head>
//   <body>
//     <div class="wrapper">
//       <div class="container">
//         <div class="header">
//           <img src="https://i.imgur.com/vVCYZkM.png" alt="PayNoval Logo" class="logo" />
//           <h1>Transaction confirmée</h1>
//         </div>
//         <div class="content">
//           <p class="greeting">Bonjour ${name},</p>
//           <p class="message">Votre transaction a été validée par le destinataire.</p>
//           <table class="details">
//             <tr><th>ID Transaction</th><td>${transactionId}</td></tr>
//             <tr><th>Montant</th><td>${amount} ${currency}</td></tr>
//             <tr><th>Date</th><td>${date}</td></tr>
//           </table>
//           <div class="notice">⚠️ Pour votre sécurité, ne communiquez jamais vos données sensibles. En cas de doute, vérifiez auprès de PayNoval.</div>
//         </div>
//         <div class="footer">&copy; ${new Date().getFullYear()} PayNoval. Tous droits réservés.</div>
//       </div>
//     </div>
//   </body>
//   </html>
//   `;
// }

// function confirmedReceiverTemplate({ amount, currency, name, transactionId, date }) {
//   return `
//   <!DOCTYPE html>
//   <html lang="fr">
//   <head>
//     <meta charset="UTF-8">
//     <meta name="viewport" content="width=device-width, initial-scale=1.0">
//     <title>Transaction confirmée</title>
//     ${commonStyles}
//   </head>
//   <body>
//     <div class="wrapper">
//       <div class="container">
//         <div class="header">
//           <img src="https://i.imgur.com/vVCYZkM.png" alt="PayNoval Logo" class="logo" />
//           <h1>Transaction confirmée</h1>
//         </div>
//         <div class="content">
//           <p class="greeting">Bonjour ${name},</p>
//           <p class="message">Vous avez validé la transaction avec succès.</p>
//           <table class="details">
//             <tr><th>ID Transaction</th><td>${transactionId}</td></tr>
//             <tr><th>Montant</th><td>${amount} ${currency}</td></tr>
//             <tr><th>Date</th><td>${date}</td></tr>
//           </table>
//           <div class="notice">⚠️ Soyez vigilant : PayNoval n’enverra jamais de liens non sécurisés. Vérifiez toujours l’URL.</div>
//         </div>
//         <div class="footer">&copy; ${new Date().getFullYear()} PayNoval. Tous droits réservés.</div>
//       </div>
//     </div>
//   </body>
//   </html>
//   `;
// }

// function cancelledSenderTemplate({ amount, currency, name, transactionId, date, reason }) {
//   return `
//   <!DOCTYPE html>
//   <html lang="fr">
//   <head>
//     <meta charset="UTF-8">
//     <meta name="viewport" content="width=device-width, initial-scale=1.0">
//     <title>Transaction annulée</title>
//     ${commonStyles}
//   </head>
//   <body>
//     <div class="wrapper">
//       <div class="container">
//         <div class="header">
//           <img src="https://i.imgur.com/vVCYZkM.png" alt="PayNoval Logo" class="logo" />
//           <h1>Transaction annulée</h1>
//         </div>
//         <div class="content">
//           <p class="greeting">Bonjour ${name},</p>
//           <p class="message">Votre transaction a été annulée${reason ? ` : ${reason}` : '.'}</p>
//           <table class="details">
//             <tr><th>ID Transaction</th><td>${transactionId}</td></tr>
//             <tr><th>Montant</th><td>${amount} ${currency}</td></tr>
//             <tr><th>Date</th><td>${date}</td></tr>
//           </table>
//           <div class="notice">⚠️ Méfiez-vous des faux emails demandant une annulation. Contactez-nous via l’application.</div>
//         </div>
//         <div class="footer">&copy; ${new Date().getFullYear()} PayNoval. Tous droits réservés.</div>
//       </div>
//     </div>
//   </body>
//   </html>
//   `;
// }

// function cancelledReceiverTemplate({ amount, currency, name, transactionId, date, reason }) {
//   return `
//   <!DOCTYPE html>
//   <html lang="fr">
//   <head>
//     <meta charset="UTF-8">
//     <meta name="viewport" content="width=device-width, initial-scale=1.0">
//     <title>Transaction annulée</title>
//     ${commonStyles}
//   </head>
//   <body>
//     <div class="wrapper">
//       <div class="container">
//         <div class="header">
//           <img src="https://i.imgur.com/vVCYZkM.png" alt="PayNoval Logo" class="logo" />
//           <h1>Transaction annulée</h1>
//         </div>
//         <div class="content">
//           <p class="greeting">Bonjour ${name},</p>
//           <p class="message">La transaction a été annulée${reason ? ` : ${reason}` : '.'}</p>
//           <table class="details">
//             <tr><th>ID Transaction</th><td>${transactionId}</td></tr>
//             <tr><th>Montant</th><td>${amount} ${currency}</td></tr>
//             <tr><th>Date</th><td>${date}</td></tr>
//           </table>
//           <div class="notice">⚠️ Ne jamais cliquer sur des liens suspects. Vérifiez toujours l’expéditeur.</div>
//         </div>
//         <div class="footer">&copy; ${new Date().getFullYear()} PayNoval. Tous droits réservés.</div>
//       </div>
//     </div>
//   </body>
//   </html>
//   `;
// }

// module.exports = {
//   initiatedSenderTemplate,
//   initiatedReceiverTemplate,
//   confirmedSenderTemplate,
//   confirmedReceiverTemplate,
//   cancelledSenderTemplate,
//   cancelledReceiverTemplate
// };






// src/utils/emailTemplates.js

/**
 * Styles communs pour les emails
 */
const commonStyles = `
  <style>
    body { margin:0; padding:0; background-color:#f4f4f7; font-family:'Helvetica Neue',Arial,sans-serif; color:#333; }
    .wrapper { width:100%; background-color:#f4f4f7; padding:40px 0; }
    table[role="presentation"] { width:90%; max-width:600px; margin:0 auto; border-radius:20px; overflow:hidden; box-shadow:0 5px 14px rgba(0,0,0,0.1); border-collapse:collapse; }
    td { font-size:16px; line-height:1.5; padding:0; }
    .button a { background-color:#0D7E58; color:#fff !important; text-decoration:none; padding:12px 25px; border-radius:4px; font-weight:600; display:inline-block; }
    .notice { background-color:#e8f5e9; border-left:4px solid #43a047; padding:15px; font-size:14px; color:#2e7d32; }
    h1 { margin:0; color:#fff; font-size:25px; }
    .footer-text { background-color:#f0f4f8; text-align:center; padding:20px; font-size:12px; color:#777; }
    th, td { padding:12px 15px; }
    th { background-color:#f0f4f8; color:#555; font-weight:600; text-align:left; }
    td.detail { background-color:#fafbfc; }
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
          <td style="background-color:#0D7E58;padding:20px;text-align:center;">
            <img src="${headerLogoUrl}" alt="Logo PayNoval" width="50" style="vertical-align:middle;margin-right:10px;">
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

/**
 * Template pour transaction initiée (expéditeur)
 */
function initiatedSenderTemplate(data) {
  const bodyHtml = `
    <p style="font-size:18px;margin-bottom:20px;">Bonjour ${data.name || 'utilisateur'},</p>
    <p style="margin-bottom:25px;">Votre transaction a été initiée avec succès. Les fonds seront débloqués une fois que le destinataire aura validé.</p>
    <table role="presentation" style="width:100%;margin-bottom:30px;border-collapse:separate;border-spacing:0 8px;">
      <tr><th>ID Transaction</th><td class="detail">${data.transactionId}</td></tr>
      <tr><th>Montant</th><td class="detail">${data.amount} ${data.currency}</td></tr>
      <tr><th>Expéditeur</th><td class="detail">${data.senderEmail}</td></tr>
      <tr><th>Destinataire</th><td class="detail">${data.receiverEmail}</td></tr>
      <tr><th>Date</th><td class="detail">${data.date}</td></tr>
    </table>
    <div style="text-align:center;margin-bottom:30px;" class="button"><a href="${data.confirmLinkWeb}">Voir la transaction</a></div>
    <p style="margin-bottom:25px;">Vos transactions en attente seront automatiquement annulées au bout de 10 jours.</p>
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
  const bodyHtml = `
    <p style="font-size:18px;margin-bottom:20px;">Bonjour ${data.name},</p>
    <p style="margin-bottom:25px;">Vous avez reçu une transaction en attente de validation.</p>
    <table role="presentation" style="width:100%;margin-bottom:30px;border-collapse:separate;border-spacing:0 8px;">
      <tr><th>ID Transaction</th><td class="detail">${data.transactionId}</td></tr>
      <tr><th>Montant</th><td class="detail">${data.amount} ${data.currency}</td></tr>
      <tr><th>Expéditeur</th><td class="detail">${data.senderEmail}</td></tr>
      <tr><th>Date</th><td class="detail">${data.date}</td></tr>
    </table>
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
 * Template pour transaction confirmée
 */
function confirmedSenderTemplate(data) {
  const bodyHtml = `
    <p style="font-size:18px;margin-bottom:20px;">Bonjour ${data.name},</p>
    <p style="margin-bottom:25px;">Votre transaction a été validée par le destinataire.</p>
    <table role="presentation" style="width:100%;margin-bottom:30px;border-collapse:separate;border-spacing:0 8px;">
      <tr><th>ID Transaction</th><td class="detail">${data.transactionId}</td></tr>
      <tr><th>Montant</th><td class="detail">${data.amount} ${data.currency}</td></tr>
      <tr><th>Date</th><td class="detail">${data.date}</td></tr>
    </table>
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

function confirmedReceiverTemplate(data) {
  const bodyHtml = `
    <p style="font-size:18px;margin-bottom:20px;">Bonjour ${data.name},</p>
    <p style="margin-bottom:25px;">Vous avez validé la transaction avec succès.</p>
    <table role="presentation" style="width:100%;margin-bottom:30px;border-collapse:separate;border-spacing:0 8px;">
      <tr><th>ID Transaction</th><td class="detail">${data.transactionId}</td></tr>
      <tr><th>Montant</th><td class="detail">${data.amount} ${data.currency}</td></tr>
      <tr><th>Date</th><td class="detail">${data.date}</td></tr>
    </table>
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
 * Template pour transaction annulée
 */
function cancelledSenderTemplate(data) {
  const bodyHtml = `
    <p style="font-size:18px;margin-bottom:20px;">Bonjour ${data.name},</p>
    <p style="margin-bottom:25px;">Votre transaction a été annulée${data.reason ? ` : ${data.reason}` : '.'}</p>
    <table role="presentation" style="width:100%;margin-bottom:30px;border-collapse:separate;border-spacing:0 8px;">
      <tr><th>ID Transaction</th><td class="detail">${data.transactionId}</td></tr>
      <tr><th>Montant</th><td class="detail">${data.amount} ${data.currency}</td></tr>
      <tr><th>Date</th><td class="detail">${data.date}</td></tr>
    </table>
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

function cancelledReceiverTemplate(data) {
  const bodyHtml = `
    <p style="font-size:18px;margin-bottom:20px;">Bonjour ${data.name},</p>
    <p style="margin-bottom:25px;">La transaction a été annulée${data.reason ? ` : ${data.reason}` : '.'}</p>
    <table role="presentation" style="width:100%;margin-bottom:30px;border-collapse:separate;border-spacing:0 8px;">
      <tr><th>ID Transaction</th><td class="detail">${data.transactionId}</td></tr>
      <tr><th>Montant</th><td class="detail">${data.amount} ${data.currency}</td></tr>
      <tr><th>Date</th><td class="detail">${data.date}</td></tr>
    </table>
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
