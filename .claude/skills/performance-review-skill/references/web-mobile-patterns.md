# Patterns de performance — React (web) et signaux React Native

## React

### Context trop large

**Avant**
```jsx
<AppContext.Provider value={{ user, theme, notifications, cart, settings }}>
```
Tout consommateur re-render dès qu'un seul de ces champs change, même s'il n'utilise que `theme`.

**Après**
```jsx
<UserContext.Provider value={user}>
  <ThemeContext.Provider value={theme}>
    <CartContext.Provider value={cart}>
      {children}
    </CartContext.Provider>
  </ThemeContext.Provider>
</UserContext.Provider>
```
Séparer les contexts selon leur fréquence de mise à jour évite les re-renders en cascade non liés.

### Calcul coûteux non mémoïsé

**Avant**
```jsx
function Dashboard({ transactions }) {
  const total = transactions.reduce((sum, t) => sum + t.amount, 0); // recalculé à chaque render
  return <Total value={total} />;
}
```

**Après**
```jsx
function Dashboard({ transactions }) {
  const total = useMemo(
    () => transactions.reduce((sum, t) => sum + t.amount, 0),
    [transactions]
  );
  return <Total value={total} />;
}
```

### Dépendances de Hooks incorrectes

**Avant**
```jsx
useEffect(() => {
  fetchUserData(userId);
}, []); // userId omis : l'effet ne se relance jamais si userId change
```

**Après**
```jsx
useEffect(() => {
  fetchUserData(userId);
}, [userId]);
```
Une dépendance manquante n'est pas qu'un bug de correction (voir skill `debug`) — c'est aussi une source de perf trompeuse : soit l'effet ne se relance jamais quand il faudrait, soit (cas inverse) il se relance à chaque render faute de mémoïsation de sa dépendance.

## React Native — signaux à repérer (analyse complète : `react-native-perf-doctor`)

- `.map()` dans un `ScrollView` pour une liste potentiellement longue → signal de non-virtualisation.
- Fonctions/objets créés inline dans un `renderItem` de `FlatList` → signal de re-render évitable par item.
- `useEffect` avec abonnement/timer sans fonction de nettoyage visible → signal de fuite mémoire potentielle.
- Images chargées sans dimension explicite ni lib de cache → signal de décodage en pleine résolution inutile.
- Animation `Animated` sans `useNativeDriver` → signal d'animation sur le thread JS.

Pour chacun de ces signaux, le rapport de `performance-review` doit se limiter à les lister avec leur emplacement, et recommander `react-native-perf-doctor` pour l'analyse fine et la correction — pas reproduire ici tout le détail de cette skill.
