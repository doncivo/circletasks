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
