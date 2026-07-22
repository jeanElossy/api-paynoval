# Checklist SEO — exemples concrets

## Titre de page

**Avant**
```jsx
<title>Accueil</title>
```
Trop générique, ne décrit ni le site ni le contenu de la page.

**Après**
```jsx
<title>Services de coaching en ligne | NomDuSite</title>
```
Descriptif, inclut le nom du site, sous ~60 caractères pour ne pas être tronqué dans les résultats de recherche.

## Meta description

**Avant** : absente.

**Après**
```jsx
<meta name="description" content="Découvrez nos programmes de coaching personnalisés pour atteindre vos objectifs, avec un accompagnement sur mesure." />
```
Environ 150-160 caractères, résume le contenu de la page de façon incitative.

## Hiérarchie de titres

**Avant**
```jsx
<div className="title-big">Nos Services</div>
<div className="title-medium">Coaching individuel</div>
```
Aucune balise de titre réelle — invisible pour les moteurs de recherche et les lecteurs d'écran.

**Après**
```jsx
<h1>Nos Services</h1>
<h2>Coaching individuel</h2>
```
Une seule `h1` par page, hiérarchie logique ensuite (`h2`, `h3`...) sans saut de niveau.

## URLs propres

**Avant** : `/page?id=4827&cat=2`

**Après** : `/services/coaching-individuel`

Lisible, descriptive, stable dans le temps.

## Balises sémantiques

Préférer les éléments HTML sémantiques aux `div` génériques quand la structure s'y prête :
```jsx
<header>...</header>
<nav>...</nav>
<main>
  <article>...</article>
</main>
<footer>...</footer>
```
Aide à la fois le SEO et l'accessibilité (lecteurs d'écran).

## Images

- `alt` descriptif sur toute image informative (`alt=""` pour les images purement décoratives).
- Nom de fichier descriptif plutôt que `IMG_2847.jpg`.
- Format et poids optimisés pour ne pas pénaliser la vitesse de chargement (qui est elle-même un facteur SEO).
