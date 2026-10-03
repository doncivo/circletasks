# Dettes techniques et fonctionnelles ouvertes

Inventaire établi par la revue globale de fin d'ordre 1 (2026-10-03). Chaque dette est classée selon l'ordre où elle doit être soldée. Une dette soldée est barrée, avec le commit qui la solde.

## Ordre 2

- Logique métier dans des composants, en double : `GoalHistory.tsx:38-48` et `GoalsScreen.tsx:26,75-82` groupent et trient les tâches par objectif, chacun avec son propre comparateur. À remplacer par un seul sélecteur dans `src/domain`.
- Réglages écrits par les stores sans passer par un cas d'usage : `settingsStore.ts:74-130`, `routineStore.ts:117`, `somedayStore.ts:149`, `spaceFilter.ts:33`.
- Code mort et commentaires périmés :
  - `getDatabase` (bootstrap.ts:54) et `createPendingRepositories` (dataAccess.ts:65) ne servent plus qu'aux tests.
  - Commentaire « À brancher dans App.tsx » (bootstrap.ts) et conséquence associée dans l'ADR 0004.
  - Ordre de M14 erroné dans 0001_core_tables.ts:25.
- Fichiers de plus de 400 lignes à découper : `taskRepository.ts` (597), `DateField.tsx` (472), `createTaskUseCases.ts` (466), `todayStore.ts` (460).
- Liens tâche → checklist et tâche → événement : migration à faire (ADR 0004, point ouvert 3).
- Stories partielles à clore :
  - A-09, critères 9-10 (alerte d'agenda) ;
  - S-05, critères 9-10 (alimentation par M8) ;
  - ES-06, critères 5-6 (affectation des agendas).
- Points d'extension à utiliser :
  - M6 et M7 par `registerTodaySource` ;
  - K-01 vers `externalEvents` ;
  - M14 : migration `search_index` en FTS5.
- Primitive de glisser commune à `useSortable` et `useZoneDrag` (avenant S-06 de l'ADR 0004).
- Segments Tâche / Événement / Routine de la feuille Ajout, à construire avec E-01.
- « Date de fin » du RecurrencePicker encore native (dette T-14).

## Ordre 3

- ES-08 : écrans Statistiques et Focus par espace et projet, table `focus_session`.
- Rapport mensuel global (H-01) ; aujourd'hui, seules la partie routines et l'accès aux tâches terminées existent.

## Ordre 4 (synchro)

- Lister dans l'ADR de synchro les colonnes locales, non synchronisées : `task.discarded`, `external_event` (sans colonnes de synchro) et les réglages de portée locale.
- Documenter le marqueur `series_index = -1`.
- Dériver `routine.paused` de `routine_pause` au lieu de le fusionner seul.
- La purge fait un `DELETE` physique (taskRepository.ts:467-468) : à concilier avec les traces de suppression (risque de résurrection, Y-09).
- Fixer une limite de dérive du hlc.
- Bandeaux « Synchro en cours » et « En attente d'iCloud » (A-09).
- Corbeille : `trashStore.ts:18` garde des copies hors de `taskEntities`, ce qui est documenté ; à revoir avec la synchro.

## Ordre 5 (iPhone)

- Planifier les rappels sur `effectiveFireAt` (domain/quietHours.ts:100) et recalculer chaque jour le `fire_at` des routines.
- Ignorer les routines en pause ou archivées.
- Brancher le balayage (A-07) et la notification sur `sendToSomeday`.
- Créer l'interface de planification des notifications dans `src/platform`, qui n'existe pas encore.

## Livraison

- D-03, critères 10-11 : workflow de release et secrets GitHub (PREP-01).
- Test d'installation réelle N → N+1 sur le PC, à faire par Ali.
