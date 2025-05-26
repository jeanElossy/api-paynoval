// src/utils/emailTemplates.js

/**
 * Styles communs pour les emails
 */
const commonStyles = `
  <style>
    body { font-family: Arial, sans-serif; color: #333; margin: 0; padding: 0; }
    .container { padding: 20px; }
    .header { padding: 10px; text-align: center; color: white; }
    .content { margin: 20px 0; }
    .footer { font-size: 12px; color: #777; text-align: center; margin-top: 30px; }
    .details { border-collapse: collapse; width: 100%; }
    .details th, .details td { border: 1px solid #ddd; padding: 8px; }
    .details th { background-color: #f2f2f2; }
    .button { display: inline-block; padding: 10px 20px; border-radius: 4px; text-decoration: none; }
  </style>
`;

/**
 * Email template pour l'expéditeur lors d'une transaction initiée
 * params: { amount, currency, name, transactionId, date, senderEmail, receiverEmail }
 */
function initiatedSenderTemplate({ amount, currency, name, transactionId, date, senderEmail, receiverEmail }) {
  return `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Transaction lancée</title>
  ${commonStyles}
</head>
<body>
  <div class="container">
    <div class="header" style="background-color:#4CAF50;"><h1>Transaction lancée</h1></div>
    <div class="content">
      <p>Bonjour ${name},</p>
      <p>Votre transaction a bien été lancée. Les fonds seront débloqués une fois le destinataire l'aura validée.</p>
      <table class="details">
        <tr><th>ID Transaction</th><td>${transactionId}</td></tr>
        <tr><th>Montant</th><td>${amount} ${currency}</td></tr>
        <tr><th>Expéditeur</th><td>${senderEmail}</td></tr>
        <tr><th>Destinataire</th><td>${receiverEmail}</td></tr>
        <tr><th>Date</th><td>${date}</td></tr>
      </table>
      <p>Demandez au destinataire de valider la transaction en saisissant la phrase secrète.</p>
      <p>Vos transactions en attente seront automatiquement annulées au bout de 10 jours.</p>
    </div>
    <div class="footer"><p>&copy; ${new Date().getFullYear()} PayNoval. Tous droits réservés.</p></div>
  </div>
</body>
</html>
`;
}

/**
 * Email template pour le destinataire lors d'une transaction initiée
 * params: { amount, currency, name, senderEmail, transactionId, date, confirmLink }
 */
function initiatedReceiverTemplate({ amount, currency, name, senderEmail, transactionId, date, confirmLink }) {
  return `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Validation requise</title>
  ${commonStyles}
</head>
<body>
  <div class="container">
    <div class="header" style="background-color:#4CAF50;"><h1>Validation requise</h1></div>
    <div class="content">
      <p>Bonjour ${name},</p>
      <p>Vous avez reçu une transaction en attente de validation.</p>
      <table class="details">
        <tr><th>ID Transaction</th><td>${transactionId}</td></tr>
        <tr><th>Montant</th><td>${amount} ${currency}</td></tr>
        <tr><th>Expéditeur</th><td>${senderEmail}</td></tr>
        <tr><th>Date</th><td>${date}</td></tr>
      </table>
      <p>Vos transactions en attente seront annulées après 10 jours.</p>
      <p>Pour valider cette transaction, cliquez sur :</p>
      <p><a href="${confirmLink}" class="button" style="background:#0D7E58;color:#fff;">Valider la transaction</a></p>
    </div>
    <div class="footer"><p>&copy; ${new Date().getFullYear()} PayNoval. Tous droits réservés.</p></div>
  </div>
</body>
</html>
`;
}

/**
 * Email template pour l'expéditeur lors d'une transaction confirmée
 * params: { amount, currency, name, transactionId, date }
 */
