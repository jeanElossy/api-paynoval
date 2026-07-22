# Structure de page et responsive

## Composition en sections indépendantes

**Avant (page monolithique)**
```jsx
function HomePage() {
  return (
    <div>
      <div className="hero">...</div>
      <div className="about">...</div>
      <div className="services">
        {services.map(s => <div key={s.id}>...</div>)}
      </div>
      {/* des centaines de lignes de plus */}
    </div>
  );
}
```
Tout est dans un seul fichier, rien n'est réutilisable, illisible au-delà de quelques sections.

**Après (composition)**
```jsx
function HomePage() {
  return (
    <>
      <HeroSection />
      <AboutSection />
      <ServicesSection services={services} />
      <GallerySection />
      <TestimonialsSection />
      <ContactSection />
    </>
  );
}
```
Chaque section est un composant à part (créé via `create-component` si besoin), testable et réutilisable indépendamment.

## Layout partagé

Si plusieurs pages partagent un header/footer/navigation, extraire un composant `Layout` plutôt que de le répéter dans chaque page :

```jsx
function Layout({ children }) {
  return (
    <>
      <Header />
      <main>{children}</main>
      <Footer />
    </>
  );
}

function HomePage() {
  return (
    <Layout>
      <HeroSection />
      <AboutSection />
    </Layout>
  );
}
```

## Responsive

Vérifier systématiquement trois largeurs : mobile (~375px), tablette (~768px), desktop (~1280px+).

Points à contrôler pour chaque section :
- Le texte reste lisible sans zoom (pas de troncature involontaire).
- Les images/médias ne débordent pas et gardent un ratio cohérent.
- La navigation bascule proprement (menu burger sur mobile si le menu desktop ne rentre pas).
- Les grilles de contenu (ex: cards de services) passent d'une grille multi-colonnes à une colonne unique sur mobile plutôt que de rétrécir jusqu'à devenir illisible.
