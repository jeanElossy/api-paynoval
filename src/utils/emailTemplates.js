// src/utils/emailTemplates.js

/**
 * Génère le template HTML pour l'email de transaction initiée
 * @param {Object} data
 * @param {string} data.amount
 * @param {string} data.senderEmail
 * @param {string} data.receiverEmail
 * @param {string} data.transactionId
 * @param {string} data.date
 * @param {string} data.confirmLink
 * @returns {string} HTML complet
 */
function initiatedTemplate({ amount, senderEmail, receiverEmail, transactionId, date, confirmLink }) {
  return `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Transaction Initiée</title>
  <style>
    body { font-family: Arial, sans-serif; color: #333; margin: 0; padding: 0; }
    .container { padding: 20px; }
    .header { background-color: #4CAF50; color: white; padding: 10px; text-align: center; }
    .content { margin: 20px 0; }
    .footer { font-size: 12px; color: #777; text-align: center; margin-top: 30px; }
    .details { border-collapse: collapse; width: 100%; }
    .details th, .details td { border: 1px solid #ddd; padding: 8px; }
    .details th { background-color: #f2f2f2; }
    .button { display: inline-block; padding: 10px 20px; background: #0D7E58; color: #fff; border-radius: 4px; text-decoration: none; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Transaction Initiée</h1>
    </div>
    <div class="content">
      <p>Bonjour,</p>
      <p>Une nouvelle transaction a été <strong>initiée</strong> sur votre compte PayNoval.</p>
      <table class="details">
        <tr><th>ID Transaction</th><td>${transactionId}</td></tr>
        <tr><th>Montant</th><td>${amount} €</td></tr>
        <tr><th>Expéditeur</th><td>${senderEmail}</td></tr>
        <tr><th>Destinataire</th><td>${receiverEmail}</td></tr>
        <tr><th>Date</th><td>${date}</td></tr>
      </table>
      <p>Pour confirmer la transaction, veuillez cliquer sur le bouton ci-dessous :</p>
      <p>
        <a href="${confirmLink}" class="button">Confirmer la transaction</a>
      </p>
      <p>Si le lien ne fonctionne pas, copiez et collez cette URL dans votre navigateur :<br>
        <code>${confirmLink}</code>
      </p>
    </div>
    <div class="footer">
      <p>&copy; ${new Date().getFullYear()} PayNoval. Tous droits réservés.</p>
    </div>
  </div>
</body>
</html>
`;
}

/**
 * Génère le template HTML pour l'email de transaction confirmée
 * @param {Object} data
 * @param {string} data.amount
 * @param {string} data.senderEmail
 * @param {string} data.receiverEmail
 * @param {string} data.transactionId
 * @param {string} data.date
 * @returns {string} HTML complet
 */
function confirmedTemplate({ amount, senderEmail, receiverEmail, transactionId, date }) {
  return `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Transaction Confirmée</title>
  <style>
    body { font-family: Arial, sans-serif; color: #333; margin: 0; padding: 0; }
    .container { padding: 20px; }
    .header { background-color: #2196F3; color: white; padding: 10px; text-align: center; }
    .content { margin: 20px 0; }
    .footer { font-size: 12px; color: #777; text-align: center; margin-top: 30px; }
    .details { border-collapse: collapse; width: 100%; }
    .details th, .details td { border: 1px solid #ddd; padding: 8px; }
    .details th { background-color: #f2f2f2; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Transaction Confirmée</h1>
    </div>
    <div class="content">
      <p>Bonjour,</p>
      <p>Votre transaction a été <strong>confirmée</strong> avec succès.</p>
      <table class="details">
        <tr><th>ID Transaction</th><td>${transactionId}</td></tr>
        <tr><th>Montant</th><td>${amount} €</td></tr>
        <tr><th>Expéditeur</th><td>${senderEmail}</td></tr>
        <tr><th>Destinataire</th><td>${receiverEmail}</td></tr>
        <tr><th>Date</th><td>${date}</td></tr>
      </table>
      <p>Merci d'utiliser PayNoval pour vos transferts.</p>
    </div>
    <div class="footer">
      <p>&copy; ${new Date().getFullYear()} PayNoval. Tous droits réservés.</p>
    </div>
  </div>
</body>
</html>
`;
}

/**
 * Génère le template HTML pour l'email de transaction annulée
 * @param {Object} data
 * @param {string} data.amount
 * @param {string} data.senderEmail
 * @param {string} data.receiverEmail
 * @param {string} data.transactionId
 * @param {string} data.date
 * @param {string} [data.reason]
 * @returns {string} HTML complet
 */
function cancelledTemplate({ amount, senderEmail, receiverEmail, transactionId, date, reason }) {
  return `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Transaction Annulée</title>
  <style>
    body { font-family: Arial, sans-serif; color: #333; margin: 0; padding: 0; }
    .container { padding: 20px; }
    .header { background-color: #F44336; color: white; padding: 10px; text-align: center; }
    .content { margin: 20px 0; }
    .footer { font-size: 12px; color: #777; text-align: center; margin-top: 30px; }
    .details { border-collapse: collapse; width: 100%; }
    .details th, .details td { border: 1px solid #ddd; padding: 8px; }
    .details th { background-color: #f2f2f2; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Transaction Annulée</h1>
    </div>
    <div class="content">
      <p>Bonjour,</p>
      <p>Nous sommes désolés, mais votre transaction a été <strong>annulée</strong>.</p>
      <table class="details">
        <tr><th>ID Transaction</th><td>${transactionId}</td></tr>
        <tr><th>Montant</th><td>${amount} €</td></tr>
        <tr><th>Expéditeur</th><td>${senderEmail}</td></tr>
        <tr><th>Destinataire</th><td>${receiverEmail}</td></tr>
        <tr><th>Date</th><td>${date}</td></tr>
        ${reason ? `<tr><th>Raison</th><td>${reason}</td></tr>` : ''}
      </table>
      <p>Pour plus d'informations, veuillez contacter le support PayNoval.</p>
    </div>
    <div class="footer">
      <p>&copy; ${new Date().getFullYear()} PayNoval. Tous droits réservés.</p>
    </div>
  </div>
</body>
</html>
`;
}


module.exports = {
  initiatedTemplate,
  confirmedTemplate,
  cancelledTemplate
};

