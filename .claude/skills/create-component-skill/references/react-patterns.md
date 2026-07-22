# Patterns React (web)

## Props explicites et minimales

**Avant**
```jsx
function ProductCard({ data }) {
  return <div>{data.name} - {data.price}</div>;
}
```
`data` est vague — le composant appelant ne sait pas quoi passer sans aller lire le code.

**Après**
```jsx
function ProductCard({ name, price, imageUrl }) {
  return (
    <div>
      <img src={imageUrl} alt={name} />
      <span>{name}</span>
      <span>{price}</span>
    </div>
  );
}
```
Chaque prop est explicite, le composant est auto-documenté par sa signature.

## Mémoïsation et re-renders

**Avant**
```jsx
function ProductList({ products }) {
  return products.map(p => (
    <ProductCard key={p.id} onSelect={() => handleSelect(p.id)} />
  ));
}
```
Une nouvelle fonction est créée à chaque render pour chaque item.

**Après**
```jsx
const ProductCard = React.memo(function ProductCard({ id, onSelect }) {
  return <div onClick={() => onSelect(id)}>...</div>;
});

function ProductList({ products }) {
  const handleSelect = useCallback((id) => { /* ... */ }, []);
  return products.map(p => (
    <ProductCard key={p.id} id={p.id} onSelect={handleSelect} />
  ));
}
```

## Extraire la logique complexe dans un hook

**Avant**
```jsx
function SearchBar() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    setLoading(true);
    const id = setTimeout(() => {
      fetchResults(query).then(r => { setResults(r); setLoading(false); });
    }, 300);
    return () => clearTimeout(id);
  }, [query]);
  return (/* JSX mêlé à toute cette logique */);
}
```

**Après**
```jsx
function useDebouncedSearch(query, delay = 300) {
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    setLoading(true);
    const id = setTimeout(() => {
      fetchResults(query).then(r => { setResults(r); setLoading(false); });
    }, delay);
    return () => clearTimeout(id);
  }, [query, delay]);
  return { results, loading };
}

function SearchBar() {
  const [query, setQuery] = useState('');
  const { results, loading } = useDebouncedSearch(query);
  return (/* JSX propre, logique isolée dans le hook */);
}
```
Le composant reste lisible ; le hook est testable et réutilisable ailleurs.

## Accessibilité

**Avant**
```jsx
<div onClick={handleClick}>Valider</div>
```
Pas de sémantique bouton, inaccessible au clavier.

**Après**
```jsx
<button onClick={handleClick}>Valider</button>
```
Ou si un style custom est nécessaire sur un élément non natif :
```jsx
<div role="button" tabIndex={0} onClick={handleClick} onKeyDown={handleKeyDown}>
  Valider
</div>
```

Toujours vérifier :
- `alt` sur les images informatives (vide `alt=""` pour les images décoratives)
- `label`/`aria-label` sur les champs de formulaire
- focus visible et navigable au clavier sur tout élément interactif
- contraste suffisant entre texte et fond
