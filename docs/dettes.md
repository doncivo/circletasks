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
- Primitive de glisser commune à `useSortable` et `useZoneDrag` (avenant S-06 de l'ADR 0004).
- ~~Segments Tâche / Événement / Routine de la feuille Ajout, à construire avec E-01.~~ (soldé par E-01 : `AddSheet`, `AddSegments`, `RoutineForm` réutilisé)
- « Date de fin » du RecurrencePicker encore native (dette T-14).
- Jours fériés (E-03) : mettre à jour la table des fêtes religieuses tunisiennes (`src/domain/holidays/lunarTable.ts`) avant la fin de chaque année (un test échoue sinon) ; sur iPhone, la roue des jours du sélecteur de date ne remonte pas au-delà de 60 jours (corriger une fête passée plus ancienne se fait sur PC).
- E-04 critère 8 (« J-n » sur les jours fériés) contredit la maquette et E-03 : maquette suivie (tag « Férié FR / TN »), à corriger dans le PRD par Ali.

## Ordre 3

- ES-08 : écrans Statistiques et Focus par espace et projet, table `focus_session`.
- Rapport mensuel global (H-01) ; aujourd'hui, seules la partie routines et l'accès aux tâches terminées existent.

## Ordre 4 (synchro)

- Exclure `search_index` et `search_index_doc` des journaux de synchro (RC-01 : index local reconstruit sur chaque appareil).
- Lister dans l'ADR de synchro les colonnes locales, non synchronisées : `task.discarded`, `external_event` (sans colonnes de synchro) et les réglages de portée locale.
- Documenter le marqueur `series_index = -1`.
- Dériver `routine.paused` de `routine_pause` au lieu de le fusionner seul.
- La purge fait un `DELETE` physique (taskRepository.ts:467-468) : à concilier avec les traces de suppression (risque de résurrection, Y-09).
- Fixer une limite de dérive du hlc.
- Bandeaux « Synchro en cours » et « En attente d'iCloud » (A-09).
- Corbeille : `trashStore.ts:18` garde des copies hors de `taskEntities`, ce qui est documenté ; à revoir avec la synchro.

## Ordre 5 (iPhone)

- Rappels d'événements (E-01) : une ligne `reminder` par avance, calculée sur la prochaine occurrence ; l'ordre 5 doit recalculer l'échéance de chaque occurrence d'une série (mensuelle, annuelle) et ne planifier que les rappels à venir.
- Planifier les rappels sur `effectiveFireAt` (domain/quietHours.ts:100) et recalculer chaque jour le `fire_at` des routines.
- Ignorer les routines en pause ou archivées.
- Brancher le balayage (A-07) et la notification sur `sendToSomeday`.
- Créer l'interface de planification des notifications dans `src/platform`, qui n'existe pas encore.

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
- Primitive de glisser commune à useSortable et useZoneDrag.
- « Date de fin » du RecurrencePicker.
- ES-08 et H-01.
- Interfaces src/platform pour l'OCR, l'export et les fichiers.

**Ajouts pour l'ordre 4 (inventaire des données locales et des risques) :**
- Historique des recherches : réglage local (RC-04).
- task.external_event_id : pointe vers external_event, une table locale.
- holiday : les fêtes lunaires semées reçoivent un id aléatoire sur chaque appareil (holidayUseCases.ts:29), alors que la table est unique par pays, année et fête. Il faut un id déterministe ou une fusion sur la clé naturelle.
