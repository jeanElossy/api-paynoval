# Exemple complet — architecture en couches

Ressource : commandes (`orders`), endpoint `GET /api/orders/:id`.

## Model

```js
// models/Order.js
const mongoose = require('mongoose');

const orderSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  items: [{
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    quantity: { type: Number, required: true, min: 1 },
  }],
  status: { type: String, enum: ['pending', 'paid', 'shipped', 'cancelled'], default: 'pending' },
  totalAmount: { type: Number, required: true, min: 0 },
}, { timestamps: true });

module.exports = mongoose.model('Order', orderSchema);
```
Validation intégrée (`required`, `min`, `enum`), index sur `userId` car c'est le champ de filtre le plus fréquent.

## Service

```js
// services/orderService.js
const Order = require('../models/Order');

async function getOrderById(orderId, requestingUserId) {
  const order = await Order.findById(orderId).lean();
  if (!order) {
    const err = new Error('Order not found');
    err.status = 404;
    throw err;
  }
  if (String(order.userId) !== String(requestingUserId)) {
    const err = new Error('Forbidden');
    err.status = 403;
    throw err;
  }
  return order;
}

module.exports = { getOrderById };
```
Toute la logique métier (récupération + contrôle de propriété) est ici, testable indépendamment d'Express. `.lean()` car la donnée retournée est en lecture seule.

## Controller

```js
// controllers/orderController.js
const orderService = require('../services/orderService');

async function getOrder(req, res, next) {
  try {
    const order = await orderService.getOrderById(req.params.id, req.user.id);
    res.status(200).json(order);
  } catch (err) {
    next(err);
  }
}

module.exports = { getOrder };
```
Le controller appelle le service, gère la réponse HTTP, délègue les erreurs à un middleware global via `next(err)`.

## Route

```js
// routes/orderRoutes.js
const express = require('express');
const router = express.Router();
const { getOrder } = require('../controllers/orderController');
const requireAuth = require('../middlewares/requireAuth');
const validateObjectId = require('../middlewares/validateObjectId');

router.get('/:id', requireAuth, validateObjectId('id'), getOrder);

module.exports = router;
```
La route n'a aucune logique — middlewares (auth, validation du format d'ID) puis appel du controller.

## Middleware d'erreur global (une fois pour tout le projet)

```js
// middlewares/errorHandler.js
function errorHandler(err, req, res, next) {
  const status = err.status || 500;
  const message = status === 500 && process.env.NODE_ENV === 'production'
    ? 'Internal server error'
    : err.message;
  res.status(status).json({ error: message });
}

module.exports = errorHandler;
```
Ne fuit pas la stack trace en production ; centralise le format d'erreur pour toute l'API.
