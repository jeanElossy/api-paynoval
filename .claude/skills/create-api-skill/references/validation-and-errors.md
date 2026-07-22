# Validation des entrées et gestion d'erreurs

## Valider avant de faire confiance aux données

**Avant**
```js
async function createOrder(req, res, next) {
  const order = await orderService.create(req.body); // req.body utilisé tel quel
  res.status(201).json(order);
}
```
N'importe quel champ, type ou valeur peut arriver — y compris des opérateurs MongoDB malveillants.

**Après (avec un validateur, ex: express-validator ou zod)**
```js
const { z } = require('zod');

const createOrderSchema = z.object({
  items: z.array(z.object({
    productId: z.string(),
    quantity: z.number().int().min(1),
  })).min(1),
});

async function createOrder(req, res, next) {
  try {
    const data = createOrderSchema.parse(req.body);
    const order = await orderService.create(data, req.user.id);
    res.status(201).json(order);
  } catch (err) {
    next(err);
  }
}
```
Seules les données conformes au schéma passent ; toute tentative d'injection d'un champ ou opérateur inattendu est rejetée avant d'atteindre la base.

## Ne jamais passer req.query/req.body directement dans une requête Mongo

**Avant**
```js
const orders = await Order.find(req.query); // filtre entièrement contrôlé par le client
```
Un client peut injecter `{ "$where": "..." }` ou des opérateurs comme `$ne` dans `req.query`.

**Après**
```js
const { status, userId } = req.query;
const filter = {};
if (status) filter.status = String(status);
if (userId) filter.userId = String(userId);
const orders = await Order.find(filter);
```
Seuls les champs explicitement attendus sont extraits et castés au bon type.

## Codes HTTP cohérents

**Avant**
```js
catch (err) {
  res.status(500).json({ error: err.message }); // tout finit en 500
}
```
Une ressource introuvable ou un accès refusé ne sont pas des erreurs serveur.

**Après**
```js
// dans le service : throw new Error('...') avec err.status = 404 / 403 / 400
// dans le controller :
catch (err) {
  next(err); // délégué au middleware d'erreur global qui utilise err.status
}
```
- `400` : entrée invalide
- `401` : non authentifié
- `403` : authentifié mais non autorisé
- `404` : ressource introuvable
- `500` : erreur serveur inattendue uniquement

## Ne jamais laisser une erreur non gérée

**Avant**
```js
router.get('/:id', async (req, res) => {
  const order = await orderService.getOrderById(req.params.id); // pas de try/catch
  res.json(order);
});
```
Si `getOrderById` rejette, la requête reste bloquée ou fait planter le process selon la version de Node/Express.

**Après**
```js
router.get('/:id', async (req, res, next) => {
  try {
    const order = await orderService.getOrderById(req.params.id);
    res.json(order);
  } catch (err) {
    next(err);
  }
});
```
Chaque route async encadre ses appels dans un try/catch qui délègue au middleware d'erreur global.
