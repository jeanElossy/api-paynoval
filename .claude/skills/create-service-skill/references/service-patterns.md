# Patterns de Service métier

## Séparation HTTP / métier

**Avant**
```js
// services/orderService.js
async function createOrder(req, res) {
  const order = await Order.create(req.body);
  res.status(201).json(order);
}
```
Le service dépend d'Express — impossible à tester sans mocker `req`/`res`, impossible à réutiliser dans un script ou un job planifié.

**Après**
```js
// services/orderService.js
async function createOrder(orderData, userId) {
  const order = await Order.create({ ...orderData, userId });
  return order;
}

module.exports = { createOrder };
```
```js
// controllers/orderController.js
async function createOrderHandler(req, res, next) {
  try {
    const order = await orderService.createOrder(req.body, req.user.id);
    res.status(201).json(order);
  } catch (err) {
    next(err);
  }
}
```
Le service prend des données simples et retourne des données simples ; le controller fait le pont avec Express.

## Erreurs explicites, jamais masquées

**Avant**
```js
async function verifyOtp(userId, code) {
  try {
    const record = await OtpRecord.findOne({ userId, code });
    return !!record;
  } catch (err) {
    console.log(err);
    return false; // l'erreur disparaît, l'appelant croit juste que l'OTP est invalide
  }
}
```

**Après**
```js
async function verifyOtp(userId, code) {
  const record = await OtpRecord.findOne({ userId, code });
  if (!record) {
    const err = new Error('Invalid or expired code');
    err.status = 400;
    throw err;
  }
  if (record.expiresAt < new Date()) {
    const err = new Error('Code expired');
    err.status = 400;
    throw err;
  }
  return true;
}
```
Chaque cas d'échec est distingué et explicite ; une erreur inattendue (ex: DB indisponible) remonte naturellement à l'appelant au lieu d'être avalée.

## Nommage explicite en verbes

**Avant**
```js
function process(data) { /* ... */ }
function handle(order) { /* ... */ }
```
Aucune indication sur ce que fait réellement la fonction.

**Après**
```js
function calculateShippingFees(order) { /* ... */ }
function sendOrderConfirmationEmail(order) { /* ... */ }
function markOrderAsPaid(orderId) { /* ... */ }
```

## Appels à des services externes

**Avant**
```js
async function sendNotification(userId, message) {
  await fetch('https://api.notification-provider.com/send', {
    method: 'POST',
    body: JSON.stringify({ to: userId, message }),
  });
  // pas de gestion d'échec réseau, pas de retry, pas de timeout
}
```

**Après**
```js
async function sendNotification(userId, message) {
  try {
    const response = await fetch('https://api.notification-provider.com/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: userId, message }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      throw new Error(`Notification provider returned ${response.status}`);
    }
  } catch (err) {
    // Logger l'échec sans forcément faire échouer toute l'opération appelante
    // selon si la notification est critique ou non pour le flux métier
    logger.error('Failed to send notification', { userId, error: err.message });
    throw err;
  }
}
```

## Découper un service trop volumineux

**Avant** : `orderService.js` avec 30 fonctions mélangeant création, paiement, expédition, remboursement, notifications.

**Après** : découper par sous-domaine métier plutôt que d'empiler dans un seul fichier :
```
services/
  order/
    createOrder.js
    orderPayment.js
    orderShipping.js
    orderRefund.js
    orderNotifications.js
  index.js  // ré-exporte tout pour garder des imports simples ailleurs
```
Chaque fichier reste court et responsable d'une seule chose, tout en gardant une API d'import stable pour le reste du code.

## Réutilisation avant duplication

Avant d'écrire une nouvelle fonction, vérifier :
- Un utilitaire générique existe-t-il déjà (`utils/`) pour ce calcul ?
- Un autre service fait-il déjà un traitement proche qui pourrait être généralisé plutôt que dupliqué ?
- Le modèle concerné a-t-il déjà une méthode statique/d'instance qui couvre le besoin ?
