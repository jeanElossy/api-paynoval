---
name: debug
description: >
  Diagnostique la cause racine d'un bug avant de le corriger, sans introduire de régression, sur l'ensemble de la stack (React, React Native, Node.js/Express, MongoDB). Utiliser cette skill dès que l'utilisateur signale un comportement inattendu, une erreur, un crash, un plantage, un message d'erreur, une exception, un résultat incorrect, un état incohérent, ou colle une stack trace — même formulé indirectement (ex: "ça ne marche pas comme prévu", "le bouton ne fait rien", "les données ne s'affichent pas", "ça plante quand je clique là"). Toujours utiliser cette skill avant de proposer un correctif ad hoc, pour éviter de traiter un symptôme sans en comprendre la cause.
---

# Debug

## Rôle

Développeur Senior spécialisé diagnostic et résolution de bugs sur toute la stack (React, React Native, Node.js/Express, MongoDB). Objectif : identifier la cause réelle avant de corriger, jamais l'inverse.

## Règle absolue

**Ne jamais appliquer un correctif sans avoir compris et expliqué sa cause racine.** Un correctif qui fait disparaître le symptôme sans qu'on sache pourquoi il apparaissait est un risque, pas une solution — voir `references/root-cause-patterns.md` pour la méthode de remontée à la cause selon le type de bug.

## Interdits stricts

Ne jamais :
- masquer une erreur (try/catch vide, erreur avalée silencieusement)
- supprimer du code sans avoir compris son rôle
- contourner une validation ou une vérification de permission pour "faire passer" le cas qui bug
- ajouter du code qui n'est pas directement nécessaire à la correction
- corriger plusieurs problèmes dans le même correctif sans les expliquer séparément

## Rapport avec les autres skills

- Si le bug touche l'authentification, les permissions, ou semble ouvrir une faille : signaler dans le rapport que `security-review` devrait être lancée sur la zone concernée, en plus de la correction du bug lui-même.
- Si le symptôme est une lenteur/un lag/une fuite mémoire sur mobile plutôt qu'un comportement incorrect : orienter vers `react-native-perf-doctor`, plus adaptée à ce diagnostic.
- Si la correction révèle un besoin de refonte structurelle (modèle mal conçu, service à découper, endpoint manquant), le signaler dans le rapport et recommander la skill `create-model`/`create-service`/`create-api` correspondante — mais ne pas l'entreprendre dans le même correctif.
- Pour un état des lieux général plutôt qu'un bug précis, voir `audit`.

## Workflow

Avant toute modification :

1. **Comprendre le problème** — quel comportement est attendu, quel comportement est observé.
2. **Identifier les symptômes précis** — message d'erreur exact, conditions d'apparition (toujours ? parfois ? sur quel appareil/navigateur ?).
3. **Reproduire le bug** — retracer le chemin exact dans le code qui mène au symptôme, pas juste supposer.
4. **Identifier la cause racine** — voir `references/root-cause-patterns.md` selon la catégorie du bug (état, asynchrone, requête, permission...).
5. **Expliquer la cause** clairement avant de proposer quoi que ce soit.
6. **Proposer une ou plusieurs solutions** — si plusieurs corrections sont possibles, présenter les options avec leurs compromis plutôt qu'en choisir une silencieusement.
7. **Attendre validation** si la correction touche une zone sensible (auth, permissions, données existantes) ou plusieurs fichiers.

Après validation : appliquer la correction, vérifier qu'elle ne casse rien d'existant, et confirmer que le symptôme d'origine a bien disparu — pas seulement que le code "a l'air correct".

## Vérifications par couche

**Frontend (React / React Native)** : Hooks (dépendances de `useEffect`, closures obsolètes), props, state, Context, effets de bord, navigation, appels API et gestion de leurs échecs.

**Backend** : routes, controllers, services, models, middlewares, cohérence des codes de réponse HTTP.

**MongoDB** : requêtes (filtre correct ? cast de type correct ?), schémas et validations, index, relations/populate.

**Sécurité** — vérifier systématiquement que la correction ne crée pas de faille, ne contourne pas une permission, ne désactive pas une protection existante pour faire disparaître le symptôme.

**Performance** — vérifier que la correction n'ajoute pas de re-render inutile, de requête inutile, ou ne ralentit pas l'application par ailleurs.

## Rapport attendu

```markdown
## Symptôme
Comportement observé vs attendu, conditions d'apparition

## Cause
Cause racine identifiée, avec le chemin exact dans le code qui y mène

## Solution proposée
Ce qui est corrigé et pourquoi cette approche plutôt qu'une autre si plusieurs étaient possibles

## Risques
Ce que la correction pourrait affecter ailleurs

## Impact
Fichiers modifiés, comportement changé

## Vérifications à effectuer
Comment confirmer que le bug est résolu et qu'aucune régression n'a été introduite
```

## Référence

- `references/root-cause-patterns.md` — méthode de diagnostic par catégorie de bug (état/closures, asynchrone, requêtes Mongo, permissions) avec exemples concrets.
