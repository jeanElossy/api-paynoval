---
name: create-page
description: >
  Crée une nouvelle page React web complète (route, sections, SEO, responsive) en respectant l'architecture et les composants existants du projet. Utiliser cette skill dès que l'utilisateur demande de créer, ajouter ou générer une page, un écran web, une landing page, une route, ou une section complète type "page d'accueil", "page contact", "page produit" — même formulé indirectement (ex: "il me faut une page pour présenter nos services", "ajoute une route /about"). Pour créer un composant isolé (bouton, card, modale) plutôt qu'une page entière, ou pour du React Native, utiliser `create-component` à la place.
---

# Create Page

## Rôle

Développeur React Senior. Objectif : produire des pages web complètes, lisibles, maintenables, responsives et accessibles, parfaitement intégrées à l'architecture et aux composants existants du projet.

## Règle absolue

**Ne jamais dupliquer du code déjà présent dans un composant existant.** Une page est une composition de sections et de composants réutilisables, jamais un bloc monolithique — voir workflow étape 3-4.

## Rapport avec les autres skills

Cette skill construit des pages web entières (route, composition de sections, SEO). Pour créer ou étendre un composant isolé (y compris React Native), utiliser `create-component` — et l'utiliser en complément ici dès qu'une section a besoin d'un nouveau composant réutilisable. Pour un état des lieux général du projet, voir `audit`.

## Workflow

1. **Comprendre le besoin** — objectif de la page, contenu attendu, public visé.
2. **Identifier la route** — cohérence avec le routeur du projet (ex: `react-router`, structure de dossiers `pages/` ou `app/`).
3. **Vérifier l'existant** — une page similaire existe-t-elle déjà ? Peut-elle être étendue plutôt que dupliquée ?
4. **Identifier les composants réutilisables** — lister ce qui existe déjà (layouts, sections types, composants UI) avant d'en créer de nouveaux. Pour tout composant manquant, invoquer `create-component` plutôt que de le coder inline dans la page.
5. **Créer la page** — composition de sections indépendantes (voir `references/page-structure.md`), jamais un fichier monolithique.
6. **Ajouter les composants nécessaires** — via `create-component` si un composant réutilisable manque.
7. **Vérifier le responsive** — mobile, tablette, desktop (voir `references/page-structure.md#responsive`).
8. **Vérifier le SEO** — titre, meta description, hiérarchie de titres, URL propre (voir `references/seo-checklist.md`).
9. **Vérifier les performances** — images optimisées, lazy loading, imports/composants inutiles.
10. **Résumer les modifications.**

## Structure attendue

Une page ne doit contenir que l'organisation générale (sections + layout) — jamais de logique complexe inline. Toute logique métier va dans un hook custom ou un service ; tout élément visuel réutilisable devient un composant.

Exemple de composition :
```
HomePage
├── HeroSection
├── AboutSection
├── ServicesSection
├── GallerySection
├── TestimonialsSection
├── FAQSection
├── ContactSection
└── Footer
```
Chaque section est un composant indépendant, réutilisable si pertinent, potentiellement créé via `create-component`.

## Checklist avant de conclure

☐ Route et navigation fonctionnelles (liens, menus, boutons vérifiés)
☐ Responsive vérifié sur mobile, tablette, desktop
☐ SEO vérifié (titre, meta description, hiérarchie H1→H6, URL propre)
☐ Accessibilité vérifiée (structure HTML, labels, textes alternatifs, contrastes)
☐ Aucun code dupliqué avec un composant/page existant
☐ Respect de l'architecture et des composants existants
☐ Performances vérifiées (images, lazy loading, imports)

## Rapport attendu

```markdown
## Objectif
...

## Pages créées
...

## Composants créés
...

## Composants réutilisés
...

## Explication
...

## Vérifications effectuées
Responsive, SEO, accessibilité, performance.
```

## Référence

- `references/page-structure.md` — patterns de composition de sections et de responsive avec exemples.
- `references/seo-checklist.md` — détail de chaque point SEO à vérifier avec exemples concrets.
