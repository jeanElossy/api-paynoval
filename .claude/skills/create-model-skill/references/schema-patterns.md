# Patterns de schéma Mongoose

## Validations explicites

**Avant**
```js
const productSchema = new mongoose.Schema({
  name: String,
  price: Number,
  status: String,
});
```
Aucune contrainte : n'importe quelle valeur (y compris absente, négative, ou hors des statuts valides) peut être enregistrée.

**Après**
```js
const productSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, minlength: 2, maxlength: 120 },
  price: { type: Number, required: true, min: 0 },
  status: { type: String, enum: ['draft', 'published', 'archived'], default: 'draft' },
}, { timestamps: true });
```

## Relations : référence vs embedding

**Référence** (`ObjectId` + `ref`) — à utiliser quand l'entité liée :
- a un cycle de vie indépendant (peut exister/être modifiée sans l'entité parente)
- est potentiellement partagée entre plusieurs documents
- peut grossir sans borne (ex: commentaires d'un article)

```js
const orderSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
});
```

**Embedding** (sous-document) — à utiliser quand la donnée :
- est intrinsèquement liée au document parent et n'a pas de sens seule
- reste de taille bornée et raisonnable
- est presque toujours lue en même temps que le parent

```js
const orderSchema = new mongoose.Schema({
  shippingAddress: {
    street: { type: String, required: true },
    city: { type: String, required: true },
    zipCode: { type: String, required: true },
  },
});
```
Une adresse de livraison n'a pas d'existence indépendante de la commande → embedding. Un utilisateur a une existence indépendante et est partagé par plusieurs commandes → référence.

## populate ciblé

**Avant**
```js
const orders = await Order.find().populate('userId').populate('items.productId');
```
Toutes les relations sont résolues systématiquement, même quand l'appelant n'en a pas besoin — coût réseau/mémoire inutile.

**Après**
```js
// Seulement quand l'usage l'exige réellement, avec les champs nécessaires :
const order = await Order.findById(id).populate('userId', 'name email');
```
`populate` limité au cas d'usage précis, avec sélection des champs utiles plutôt que le document entier.

## Stratégie d'index

- Index sur tout champ utilisé fréquemment en filtre (`find({ status: ... })`) ou en tri (`sort({ createdAt: -1 })`).
- Index unique sur les champs qui doivent l'être en métier (`email`, `username`) — laisser MongoDB rejeter les doublons plutôt que de le vérifier uniquement côté application.
```js
email: { type: String, required: true, unique: true, lowercase: true, trim: true },
```
- Index composé quand les requêtes filtrent systématiquement sur plusieurs champs ensemble :
```js
orderSchema.index({ userId: 1, status: 1 });
```
- Éviter d'indexer un champ rarement filtré/trié — chaque index a un coût en écriture et en stockage.

## Méthodes statiques et d'instance

À utiliser pour la logique directement liée à la forme des données du modèle — pas pour la logique métier générale (qui reste dans les services).

```js
userSchema.methods.comparePassword = function (candidate) {
  return bcrypt.compare(candidate, this.password);
};

userSchema.statics.findByEmail = function (email) {
  return this.findOne({ email: email.toLowerCase() });
};
```

## Sécurité — mots de passe et champs sensibles

**Avant**
```js
password: { type: String, required: true }
// stocké tel quel dans le controller : new User({ password: req.body.password })
```

**Après**
```js
password: { type: String, required: true, select: false }
```
```js
userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});
```
`select: false` exclut le mot de passe des requêtes par défaut ; le hash est fait au niveau du modèle donc impossible à oublier dans un controller.

## Documents trop volumineux / tableaux non bornés

**Avant**
```js
const articleSchema = new mongoose.Schema({
  title: String,
  comments: [commentSchema], // peut grossir indéfiniment dans le même document
});
```

**Après**
```js
// Article sans les commentaires embarqués
const articleSchema = new mongoose.Schema({ title: String });

// Collection séparée, référencée
const commentSchema = new mongoose.Schema({
  articleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Article', required: true, index: true },
  text: String,
});
```
Au-delà d'un volume raisonnable et non borné, une collection séparée évite d'atteindre la limite de taille de document MongoDB (16 Mo) et garde les écritures/lectures performantes.
