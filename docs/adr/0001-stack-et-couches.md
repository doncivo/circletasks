# ADR 0001 — Stack, couches et dépendances

- Statut : accepté
- Date : 2026-10-01
- Tâche : PREP-02 (ordre 0)

## Contexte

CircleTasks est une seule base de code React exécutée dans Tauri 2 sur Windows (WebView2) et sur iPhone 16 Pro Max (WKWebView), livrée en une fois (PRD sections 2, 7 et 11.4). Il n'y a pas de Mac : rien ne peut être testé localement sur iOS, d'où l'importance de règles qui garantissent par construction que le code partagé tourne sur les deux plateformes. Les règles métier doivent être testées une seule fois (PRD 7), couvertes à 80 % (PRD 8), et 26 agents interviennent sur le dépôt : les frontières doivent être vérifiées automatiquement, pas seulement documentées.

## Décision

### Stack

React 18, Vite 8, TypeScript 6 strict, Zustand 5, SQLite via tauri-plugin-sql, Rust (Tauri 2), plugins Swift iOS dans `src-tauri/plugins/`. Tests : Vitest 5 (Node + jsdom), Testing Library, Playwright, `cargo test`.

TypeScript reste en 6.0.x : typescript-eslint 8 n'accepte pas TypeScript 7 (pair `<6.1.0`). Montée de version à réévaluer quand typescript-eslint la supportera.

Options de compilation : `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `verbatimModuleSyntax`. Cible `es2022` (Chromium 120 et Safari 17).

### Identifiant d'application

`fr.circletasks.planner` (Windows et bundle iOS). Il fixe le dossier de données (base SQLite) et la clé du coffre système : **il ne doit plus changer** après la première installation. Pas de suffixe `.app` (refusé par Tauri). SideStore ajoute son propre préfixe d'équipe à l'installation, sans effet sur le code.

### Couches et sens des dépendances

```
domain  ←  db  ←  sync
   ↑        ↑       ↑
  i18n    platform ─┘
   ↑        ↑
   ui  ←  features  ←  App.tsx / main.tsx
