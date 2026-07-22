---
name: react-native-perf-doctor
description: >
  Détecte et corrige les problèmes de performance (lenteur, lag, fuites mémoire) dans une application React Native via analyse statique du code. Utiliser cette skill dès que l'utilisateur mentionne que son app est lente, qu'il y a du lag, des ralentissements, des freezes, une consommation mémoire excessive, un crash lié à la mémoire, ou qu'il demande explicitement une vérification/audit de performance — même si ces mots ne sont pas utilisés littéralement (ex: ça rame, ça saccade, l'app devient lente avec le temps). Toujours utiliser cette skill avant de proposer une correction ad hoc de performance sur du code React Native.
---

# React Native Perf Doctor

Skill pour auditer statiquement une base de code React Native, repérer les causes probables de lenteur ou de fuites mémoire, corriger le code concerné, et expliquer au développeur pourquoi le problème existait.

## Quand se déclencher

- L'utilisateur signale un symptôme : lenteur, lag, freeze, saccades, "l'app rame", scroll qui saccade, consommation mémoire qui grimpe, crash OOM (out of memory), l'app qui ralentit avec l'usage.
- L'utilisateur demande explicitement un audit ou une vérification de performance.
- L'utilisateur pointe un fichier/écran précis en disant qu'il est lent.

## Rapport avec les autres skills

Cette skill fait le diagnostic de performance *approfondi* et corrige le code. Pour un audit de performance global du projet (React web, backend, MongoDB compris, pas seulement React Native), voir `performance-review`, qui délègue ici pour tout ce qui touche spécifiquement au mobile. Pour un état des lieux général du projet qui inclut des signaux de performance parmi d'autres dimensions, voir `audit`. Pour créer un nouveau composant ou écran en respectant déjà les bonnes pratiques de performance, voir `create-component` et `create-screen`.

Ne PAS se déclencher pour des bugs fonctionnels sans lien avec la performance (erreurs de logique, crashs non liés à la mémoire, problèmes de style/UI).

## Méthode : analyse statique uniquement

Cette skill ne lance jamais l'app, aucun simulateur, aucun profiler. Tout le diagnostic se fait par lecture du code source (composants, hooks, navigation, listes, assets, dépendances).

### Étape 1 — Cartographier la zone concernée

1. Si l'utilisateur pointe un écran/fichier précis, commencer par lui.
2. Sinon, localiser les écrans les plus probables : listes longues, écrans avec animations, écrans avec beaucoup de state, écrans de navigation fréquente.
3. Repérer la stack technique (Expo ou RN bare, navigation utilisée, gestion d'état — Redux/Zustand/Context, etc.) pour adapter les recommandations.

### Étape 2 — Passer le code au crible des causes connues

Chercher systématiquement ces patterns (voir `references/checklist.md` pour le détail et les exemples de correction pour chacun) :

**Re-renders excessifs**
- Composants sans `React.memo` alors qu'ils re-rendent souvent avec les mêmes props
- Fonctions et objets/tableaux littéraux créés inline dans le JSX d'un parent (`onPress={() => ...}`, `style={{...}}`) sans `useCallback`/`useMemo`
- Context React dont la valeur change à chaque render, faisant re-render tous les consommateurs
- State élevé trop haut dans l'arbre, forçant des re-renders de sous-arbres entiers

**Listes non virtualisées**
- `.map()` pour afficher de longues listes au lieu de `FlatList`/`FlashList`/`SectionList`
- `FlatList` sans `keyExtractor` stable, sans `getItemLayout` quand la hauteur est fixe, ou avec `renderItem` non mémoïsé
- Absence de `windowSize`/`initialNumToRender`/`maxToRenderPerBatch` adaptés sur de très longues listes

**Fuites mémoire**
- `useEffect` qui ajoute un listener/subscription/timer sans fonction de cleanup au `return`
- Abonnements (event emitters, WebSocket, `Dimensions.addEventListener`, navigation listeners) jamais désabonnés au démontage
- Closures qui capturent de grosses données ou des refs vers des composants démontés
- `setState` appelé après démontage du composant (callback async résolu trop tard)

**Images et assets**
- Images chargées à leur résolution native sans redimensionnement (`resizeMode`, dimensions explicites)
- Absence de cache/lazy loading sur des listes d'images
- Assets embarqués non optimisés (poids, format)

**Thread JS bloqué**
- Calculs lourds synchrones dans le render ou dans un callback UI (parsing, tri, filtrage de grosses données) au lieu d'être mémoïsés ou déportés
- Animations pilotées par le JS thread sans `useNativeDriver: true`
- `console.log` en excès en production (coût non négligeable sur certains environnements)

**Navigation**
- Écrans jamais démontés/lazy alors qu'ils accumulent du state et des listeners au fil de la navigation
- Trop d'écrans gardés en mémoire dans la pile de navigation sans `unmountOnBlur` ou équivalent

### Étape 3 — Corriger

Pour chaque problème trouvé :
1. Appliquer directement la correction dans le code (pas seulement une suggestion).
2. Garder la correction minimale et ciblée — ne pas refactoriser au-delà de ce qui est nécessaire pour régler le problème de performance.
3. Si plusieurs corrections touchent le même fichier, les regrouper dans une explication commune plutôt que de fragmenter.

### Étape 4 — Expliquer

Pour chaque correction, donner une explication courte et concrète :
- Quel était le mécanisme exact du ralentissement/de la fuite (pas juste "c'est mieux comme ça")
- Pourquoi la correction règle spécifiquement ce mécanisme
- Si pertinent, l'impact attendu (ex: "évite un re-render de la liste entière à chaque frappe clavier")

Éviter le jargon non expliqué si le niveau du développeur n'est pas clair depuis la conversation.

## Sortie attendue

- Le code corrigé, appliqué directement dans les fichiers concernés.
- Un résumé listant, par fichier, les problèmes trouvés et les corrections apportées avec leur justification.
- Si aucun problème de performance évident n'est trouvé dans la zone analysée, le dire clairement plutôt que d'inventer un problème — proposer éventuellement d'élargir la zone d'analyse.

## Référence

- `references/checklist.md` — détail de chaque pattern ci-dessus avec exemples "avant/après" de code React Native, à consulter pour les exemples de correction précis.
