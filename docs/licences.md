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

# Licences — lecture de texte des images (Q-04, PRD sections 7 et 10)

- Windows.Media.Ocr (PC) : API du système (Windows 10 et 11), via la crate `windows` 0.62 (MIT OU Apache-2.0, déjà compilée par Tauri) ; aucune donnée embarquée. Le pack de langue français est installé par l'utilisateur (Paramètres Windows).
- Repli hors ligne, embarqué (PC et iPhone), chargé à la demande :
  - [`tesseract.js`](https://www.npmjs.com/package/tesseract.js) 7.0.0, licence **Apache-2.0** (worker `worker.min.js`, 111 Ko).
  - [`tesseract.js-core`](https://www.npmjs.com/package/tesseract.js-core) 7.x, licence **Apache-2.0** : noyau WebAssembly Tesseract (LSTM seul, SIMD) `tesseract-core-simd-lstm.wasm.js`, 3,9 Mo (1,5 Mo compressé).
  - [`@tesseract.js-data/fra`](https://www.npmjs.com/package/@tesseract.js-data/fra) 1.0.0, paquet MIT ; données `4.0.0_best_int/fra.traineddata.gz` (modèle « best » quantifié de Tesseract, Apache-2.0), 0,7 Mo.
  - Les fichiers sont copiés de `node_modules` dans `dist/ocr/` par le plugin Vite `vite.ocrAssets.ts` (aucun binaire versionné) et ne sont jamais téléchargés d'Internet (`cacheMethod: 'none'`, aucun cache disque).
  - Poids ajouté à l'installeur : environ 2,3 Mo compressés (PRD section 8 : installeur sous 15 Mo). Les autres variantes du noyau (sans SIMD, legacy) ne sont pas embarquées.
- Textes complets : `node_modules/tesseract.js/LICENSE.md`, `node_modules/tesseract.js-core/LICENSE`.
