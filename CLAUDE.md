# CircleTasks — mémoire projet

Planificateur personnel inspiré de NoteCircle, pour un seul utilisateur.
PC Windows (Tauri 2) et iPhone 16 Pro Max (Tauri 2 iOS), même code React, livraison unique.
Référence fonctionnelle : docs/PRD.md (user stories M1 à M18, IDs stables).
Référence visuelle : docs/maquettes/ (34 écrans validés, ouvrir index.html) ; couleurs et polices en section 5.

## Stack
React 18, Vite, TypeScript strict, Zustand, SQLite (plugin Tauri SQL), Rust (Tauri 2), plugins Swift pour iOS
(vision, speech, folder-bookmark, reminders). Tests : Vitest, Testing Library, Playwright, cargo test.

## Commandes
npm run dev | npm run tauri dev | npm run test | npm run lint | npm run typecheck | npm run tauri build

## Règles
- Une user story par branche, ID dans le commit (ex. "T-04: annulation 5 s").
- Règles métier dans src/domain uniquement ; accès base via src/db/repositories uniquement.
- Chaque élément appartient à un espace (Pro ou Perso) ; filtre Pro / Perso / Tout partout.
- Interface entièrement en français, heures en 24 h, textes dans src/i18n, jamais en dur.
- Polices Fraunces et DM Sans embarquées ; icônes Lucide au trait colorées ; les maquettes sont la référence visuelle.
- Rappels : données et réglages à l'ordre 1, envoi sur l'iPhone à l'ordre 5.
- Ne jamais ajouter une fonction de la liste « Hors périmètre » (PRD section 1).
- Pas de Mac : aucune commande iOS locale ; builds iOS via .github/workflows/build-ios.yml, installation par SideStore.
- Mise à jour PC par plugin updater et dépôt public circletasks-releases.
- Synchro par journaux chiffrés dans iCloud Drive (hlc, schema_version) ; téléchargement forcé des fichiers avant lecture.
- Rappels émis sur l'iPhone uniquement ; le PC n'envoie aucune notification de rappel.
- Pas de secret en clair ; jetons dans le coffre système ; clé updater dans GitHub Secrets.
- Bundle de départ : plafond 350 Ko gzip (tests/bundle/startBundle.test.ts), jamais relevé. Tout écran, fenêtre, bandeau ou catalogue de
  textes qui ne sert pas au premier affichage d'Aujourd'hui est en chargement à la demande dès sa création (import dynamique, catalogue
  i18n chargé avec lui, assertion « hors du départ »), jamais après coup (décision d'Ali du 2026-10-18, docs/audits/2026-10-18-bundle-depart.md).
  Garde par liste blanche `tests/bundle/start-modules.json` (BUNDLE-01) : tout module nouveau dans le départ est refusé, la liste ne s'étend
  que par un commit qui le justifie (`ajouts` : ID de story et raison) ; mesure normalisée insensible aux hachages (`tests/bundle/bundleMeasure.ts`,
  relevé par `node tests/bundle/measureStart.ts <dossier>`) ; le plafond reste le dernier juge.

## Délégation
Codex assure lui-même product-owner, agent du module, qa-test puis code-reviewer en passes distinctes, dans cet ordre, et consigne chaque résultat (décision d’Ali du 2026-10-19 ; détails dans AGENTS.md).

## Méthode (depuis le 2026-10-08)
- Suite complète dans la CI, plus en local : unitaires, Rust, e2e pc et iphone, perf et bundle sur des runners parallèles
  (.github/workflows/suite.yml ou tests.yml), à chaque push de branche de lot. En local : seulement les tests du module en cours.
- Une fusion dans main attend la CI verte sur la branche (statut « suite verte »), jamais une suite locale.
- Pendant qu'un lot est en QA ou en revue, le développement du lot suivant démarre s'il ne touche pas les mêmes dossiers.
- Une seule compilation iPhone (build-ios.yml) par lot terminé, pas une par essai.
- Inchangé : pas de « fait » sans tests verts, lint, typage et revue approuvée ; jamais de test désactivé ou allongé ;
  aucun échec silencieux.
