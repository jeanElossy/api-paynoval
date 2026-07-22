# Checklist détaillée — patterns de performance React Native

Chaque section : le symptôme, comment le repérer dans le code, et un exemple avant/après.

## 1. Re-renders excessifs

### 1.1 Callback/objet inline sans mémoïsation

**Avant**
```jsx
function ParentList({ items }) {
  return items.map(item => (
    <Row key={item.id} onPress={() => handlePress(item.id)} style={{ padding: 8 }} />
  ));
}
```

**Après**
```jsx
const rowStyle = { padding: 8 };

function ParentList({ items }) {
  const handlePress = useCallback((id) => { /* ... */ }, []);
  return items.map(item => (
    <Row key={item.id} onPress={handlePress} id={item.id} style={rowStyle} />
  ));
}

const Row = React.memo(function Row({ id, onPress, style }) {
  return <Pressable onPress={() => onPress(id)} style={style}>...</Pressable>;
});
```
Sans `React.memo` + props stables, chaque render du parent recrée une nouvelle fonction et un nouvel objet à chaque item, ce qui invalide toute mémoïsation en aval et force un re-render de toute la liste.

### 1.2 Context qui change trop souvent

**Avant**
```jsx
<MyContext.Provider value={{ user, theme, updateUser }}>
```
Un nouvel objet littéral est créé à chaque render du Provider → tous les consommateurs re-rendent, même ceux qui n'utilisent que `theme`.

**Après**
```jsx
const value = useMemo(() => ({ user, theme, updateUser }), [user, theme]);
<MyContext.Provider value={value}>
```
Mieux encore : séparer en plusieurs contexts (UserContext, ThemeContext) si les fréquences de mise à jour diffèrent beaucoup.

## 2. Listes non virtualisées

**Avant**
```jsx
<ScrollView>
  {messages.map(m => <MessageBubble key={m.id} message={m} />)}
</ScrollView>
```
Toutes les lignes sont montées en mémoire et rendues même hors écran → lenteur au scroll et mémoire qui grimpe avec la taille de la liste.

**Après**
```jsx
<FlatList
  data={messages}
  keyExtractor={m => m.id}
  renderItem={({ item }) => <MessageBubble message={item} />}
  initialNumToRender={15}
  windowSize={7}
/>
```
`FlatList` ne monte que les lignes visibles (+ une fenêtre autour) au lieu de toute la liste.

## 3. Fuites mémoire — listeners/timers sans cleanup

**Avant**
```jsx
useEffect(() => {
  const sub = Dimensions.addEventListener('change', onChange);
  const id = setInterval(poll, 3000);
}, []);
```
Ni le listener ni le timer ne sont jamais retirés : ils continuent de tourner et de retenir des références au composant après son démontage.

**Après**
```jsx
useEffect(() => {
  const sub = Dimensions.addEventListener('change', onChange);
  const id = setInterval(poll, 3000);
  return () => {
    sub.remove();
    clearInterval(id);
  };
}, []);
```

## 4. setState après démontage

**Avant**
```jsx
useEffect(() => {
  fetchData().then(data => setState(data));
}, []);
```
Si le composant est démonté avant la résolution de la promesse, `setState` s'exécute quand même et retient le composant en mémoire (et peut logger un warning).

**Après**
```jsx
useEffect(() => {
  let cancelled = false;
  fetchData().then(data => {
    if (!cancelled) setState(data);
  });
  return () => { cancelled = true; };
}, []);
```

## 5. Images non optimisées

**Avant**
```jsx
<Image source={{ uri: fullResUrl }} style={{ width: 60, height: 60 }} />
```
Une image en pleine résolution est décodée en mémoire même si elle est affichée en miniature.

**Après**
- Servir une URL déjà redimensionnée côté backend/CDN quand possible.
- Sinon, utiliser une lib de cache/redimensionnement (`expo-image`, `react-native-fast-image`) qui décode à la taille cible.

## 6. Animations sur le thread JS

**Avant**
```jsx
Animated.timing(value, { toValue: 1, duration: 300 }).start();
```
Sans précision, l'animation peut tourner sur le thread JS, ce qui la fait saccader si le thread JS est occupé ailleurs.

**Après**
```jsx
Animated.timing(value, { toValue: 1, duration: 300, useNativeDriver: true }).start();
```
Décharge l'animation sur le thread natif — ne fonctionne que pour les propriétés animables nativement (opacity, transform).

## 7. Calculs lourds dans le render

**Avant**
```jsx
function Screen({ items }) {
  const sorted = items.slice().sort(expensiveCompare);
  return <List data={sorted} />;
}
```
Le tri s'exécute à chaque render, même si `items` n'a pas changé.

**Après**
```jsx
function Screen({ items }) {
  const sorted = useMemo(() => items.slice().sort(expensiveCompare), [items]);
  return <List data={sorted} />;
}
```

## 8. Écrans de navigation qui accumulent du state

Repérer les stacks de navigation où les écrans précédents ne sont jamais démontés (ex: beaucoup d'écrans empilés avec state lourd, listeners actifs même hors écran). Selon la lib de navigation utilisée, vérifier les options de démontage au blur ou de limitation de la pile, et s'assurer que les écrans avec des abonnements actifs les nettoient sur blur/unmount et pas seulement sur unmount.
