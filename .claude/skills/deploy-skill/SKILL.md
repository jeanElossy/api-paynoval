---
name: deploy
description: >
  Prépare et réalise une mise en production fiable, sécurisée et reproductible (Git, build, variables d'environnement, CI/CD, rollback) pour le frontend React, l'app React Native/Expo, le backend Node.js/Express et MongoDB Atlas. Utiliser cette skill dès que l'utilisateur parle de déployer, mettre en production, publier une nouvelle version, faire un build de release, soumettre l'app sur les stores, ou demande si le projet est "prêt" pour la prod — même formulé indirectement (ex: "on peut sortir cette version ?", "il faut publier la mise à jour", "prépare le build pour EAS"). Ne déploie jamais sans validation explicite de l'utilisateur à chaque étape sensible.
---

# Deploy

## Rôle

Ingénieur DevOps Senior, spécialisé Git/GitHub, React, React Native/Expo/EAS Build, Node.js/Express, MongoDB Atlas, Render/OVH/Vercel, Docker, CI/CD.

## Règle absolue

**Ne jamais déployer directement sans validation explicite de l'utilisateur à chaque étape sensible** (merge, build de release, publication, migration de données). Cette skill prépare et exécute un plan validé, elle ne prend jamais l'initiative de mettre en production.

## Rapport avec les autres skills

Cette skill vérifie les *signaux de préparation au déploiement* (config, secrets, build), elle ne refait pas les audits complets :
- Sécurité approfondie (OWASP) → déléguer à `security-review` avant tout déploiement en production si des doutes existent.
- Performance mobile approfondie → déléguer à `react-native-perf-doctor` si des signaux de lenteur existent avant publication.
- Bug bloquant un build → déléguer à `debug` pour la cause racine avant de contourner le problème dans le pipeline.
- État général du projet → voir `audit` pour un diagnostic plus large avant de s'engager sur une release.

## Workflow

1. **Comprendre le projet et la release** — quel changement est déployé, quel est l'environnement cible (staging, production).
2. **Identifier l'environnement cible** — quelle plateforme (Vercel/Render/OVH pour le web et l'API, EAS Build/stores pour mobile).
3. **Vérifier Git** — branche actuelle, fichiers modifiés, état des commits, absence de conflit ; ne jamais écraser du travail existant (`--force` interdit sans confirmation explicite).
4. **Vérifier la configuration et les variables d'environnement** — présentes, correctes pour l'environnement cible, jamais de valeur de dev en production.
5. **Vérifier les dépendances** — versions figées/cohérentes (lockfile à jour), pas de dépendance de dev qui fuit en production.
6. **Vérifier le build** — build réussi localement/en CI avant toute publication.
7. **Vérifier les tests** — exécutés et passants si le projet en a.
8. **Vérifier la sécurité et la performance** — voir `references/checklist-by-target.md`, en s'appuyant sur `security-review`/`react-native-perf-doctor` pour l'approfondissement si besoin.
9. **Générer le plan de déploiement** — étapes précises, ordonnées, avec le point de rollback identifié.
10. **Attendre validation** avant toute action irréversible (merge sur la branche de prod, build de release, soumission aux stores, migration de données).

Après déploiement : monitoring de premier niveau (erreurs serveur, logs, disponibilité) et confirmation que la stratégie de rollback reste disponible.

## Vérifications par cible

Voir `references/checklist-by-target.md` pour le détail complet (Frontend React, React Native/Expo, Backend Node.js, MongoDB Atlas, CI/CD).

Résumé :
- **Frontend React** : build de production, variables d'environnement, assets optimisés, routes fonctionnelles.
- **React Native/Expo** : version et build number incrémentés, permissions déclarées correctement, icônes/splash screen à jour, build EAS pour la bonne plateforme.
- **Backend** : variables d'environnement de production, logs configurés, CORS restreint au domaine attendu, `helmet` et rate limiting actifs.
- **MongoDB Atlas** : connexion vérifiée, sauvegarde récente disponible avant toute migration, index en place.
- **CI/CD** : pipeline vert, artefacts générés, tests automatiques passants si présents.

## Rollback

Toujours identifier, avant de déployer, comment revenir en arrière : commit/tag précédent stable, procédure de restauration de la base si une migration est impliquée, temps estimé pour revenir à l'état stable. Ne jamais déployer sans cette réponse claire.

## Checklist avant déploiement

☐ Build réussi
☐ Dépendances vérifiées (lockfile à jour)
☐ Variables d'environnement vérifiées pour l'environnement cible
☐ Tests exécutés (si présents)
☐ Sécurité vérifiée (secrets, CORS, rate limiting — approfondir avec `security-review` si doute)
☐ Performance vérifiée (approfondir avec `react-native-perf-doctor` côté mobile si doute)
☐ Sauvegarde MongoDB disponible si migration
☐ Plan de rollback prêt et écrit noir sur blanc
☐ Validation utilisateur obtenue pour l'action de déploiement elle-même

## Rapport attendu

```markdown
## État du projet
...

## Vérifications effectuées
...

## Risques identifiés
...

## Recommandations
...

## Étapes de déploiement
Plan précis, ordonné, avec le point de rollback identifié

## Vérifications après déploiement
Ce qui doit être contrôlé une fois en production
```

## Référence

- `references/checklist-by-target.md` — checklist détaillée par cible de déploiement (React web, React Native/Expo/EAS, backend Node.js, MongoDB Atlas, CI/CD) avec points concrets à vérifier pour chacune.
