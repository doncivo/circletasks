# Y-IOS-01 — Plugin folder-bookmark, `BookmarkFs` et cycle de synchro en arrière-plan

Module : M15 Synchronisation · Ordre de construction : 5 (lot Y-IOS, phase 1, **premier** du lot, avant Y-IOS-02) · Agents : **sync-icloud** (Rust `SyncFs`/`BookmarkFs`, moteur, contrat) et **ios-mobile** (Swift du plugin, capability iOS, CI) · Relectures : qa-test, code-reviewer, **security-privacy (obligatoire : accès fichiers sous signet, liens symboliques)** · Statut : à faire
Story technique, sans équivalent au PRD (écart noté dans docs/decisions.md, 2026-10-07, validée par Ali). Rend vraies sur iPhone les stories Y-01, Y-02, Y-03, Y-05 (dossier, cycle, bouton, hors ligne).
Dépend de : I-01 (chaîne `build-ios.yml` par branche, contrat Info.plist), Y-01 à Y-03, Y-TECH-01, Y-TECH-02 (livrés). Précède Y-IOS-02.

## Contexte

- Décisions du 2026-10-07 : cycle borné à **~25 s** dans une tâche d'arrière-plan iOS, une coupure ne perd rien (file durable, reprise à l'ouverture suivante) ; Y-IOS-01 puis Y-IOS-02 ; chaque lot à plugin Swift est accepté seulement si `build-ios.yml` lancé sur sa branche est vert.
- ADR 0011 : §6.3 (contrat du plugin), §6.1 (Y-01, signet), §10.1 et §10.2 (déclenchement et cycle), §21 point 1 (lecture d'un instantané en flux sur iPhone), ADR 0007 (build sans Mac, avenant POC-01 sur les entitlements : aucun entitlement iCloud, Apple ID gratuit).
- **Règle d'Ali : aucun échec silencieux** (tout blocage visible dans Réglages, Détails ou un bandeau, persisté, effacé à la résolution).

## À lire avant le code

`docs/adr/0011-synchronisation-icloud.md` : §0, §1.6, §6 (entier), §10, §11.1 (commandes et capabilities), §13, §21 points 1 et 7 ; `docs/adr/0007-build-ios-sans-mac.md` (et avenants) ; `src-tauri/plugins/README.md` ; `src-tauri/src/sync/files.rs` (trait `SyncFs`, `StdFs`) ; `src-tauri/src/sync/service.rs` ; `src-tauri/capabilities/sync.json` ; `src/platform/sync/{types,index,tauriSync}.ts` (`available`, `SyncReason`) ; `src/sync/engine.ts`, `src/sync/service.ts` (cycle, raison `hide`, budget de « Quitter ») ; `docs/stories/Y-01.md`, `Y-02.md`, `Y-05.md` ; `docs/dettes.md` (« Ordre 5 », « Synchro, boîtes natives sur iPhone ») ; `scripts/ios/plist-contract.json`.

## ADR requis avant le code

**Avenant à l'ADR 0011, §22 « Plateforme iOS : plugin folder-bookmark, `BookmarkFs`, arrière-plan », par l'architecte, avant la première ligne** (le §6.3 donne le principe, pas le contrat). Contenu attendu :
1. **Contrat du plugin** (commandes Swift, entrées, sorties, codes d'erreur ramenés aux `SyncErrorCode` existants, aucun texte français en Swift) : `pick_folder` (UIDocumentPickerViewController en mode dossier, signet créé), `resolve` (signet obsolète rafraîchi, sinon `folder-unreachable`), `list`, `read_from(offset, max)`, `append`, `write_atomic` (écrire puis renommer), `delete`, `download` (`startDownloadingUbiquitousItem`, attente `ubiquitousItemDownloadingStatus == .current`, 60 s par fichier, 3 min par cycle, `cloud-pending`), `status`. Tout sous `startAccessingSecurityScopedResource` et `NSFileCoordinator` ; liens symboliques refusés sur chaque composant sous la racine (`unsafe-folder`) ; budget d'hydratation par cycle ; formes d'appel Rust (`PluginHandle::run_mobile_plugin`) ; `BookmarkFs` implémente `SyncFs` sans toucher au chiffrement, aux noms ni aux bornes.
2. **Arrière-plan** : qui ouvre la tâche (`beginBackgroundTask` côté Swift à `willResignActive`, avant que la WebView soit suspendue, ou à l'appel JS), commande de fin, gestionnaire d'expiration (~30 s côté iOS, cycle borné à **25 s** côté moteur), signal au moteur (échéance en argument de `syncNow('hide')`), points d'arrêt autorisés (**entre** deux unités atomiques : jamais au milieu d'un `append` ou d'une écriture d'instantané), reprise du cycle suivant, et si une commande nouvelle est ajoutée : liste exacte des commandes (`build.rs`, `config.rs`, capabilities), qui sont aujourd'hui 24.
3. **Capabilities iOS** : `sync.json` ne vise que Windows ; capability `sync-ios.json` (plateforme iOS, fenêtre `main`) avec la liste exacte des commandes autorisées sur iPhone (sans `sync_pairing_payload`, `sync_pairing_open`, `sync_pairing_close`, qui n'existent pas sur iPhone) ; `main` iPhone peut appeler `sync_key_import` (Y-IOS-02). Entrée Info.plist : aucune clé attendue (sélecteur de dossier et signet n'en demandent pas) ; si l'architecte en trouve une, l'entrée est ajoutée à `scripts/ios/plist-contract.json` avec son texte français. Validité du signet après une réinstallation par SideStore : cas prévu (signet absent ou invalide = « Choisissez le dossier à nouveau », jamais une erreur muette).

## Critères testables sans Mac

Légende : **[R]** `cargo test` (Windows, plugin Swift remplacé par un faux en mémoire qui parle le même protocole JSON), **[U]** Vitest, **[S]** contrôle statique, **[E]** Playwright projet `iphone` (simulateur de dossier `__ctSyncSim`, plateforme `ios`), **[CI]** `build-ios.yml` lancé sur la branche du lot.

### Contrat et `BookmarkFs`

1. **[S]** **Étant donné** le contrat du plugin (fixture `tests/fixtures/sync/folder-bookmark-contract.json` : commandes, champs, codes d'erreur), **alors** un test lit les sources Swift et Rust : chaque commande déclarée existe des deux côtés avec les mêmes noms et champs, chaque code d'erreur Swift est un `SyncErrorCode` connu, et **aucune chaîne française** ne figure dans les sources Swift (texte d'interface seulement via Rust, `src/i18n/native/fr.json`).
2. **[R]** **Alors** `BookmarkFs` passe la **même suite de conformité** `SyncFs` que `StdFs` (lister, lire à partir d'un octet, ajouter, écrire puis renommer, supprimer, taille, fichier absent, fichier partiel, fichier dans le nuage) avec le faux du plugin ; la suite est partagée (une table de cas, deux implémentations).
3. **[R]** **Étant donné** un fichier « dans le nuage » (statut du faux), **alors** `BookmarkFs` demande le téléchargement, attend, lit ; délai de 60 s ou 3 minutes par cycle dépassé : `cloud-pending` ; erreur du plugin : `cloud-error` ; le cycle saute le fichier et la phase « En attente d'iCloud » liste les fichiers (comportement identique au PC, A-09).
4. **[R]** **Étant donné** un lien symbolique, un composant remplacé par un lien entre deux appels, ou un fichier hors de la racine du signet, **alors** `unsafe-folder` ; rien n'est lu ni écrit.
5. **[R]** **Alors** `read_snapshot_tail` compte les lignes **en flux** avec `read_from` et ne garde que la dernière (ADR 0011 §21 point 1) : même résultat et mêmes statuts que la lecture complète sur la table de cas existante, mémoire constante testée sur un instantané de 64 Mio simulé.
6. **[R]** **Étant donné** un signet obsolète, **alors** il est rafraîchi et réenregistré sans action de l'utilisateur ; un signet impossible à résoudre rend `folder-unreachable`, **état persistant** (voir critère 12).
7. **[R]** **Alors** le chemin du dossier ne parvient jamais à la WebView (`sync_folder_info` rend `{ name, kind, configured, pinned }` seulement) ; `kind` vaut `icloud` quand le dossier est sous iCloud Drive (détection par le plugin), `local` sinon avec l'avertissement existant « Ce dossier n'est pas dans iCloud Drive… ».

### TypeScript, disponibilité et cycle en arrière-plan

8. **[U]** **Étant donné** (`tauri`, `ios`), **alors** `SyncPlatform.available()` vaut vrai (Y-01 critère 18) ; la section Réglages > Synchronisation et le bouton « Synchroniser » sont visibles sur iPhone, absents du navigateur sans simulateur ; `SYNC_COMMAND_WINDOWS`/capabilities : `config.rs` fixe la liste exacte iOS et prouve qu'aucune commande de la fenêtre `pairing` n'est accordée sur iPhone.
9. **[U]** **Étant donné** `syncNow('hide')` avec une échéance de 25 s (horloge injectée), **quand** le cycle dépasse l'échéance entre deux unités, **alors** il s'arrête **proprement** : aucune écriture partielle, la file `sync_outbox` garde ce qui n'est pas publié, `sync_meta` ne marque pas un cycle complet, la phase suivante reprend (propriété : un arrêt à chacune des frontières du cycle, puis un cycle complet, donne des bases identiques à un cycle ininterrompu ; modèle des propriétés de la section 12).
10. **[U]** **Alors** l'échéance ne s'applique qu'au cycle lancé au passage en arrière-plan ; les cycles d'ouverture, de reprise, périodique et « Synchroniser » ne sont pas bornés par elle ; un cycle de passage en arrière-plan en cours est repris à l'ouverture suivante (raison `open`) sans doublon (idempotence des ajouts de la section 10.2).
11. **[U]** **Étant donné** la tâche d'arrière-plan refusée par iOS ou expirée avant la fin, **alors** le moteur ne considère pas la synchro comme réussie ; `lastSyncAt` n'avance pas ; le texte de Réglages reste exact (« Dernière synchro à {heure} »). Une interruption à l'échéance n'est pas une panne ; trois interruptions de suite ne produisent pas de bandeau (aucune nouvelle valeur de domaine dans ce lot), mais le cycle d'ouverture suivant, non borné, qui échouerait, affiche son erreur comme toujours.

### Aucun échec silencieux

12. **[U]** **Étant donné** `folder-unreachable`, `unsafe-folder`, signet absent ou invalide (réinstallation) ou plugin en erreur, **alors** la phase `error`/`needs-folder` apparaît dans Réglages > Synchronisation, Détails et le bandeau A-09, avec le texte existant du code (ou « Choisissez de nouveau le dossier iCloud Drive / CircleTasks » pour un signet perdu), **persistée** (reste après redémarrage, tant que le dossier n'est pas rechoisi ou rejoignable), et effacée au premier cycle réussi ou au nouveau choix du dossier.
13. **[U]** **Alors** l'annulation du sélecteur de dossier (`choose()` rend null) ne change rien et n'affiche pas d'erreur (Y-01) ; une erreur du sélecteur rend un code, jamais un chemin ni le texte brut de l'erreur Swift.
14. **[E]** Projet `iphone` avec le simulateur de dossier : choisir le dossier, créer une tâche, passer la page en arrière-plan (événement de visibilité) avec une échéance de 25 s simulée → cycle `hide` lancé et borné ; dossier rendu injoignable par le simulateur → bandeau visible, recharger la page → toujours visible, dossier rétabli → disparu.
15. **[CI]** `build-ios.yml` vert sur la branche du lot : le plugin Swift compile dans le projet généré par `tauri ios init`, l'IPA est produite, les contrôles existants et le contrat Info.plist passent ; `cargo tree --target aarch64-apple-ios` montre le crate du plugin et aucun plugin PC ; `cargo tree` pour Windows ne montre pas `BookmarkFs`.

## Critères seulement vérifiables sur l'appareil (reportés dans `_checklist-ordre-5.md`, section « Plateforme iOS de la synchro »)

- A1. Choisir `iCloud Drive/CircleTasks` avec le sélecteur ; redémarrer l'app : le dossier est retenu (signet).
- A2. Hydratation réelle : un fichier écrit par le PC mais « dans le nuage » sur l'iPhone est téléchargé, lu, état « En attente d'iCloud » puis reprise (Y-02 v6).
- A3. Refus d'un lien symbolique placé sous le dossier (créé par un raccourci) : `unsafe-folder` visible.
- A4. Cycle au passage en arrière-plan : créer une tâche sur l'iPhone, verrouiller l'écran, vérifier sur le PC que la tâche arrive sans rouvrir l'app (« À la fermeture », decisions 2026-10-05) ; mesurer la durée réelle de la tâche d'arrière-plan.
- A5. Mise à jour par SideStore (N vers N+1) : signet toujours valide ou invitation claire à rechoisir le dossier ; aucune perte de la file.
- A6. iPhone sans réseau ni dossier joignable : la file attend, rien n'est perdu, la phase est visible (Y-05).

## Hors de cette story

Clé, Trousseau, scan du QR, confirmations natives, fuseau local, échec de réintégration : Y-IOS-02. Rappels : lot N1. Plugin Fichiers (P-04-iOS, lot F).

## Ordre des sous-tâches

1. Avenant ADR 0011 §22 (architecte).
2. Fixture de contrat et contrôle statique (critère 1) ; suite de conformité `SyncFs` partagée (critère 2).
3. Rust : `BookmarkFs`, faux du plugin, lecture en flux de l'instantané ; erreurs et états persistants.
4. Swift : plugin `src-tauri/plugins/folder-bookmark/` ; capability iOS ; `lib.rs` sous `cfg(target_os = "ios")` ; premier `build-ios.yml` sur la branche.
5. TypeScript : `available()` iOS, échéance du cycle `hide`, états visibles ; propriétés d'interruption.
6. e2e projet `iphone` ; `build-ios.yml` final vert ; security-privacy ; qa-test, code-reviewer ; checklist d'appareil.

## Écarts et points à arbitrer

- Ce lot ne touche ni `src/domain` ni `src/db` (lot N1 en parallèle) ; si le critère 11 exige finalement un avertissement nouveau (`SyncWarningCode`), il attend la fin du lot N1 ou passe en story séparée.
- Fichiers communs avec le lot N1 : `src-tauri/Cargo.toml`, `src-tauri/src/lib.rs`, capabilities iOS, `build.rs` : fusionner N1 d'abord ou résoudre à la main ; un seul `build-ios.yml` par branche à la fois si les minutes macOS sont comptées.
