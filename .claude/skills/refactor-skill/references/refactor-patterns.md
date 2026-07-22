# Patterns de refactoring — exemples concrets

## Extraction de fonction

**Avant**
```js
async function checkout(cart, userId) {
  let total = 0;
  for (const item of cart.items) {
    total += item.price * item.quantity;
  }
  if (cart.couponCode) {
    const coupon = await Coupon.findOne({ code: cart.couponCode });
    if (coupon && coupon.expiresAt > new Date()) {
      total = total * (1 - coupon.discountPercent / 100);
    }
  }
  const order = await Order.create({ userId, total, items: cart.items });
  return order;
}
```
Trois responsabilités mélangées (calcul du total, application du coupon, création de la commande) dans une seule fonction.

**Après**
```js
function calculateSubtotal(items) {
  return items.reduce((sum, item) => sum + item.price * item.quantity, 0);
}

async function applyCouponIfValid(subtotal, couponCode) {
  if (!couponCode) return subtotal;
  const coupon = await Coupon.findOne({ code: couponCode });
  if (!coupon || coupon.expiresAt <= new Date()) return subtotal;
  return subtotal * (1 - coupon.discountPercent / 100);
}

async function checkout(cart, userId) {
  const subtotal = calculateSubtotal(cart.items);
  const total = await applyCouponIfValid(subtotal, cart.couponCode);
  return Order.create({ userId, total, items: cart.items });
}
```
Même comportement exact, mais chaque fonction est testable isolément et le rôle de `checkout` devient lisible d'un coup d'œil.

## Découpage d'un composant trop volumineux

**Avant** : un composant `Dashboard` de 400 lignes qui mélange affichage des statistiques, liste des commandes récentes, formulaire de filtre, et logique de récupération de données.

**Après** : découpage en composants dédiés, `Dashboard` devenant une simple composition :
```jsx
function Dashboard() {
  const { stats, orders, loading } = useDashboardData();
  return (
    <>
      <StatsSummary stats={stats} />
      <OrderFilters />
      <RecentOrdersList orders={orders} loading={loading} />
    </>
  );
}
```
La logique de récupération de données part dans un hook custom (`useDashboardData`), chaque section devient un composant indépendant et testable. Comportement identique, structure lisible.

## Suppression de duplication entre services

**Avant**
```js
// userService.js
function formatUserName(user) {
  return `${user.firstName.trim()} ${user.lastName.trim()}`;
}

// invoiceService.js
function formatBuyerName(buyer) {
  return `${buyer.firstName.trim()} ${buyer.lastName.trim()}`; // même logique, dupliquée
}
```

**Après**
```js
// utils/formatName.js
function formatFullName(person) {
  return `${person.firstName.trim()} ${person.lastName.trim()}`;
}

module.exports = { formatFullName };
```
Les deux services importent et utilisent la même fonction. Un futur changement de règle de formatage se fait à un seul endroit.

## Clarification de nommage

**Avant**
```js
function calc(o, u) {
  const d = o.items.length;
  return d > 5 ? u.discount * 2 : u.discount;
}
```
Impossible de comprendre ce que fait la fonction sans lire tout son corps.

**Après**
```js
function calculateApplicableDiscount(order, user) {
  const itemCount = order.items.length;
  const hasBulkOrder = itemCount > 5;
  return hasBulkOrder ? user.discount * 2 : user.discount;
}
```
Même logique exacte, mais lisible sans effort. Le renommage seul est déjà un refactoring valable, même sans changer la structure.

## Retirer du code mort avec prudence

Avant de supprimer une fonction/un fichier qui semble inutilisé :
- Vérifier qu'il n'est pas appelé dynamiquement (chaîne de caractères construite, import dynamique, route enregistrée par convention).
- Vérifier qu'il n'est pas exporté et potentiellement utilisé par un autre module/package du monorepo.
- En cas de doute, signaler dans le rapport plutôt que de supprimer silencieusement.
