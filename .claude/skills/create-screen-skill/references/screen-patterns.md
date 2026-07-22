# Patterns d'écran React Native

## Formulaire et clavier

**Avant**
```jsx
function LoginScreen() {
  return (
    <View style={styles.container}>
      <TextInput placeholder="Email" />
      <TextInput placeholder="Mot de passe" secureTextEntry />
      <Button title="Se connecter" onPress={handleLogin} />
    </View>
  );
}
```
Sur iOS/Android, le clavier peut masquer les champs ou le bouton sans que rien ne s'ajuste.

**Après**
```jsx
function LoginScreen() {
  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <TextInput placeholder="Email" />
      <TextInput placeholder="Mot de passe" secureTextEntry />
      <Button title="Se connecter" onPress={handleLogin} />
    </KeyboardAvoidingView>
  );
}
```

## Écran avec liste de données

**Avant**
```jsx
function OrdersScreen({ orders }) {
  return (
    <ScrollView>
      {orders.map(o => <OrderCard key={o.id} order={o} />)}
    </ScrollView>
  );
}
```
Toute la liste est montée en mémoire même hors écran.

**Après**
```jsx
function OrdersScreen({ orders }) {
  return (
    <SafeAreaView style={{ flex: 1 }}>
      <FlatList
        data={orders}
        keyExtractor={o => o.id}
        renderItem={({ item }) => <OrderCard order={item} />}
      />
    </SafeAreaView>
  );
}
```

## Navigation entre écrans avec paramètres

**Avant**
```jsx
navigation.navigate('OrderDetail');
```
L'écran cible n'a aucune information sur quelle commande afficher.

**Après**
```jsx
navigation.navigate('OrderDetail', { orderId: order.id });

// Dans OrderDetailScreen :
function OrderDetailScreen({ route }) {
  const { orderId } = route.params;
  const { data: order } = useOrder(orderId); // hook custom qui appelle le service
  // ...
}
```
La logique de récupération de la donnée reste dans un hook/service, pas dans l'écran.

## Écran = composition, pas logique métier

**Avant**
```jsx
function ProfileScreen() {
  const [user, setUser] = useState(null);
  useEffect(() => {
    fetch(`https://api.example.com/users/me`)
      .then(r => r.json())
      .then(data => {
        const formatted = { ...data, fullName: `${data.firstName} ${data.lastName}` };
        setUser(formatted);
      });
  }, []);
  // ...
}
```
L'appel réseau et la logique de formatage sont directement dans l'écran.

**Après**
```jsx
function ProfileScreen() {
  const { user, loading } = useCurrentUser(); // hook qui appelle userService
  if (loading) return <LoadingSpinner />;
  return <ProfileContent user={user} />;
}
```
L'écran ne fait que composer : hook pour la donnée, composant pour l'affichage.

## Performance

Points à vérifier systématiquement sur un nouvel écran :
- Callbacks passés aux composants enfants mémoïsés avec `useCallback` s'ils sont recréés à chaque render.
- Images redimensionnées à la taille d'affichage réelle, pas en pleine résolution.
- Animations avec `useNativeDriver: true` quand la propriété animée le permet.
- Pas de calcul lourd non mémoïsé dans le corps du composant (utiliser `useMemo`).
