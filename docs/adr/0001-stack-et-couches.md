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
| chrono-node 2.10 (Q-02, avenant du 2026-10-04) | Date et heure dans les phrases françaises (locale `fr` seule : `chrono-node/fr`), enveloppé dans `src/domain/naturalDate.ts` | MIT | ~55 Ko minifié, ~15 Ko gzip (locale fr et noyau) ; dans le bundle principal (seuil de 100 Ko gzip, Q-02 D1) | oui (JS pur, sans API navigateur ni Node) |
| recharts 3.10 (H-02, ADR 0009) | Graphique « taux de complétion par semaine » du rapport, `src/features/stats/CompletionChart.tsx` uniquement | MIT (transitives MIT / ISC) | ~91 Ko gzip, **bloc paresseux** (`React.lazy`), hors bundle de départ | oui (JS, SVG) |
| crate `tauri-plugin-dialog` (H-03, ADR 0009) | « Enregistrer sous » ouvert côté Rust par la commande `export_save_file` ; aucun paquet npm, aucune permission `dialog:` pour la WebView | MIT / Apache-2.0 | 0 Ko JS | PC seulement : crate absente du build iOS, `FileService` indisponible sur iPhone jusqu'à l'ordre 5 |

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

## Avenant : tailles mesurées du démarrage (2026-10-05)

### Contexte

L'audit de performance de fin d'ordre 3 (`vite build` sur `main`, 2026-10-05) contredit deux affirmations de cet ADR : « Total JS de la coquille : ~49 Ko gzip » et le seuil de 100 Ko gzip pour le bundle principal (cité dans la ligne chrono-node, d'après Q-02 D1). La coquille a grossi avec les ordres 1 à 3 (écrans, stores, contrats de plateforme, chrono-node) et aucun test ne vérifiait ce seuil, ce qui a laissé passer l'écart.

### Mesures (gzip)

| Élément chargé au démarrage | Taille |
| --- | --- |
| Bloc `main` (code de l'app, chrono-node compris) | 141,65 Ko |
| Bloc « tokens » (react-dom, lucide-react) | 176,08 Ko |
| Blocs core, types, runtime | < 2 Ko |
| **Total JS de départ** | **~320 Ko** |
| CSS | 26,8 Ko |
| Polices woff2 (Fraunces, DM Sans) | ~182 Ko |

Hors démarrage : recharts en bloc paresseux (90,79 Ko gzip, conforme à l'ADR 0009) ; tesseract.js hors graphe de modules, servi comme fichiers statiques sous `/ocr/` (Q-04).

### Décision

- Le seuil de 100 Ko gzip pour le bloc principal est **retiré** : il n'est plus tenable sans un découpage que l'ordre 3 ne justifie pas.
- Nouveau seuil : **350 Ko gzip pour la somme des blocs JS chargés au démarrage** (blocs d'entrée et leurs imports statiques ; blocs paresseux et `/ocr/` exclus). Il est **vérifié** par le script npm `test:bundle` (ajouté par qa-test) : dépasser le seuil fait échouer le script. Marge actuelle : ~30 Ko (~9 %).
- Toute nouvelle dépendance embarquée indique désormais si elle entre dans le démarrage ; si elle fait dépasser 350 Ko, elle passe en import dynamique (règle de Q-02 D1, appliquée au total et non plus au seul bloc `main`).
- La phrase « Total JS de la coquille : ~49 Ko gzip » et la mention « seuil de 100 Ko gzip, Q-02 D1 » de la ligne chrono-node sont remplacées par cet avenant.

### Conséquences pour l'iPhone (démarrage à froid < 1 s, PRD 8)

- Les fichiers sont lus depuis le paquet de l'app, sans réseau : le coût ne vient pas du transfert mais de l'analyse et de la compilation du JS par WKWebView. 320 Ko gzip représentent environ trois à quatre fois plus de JS minifié à analyser ; sur l'A18 Pro, c'est de l'ordre de quelques dizaines à une centaine de millisecondes (estimation, non mesurée), à ajouter à l'initialisation de WKWebView, à l'ouverture de SQLite et au premier rendu.
- Le seuil de 350 Ko est donc compatible avec le budget de 1 s, mais il n'en est pas la preuve : il garantit seulement que le JS ne dérive pas. Faute de Mac, la mesure réelle se fera sur l'iPhone à l'ordre 5 (build `build-ios.yml`, installation SideStore). Si le démarrage dépasse 1 s, le premier levier est le découpage décrit ci-dessous, avant toute baisse du seuil.
- Les fichiers `/ocr/` (~4,7 Mo non compressés) sont copiés dans `dist/` et donc présents dans le paquet iOS, mais ne sont jamais chargés au démarrage.

### Recommandations (non appliquées)

- Nommer explicitement le bloc des bibliothèques « vendor » au lieu de « tokens ». Constat : `vite.config.ts` ne définit pas aujourd'hui de `manualChunks` ; le nom « tokens » est choisi automatiquement par Rollup pour le bloc partagé entre les deux entrées (`index.html` et `capture.html`), d'après l'un des modules qu'il contient. Le renommage suppose donc d'ajouter `build.rollupOptions.output.manualChunks` (ou une règle `chunkFileNames`) ; le script `test:bundle` doit identifier les blocs de départ par le graphe (manifeste Vite), pas par leur nom, pour rester valable après ce changement.
- Étudier un découpage du démarrage, par ordre de gain attendu : écrans secondaires (Réglages, Statistiques, Calendriers, Focus) en `React.lazy` hors de l'écran d'accueil ; chrono-node chargé à la première frappe dans un champ de saisie naturelle ; vérifier que lucide-react n'importe que les icônes nommées (tree-shaking) ; s'assurer que la fenêtre de capture (`capture.html`) ne tire pas le bloc entier. Chaque découpage se mesure avec `test:bundle` avant et après.
