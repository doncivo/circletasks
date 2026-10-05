# Licences — polices et icônes embarquées (PREP-04)

Toutes ces ressources sont embarquées dans l'app (fichiers locaux inclus dans `dist/` puis
dans le bundle Tauri) : aucune n'est chargée depuis Internet au moment de l'exécution.

## Fraunces

- Rôle : police à empattements des titres (`--ct-font-title`), graisses 600/700, axe
  optique `opsz` (PRD section 5).
- Paquet : [`@fontsource-variable/fraunces`](https://www.npmjs.com/package/@fontsource-variable/fraunces).
- Licence : SIL Open Font License 1.1 (OFL).
- Copyright : 2020 The Fraunces Project Authors (github.com/undercasetype/Fraunces).
- Fichiers embarqués : `fraunces-latin-opsz-normal.woff2`, `fraunces-latin-ext-opsz-normal.woff2`
  (sous-ensembles latin et latin-ext seulement, style normal ; le sous-ensemble vietnamese
  et l'italique sont exclus pour limiter la taille de l'app).
- Texte complet de la licence : `node_modules/@fontsource-variable/fraunces/LICENSE`.

## DM Sans

- Rôle : police sans empattements du texte courant (`--ct-font-text`), graisses
  400/500/600/700.
- Paquet : [`@fontsource-variable/dm-sans`](https://www.npmjs.com/package/@fontsource-variable/dm-sans).
- Licence : SIL Open Font License 1.1 (OFL).
- Copyright : 2014 The DM Sans Project Authors (github.com/googlefonts/dm-fonts).
- Fichiers embarqués : `dm-sans-latin-wght-normal.woff2`, `dm-sans-latin-ext-wght-normal.woff2`
  (sous-ensembles latin et latin-ext seulement, style normal).
- Texte complet de la licence : `node_modules/@fontsource-variable/dm-sans/LICENSE`.

## Lucide

- Rôle : icônes au trait des maquettes (`src/ui/Icon.tsx`), importées nommément par
  composant pour permettre le tree-shaking.
- Paquet : [`lucide-react`](https://www.npmjs.com/package/lucide-react).
- Licence : ISC.
- Texte complet de la licence : `node_modules/lucide-react/LICENSE`.

## Rappel OFL

La licence SIL OFL autorise l'intégration et la redistribution des polices avec le
logiciel, à condition de conserver la mention de copyright et le texte de la licence
(ce que fait ce document) et de ne pas vendre les polices seules. CircleTasks ne
redistribue pas les fichiers de police séparément de l'application.

# Licences — dépendances Rust des agendas externes (K-01, ADR 0008)

- `keyring` 3 (coffre système : Gestionnaire d'identification Windows, Trousseau iOS) : MIT OU Apache-2.0.
- `reqwest` 0.13 avec `rustls` (HTTP des agendas, déjà compilé par l'updater) : MIT OU Apache-2.0.
- `url`, `sha2`, `rand`, `base64` (analyse d'URL, PKCE) : MIT OU Apache-2.0.

# Licence — chrono-node (Q-02, ADR 0001 avenant)

- Paquet : [`chrono-node`](https://www.npmjs.com/package/chrono-node) 2.10, licence MIT (copyright Wanasit Tanakitrungruang).
- Usage : lecture des dates absolues et de "dans N jours" dans la saisie rapide, locale française seule (`src/domain/naturalDate.ts`).
- Texte complet de la licence : `node_modules/chrono-node/LICENSE`.

# Licence — carillon de fin de session Focus (F-04 D4)

- Fichier : `src/features/focus/assets/focus-end.wav` (22 050 Hz, mono, 16 bits, 1,6 s, environ 70 Ko).
- Origine : synthétisé par `scripts/generate-focus-chime.mjs` (partiels de cloche à décroissance exponentielle) ; œuvre originale du projet, sans échantillon tiers, placée dans le domaine public (CC0). Aucune attribution requise.
- Lu par un élément `Audio` au volume du système (`src/platform/focus/sound.ts`), jamais par une API Rust ; aucune notification Windows.

# Licences — lecture de texte des images (Q-04, PRD sections 7 et 10)

- Windows.Media.Ocr (PC) : API du système (Windows 10 et 11), via la crate `windows` 0.62 (MIT OU Apache-2.0, déjà compilée par Tauri) ; aucune donnée embarquée. Le pack de langue français est installé par l'utilisateur (Paramètres Windows).
- Repli hors ligne, embarqué (PC et iPhone), chargé à la demande :
  - [`tesseract.js`](https://www.npmjs.com/package/tesseract.js) 7.0.0, licence **Apache-2.0** (worker `worker.min.js`, 111 Ko).
  - [`tesseract.js-core`](https://www.npmjs.com/package/tesseract.js-core) 7.x, licence **Apache-2.0** : noyau WebAssembly Tesseract (LSTM seul, SIMD) `tesseract-core-simd-lstm.wasm.js`, 3,9 Mo (1,5 Mo compressé).
  - [`@tesseract.js-data/fra`](https://www.npmjs.com/package/@tesseract.js-data/fra) 1.0.0, paquet MIT ; données `4.0.0_best_int/fra.traineddata.gz` (modèle « best » quantifié de Tesseract, Apache-2.0), 0,7 Mo.
  - Les fichiers sont copiés de `node_modules` dans `dist/ocr/` par le plugin Vite `vite.ocrAssets.ts` (aucun binaire versionné) et ne sont jamais téléchargés d'Internet (`cacheMethod: 'none'`, aucun cache disque).
  - Poids ajouté à l'installeur : environ 2,3 Mo compressés (PRD section 8 : installeur sous 15 Mo). Les autres variantes du noyau (sans SIMD, legacy) ne sont pas embarquées.
- Textes complets : `node_modules/tesseract.js/LICENSE.md`, `node_modules/tesseract.js-core/LICENSE`.

# Licence — Recharts (H-02 D4)

- Paquet : [`recharts`](https://www.npmjs.com/package/recharts) 3.10, licence **MIT** ; dépendances transitives (`victory-vendor` d3, `@reduxjs/toolkit`, `immer`, `reselect`, `decimal.js-light`) sous licences MIT ou ISC.
- Usage : graphique en barres « taux de complétion par semaine » du rapport du mois (`src/features/stats/CompletionChart.tsx`), chargé à la demande par import dynamique (jamais dans le paquet de départ).
- Texte complet de la licence : `node_modules/recharts/LICENSE`.
- `victory-vendor` (copie des modules d3 utilisés) : licence **MIT AND ISC** (d3-array, d3-scale, d3-shape, d3-time, d3-interpolate, d3-color, d3-format, d3-path, d3-timer : ISC).
- `d3-ease` : licence **BSD-3-Clause** (Copyright 2010-2021 Mike Bostock, Copyright 2001 Robert Penner). Cette licence demande de conserver l'avis de copyright, la liste des conditions et l'avertissement dans la documentation fournie avec le logiciel : le texte complet est dans `node_modules/d3-ease/LICENSE` ; il doit rester reproduit dans les mentions de licences de l'application. Les noms des auteurs ne servent pas à promouvoir l'application.

# Licences — export de fichiers (H-03)

- Aucun plugin Tauri dialog ni fs côté WebView : « Enregistrer sous » est ouvert et le fichier écrit par Rust. Seule la crate `tauri-plugin-dialog` (MIT OU Apache-2.0, projet Tauri, PC Windows uniquement) sert à ouvrir la boîte depuis Rust ; `tauri-plugin-opener` (déjà présent) affiche le fichier dans le dossier.
- Aucune dépendance pour le PDF ni le PNG (dessin canvas, PDF minimal écrit par `src/domain/pdfDocument.ts`).

# Licences — dépendances Rust de la synchronisation (Y-08, ADR 0011 section 2)

Ajoutées en dépendances directes **sans nouvelle entrée dans `Cargo.lock`** (déjà compilées par les dépendances existantes ; seule la liste des dépendances du paquet `circletasks` change) :

- `aws-lc-rs` 1.18 (AES-256-GCM par `RandomizedNonceKey`, HKDF-SHA256, SHA-256, aléa système), fonctionnalités `aws-lc-sys` et `alloc` seulement : licence **ISC ET (Apache-2.0 OU ISC)** ; déjà fournisseur de `rustls` (via `reqwest`). Bibliothèque C embarquée `aws-lc-sys` 0.45 : ISC, Apache-2.0, MIT, BSD-3-Clause (fichiers d'origine OpenSSL / BoringSSL), voir le dépôt `aws/aws-lc`.
- `zeroize` 1.9 (effacement des tampons de clé) : MIT OU Apache-2.0 ; déjà tirée par `keyring` et `aws-lc-rs`.
- `security-framework` 3.7, **cible iOS seulement** (clé de synchro au Trousseau avec `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`, non synchronisée) : MIT OU Apache-2.0 ; même version que celle déjà compilée pour iOS par `rustls-platform-verifier` (`cargo tree --target aarch64-apple-ios -i security-framework@3.7.0`).
- `windows` 0.62 : fonctionnalités ajoutées (`Win32_Security`, `Win32_System_IO`, `Win32_Storage_FileSystem`, `Win32_Storage_CloudFilters`, `Win32_UI_Controls`, `Wdk_Foundation`, `Wdk_Storage_FileSystem`), même crate, même licence (MIT OU Apache-2.0).
