# Architecture du projet

## Nom du projet

CAVA Website

---

# Description

Le projet CAVA est le site officiel de l'église.

L'objectif est de proposer une expérience moderne, rapide, accessible et responsive.

Le site doit être facilement maintenable et évolutif.

---

# Stack technique

Frontend :

- React
- JavaScript (JSX)
- Vite

Styles :

- CSS
- CSS Modules ou fichiers CSS dédiés (selon les besoins)

Icônes :

- Lucide React

Animations :

- Framer Motion (si utilisé)

---

# Architecture générale

Le projet suit une architecture modulaire.

Chaque dossier possède une responsabilité précise.

Exemple :

src/

├── assets/
├── components/
├── pages/
├── layouts/
├── sections/
├── hooks/
├── services/
├── utils/
├── constants/
├── context/
├── styles/

---

# Organisation des composants

Les composants doivent être :

- petits
- réutilisables
- indépendants
- faciles à tester

Éviter les composants dépassant plusieurs centaines de lignes.

Lorsqu'un composant devient trop volumineux, le découper.

---

# Pages

Chaque page représente une route principale.

Exemples :

HomePage.jsx

AboutPage.jsx

EventsPage.jsx

ContactPage.jsx

GalleryPage.jsx

DonatePage.jsx

---

# Sections

Une page est composée de plusieurs sections.

Par exemple :

HomePage

↓

HeroSection

AboutSection

VisionSection

EventsSection

GallerySection

Footer

Chaque section reste indépendante.

---

# Composants

Les composants réutilisables sont placés dans :

components/

Exemples :

Button

Card

Navbar

Footer

Modal

Input

Badge

Accordion

---

# Gestion des données

Les données statiques doivent être placées dans :

constants/

ou

data/

Éviter de laisser des données directement dans les composants.

---

# Styles

Chaque composant possède son propre fichier CSS lorsque nécessaire.

Éviter les gros fichiers CSS contenant tout le projet.

---

# Images

Toutes les images sont stockées dans :

assets/

Organiser les images par catégorie.

Exemple :

assets/

images/

logos/

icons/

backgrounds/

team/

events/

---

# Performance

Toujours :

- optimiser les images
- limiter les dépendances
- utiliser le lazy loading lorsque c'est pertinent
- éviter les imports inutiles

---

# Accessibilité

Toujours respecter :

- navigation clavier
- contrastes suffisants
- textes alternatifs des images
- structure HTML correcte

---

# SEO

Toujours optimiser :

- titres
- méta descriptions
- structure des titres H1 → H6
- URLs
- performances

---

# Principe d'évolution

Toute nouvelle fonctionnalité doit :

- respecter cette architecture
- réutiliser les composants existants
- éviter la duplication
- conserver une structure claire

Ne jamais casser l'organisation actuelle du projet.