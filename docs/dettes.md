# Dettes techniques et fonctionnelles ouvertes

Inventaire établi par la revue globale de fin d'ordre 1 (2026-10-03). Chaque dette est classée selon l'ordre où elle doit être soldée. Une dette soldée est barrée, avec le commit qui la solde.

## Ordre 2

- ~~Logique métier dans des composants, en double : `GoalHistory.tsx:38-48` et `GoalsScreen.tsx:26,75-82` groupent et trient les tâches par objectif, chacun avec son propre comparateur. À remplacer par un seul sélecteur dans `src/domain`.~~ Soldée (b0b1725).
- ~~Réglages écrits par les stores sans passer par un cas d'usage : `settingsStore.ts:74-130`, `routineStore.ts:117`, `somedayStore.ts:149`, `spaceFilter.ts:33`.~~ Soldée (e3d5ac4).
- ~~Code mort et commentaires périmés :~~ Soldée (54a9181) :
  - ~~`getDatabase` (bootstrap.ts:54) et `createPendingRepositories` (dataAccess.ts:65) ne servent plus qu'aux tests.~~
  - ~~Commentaire « À brancher dans App.tsx » (bootstrap.ts) et conséquence associée dans l'ADR 0004.~~
  - ~~Ordre de M14 erroné dans 0001_core_tables.ts:25.~~
