# Patterns de performance — Backend et MongoDB

## Backend

### Opération bloquante dans le thread principal

**Avant**
```js
function generateReport(req, res) {
  const data = heavyCsvParsing(req.file.buffer); // bloque l'event loop pour tous les autres utilisateurs
  res.json(data);
}
```
Un traitement CPU-intensif synchrone bloque Node.js pour toutes les requêtes en cours pendant son exécution.

**Après**
- Déporter le traitement lourd dans un worker thread, une queue de jobs (ex: BullMQ) ou un service externe si le volume le justifie.
- À minima, découper le traitement pour rendre la main à l'event loop régulièrement si un vrai worker n'est pas justifié pour le volume actuel.

### Appels API redondants

**Avant**
```js
async function getOrderSummary(orderId) {
  const order = await fetchOrder(orderId);
  const user = await fetchUser(order.userId); // séquentiel alors qu'indépendant
  const products = await fetchProducts(order.items.map(i => i.productId)); // séquentiel aussi
  return { order, user, products };
}
```
Trois appels indépendants exécutés l'un après l'autre au lieu d'en parallèle.

**Après**
```js
async function getOrderSummary(orderId) {
  const order = await fetchOrder(orderId);
  const [user, products] = await Promise.all([
    fetchUser(order.userId),
    fetchProducts(order.items.map(i => i.productId)),
  ]);
  return { order, user, products };
}
```

## MongoDB

### Index manquant sur un champ de filtre fréquent

**Avant**
```js
// Requête très fréquente, aucun index sur `status` ni `createdAt`
await Order.find({ status: 'pending' }).sort({ createdAt: -1 });
```
Sans index, MongoDB scanne la collection entière (`COLLSCAN`) à chaque appel.

**Après**
```js
orderSchema.index({ status: 1, createdAt: -1 });
```
Un index composé qui correspond exactement au filtre + tri de la requête la plus fréquente.

### populate non ciblé

**Avant**
```js
const orders = await Order.find().populate('userId').populate('items.productId');
```
Résout systématiquement toutes les relations, y compris quand l'appelant n'affiche qu'un résumé.

**Après**
```js
const orders = await Order.find().populate('userId', 'name email').lean();
```
Champs sélectionnés explicitement, `.lean()` si le résultat n'a pas besoin d'être un document Mongoose complet (pas de `.save()` à suivre).

### Absence de pagination

**Avant**
```js
const allOrders = await Order.find({ userId }); // peut retourner des milliers de documents
```

**Après**
```js
const PAGE_SIZE = 20;
const orders = await Order.find({ userId })
  .sort({ createdAt: -1 })
  .skip((page - 1) * PAGE_SIZE)
  .limit(PAGE_SIZE);
```
Pour des volumes importants ou un tri stable, préférer une pagination par curseur (`_id`/`createdAt` comme point de départ) à `skip()`, qui devient coûteux sur de grandes pages avancées.

### Agrégation coûteuse sans étape de filtrage précoce

**Avant**
```js
await Order.aggregate([
  { $lookup: { from: 'users', localField: 'userId', foreignField: '_id', as: 'user' } },
  { $match: { status: 'paid' } }, // filtre appliqué après le lookup sur toute la collection
]);
```

**Après**
```js
await Order.aggregate([
  { $match: { status: 'paid' } }, // filtre en premier, réduit le volume avant le lookup
  { $lookup: { from: 'users', localField: 'userId', foreignField: '_id', as: 'user' } },
]);
```
Filtrer le plus tôt possible dans le pipeline réduit le nombre de documents traités par les étapes suivantes, en particulier les `$lookup` qui sont coûteux.

### Documents volumineux dans les résultats

Vérifier que les requêtes sélectionnent uniquement les champs nécessaires plutôt que le document complet, en particulier quand des champs volumineux (tableaux longs, texte riche) ne sont pas utilisés par l'appelant :
```js
await Order.find({ userId }).select('status totalAmount createdAt');
```