function confirmedSenderTemplate({ amount, currency, name, transactionId, date }) {
  return `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Transaction confirmée</title>
  ${commonStyles}
</head>
<body>
  <div class="container">
    <div class="header" style="background-color:#2196F3;"><h1>Transaction confirmée</h1></div>
    <div class="content">
      <p>Bonjour ${name},</p>
      <p>Votre transaction a été validée par le destinataire.</p>
      <table class="details">
        <tr><th>ID Transaction</th><td>${transactionId}</td></tr>
        <tr><th>Montant</th><td>${amount} ${currency}</td></tr>
        <tr><th>Date</th><td>${date}</td></tr>
      </table>
    </div>
    <div class="footer"><p>&copy; ${new Date().getFullYear()} PayNoval. Tous droits réservés.</p></div>
  </div>
</body>
</html>
`;
}

/**
 * Email template pour le destinataire lors d'une transaction confirmée
 * params: { amount, currency, name, transactionId, date }
 */
function confirmedReceiverTemplate({ amount, currency, name, transactionId, date }) {
  return `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Transaction confirmée</title>
  ${commonStyles}
</head>
<body>
  <div class="container">
    <div class="header" style="background-color:#2196F3;"><h1>Transaction confirmée</h1></div>
    <div class="content">
      <p>Bonjour ${name},</p>
      <p>Vous avez validé la transaction avec succès.</p>
      <table class="details">
        <tr><th>ID Transaction</th><td>${transactionId}</td></tr>
        <tr><th>Montant</th><td>${amount} ${currency}</td></tr>
        <tr><th>Date</th><td>${date}</td></tr>
      </table>
    </div>
    <div class="footer"><p>&copy; ${new Date().getFullYear()} PayNoval. Tous droits réservés.</p></div>
  </div>
</body>
</html>
`;
}

/**
 * Email template pour l'expéditeur lors d'une transaction annulée
 * params: { amount, currency, name, transactionId, date, reason }
 */
function cancelledSenderTemplate({ amount, currency, name, transactionId, date, reason }) {
  return `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Transaction annulée</title>
  ${commonStyles}
</head>
<body>
  <div class="container">
    <div class="header" style="background-color:#F44336;"><h1>Transaction annulée</h1></div>
    <div class="content">
      <p>Bonjour ${name},</p>
      <p>Votre transaction a été annulée${reason ? ` : ${reason}` : '.'}</p>
      <table class="details">
        <tr><th>ID Transaction</th><td>${transactionId}</td></tr>
        <tr><th>Montant</th><td>${amount} ${currency}</td></tr>
        <tr><th>Date</th><td>${date}</td></tr>
      </table>
    </div>
    <div class="footer"><p>&copy; ${new Date().getFullYear()} PayNoval. Tous droits réservés.</p></div>
  </div>
</body>
</html>
`;
}

/**
 * Email template pour le destinataire lors d'une transaction annulée
 * params: { amount, currency, name, transactionId, date, reason }
 */
function cancelledReceiverTemplate({ amount, currency, name, transactionId, date, reason }) {
  return `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Transaction annulée</title>
  ${commonStyles}
</head>
<body>
  <div class="container">
    <div class="header" style="background-color:#F44336;"><h1>Transaction annulée</h1></div>
    <div class="content">
      <p>Bonjour ${name},</p>
      <p>La transaction a été annulée${reason ? ` : ${reason}` : '.'}</p>
      <table class="details">
        <tr><th>ID Transaction</th><td>${transactionId}</td></tr>
        <tr><th>Montant</th><td>${amount} ${currency}</td></tr>
        <tr><th>Date</th><td>${date}</td></tr>
      </table>
    </div>
    <div class="footer"><p>&copy; ${new Date().getFullYear()} PayNoval. Tous droits réservés.</p></div>
  </div>
</body>
</html>
`;
}

module.exports = {
  initiatedSenderTemplate,
  initiatedReceiverTemplate,
  confirmedSenderTemplate,
  confirmedReceiverTemplate,
  cancelledSenderTemplate,
  cancelledReceiverTemplate
};
