# Diagnostic par catégorie de bug — exemples concrets

## Closure obsolète (stale closure) dans un Hook

**Symptôme** : une fonction dans un `useEffect`/`useCallback` utilise une valeur "figée", périmée par rapport à l'état actuel.

```jsx
function Counter() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const id = setInterval(() => {
      console.log(count); // toujours 0, jamais mis à jour
    }, 1000);
    return () => clearInterval(id);
  }, []); // tableau de dépendances vide → count figé à sa valeur initiale
}
```
**Cause racine** : le tableau de dépendances vide fait que la fonction du `setInterval` garde la closure de la première exécution du `useEffect`.

**Correction** : soit ajouter `count` aux dépendances (en acceptant de recréer l'interval), soit utiliser la forme fonctionnelle de `setState` qui n'a pas besoin de lire `count` depuis la closure :
```jsx
setCount(prev => prev + 1); // pas besoin de count dans les dépendances
```

## Race condition sur une requête asynchrone

**Symptôme** : les données affichées correspondent à une requête précédente plutôt qu'à la plus récente (ex: recherche qui affiche un résultat périmé après une frappe rapide).

```jsx
useEffect(() => {
  fetchResults(query).then(setResults); // la réponse la plus lente écrase la plus récente
}, [query]);
```
**Cause racine** : plusieurs requêtes sont en vol simultanément ; rien n'empêche une réponse ancienne d'arriver après une plus récente et d'écraser son résultat.

**Correction** :
```jsx
useEffect(() => {
  let cancelled = false;
  fetchResults(query).then(data => {
    if (!cancelled) setResults(data);
  });
  return () => { cancelled = true; };
}, [query]);
```

## Erreur avalée silencieusement

**Symptôme** : une opération échoue mais rien ne le signale, le bug semble "aléatoire".

```js
async function updateOrderStatus(orderId, status) {
  try {
    await Order.findByIdAndUpdate(orderId, { status });
  } catch (err) {
    console.log('erreur'); // le contrôleur ne sait jamais que ça a échoué
  }
}
```
**Cause racine** : l'erreur est catchée puis ignorée — l'appelant croit que l'opération a réussi.

**Correction** :
```js
async function updateOrderStatus(orderId, status) {
  const updated = await Order.findByIdAndUpdate(orderId, { status }, { new: true });
  if (!updated) {
    const err = new Error('Order not found');
    err.status = 404;
    throw err;
  }
  return updated;
}
```

## Requête MongoDB qui ne filtre pas ce qu'on croit

**Symptôme** : une requête retourne trop, ou pas assez, de résultats.

```js
// Bug : status est envoyé comme chaîne "undefined" par le frontend quand le filtre n'est pas défini
const orders = await Order.find({ status: req.query.status });
// req.query.status === "undefined" (string) filtre sur une valeur qui n'existe jamais → 0 résultat
```
**Cause racine** : `req.query.status` est une chaîne littérale `"undefined"` (pas la valeur JS `undefined`) quand le paramètre est absent mal géré côté frontend, donc le filtre Mongo ne matche jamais.

**Correction** :
```js
const filter = {};
if (req.query.status && req.query.status !== 'undefined') {
  filter.status = req.query.status;
}
const orders = await Order.find(filter);
```
Traiter la cause à la source (nettoyer l'appel frontend) reste préférable à ce correctif défensif côté backend seul.

## Bug de permission masqué par un correctif trop large

**Symptôme rapporté** : "l'utilisateur A ne peut pas voir sa propre commande."

**Mauvais réflexe** (à éviter absolument) :
```js
// "Ça marche" mais supprime le contrôle d'accès pour tout le monde
async function getOrder(orderId) {
  return Order.findById(orderId); // plus aucune vérification de propriétaire
}
```
Ce correctif fait disparaître le symptôme en supprimant la protection — exactement le type de correction interdit par cette skill.

**Bonne approche** : d'abord comprendre pourquoi la comparaison de propriétaire échouait (ex: comparaison d'un `ObjectId` avec une chaîne sans conversion) :
```js
// Cause probable : comparaison stricte entre ObjectId et string
if (order.userId !== requestingUserId) { ... } // toujours vrai, même pour le bon utilisateur

// Correction qui garde la protection intacte :
if (String(order.userId) !== String(requestingUserId)) { ... }
```
