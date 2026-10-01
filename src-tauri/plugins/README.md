# Plugins Swift iOS

Emplacement réservé aux plugins Tauri iOS écrits en Swift (PRD 11.4) :
`vision` (OCR), `speech`, `folder-bookmark` (signet iCloud Drive), `reminders` (EventKit).

Chaque plugin est un crate Tauri avec son dossier `ios/` ; son contrat (commandes,
entrées, sorties, erreurs) est défini par l'architecte avant implémentation et
consommé côté TypeScript uniquement via `src/platform/`.
Aucune compilation iOS locale : build par `.github/workflows/build-ios.yml`.
