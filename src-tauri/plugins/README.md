# Plugins Swift iOS

Emplacement réservé aux plugins Tauri iOS écrits en Swift (PRD 11.4) :
`vision` (OCR), `speech`, `folder-bookmark` (signet iCloud Drive), `notification-actions` (actions des notifications), `reminders` (EventKit),
`web-auth` (ASWebAuthenticationSession, connexion Google, ADR 0008).

Chaque plugin est un crate Tauri avec son dossier `ios/` ; son contrat (commandes,
entrées, sorties, erreurs) est défini par l'architecte avant implémentation et
consommé côté TypeScript uniquement via `src/platform/`.
Aucune compilation iOS locale : build par `.github/workflows/build-ios.yml`.

Chaque plugin qui demande une autorisation déclare ses clés Info.plist dans
`scripts/ios/plist-contract.json` (format décrit dans le fichier, ADR 0007 avenant I-01)
et ajoute les textes français dans `src-tauri/Info.ios.plist` ; `build-ios.yml` échoue si une
clé manque ou si une description d'usage est vide.

Livrés : `folder-bookmark` (Y-IOS-01, ADR 0011 §22) : aucune commande exposée à la WebView, Rust seul l'appelle
(`FolderBookmark::call`) ; contrat dans `tests/fixtures/sync/folder-bookmark-contract.json`, contrôlé statiquement contre le Swift et
`src-tauri/src/sync/bookmark.rs`, et joué par le faux du plugin (`src-tauri/tests/desktop/support/fake_bookmark.rs`).

Livré : `web-auth` (K-TECH-01, ADR 0008 §9) : `ASWebAuthenticationSession` pour la connexion Google de l'iPhone, une seule commande
`authenticate({ url, callbackScheme }) -> { callbackUrl }`, aucune permission pour la WebView (Rust seul l'appelle, `TransportWebAuth` dans
`src-tauri/src/calendars/web_auth.rs`) ; contrat dans `tests/fixtures/calendars/web-auth-contract.json`, contrôlé statiquement contre le Swift
et `web_auth.rs`, et joué par le faux du plugin (`src-tauri/tests/desktop/support/fake_web_auth.rs`). Aucune clé Info.plist.
`notification-actions` (N-03, ADR 0012 avenant N-03) : prend la place du délégué `UNUserNotificationCenterDelegate` du plugin officiel `tauri-plugin-notification` (envoi, annulation, lecture des en attente restent à ce dernier), enregistre les catégories « Fait » / « +15 min » et écrit chaque action reçue dans `Library/Application Support/ct-notification-actions/queue.jsonl`. Commandes `drain`, `ack`, `status`, `register_action_types` (+ écoute de l'événement `action`) appelées par la WebView, transmises à Swift par Tauri (aucune commande Rust) ; contrôlé statiquement par `src-tauri/tests/desktop/notification_actions.rs`, adaptateur TS unique `src/platform/notifications/tauriNotificationActions.ts`. Aucune clé Info.plist.

Lot M (ADR 0013 et son avenant I-03) :
- `haptics` (A-07, §1.1) : crate `tauri-plugin-ct-haptics`, **`links = "tauri-plugin-haptics"`** (le préfixe des permissions vient de `links`), trois
  commandes appelées par le JS (`src/platform/haptics/tauriHaptics.ts`), générateurs UIKit sur le fil principal, aucune clé Info.plist ;
- `privacy-shield` (I-03, §2.5) : une commande `set_enabled`, vue opaque quand l'app devient inactive (sélecteur d'apps), aucune clé Info.plist.
Capabilities iOS à liste exacte (`haptics-ios.json`, `privacy-shield-ios.json`), contrôlées par `tests/desktop/config.rs` et
`src/platform/lotM.consistency.test.ts` (qui relit aussi le Swift : méthodes, point d'entrée, fil principal). Plugin officiel du lot :
`tauri-plugin-biometric` =2.4.1 (I-03), capability `biometric-ios.json`, clé `NSFaceIDUsageDescription` au contrat Info.plist.