- Fichiers de plus de 400 lignes à découper : `taskRepository.ts` (597), `DateField.tsx` (472), `createTaskUseCases.ts` (466), `todayStore.ts` (460).
- Liens tâche → checklist et tâche → événement : migration à faire (ADR 0004, point ouvert 3). Lien tâche → checklist : non créé par le lot C (aucune fiche C ne l'exige, C-03 D2) ; reste le lien tâche → événement (K-04).
- Stories partielles à clore :
  - A-09, critères 9-10 (alerte d'agenda) ;
  - S-05, critères 9-10 (alimentation par M8) ;
  - ES-06, critères 5-6 (affectation des agendas).
- Points d'extension à utiliser :
  - ~~M6 par `registerTodaySource`~~ (soldé par C-03 : `registerChecklistsSource`, Aujourd'hui et Semaine) ; M7 soldé par E-01 : `registerEventsSource`, Aujourd'hui et Semaine ;
  - K-01 vers `externalEvents` ;
  - ~~M14 : migration `search_index` en FTS5.~~ (soldé par RC-01 : migration 0011, déclencheurs, `SearchRepository`)
- ~~Primitive de glisser commune à `useSortable` et `useZoneDrag`~~ (soldée avec P-01 : `src/ui/dragPrimitive.ts`).
- ~~Segments Tâche / Événement / Routine de la feuille Ajout, à construire avec E-01.~~ (soldé par E-01 : `AddSheet`, `AddSegments`, `RoutineForm` réutilisé)
- « Date de fin » du RecurrencePicker encore native (dette T-14).
- Jours fériés (E-03) : mettre à jour la table des fêtes religieuses tunisiennes (`src/domain/holidays/lunarTable.ts`) avant la fin de chaque année (un test échoue sinon) ; sur iPhone, la roue des jours du sélecteur de date ne remonte pas au-delà de 60 jours (corriger une fête passée plus ancienne se fait sur PC).
- E-04 critère 8 (« J-n » sur les jours fériés) contredit la maquette et E-03 : maquette suivie (tag « Férié FR / TN »), à corriger dans le PRD par Ali.

## Ordre 3

- ES-08 : écrans Statistiques et Focus par espace et projet, table `focus_session`.
- Rapport mensuel global (H-01) ; aujourd'hui, seules la partie routines et l'accès aux tâches terminées existent.

- Export H-03 : `ExportDialog` a sa propre fenêtre (portail + piège de focus) en attendant un composant `ui/Dialog` commun aux fenêtres et feuilles (ChoiceDialog, ConfirmDialog, Sheet) ; à factoriser.
- Export H-03 : la lecture par blocs de `StatsRepository.listTasksForExport` trie sur `COALESCE(date, '9999-99-99')`, expression non indexée : SQLite retrie les lignes restantes à chaque page, donc le coût est quadratique en nombre de pages (500 lignes par page). Mesuré sous 2 s pour 5 000 tâches ; à reprendre avec un index d'expression ou une clé de tri stockée avant d'exporter beaucoup plus.

- Rapport du mois (H-01) : il se rafraîchit après un changement de tâche ou de session Focus, pas après une modification des routines (validations, pauses) ni des objectifs ; il faut rouvrir l'écran ou changer de mois. À brancher sur une révision des routines et des objectifs.

## Ordre 4 (synchro)

Réponses de l'architecte : ADR 0011, section 8 (données exclues et cas particuliers) et section 9 (règles de l'ADR 0010). Ces dettes sont soldées par l'implémentation des lots Y1 à Y3, pas par l'ADR.

- focus_session : une seule session active garantie par le code seulement ; à la fusion de synchro, clore la plus ancienne si deux sessions sont ouvertes.
- Exclure `search_index` et `search_index_doc` des journaux de synchro (RC-01 : index local reconstruit sur chaque appareil).
- Lister dans l'ADR de synchro les colonnes locales, non synchronisées : `task.discarded`, `external_event` (sans colonnes de synchro) et les réglages de portée locale.
- Documenter le marqueur `series_index = -1`.
- Dériver `routine.paused` de `routine_pause` au lieu de le fusionner seul.
- La purge fait un `DELETE` physique (taskRepository.ts:467-468) : à concilier avec les traces de suppression (risque de résurrection, Y-09).
- Fixer une limite de dérive du hlc.
- Bandeaux « Synchro en cours » et « En attente d'iCloud » (A-09).
- Corbeille : `trashStore.ts:18` garde des copies hors de `taskEntities`, ce qui est documenté ; à revoir avec la synchro.
- Restauration P-04 et synchro : appliquer l'ADR 0010 (état publié qui fait foi, marqueur `restore-marker.json`, synchro suspendue et choix explicite, époque et instantané, âge de la version face aux traces de suppression).
- `sample.ids` (P-05) est un réglage local : après association, seul l'appareil qui a créé les données d'exemple propose de les supprimer ; à revoir dans l'ADR de synchro.

Audits de sécurité de l'ADR 0011 (trois audits et une vérification ciblée, le 2026-10-05). L'ADR est révisé après chacune, et son annexe A donne la correspondance point par section pour les trois audits. Ces points sont soldés par les lots Y1 à Y3, qui doivent tous les couvrir :
- Premier audit (24 points, validés par le second) :
  - H1 : clé visible par une WebView en deux points ; confirmation native, limite d'appels, rien dans Zustand ni dans les journaux.
  - H2 : manifeste de `build.rs` et test `config.rs`.
  - H3 : Trousseau iOS.
  - H4 : contrôle du dossier.
  - H5 : identifiants SQL du seul catalogue.
  - H6 : anti-rejeu de `state.ctx`.
  - M1 à M10, B1 à B6 : bornes, métadonnées, `calendar_account.username` (migration 0017, Y2), traces, `sync_guard`, nonces, `zeroize`, `qrcode-generator`, journaux sans secret.
- Second audit (16 points, validés par le troisième) :
  - aucune perte au changement d'époque ;
  - fenêtre dédiée `pairing` (`pairing.html`, capability `sync-pairing.json`) ;
  - compteurs de confirmation persistés, « Annuler » par défaut ;
  - `WDA_EXCLUDEFROMCAPTURE` sur `pairing` ;
  - `stateSeq` dans les accusés ;
  - plafond de 1 Mio par segment ;
  - Rust maître de `head`, `pairedBy` et `forgotten` ;
  - conception de Y-10 et Y-11 ;
  - usages de `label` dans `calendarsStore.ts`.
- Troisième audit (sur c8d1253) :
  - H1 : `main` ne peut plus créer de fenêtre. **Correctif de F-01 inclus dans Y1** : trois commandes Rust `focus_window_*` remplacent `core:webview:allow-create-webview-window` et les permissions de fenêtre de `focus-launcher.json`. L'instance `pairing` est créée par Rust, jamais réutilisée, et contrôlée par libellé, URL exacte et HWND.
  - M1 : changement d'époque matérialisé depuis la base locale, par pages.
  - B2, B3, B4, B6 : corrigés dans l'ADR (import au premier plan, `sync/own.json`, actions de la fenêtre `pairing`, graphe complet de `test:bundle`).
  - Basses du troisième audit (risques acceptés, à documenter dans l'ADR 0011 « Limites connues » au lot Y1) :
    - B1 : la condition « fenêtre au premier plan » de la confirmation native est affaiblie si `main` peut se remettre au premier plan elle-même ; le verrou de premier plan de Windows la limite, et le retrait de `show` / `set-focus` / `unminimize` de `focus-launcher.json` (H1) la réduit encore.
    - B5 : un script de `main` peut ouvrir la boîte de confirmation alors que l'utilisateur est présent ; un refus bloque l'affichage 10 min. Déni de service local accepté.
    - B7 : la mini-fenêtre `quick-capture` pouvait être imitée comme `pairing` ; impact faible, réglé par le même correctif H1 (plus de création de fenêtre depuis `main`).
    - B9 : un tiers sans clé peut déposer un en-tête `ct-*` en clair dans le dossier, ce qui provoque `folder-has-data` et bloque la création de clé. Déni de service de la menace (a), accepté ; l'utilisateur peut choisir un autre dossier ou supprimer le fichier étranger.
- Quatrième vérification (ciblée) : H1, M1, B2, B3, B4 et B6 du troisième audit sont validés. Corrections portées dans l'ADR :
  - publication par ligne et par horloge de champ, triée par hlc ; invariant « hlc strictement croissants à l'intérieur d'une époque » ;
  - republication des opérations reportées par hlc croissant, avant toute nouvelle écriture ;
  - `maxHlc` cumulé par époque ;
  - `sync_pairing_close` ;
  - URL Vite seulement en debug ;
  - résolution des jokers dans le test (5) ;
  - mode lié à l'instance `pairing` ;
  - `own.json` indexé par dossier et par clé ;
  - limite connue sur les écritures d'un appareil tiers inactif.
- Commandes : **21 commandes `sync_*`** dans `src-tauri/build.rs`, dont 18 pour `main` (`sync.json`) et 3 pour `pairing` (`sync-pairing.json` : `sync_pairing_payload`, `sync_key_import`, `sync_pairing_close`, sans aucune permission `core:`). S'y ajoutent les 3 commandes `focus_window_*` du correctif F-01.
- Limites acceptées tant que Y-10 et Y-11 ne sont pas au PRD (ADR 0011, section 14.1) : un appareil perdu garde une copie complète ; la purge reste bloquée jusqu'à 180 jours ; iCloud garde 30 jours de « Supprimés récemment » ; une clé unique lit et forge tout. À solder par le lot Y4 si Ali ajoute Y-10 et Y-11 au PRD M15.
- Risques acceptés :
  - le Gestionnaire d'identification Windows est lisible par toute la session, et la désinstallation n'efface pas la clé du coffre ;
  - sur iPhone (une seule WebView), la saisie de la clé de secours reste lisible par un script passif de la fenêtre principale ;
  - la fenêtre `pairing` apparaît noire dans les captures pendant 5 minutes au plus.

- **Lot Y1, corrections de la revue et de l'audit (dettes reportées au lot Y2)** :
  - Budget de nonces (audit S9, revue 18) : Rust compte les enregistrements scellés par clé (`sync/usage.json`, gardé quand la même clé revient) et refuse de chiffrer à 2^32 ; l'alerte au-delà de 2^30 n'est que journalisée. À faire par Y2 : remonter l'alerte dans `SyncStatus` (« Réinitialisez la synchronisation », Y-11) et la calculer sur la **somme des têtes publiées** par tous les appareils (le compteur local de Rust ne voit que ses propres scellements).
  - Revue 14 : publier le nombre d'enregistrements d'un segment **clos** et d'un instantané (fin de segment, `snap-end.count`) pour qu'un lecteur distingue un segment complet d'un segment tronqué par un tiers sans dépendre de la seule tête.
  - ~~Critère 16 de Y-01 (QA-Y1-5) : appeler `sync::marker::write_after_restore` depuis `backup::restore_backup`.~~ Soldée par le lot Y2 (branchement sur Y1) : `backup::write_restore_marker` délègue à `write_after_restore`, testé dans `restore_hardening.rs` (marqueur écrit seulement avec un dossier configuré ; aucun marqueur après une restauration récupérée au démarrage).
  - Fenêtre `pairing` (audit S1, A2) : en développement avec `devUrl` (serveur Vite), le contrôle de présence de `pairing.html` dans les actifs embarqués est sauté (la page est servie par Vite, pas embarquée) ; à revoir avec Y-06, qui livre la page et son entrée Vite (contrôle par requête au serveur de développement ou entrée déclarée).
  - Scan (audit S2) : au-delà de 64 appareils candidats non protégés, de 64 époques par appareil ou de 50 000 entrées listées, le scan est `incomplete` ; le moteur doit l'afficher (« dossier encombré ») sans en tirer de conclusion de purge.
- **Y-07, règle « même écriture » de la réintégration** (`decideReintegration`, `src/domain/sync/compat.ts`) : un champ gardé au hlc du repli « * » de sa ligne, sans horloge propre, est écrit (il complète l'écriture reçue quand la colonne n'existait pas). La règle suppose que **toute future migration additive régénère les déclencheurs de capture** pour la nouvelle colonne (horloge propre posée à chaque écriture locale, comme `captureTriggers` de la migration 0015) : sans cela, une écriture locale de la colonne n'aurait pas d'horloge propre et pourrait être écrasée par une valeur gardée au hlc du repli. À vérifier dans la fiche de la première migration additive réelle (la migration de test `tests/sim/syncVersions.ts` le fait).
- **Y-07, code copié entre `src/db/repositories/sql/syncUnknown.ts` et `src/sync/apply.ts`** (écriture d'une ligne et de ses horloges, repli « * », inscription des conflits, contrôle des parents) : à mettre en commun après le lot Y3 (`apply.ts` est en lecture seule pendant le lot).

## Ordre 5 (iPhone)

- Rappels d'événements (E-01) : une ligne `reminder` par avance, calculée sur la prochaine occurrence ; l'ordre 5 doit recalculer l'échéance de chaque occurrence d'une série (mensuelle, annuelle) et ne planifier que les rappels à venir.
- Planifier les rappels sur `effectiveFireAt` (domain/quietHours.ts:100) et recalculer chaque jour le `fire_at` des routines.
- Ignorer les routines en pause ou archivées.
- Brancher le balayage (A-07) et la notification sur `sendToSomeday`.
- Créer l'interface de planification des notifications dans `src/platform`, qui n'existe pas encore.
- P-04 critère 11 (sauvegarde et restauration sur iPhone) : commandes limitées à Windows, `container.backups` indisponible sur iOS ; à ouvrir par un avenant à l'ADR 0009 (capability iOS, gestionnaire mobile, réouverture de la base sans `relaunch`) en respectant l'ADR 0010.
- P-07 sur iPhone : « Télécharger un modèle » et le rapport des lignes rejetées sont masqués tant que le plugin Fichiers (`FileService.save`) n'existe pas.
- Synchro (ADR 0011, section 2.1) : lancer le scan du QR depuis Rust (`sync_key_import({ scan: true })`). Si l'API Rust du plugin barcode-scanner ne le permet pas, faire passer le texte par le JS et documenter ce troisième point d'exposition par un avenant. Vérifier aussi les attributs du Trousseau (`SecItemCopyMatching`) et le refus des liens symboliques sous le signet du dossier.

## Livraison

- D-03, critères 10-11 : workflow de release et secrets GitHub (PREP-01).
- Test d'installation réelle N → N+1 sur le PC, à faire par Ali.

## Sécurité

- Audit des dépendances Rust (RustSec) : l'étape `audit-rust` de `.github/workflows/tests.yml` lance `cargo audit` ; l'audit LOCAL reste à lancer (`cargo install cargo-audit --locked` puis `cargo audit --file src-tauri/Cargo.lock`) dès que l'outil est installé sur le poste, l'outil ne l'étant pas encore (lot K, revue sécurité).

## Mise à jour de fin d'ordre 2 (2026-10-04)

**Soldées pendant l'ordre 2 :**
- sources M6 et M7 branchées sur registerTodaySource ;
- index FTS5 (migration 0011) ;
- segments Tâche / Événement / Routine de la feuille Ajout ;
- lien tâche → événement (0012) ;
- ES-06 et S-05 clôturées ; A-09 reste ouverte pour le seul critère 9 (ordre 4).

**À solder AVANT l'ordre 3 (lot de remboursement) :**
- ~~Sélecteur d'objectifs unique dans src/domain (tri en double : GoalHistory.tsx:47, GoalsScreen.tsx:28 et 82)~~ (soldée : b0b1725).
- ~~Cas d'usage pour les réglages, à la place des écritures directes de settingsStore.ts:74-101, routineStore, somedayStore et spaceFilter~~ (soldée : e3d5ac4).
- ~~Cas d'usage pour calendarsStore.ts : écritures directes dans les repositories aux lignes 161 et 314-341~~ (soldée : af431a4).
- ~~Développement des RRULE déplacé de features/calendars/providers/recurrence.ts vers src/domain/externalRecurrence.ts~~ (soldée : 0b0b316).
- ~~Code mort : bootstrap.ts:55 (getDatabase), bootstrap.ts:86 (« À brancher »), dataAccess.ts:71 ; commentaire faux dans 0001_core_tables.ts:25~~ (soldée : 54a9181).

**Ordre 3 :**
- Découper les fichiers de plus de 400 lignes : taskRepository (607), DateField (472), createTaskUseCases (468), todayStore (460), calendarsStore (412), et src/i18n/fr.ts (630) par module.
- ~~Primitive de glisser commune à useSortable et useZoneDrag~~ (soldée avec P-01 : `src/ui/dragPrimitive.ts`).
- « Date de fin » du RecurrencePicker.
- ES-08 et H-01.
- Interfaces src/platform pour l'OCR, l'export et les fichiers.

**Ajouts pour l'ordre 4 (inventaire des données locales et des risques) :**
- Historique des recherches : réglage local (RC-04).
- task.external_event_id : pointe vers external_event, une table locale.
- holiday : les fêtes lunaires semées reçoivent un id aléatoire sur chaque appareil (holidayUseCases.ts:29), alors que la table est unique par pays, année et fête. Il faut un id déterministe ou une fusion sur la clé naturelle.

- Supprimer le réglage inutilisé `general.theme` (remplacé par `ui.theme`).
- PRD 6 : thème classé comme préférence partagée, alors que `ui.theme` est local (décision D1) — à corriger par Ali.

## Ordre 3

- Fusionner les grammaires de dates `dateInput.ts` (T-14) et `naturalDate.ts` (Q-02) ; chrono-node conservé (PRD 7).
- Focus : si l'écriture de clôture au terme échoue toujours, `checkElapsed` (appelé chaque seconde) réaffiche le message d'erreur en boucle : afficher une seule fois par session (revue du lot F).
- Export H-03 (troisième revue et audit, non bloquant) :
  - nom de temporaire unique par appel (`.ct-export-<aléa>.partial`, `create_new`, sans suppression préalable) : évite le conflit de deux exports simultanés et l'échec au-delà d'environ 243 caractères de nom ;
  - ajouter `CONIN$`, `CONOUT$`, `COM¹-³` et `LPT¹-³` aux noms réservés ; appliquer le préfixe `_` avant la coupe à 200 caractères ;
  - lecteur réseau monté (`Z:`) ou jonction vers un partage : le contrôle porte sur la lettre de lecteur seulement (option `GetDriveTypeW` et `canonicalize`) ;
  - repli JSON du corps : plafond vérifié après la désérialisation par Tauri (refuser ce repli ou plafond plus bas) ;
  - motif d'erreur dédié `too-large` (texte i18n) ; signature `reveal()` sans paramètre côté TS ;
  - tests ExportDialog : témoin positif pour `flush()`, `vi.restoreAllMocks()` en `afterEach`.
- Lot P (revue et audit du 2026-10-05, non bloquant) :
  - lecteur réseau mappé (`Z:`) : l'import (`import_open_file`) contrôle la lettre de lecteur seulement, comme l'export H-03 (option `GetDriveTypeW`) ;
  - iPhone : l'événement `cancel` de `<input type="file">` n'est pas déclenché de façon fiable par WKWebView ; une annulation peut laisser `pickText` en attente (promesse jamais résolue) : à traiter avec le plugin Fichiers de l'ordre 5 ;
  - import : U+200C (liaison nulle, utile en persan) est retiré avec les autres caractères de format Cf ; à autoriser entre deux lettres arabes si le besoin se présente ;
  - restauration et récupération : course entre `is_plain_file` et `rename` (contrôle puis action, sans verrou), course entre `ensure_plain_backups_dir` et `create_dir_all` (le dossier peut devenir un lien entre le contrôle et l'écriture), et liens physiques (un fichier à plusieurs noms n'est pas détecté) ; option : ouvrir le fichier d'abord et renommer par descripteur ;
  - déclencheurs : la référence est unique (`backup_triggers.rs`, état après la migration 0011) ; une migration future qui modifie un déclencheur obligera à la mettre à jour (version d'introduction par déclencheur, ou DROP / CREATE imposés dans les migrations) ;
  - après un échange réussi, l'ancienne base existe en double : la copie de sécurité `pre-restore` ET ses restes archivés par la récupération au démarrage (si l'arrêt a eu lieu avant le nettoyage) ;
  - `stampCases()` (CASE par identifiant pour un tampon distinct par ligne) est dupliqué dans `taskRepository` et `reminderRepository` : à partager dans `sqlHelpers` ;
  - annulation de l'import : double découpage en paquets (commande d'annulation puis repository) ;
  - annulation de l'import : afficher « n retirées, m conservées » quand des tâches modifiées depuis restent en place ;
  - `src/platform/relaunch.ts` importe `@tauri-apps/plugin-process` de façon statique (import dynamique pour alléger le bloc de départ) ;
  - renommer `FileExportError` en `FileError` (il sert aussi à la lecture) ;
  - restauration : points d'analyse de la couche de bureau (`app_config_dir` lui-même par jonction) non contrôlés au-delà du dossier `backups/`.
- `cargo clippy --all-targets` : avertissements existants dans `src-tauri/src/backup.rs` (vers les lignes 757 à 904) et `src-tauri/tests/desktop/export.rs` (lignes 35 et 47), relevés pendant Q-01 critère 10 ; à corriger, puis ajouter clippy au job CI `tests.yml`.
- build-windows.yml : l'extraction des notes depuis CHANGELOG.md garde la ligne vide qui suit le titre (`notes` de latest.json commence par « \n ») ; retirer les lignes vides de tête et de fin.
- **Identifiants typés inopérants** (relevé à l'amorce de l'ordre 4, vérifié par `tsc --strict`) : dans `src/domain/types.ts`, `SpaceId`, `TaskId`, `DeviceId`, etc. sont déclarés `Brand<Id, 'X'>` avec `Id = Brand<string, 'Id'>` ; les deux marques littérales sur la même propriété réduisent le type à `never`. Un `SpaceId` s'affecte donc sans erreur à un `TaskId`. Correction : marques distinctes (propriété par marque, ou `Id` non marqué) puis corriger les erreurs de typage révélées. Story technique séparée, hors des lots de synchro (touche tout `src/domain` et `src/db`).
- **Synchro, revue de l'amorce (points bas reportés)** : (1) Y1 `files.rs` et `memory.ts:734-740` : plafonner la liste `pending` du scan à `MAX_SCAN_ENTRIES_PER_FOLDER` et lever `incomplete` (tête authentifiée très éloignée du plus ancien segment) ; (2) `format.bounds.test.ts` : tester que `publishedStateToJson` donne le même texte pour un objet aux clés dans un autre ordre (`pairedBy` en premier, accusé inversé) ; (3) Y2 `parse.ts` : appliquer `hasStrictJsonShape` au texte de `state.ctx` (clés en double refusées comme serde).
- **cargo audit, RUSTSEC-2023-0071 (rsa)** : exception dans tests.yml, rsa n'étant dans Cargo.lock que par sqlx-mysql (jamais compilé, fonction « sqlite » seule de tauri-plugin-sql) ; étape « rsa jamais compilé » qui fait échouer la CI si cela change. À retirer quand sqlx publiera une version sans rsa ou quand l'avis aura un correctif.
- **Synchro, rappel supprimé ailleurs puis cible restaurée (limite connue, trois appareils seulement ; lot Y2)** : C supprime un rappel R ; A supprime sa cible T (R encore vivant chez A, qui n'a pas lu C) ; B restaure T sans avoir lu C non plus et republie R entier comme rappel vivant ; si A a entre-temps purgé T et R (trace de R = hlc de suppression de T, la suppression de R par C n'y figure pas), A accepte R avec la cible restaurée (`apply.ts`, règle « base de la cible ou horloge propre ») : R ressuscite chez A jusqu'à ce que A lise la suppression de C, qui l'emporte alors (hlc plus grand). Pas de perte, mais un rappel supprimé peut réapparaître un temps. Correction possible : garder dans la trace le hlc de suppression propre du rappel quand il est connu, ou attendre que tous les appareils actifs aient lu la cible restaurée avant d'accepter ses rappels. Avec deux appareils (PC et iPhone), le cas ne se produit pas.
- **Synchro, partie d'une ligne découpée sans champ partagé (lot Y2)** : `publisher.ts` (`splitOp`) recopie `deleted_at` et le plus petit champ au hlc maximal dans chaque partie d'une ligne de plus de 256 Kio ; si cela ne tient pas à côté d'un champ proche de la limite, la partie part sans eux et peut porter un hlc maximal plus petit : la lecture la traiterait alors comme un groupe à part (accusé avancé avant les autres parties). Cas limite (champ seul de près de 256 Kio en UTF-8 plus un champ partagé volumineux) ; à revoir avec un repère de groupe explicite dans l'enregistrement.
- **publisher.ts** : le comptage des entrées « + » relit toute la file hors transaction ; une requête COUNT(*) WHERE field = '+' suffirait (revue finale du lot Y2).
