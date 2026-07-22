# Patterns React Native

## Listes : FlatList plutôt que .map()

**Avant**
```jsx
<ScrollView>
  {products.map(p => <ProductCard key={p.id} product={p} />)}
</ScrollView>
```
Toute la liste est montée en mémoire, même hors écran.

**Après**
```jsx
<FlatList
  data={products}
  keyExtractor={p => p.id}
  renderItem={({ item }) => <ProductCard product={item} />}
/>
```

## StyleSheet plutôt que styles inline

**Avant**
```jsx
<View style={{ padding: 16, backgroundColor: '#fff', borderRadius: 8 }}>
```
Objet recréé à chaque render, pas de validation à la compilation.

**Après**
```jsx
const styles = StyleSheet.create({
  card: { padding: 16, backgroundColor: '#fff', borderRadius: 8 },
});

<View style={styles.card}>
```

## SafeAreaView sur les écrans

**Avant**
```jsx
function ProfileScreen() {
  return (
    <View>
      <Header />
      <ProfileContent />
    </View>
  );
}
```
Le contenu peut être caché par l'encoche ou la barre de statut.

**Après**
```jsx
import { SafeAreaView } from 'react-native-safe-area-context';

function ProfileScreen() {
  return (
    <SafeAreaView style={{ flex: 1 }}>
      <Header />
      <ProfileContent />
    </SafeAreaView>
  );
}
```

## Callbacks stables pour les items de liste

**Avant**
```jsx
<FlatList
  data={products}
  renderItem={({ item }) => (
    <ProductCard product={item} onPress={() => navigate('Detail', { id: item.id })} />
  )}
/>
```
Nouvelle fonction créée à chaque render de chaque ligne.

**Après**
```jsx
const handlePress = useCallback((id) => {
  navigate('Detail', { id });
}, [navigate]);

<FlatList
  data={products}
  renderItem={({ item }) => (
    <ProductCard product={item} onPress={handlePress} />
  )}
/>
```
Combiner avec `React.memo` sur `ProductCard` pour éviter les re-renders des lignes non affectées.

## Images

**Avant**
```jsx
<Image source={{ uri: product.fullResImageUrl }} style={{ width: 60, height: 60 }} />
```
Décode l'image en pleine résolution même pour une miniature.

**Après**
- Utiliser une URL déjà redimensionnée côté backend/CDN si possible.
- Sinon, une lib de cache/redimensionnement (`expo-image`, `react-native-fast-image`) pour décoder à la bonne taille et bénéficier du cache disque.
