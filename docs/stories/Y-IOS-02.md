# Y-IOS-02 — Trousseau, scan du QR (par le JS, ADR 0011 §23), confirmations natives et fuseau local sur iPhone

Module : M15 Synchronisation · Ordre de construction : 5 (lot Y-IOS, phase 1, **après** Y-IOS-01) · Agents : **sync-icloud** (Rust, TypeScript) et **ios-mobile** (Swift de l'alerte, plist, CI) · Relectures : qa-test, code-reviewer, **security-privacy (obligatoire : exposition de la clé, Trousseau, scan)** · Statut : codé (build-ios.yml et relectures à faire)
Story technique (écart noté dans docs/decisions.md, 2026-10-07, validée par Ali). Rend vraies sur iPhone Y-06, Y-08, Y-10, Y-11 et la partie iPhone de Y-07.
Dépend de : Y-IOS-01 (plugin folder-bookmark, `BookmarkFs`, capability iOS, `available()` vrai sur iOS), Y-06, Y-08, Y-10, Y-11 (livrés côté PC).

## Contexte

- Décisions du 2026-10-07 : confirmations natives par **`UIAlertController` du plugin folder-bookmark**, « Annuler » par défaut, textes de `src/i18n/native/fr.json` passés par Rust (aucun texte en dur en Swift) ; scan du QR par l'**API Rust du plugin `barcode-scanner` d'abord**, et si elle ne compile pas, texte par le JS avec un avenant à l'ADR 0011 §2.1 (la compilation en CI tranche).
- ADR 0011 : §2.1 (exposition de la clé, iPhone : une seule WebView, limite documentée, l'iPhone n'affiche jamais le QR), §2.2 (Trousseau `ThisDeviceOnly`, non synchronisé, `vault_ios.rs`), consentement (compteurs, préconditions), §21 point 6, Questions ouvertes 6 et 8, audit M8 et B3 (`kid` vérifié avant l'enregistrement).
- **Règle d'Ali : aucun échec silencieux** (tout blocage visible dans Réglages, Détails ou un bandeau, persisté, effacé à la résolution).

## À lire avant le code

`docs/adr/0011-synchronisation-icloud.md` : §2 (2.1, 2.2, consentement), §10.3, §11.1, §14.2, §14.3, §17 à §21 (rappels de Y-06 à Y-11), Questions ouvertes 6 et 8 ; `docs/stories/Y-06.md`, `Y-07.md`, `Y-08.md`, `Y-10.md`, `Y-11.md` ; `docs/dettes.md` (« Ordre 5 (iPhone) », « Synchro, boîtes natives sur iPhone », « Y-07, à vérifier à l'ordre 5 ») ; `src-tauri/src/vault.rs`, `src-tauri/src/vault_ios.rs` ; `src-tauri/src/sync/consent.rs` (`ConsentUi`, `DialogSpec`, `ConsentGate`, `WindowsConsentUi`) ; `src-tauri/src/sync/forget.rs` (`local_offset_minutes`) ; `src/i18n/native/fr.json` ; `src/i18n/fr.syncPairing.ts` ; maquette `docs/maquettes/Appairage.html` ; `scripts/ios/plist-contract.json`.

## ADR requis avant le code

**Avenant à l'ADR 0011, §23 « Plateforme iOS : Trousseau, scan, confirmations », par l'architecte, avant la première ligne** (peut être rédigé avec le §22 de Y-IOS-01). Contenu attendu :
1. **Scan** : signature de l'appel Rust (trait `QrScanner` injectable, implémentation `tauri-plugin-barcode-scanner` mobile, résultat `Scanned(text) | Cancelled | PermissionDenied | Unavailable`), version du plugin, présence dans `Cargo.toml` sous `cfg(target_os = "ios")`, entrée `barcode-scanner` du contrat Info.plist (`NSCameraUsageDescription`, texte français) ; **si l'API Rust est inutilisable** (constat de compilation en CI), repli JS : le texte scanné est transmis immédiatement à `sync_key_import({ qrText })` sans être stocké, **troisième point d'exposition** inscrit au §2.1 et dans docs/decisions.md.
2. **Confirmation iOS** : implémentation `IosConsentUi` du trait `ConsentUi` par une commande du plugin folder-bookmark (`UIAlertController` style alerte, bouton « Annuler » `preferredAction` et style `.cancel`, bouton d'action en style `.default` ; refus si `UIApplication.shared.applicationState != .active`), forme de `DialogSpec` côté plugin (titre, message, deux libellés, tous fournis par Rust depuis `fr.json`), conservation des compteurs de `consent.json` (3 affichages et 5 imports par 10 minutes, blocage de 10 minutes après un refus) dans le dossier de configuration de l'app sandboxée, marqueur `consent.refused`, et liste des confirmations sur iPhone (remplacement de clé, « Oublier le dossier et la clé », oubli d'un appareil, réinitialisation ; **pas d'« Afficher la clé »**, qui n'existe pas sur iPhone).
3. **Fuseau local et capability** : `local_offset_minutes` par `libc::localtime_r` (`tm_gmtoff`) sous `cfg(unix)` (iOS et tests Linux), sinon API Foundation du plugin ; capability `sync-ios.json` complétée avec `sync_key_import`, `sync_key_status`, `sync_key_create`, `sync_device_forget`, `sync_forgotten_delete`, `sync_reset_key` (liste exacte fixée par test) ; l'iPhone ne reçoit pas les commandes de la fenêtre `pairing`.

## Critères testables sans Mac

Légende : **[R]** `cargo test` Windows (et Linux pour le code `cfg(unix)`), **[U]** Vitest, **[S]** contrôle statique, **[E]** Playwright projet `iphone` (simulateur, plateforme `ios`), **[CI]** `build-ios.yml` sur la branche du lot.

### Trousseau

1. **[R]** **Étant donné** `sync_key_attributes()` (`vault_ios.rs`), **alors** il fixe `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` et `kSecAttrSynchronizable = false` ; le test existant (`sync_key.rs`) reste vert pour `circletasks.sync.key.v1` et `circletasks.sync.key.next` ; un compte hors de ces deux noms est refusé.
2. **[S]** **Alors** un contrôle de la CI lit la sortie de `cargo tree --target aarch64-apple-ios` : `security-framework` est présent avec la version attendue par l'architecte, `keyring` n'est utilisé que pour les jetons d'agenda ; échec explicite sinon.
3. **[CI]** **Alors** `vault_ios.rs` **compile** dans la cible iOS du build (le module n'est actif que sous `cfg(target_os = "ios")`) ; un build qui ne l'inclurait pas (cfg erroné) échoue par un test de présence du symbole.
4. **[R]** **Étant donné** une clé de synchro absente, illisible ou en erreur du Trousseau (`errSecItemNotFound`, `errSecInteractionNotAllowed` écran verrouillé), **alors** `sync_key_status` rend `present: false` ou le code `vault-locked`/`io` sans jamais écrire la clé dans un journal ; la synchro attend l'écran déverrouillé (phase visible) et ne recrée **jamais** une clé en silence.

### Scan du QR par Rust

5. **[R]** **Étant donné** un `QrScanner` injecté, **quand** `sync_key_import({ scan: true })` est appelé depuis `main` sur iPhone au premier plan, **alors** Rust lance le scan, vérifie le format du QR, le `kid` contre le dossier **avant** l'enregistrement (audit B3), demande la confirmation native si une **autre** clé est déjà présente (audit M8), enregistre la clé au Trousseau et rend `{ kid, pairedBy, epoch }` ; **le texte scanné ne transite jamais par la WebView** (le résultat de la commande, les événements et les journaux sont fouillés par un test).
6. **[R]** Cas : annulation du scan (`Cancelled` : aucun effet, aucun échec affiché), caméra refusée (`PermissionDenied` : bandeau persistant « L'accès à la caméra est refusé » avec renvoi aux réglages iOS, effacé quand `scan` réussit ou que la permission est accordée), QR invalide ou d'un autre format (`invalid-key`), mauvais `kid` (`kid-mismatch`), QR expiré (`expired`), fenêtre pas au premier plan (`not-foreground`, aucune caméra ouverte), limite de 5 imports par 10 minutes (`rate-limited`).
7. **[U]** **Alors** l'écran iPhone « Associer au PC » (Réglages → Synchronisation → Associer au PC, d'après Appairage.html, composants existants) enchaîne : étape « Autorisation caméra accordée » (demandée au premier usage avec explication, I-05), scan, « Réception de la clé de chiffrement », « Choix du dossier iCloud Drive / CircleTasks » (Y-IOS-01), progression de l'arrivée (`SyncStatus.progress`), lien « Saisir la clé de secours à la place » (champ `autocomplete="off"`, vidé après envoi, jamais dans un store Zustand ni un journal). L'iPhone **n'affiche jamais le QR** (aucun appel à `sync_pairing_payload`, test de l'absence de la commande dans la capability iOS).
8. **[U]** **Alors** l'étape « Synchronisation » de l'assistant de premier lancement apparaît sur iPhone (4 étapes quand `available()` est vrai, 3 sinon, P-05, Y-06 D5), passable puis accessible dans Réglages.
9. **[S]** **Alors** l'entrée `barcode-scanner` du contrat `scripts/ios/plist-contract.json` exige `NSCameraUsageDescription` non vide ; `src-tauri/Info.ios.plist` porte le texte français (« CircleTasks utilise la caméra pour scanner le code d'association affiché sur votre PC. ») ; `build-ios.yml` échoue si la clé manque (test négatif du script).
10. **[CI]** **Alors** `build-ios.yml` **compile** l'appel Rust du plugin `barcode-scanner` ; le résultat de ce build **tranche** : succès = chemin Rust, définitif ; échec = avenant au §2.1 et chemin JS (critère 5 reformulé : texte scanné transmis sans stockage, non journalisé, fouillé par un test), puis nouveau build vert avant clôture.

### Confirmations natives iOS

11. **[R]** **Étant donné** `IosConsentUi` et le faux du plugin, **alors** pour chaque confirmation (remplacement de clé, oubli du dossier et de la clé, oubli d'un appareil, réinitialisation) le `DialogSpec` envoyé au plugin contient titre, message et deux libellés pris dans `fr.json`, « Annuler » par défaut ; la réponse « Annuler », la fermeture sans réponse et l'erreur du plugin valent un refus (échec fermé) ; la confirmation n'est jamais ouverte hors du premier plan (`not-foreground`, aucune boîte).
12. **[R]** **Alors** `ConsentGate` : 3 affichages et 5 imports par 10 minutes, blocage de 10 minutes après un refus, `consent.json` relu après redémarrage (dossier de configuration injectable), fichier illisible = bloqué 10 minutes, `consent.refused` si l'écriture échoue : les mêmes tests que sur PC passent avec `IosConsentUi` (suite partagée).
13. **[S]** **Alors** les sources Swift du plugin ne contiennent aucune chaîne française ni libellé en dur (contrôle statique de Y-IOS-01 critère 1 étendu à l'alerte).
14. **[U]** **Étant donné** un refus ou un blocage de confirmation, **alors** le message de l'écran (« Confirmation refusée », « Réessayez dans {n} min ») reste affiché dans Réglages ou Détails (écran d'où l'action a été lancée) jusqu'à la prochaine tentative réussie ; aucune erreur muette.

### Fuseau local et échec de réintégration

15. **[R]** **Étant donné** `local_offset_minutes(utc_ms)` implémentée par `localtime_r` (`cfg(unix)`), **alors** un test (exécuté sur le runner Linux de `tests.yml`, étape `cargo test` ajoutée par ci-release si elle manque) règle `TZ` sur Europe/Paris et America/New_York et vérifie l'été (+120 / −240) et l'hiver (+60 / −300), le passage à l'heure d'été, et un fuseau inconnu (0 **avec** journal du code `tz-unknown` et mention « UTC » dans le texte de la boîte d'oubli : jamais une heure locale fausse sans le dire).
16. **[U]** **Étant donné** `reintegrationFailure` dans `SyncStatus` (Y-07, dettes) et la plateforme `ios`, **alors** l'échec de réintégration est affiché dans Réglages > Synchronisation, Détails et le bandeau (nombre, tables, date, noms d'erreur, jamais de contenu), **persistant** après redémarrage, effacé quand une réintégration réussit (test pour chaque cas, avec le simulateur et un faux de service).
17. **[E]** Projet `iphone` avec le simulateur (`platform: 'ios'`, `role: 'join'`) : « Associer au PC » → scan simulé (texte fourni par le simulateur, jamais par la WebView réelle) → progression → tâche du PC visible ; refus de caméra simulé → bandeau persistant ; confirmation de remplacement de clé refusée → clé inchangée et message visible.

## Critères seulement vérifiables sur l'appareil (reportés dans `_checklist-ordre-5.md`)

- A1. **Parcours 11 réel** : QR affiché sur le PC, scan par l'iPhone (caméra demandée avec explication), dossier choisi, tâche du PC lisible sur l'iPhone, titre introuvable dans `iCloud Drive\CircleTasks` (Y-06, Y-08).
- A2. Attributs du Trousseau relus par `SecItemCopyMatching` (`ThisDeviceOnly`, non synchronisé) pour `circletasks.sync.key.v1` et `.next` ; élément non présent sur un second appareil de l'Apple ID.
- A3. Alerte iOS : « Annuler » par défaut (appui sur la touche par défaut ne valide rien), refus quand l'app n'est pas au premier plan, textes lisibles en mode clair et sombre, compteurs persistants après fermeture forcée.
- A4. Heure de la boîte « Oublier cet appareil » affichée en heure locale iPhone (été et hiver si possible).
- A5. Y-10 et Y-11 réels avec l'iPhone (oubli, réinitialisation, « Cet appareil doit être associé de nouveau »), Y-07 version réelle (iPhone mis à jour avant le PC) : voir la checklist.
- A6. Saisie de la clé de secours sur iPhone (limite documentée d'une seule WebView), progression d'arrivée, étape « Synchronisation » de l'assistant à 4 étapes.

## Hors de cette story

Plugin folder-bookmark et cycle d'arrière-plan : Y-IOS-01. Caméra pour l'OCR (Vision) : CAP-IOS-01 (même clé `NSCameraUsageDescription`, une seule entrée suffit si le contrat la porte déjà). Face ID : I-03.

## Ordre des sous-tâches

1. Avenant ADR 0011 §23 (architecte, avec le §22).
2. Rust : trait `QrScanner` et faux, `sync_key_import({ scan: true })`, `IosConsentUi`, suite partagée `ConsentGate`, `local_offset_minutes` (`localtime_r`), tests des critères 1, 4, 5, 6, 11, 12, 15.
3. Swift : commande d'alerte du plugin folder-bookmark ; ajout du plugin `barcode-scanner` (cargo, capability, plist et son contrat) ; premier `build-ios.yml` sur la branche : **le résultat tranche le chemin du scan (critère 10)**.
4. TypeScript : écran « Associer au PC » (iPhone), étape de l'assistant, états visibles (caméra, confirmation, réintégration), saisie de la clé de secours.
5. e2e projet `iphone` ; `build-ios.yml` final vert ; security-privacy ; qa-test, code-reviewer ; checklist d'appareil.

## Écarts et points à arbitrer

- **Écart au backlog (à valider par Ali)** : les écrans iPhone « Associer au PC », saisie de la clé de secours, progression d'arrivée et étape de l'assistant n'appartiennent à aucune story de l'ordre 5 (Y-06 est `fait` côté PC, avec « scan réel à l'ordre 5 »). Le product-owner les place ici (critères 7 et 8) ; sinon créer Y-IOS-03.
- Le lot ne touche ni `src/domain` ni `src/db` (lot N1 en parallèle) ; si un texte d'avertissement nouveau est nécessaire (`SyncWarningCode`), il attend la fin de N1.
- Texte de la caméra : unique pour barcode-scanner et vision si CAP-IOS-01 arrive avec le même texte ; sinon deux entrées au contrat.

## Corrections apportées par l'ADR 0011 §23 (font foi sur cette fiche)

- **Scan par le JS** (critères 5, 6 et 10) : l'API Rust de `tauri-plugin-barcode-scanner` 2.5.1 n'existe pas (constat du code, §23 point 2) ; le chemin est tranché sans attendre la compilation. `key.scanAndImport()` (`tauriSync.ts`) : page au premier plan, autorisation de la caméra, `scan({ windowed: true, formats: [QRCode] })`, texte passé **aussitôt** à `sync_key_import({ qrText })`, jamais rendu ni gardé ; `{ scan: true }` refusé (`invalid-pairing`, inscrit dans `import-failure.json`). Le trait `QrScanner` de Rust est seulement réservé (non implémenté).
- **Codes existants seulement** (critères 4 et 6) : `vault-unavailable` (et non `vault-locked`), `invalid-pairing` (et non `invalid-key`), `key-mismatch` (et non `kid-mismatch`), `pairing-expired` (et non `expired`), `not-foreground`, `rate-limited`, `consent-denied`, `not-configured`, `cloud-pending`.
- **Caméra refusée** (critère 6) : **pas de bandeau nouveau** (il toucherait `src/domain/syncBanners.ts`) : état lu du système (`checkPermissions`) à l'affichage de « Associer au PC » et à chaque retour au premier plan, dit dans l'écran d'association et sur la ligne de Réglages › Synchronisation (« L'accès à la caméra est refusé », « Ouvrir les réglages ») ; le bandeau persistant reste celui de `needs-pairing`.
- **Ordre dossier puis clé** (critère 7, section 10.3) : choix du dossier d'abord (s'il n'est pas lié), puis explication de la caméra, scan, réception de la clé, progression de l'arrivée ; la maquette Appairage.html montre l'ordre inverse, la section 10.3 fait foi.
- **Capability** (section « ADR requis », point 3) : `sync-ios.json` accorde 21 permissions `allow-sync-*` (les 24 moins les trois de la fenêtre `pairing`) et les cinq commandes de barcode-scanner (`scan`, `cancel`, `check-permissions`, `request-permissions`, `open-app-settings`) ; aucune permission `folder-bookmark:`.
- **Confirmations sur iPhone** : remplacement de clé, « Oublier le dossier et la clé », oubli d'un appareil, réinitialisation ; **jamais « Afficher la clé »** (aucune commande de la fenêtre `pairing` sur iPhone).
- **Fuseau** (critère 15) : `local_offset_minutes` rend `Option` ; None : heure UTC suivie de « UTC » (`forgetDetail.utc`), journal `tz-unknown` ; un fuseau inconnu de la bibliothèque C est lu comme UTC (décalage 0, jamais une erreur).
- **Clé en mémoire** : la clé lue au Trousseau reste en mémoire (`CachedVault`, relue seulement après une écriture ou une suppression faite par l'app) : le cycle du passage en arrière-plan, écran verrouillé, garde la clé déjà chargée.