```

| Couche | Rôle | Peut importer |
| --- | --- | --- |
| `src/domain` | Règles métier pures, types partagés (`types.ts`), `Clock`, `IdGenerator` | rien |
| `src/db` | Contrat `SqlDriver`, migrations, repositories, driver Wasm de dev | domain |
| `src/sync` | Journaux, hlc, fusion (ordre 4) | domain, db, platform |
| `src/platform` | Seul endroit qui connaît Tauri, Windows, iOS ; choisit le driver SQLite | domain, db, i18n |
| `src/i18n` | Textes FR / EN, `t()` | rien |
| `src/ui` | Design system, hooks de mise en page (`useLayout`) | domain, i18n |
| `src/features` | Écrans et stores par module (tasks, today, week…) | tout sauf drivers et `platform/tauri` en direct |

La chaîne « domain → db → features → ui » de CLAUDE.md se lit comme l'empilement des couches ; `ui` est le design system (PRD 11.4) et ne connaît ni la base ni les features, ce sont les features qui composent les composants `ui`.

Règles vérifiées par ESLint (`eslint.config.js`, `no-restricted-imports`) :

- `@tauri-apps/*` ne s'importe que dans `src/platform` ;
- `domain` et `i18n` n'importent aucune autre couche ; `db` uniquement `domain` ; `ui` ni db, ni features, ni sync, ni platform ;
- les features n'importent jamais un driver (`db/drivers`, `platform/tauri`) ;
- `no-explicit-any` et `no-console` en erreur ; texte JSX en dur interdit (ADR 0003).

Les fichiers de test sont exemptés des règles de frontière (ils peuvent instancier le driver Wasm).

### Commandes Tauri

Une seule commande Rust personnalisée à ce jour : `set_tray_labels` (zone de notification PC, ADR 0006, qui documente aussi les plugins PC ajoutés par D-01 à D-03). Toute nouvelle commande sera spécifiée ici ou dans un ADR dédié (nom en `snake_case`, entrées, sortie, erreurs sous forme `{ code, message }`) et exposée côté TypeScript par une fonction de `src/platform/`, jamais par `invoke` dans une feature.

### Dépendances retenues

Toutes compatibles iOS : soit exécutées dans la WebView (JS pur), soit outils de build / test qui ne sont pas embarqués.

**Embarquées dans l'app**

| Paquet | Rôle | Licence | Poids (min + gzip) | iOS |
| --- | --- | --- | --- | --- |
| react, react-dom 18.3 | Interface | MIT | ~45 Ko | oui (JS) |
| zustand 5 | État global | MIT | ~1 Ko | oui (JS) |
| @tauri-apps/api 2 | Détection runtime, IPC | MIT / Apache-2.0 | ~2 Ko utilisés | oui (Tauri 2 mobile) |
| @tauri-apps/plugin-sql 2 | Pont JS du plugin SQL | MIT / Apache-2.0 | ~1 Ko | oui (plugin desktop et mobile) |
| crate tauri 2, tauri-build 2 | Runtime | MIT / Apache-2.0 | — | oui |
| crate tauri-plugin-sql 2 (feature `sqlite`) | SQLite via sqlx, SQLite embarqué avec FTS5 et JSON1 | MIT / Apache-2.0 (SQLite : domaine public) | ~1,5 Mo natif | oui |
| crates serde, serde_json | Sérialisation des futures commandes | MIT / Apache-2.0 | — | oui |
| @fontsource-variable/fraunces (PREP-04) | Police des titres, fichiers locaux (`src/ui/theme/fonts.css`) | SIL OFL 1.1 | ~124 Ko woff2 (latin + latin-ext, normal) | oui (fichiers statiques) |
| @fontsource-variable/dm-sans (PREP-04) | Police du texte courant, fichiers locaux | SIL OFL 1.1 | ~54 Ko woff2 (latin + latin-ext, normal) | oui (fichiers statiques) |
| lucide-react (PREP-04) | Icônes au trait des maquettes, `src/ui/Icon.tsx` | ISC | ~0,5 Ko par icône importée nommément (tree-shaking) | oui (JS) |

Total JS de la coquille : ~49 Ko gzip (hors icônes à l'usage). Polices : ~178 Ko de woff2 embarqués, non chargés depuis Internet (docs/licences.md). Le profil release Rust est optimisé taille (`lto`, `opt-level = "s"`, `strip`) pour tenir l'installeur sous 15 Mo (PRD 8).

**Développement et tests uniquement (non embarquées)**

| Paquet | Rôle | Licence |
| --- | --- | --- |
| @sqlite.org/sqlite-wasm | Driver SQLite de dev / test (ADR 0002) ; exclu des builds Tauri | Apache-2.0 (SQLite : domaine public) |
| typescript 6.0 | Typage | Apache-2.0 |
| vite 8, @vitejs/plugin-react 6 | Serveur de dev, build | MIT |
| @tauri-apps/cli 2 | Build et icônes Tauri | MIT / Apache-2.0 |
| vitest 5, @vitest/coverage-v8 5 | Tests unitaires, couverture | MIT |
| jsdom | DOM des tests de composants | MIT |
| @testing-library/react, /dom, /jest-dom | Tests de composants | MIT |
| @playwright/test | Tests de bout en bout | Apache-2.0 |
| eslint 10, @eslint/js, typescript-eslint 8, eslint-plugin-react-hooks 7, globals | Lint | MIT |
| @types/react, @types/react-dom, @types/node | Types | MIT |

Écartés : bibliothèques i18n (ADR 0003), sql.js (pas de FTS5, ADR 0002).

## Conséquences

- Tout ajout de dépendance passe par l'architecte et met à jour le tableau ci-dessus (rôle, licence, taille, compatibilité iOS).
- Un import interdit casse `npm run lint` : les frontières ne reposent pas sur la discipline des agents.
- Le code spécifique à une plateforme vit dans `src/platform/` ; le reste du code reçoit des abstractions (`openDatabase`, `detectRuntime`, `detectOs`).
- Les règles métier n'appellent jamais `Date.now()` ni `crypto.randomUUID()` directement : elles reçoivent une `Clock` et un `IdGenerator` (`src/domain/clock.ts`, `src/domain/id.ts`), ce qui les rend déterministes en test.
- Le store global (`src/features/app/appStore.ts`) ne contient que l'état transverse (statut de la base, filtre d'espace) ; chaque feature gère son propre store.
- `useLayout()` (`src/ui/useLayout.ts`) distingue PC (≥ 1024 px, largeur minimale de la fenêtre Tauri) et mobile ; c'est la seule source de vérité de la mise en page.
