# Création d'un composant

## Objectif

Créer un composant professionnel, réutilisable, maintenable et performant.

Le composant doit respecter l'architecture, le Design System et les Coding Standards du projet.

Ne jamais créer un composant qui duplique une fonctionnalité existante.

---

# Workflow obligatoire

Toujours respecter cet ordre.

---

## 1. Comprendre le besoin

Identifier :

- le rôle du composant
- les utilisateurs concernés
- le contexte d'utilisation
- les interactions attendues
- les contraintes techniques

Si des informations sont manquantes, poser les questions nécessaires.

---

## 2. Vérifier l'existant

Analyser :

- les composants existants
- les composants similaires
- le Design System
- les composants partagés
- les Hooks existants

Toujours privilégier la réutilisation.

---

## 3. Définir les responsabilités

Le composant doit avoir une responsabilité unique.

Éviter les composants qui gèrent plusieurs fonctionnalités différentes.

---

## 4. Définir les propriétés (Props)

Lister :

- les props obligatoires
- les props optionnelles
- les valeurs par défaut
- les événements
- les callbacks

Les props doivent être explicites.

---

## 5. Vérifier l'architecture

Toujours respecter :

- composants réutilisables
- séparation de la logique
- séparation de la présentation
- Hooks personnalisés lorsque nécessaire

---

## 6. Performance

Toujours analyser :

- React.memo
- useMemo
- useCallback
- calculs inutiles
- re-render inutiles

Optimiser uniquement lorsque cela apporte un bénéfice réel.

---

## 7. Accessibilité

Toujours vérifier :

- labels
- rôles
- navigation clavier (Web)
- taille des zones tactiles (Mobile)
- contraste
- lecteurs d'écran

---

## 8. Responsive

Le composant doit fonctionner sur :

- Mobile
- Tablette
- Desktop (Web)

---

## 9. Gestion des erreurs

Toujours prévoir :

- valeurs nulles
- données manquantes
- états de chargement
- états d'erreur
- états vides

---

## 10. Documentation

Documenter :

- le rôle du composant
- les props
- les événements
- les exemples d'utilisation

---

## 11. Tests

Toujours prévoir :

- rendu normal
- props invalides
- événements
- interactions utilisateur
- cas limites

---

## 12. Résumé

Toujours terminer par :

## Composant créé

...

---

## Responsabilités

...

---

## Props

...

---

## États gérés

...

---

## Optimisations

...

---

## Accessibilité

...

---

## Tests

...

---

## Recommandations

...

---

# Checklist

☐ Responsabilité unique

☐ Props explicites

☐ Réutilisable

☐ Responsive

☐ Accessible

☐ Performant

☐ Conforme au Design System

☐ Tests prévus

☐ Documentation créée

☐ Aucune duplication

---

# Philosophie

Un composant est une brique réutilisable de l'application.

Chaque composant doit être :

- simple
- cohérent
- réutilisable
- facilement testable
- performant
- accessible
- évolutif

Tu refuses de créer un composant qui duplique un composant existant ou qui mélange plusieurs responsabilités.