---
name: create-component
description: >
  Crée un composant React ou React Native professionnel, réutilisable et performant en respectant les standards du projet. Utiliser cette skill dès que l'utilisateur demande de créer, ajouter, ou générer un composant, un écran, une card, un formulaire, une modale, un bouton ou tout élément d'UI React/React Native — même formulé indirectement (ex: "j'ai besoin d'un truc pour afficher la liste des produits", "ajoute une popup de confirmation", "il me faut un écran de profil"). Toujours consulter cette skill avant de créer un composant à la main, pour vérifier d'abord si un composant existant peut être réutilisé ou étendu plutôt que dupliqué.
---

# Create Component

## Rôle

Développeur Frontend Senior spécialisé React et React Native. Objectif : produire des composants modernes, réutilisables, performants et faciles à maintenir, cohérents avec l'architecture existante du projet.

## Règle absolue

**Ne jamais créer un nouveau composant si un composant existant peut être réutilisé ou étendu.** Chercher activement avant de coder — voir étape 3 du workflow.

## Rapport avec les autres skills

Cette skill couvre la création et les patterns de composants. Pour créer une page web complète (route, composition de sections, SEO), utiliser `create-page` — qui invoque elle-même cette skill pour chaque composant réutilisable manquant. Pour créer un écran mobile complet (navigation, données), utiliser `create-screen` de la même façon. Pour un diagnostic de performance mobile approfondi sur du code React Native existant (pas de la création), voir `react-native-perf-doctor`. Pour un état des lieux général du projet, voir `audit`.

## Workflow

1. **Comprendre le besoin** — quel est le rôle du composant, où sera-t-il utilisé, quelles données affiche-t-il.
2. **Identifier l'emplacement** — repérer la convention de dossiers du projet (ex: `components/`, `screens/`, `features/<domaine>/components/`) et y placer le composant en cohérence avec l'existant.
3. **Chercher l'existant** — parcourir les composants déjà présents pour voir si l'un d'eux couvre déjà (ou presque) le besoin. Privilégier l'extension (nouvelle prop, variante) à la duplication.
4. **Réutiliser si possible** — si un composant proche existe, l'étendre plutôt que d'en créer un nouveau ; documenter ce choix dans le rapport final.
5. **Créer le composant** — voir `references/react-patterns.md` (web) ou `references/react-native-patterns.md` (mobile) pour les patterns attendus.
6. **Vérifier l'intégration** — le composant s'intègre-t-il proprement là où il est appelé (props cohérentes, pas de duplication de logique avec le parent) ?
7. **Vérifier les performances** — re-renders inutiles, imports superflus, calculs coûteux non mémoïsés (voir `references/react-patterns.md#performance`).
8. **Résumer les modifications** — voir format de rapport ci-dessous.

## Standards attendus

### React (web)
- Composants fonctionnels avec Hooks, jamais de classes.
- `const` par défaut, pas de `var`/`let` évitable.
- Composants courts et lisibles ; extraire la logique complexe dans un hook custom plutôt que de gonfler le composant.
- Props explicites et limitées au strict nécessaire — pas de props "au cas où".
- Accessibilité web : labels sur les champs, navigation clavier possible, contrastes suffisants, texte alternatif sur les images.

### React Native
- `StyleSheet.create` pour les styles, jamais de styles inline répétés.
- `SafeAreaView` quand l'écran touche les bords (notch, barre de statut).
- `FlatList`/`SectionList` pour toute liste potentiellement longue — jamais `.map()` dans un `ScrollView` pour une liste de données.
- Voir `references/react-native-patterns.md` pour les optimisations de performance courantes (mémoïsation, callbacks stables, images).

### Cohérence UI
- Respecter les couleurs, la typographie et les espacements déjà utilisés dans le projet (chercher un fichier de thème/design tokens s'il existe) plutôt que d'introduire de nouvelles valeurs.
- Réutiliser les composants UI de base déjà présents (boutons, inputs, cards) plutôt que d'en recréer des variantes.

## Checklist avant de conclure

☐ Un composant existant a été cherché avant d'en créer un nouveau
☐ Composant réutilisable et indépendant (pas de dépendance cachée au contexte du parent)
☐ Code lisible, composants fonctionnels + Hooks
☐ Props explicites et minimales
☐ Re-renders inutiles vérifiés (mémoïsation si nécessaire)
☐ Cohérence UI respectée (couleurs, typographie, espacements existants)
☐ Accessibilité vérifiée
☐ Aucun code dupliqué avec un composant existant

## Rapport attendu

```markdown
## Objectif
Ce que fait le composant et pourquoi il a été créé (ou pourquoi un existant a été étendu).

## Fichiers créés
...

## Fichiers modifiés
...

## Explication
Choix techniques notables (état, mémoïsation, structure des props).

## Vérifications effectuées
Performance, accessibilité, cohérence UI, réutilisabilité.
```

## Référence

- `references/react-patterns.md` — patterns React (web) attendus avec exemples avant/après : mémoïsation, structure de props, accessibilité.
- `references/react-native-patterns.md` — patterns React Native attendus avec exemples avant/après : listes, styles, SafeAreaView, performance.
