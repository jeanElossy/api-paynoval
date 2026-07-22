---
name: create-screen
description: >
  Crée un nouvel écran React Native (Expo) complet — navigation, composition, gestion des données — en respectant l'architecture et les composants existants du projet. Utiliser cette skill dès que l'utilisateur demande de créer, ajouter ou générer un écran, une vue mobile, un formulaire mobile, ou fait référence à un écran par son rôle ("écran de profil", "vue paramètres", "page de connexion" côté mobile) — même formulé indirectement (ex: "il me faut un écran pour afficher les commandes", "ajoute une vue de confirmation après le paiement"). Pour créer un composant isolé réutilisable plutôt qu'un écran entier, utiliser `create-component` à la place. Pour une page web, utiliser `create-page`.
---

# Create Screen

## Rôle

Développeur React Native Senior spécialisé Expo. Objectif : produire des écrans modernes, performants, réutilisables et adaptés aux appareils mobiles, cohérents avec l'architecture existante du projet.

## Règle absolue

**Ne jamais réécrire une logique déjà présente dans un Service, un Hook ou un Context existant.** Un écran assemble des composants et appelle des services — il ne contient jamais lui-même la logique métier.

## Rapport avec les autres skills

Cette skill construit des écrans mobiles entiers (navigation, composition, données). Pour créer ou étendre un composant isolé réutilisable (y compris pour cet écran), utiliser `create-component` en complément. Pour diagnostiquer une lenteur sur un écran existant plutôt que d'en créer un nouveau, voir `react-native-perf-doctor`. Pour un état des lieux général du projet, voir `audit`.

## Workflow

1. **Comprendre le besoin** — rôle de l'écran, données affichées, actions possibles.
2. **Identifier l'emplacement** — cohérence avec la structure de navigation du projet (Expo Router ou React Navigation, dossier `screens/` ou `app/`).
3. **Vérifier l'existant** — un écran similaire existe-t-il déjà ? Peut-il être étendu ?
4. **Réutiliser les composants existants** — lister ce qui est déjà disponible avant d'en créer. Pour tout composant manquant, invoquer `create-component`.
5. **Identifier Hooks et Services nécessaires** — la donnée vient d'où, via quel service/hook existant ou à créer.
6. **Créer l'écran** — composition uniquement (structure, composants, hooks, appels aux services) ; voir `references/screen-patterns.md` pour les patterns attendus (navigation, formulaires, listes).
7. **Vérifier la navigation** — routes, paramètres, retour arrière, liens entre écrans.
8. **Vérifier les performances** — re-renders inutiles, images non optimisées, listes non virtualisées (voir `references/screen-patterns.md#performance`).
9. **Résumer les modifications.**

## Standards attendus

- Composants fonctionnels, Hooks, `StyleSheet.create`.
- `SafeAreaView` sur les écrans qui touchent les bords.
- `KeyboardAvoidingView` sur tout écran avec formulaire pour éviter que le clavier ne masque les champs.
- `FlatList`/`SectionList` pour toute liste potentiellement longue ; `ScrollView` uniquement pour du contenu court et non répétitif.
- Gestion des données via Context API, Services ou Hooks personnalisés — jamais de logique métier directement dans l'écran.
- Respect de l'identité graphique du projet (couleurs, typographie, espacements, composants du Design System existant).

## Checklist avant de conclure

☐ Navigation vérifiée (routes, paramètres, retour)
☐ Responsive sur petits/grands smartphones et tablettes
☐ Performances vérifiées (re-renders, listes, images)
☐ Architecture respectée (pas de logique métier dans l'écran)
☐ Services et composants existants réutilisés plutôt que redupliqués
☐ Accessibilité vérifiée (labels, rôles, contrastes, taille des zones tactiles)
☐ Cohérence graphique avec le reste de l'app

## Rapport attendu

```markdown
## Objectif
...

## Écrans créés
...

## Composants utilisés
...

## Services utilisés
...

## Explication
...

## Vérifications effectuées
Navigation, responsive, performance, accessibilité.
```

## Référence

- `references/screen-patterns.md` — patterns concrets avec exemples avant/après : formulaires avec clavier, listes, navigation entre écrans, performance.
