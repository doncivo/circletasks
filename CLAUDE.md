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

## Délégation
Toujours passer par product-owner pour choisir la story, puis l'agent du module, puis qa-test et code-reviewer.
