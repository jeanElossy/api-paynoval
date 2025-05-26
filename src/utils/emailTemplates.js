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
 */
function initiatedSenderTemplate({
  amount,
  localCurrencySymbol,
  nameExpediteur,
  transactionId,
  senderEmail,
  receiverEmail,
  date
}) {
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
      <p>Bonjour ${nameExpediteur},</p>
      <p>Votre transaction a bien été lancée. Les fonds seront débloqués une fois le destinataire l'aura validée.</p>
      <table class="details">
        <tr><th>ID Transaction</th><td>${transactionId}</td></tr>
        <tr><th>Montant</th><td>${amount} ${localCurrencySymbol}</td></tr>
        <tr><th>Expediteur</th><td>${senderEmail}</td></tr>
        <tr><th>Destinataire</th><td>${receiverEmail}</td></tr>
        <tr><th>Date</th><td>${date}</td></tr>
      </table>

      <p>Demander au destinataire de valider la transaction en saisissant la phrase secrete que vous lui aviez donnée.</p>
      <p>Vos transactions en attente seront automatiquement annulées dans un delai de 10 jours, a compter du jour de lancement.</p>
    </div>

    <div class="footer"><p>&copy; ${new Date().getFullYear()} PayNoval. Tous droits réservés.</p></div>
  </div>
</body>
</html>
`;
}

/**
 * Email template pour le destinataire lors d'une transaction initiée
 */
function initiatedReceiverTemplate({
  amount,
  localCurrencySymbol,
  senderEmail,
  nameDestinataire,
  transactionId,
  date,
  confirmLink
}) {
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
      <p>Bonjour ${nameDestinataire},</p>
      <p>Vous avez reçu une transaction en attente de validation.</p>
      <table class="details">
        <tr><th>ID Transaction</th><td>${transactionId}</td></tr>
        <tr><th>Montant</th><td>${amount} ${localCurrencySymbol}</td></tr>
        <tr><th>Expéditeur</th><td>${senderEmail}</td></tr>
        <tr><th>Date</th><td>${date}</td></tr>
      </table>
      <p>Dans un delai de 10 jours vos transactions en attente seront automatiquement annulées</p>
      <p>Pour valider cette transaction, cliquez sur le bouton ci-dessous :</p>
      <p><a href="${confirmLink}" class="button" style="background:#0D7E58;color:#fff;">Valider</a></p>
    </div>

    <div class="footer"><p>&copy; ${new Date().getFullYear()} PayNoval. Tous droits réservés.</p></div>
  </div>
</body>
</html>
`;
}

/**
 * Email template pour l'expéditeur lors d'une transaction confirmée
 */
function confirmedSenderTemplate({
  amount,
  localCurrencySymbol,
  nameExpediteur,
  transactionId,
  date
}) {
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
      <p>Bonjour ${nameExpediteur},</p>
      <p>Votre transaction a été validée par le destinataire.</p>
      <table class="details">
        <tr><th>ID Transaction</th><td>${transactionId}</td></tr>
        <tr><th>Montant</th><td>${amount} ${localCurrencySymbol}</td></tr>
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
 */
function confirmedReceiverTemplate({
  amount,
  localCurrencySymbol,
  nameDestinataire,
  transactionId,
  date
}) {
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
      <p>Bonjour ${nameDestinataire},</p>
      <p>Vous avez validé la transaction avec succès.</p>
      <table class="details">
        <tr><th>ID Transaction</th><td>${transactionId}</td></tr>
        <tr><th>Montant</th><td>${amount} ${localCurrencySymbol}</td></tr>
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
 */
function cancelledSenderTemplate({
  amount,
  localCurrencySymbol,
  nameExpediteur,
  transactionId,
  date,
  reason
}) {
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
      <p>Bonjour ${nameExpediteur},</p>
      <p>Votre transaction a été annulée${reason ? ` : ${reason}` : '.'}</p>
      <table class="details">
        <tr><th>ID Transaction</th><td>${transactionId}</td></tr>
        <tr><th>Montant</th><td>${amount} ${localCurrencySymbol}</td></tr>
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
 */
function cancelledReceiverTemplate({
  amount,
  localCurrencySymbol,
  nameDestinataire,
  transactionId,
  date,
  reason
}) {
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
      <p>Bonjour ${nameDestinataire},</p>
      <p>La transaction que vous deviez valider a été annulée${reason ? ` : ${reason}` : '.'}</p>
      <table class="details">
        <tr><th>ID Transaction</th><td>${transactionId}</td></tr>
        <tr><th>Montant</th><td>${amount} ${localCurrencySymbol}</td></tr>
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
