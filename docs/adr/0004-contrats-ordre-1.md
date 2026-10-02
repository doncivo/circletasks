# ADR 0004 — Contrats de l'ordre 1 : modèle, repositories, features, coquille

- Statut : accepté
- Date : 2026-10-02
- Tâche : T-01 (étape architecte), valable pour tout l'ordre 1 (T, A, S, R, N-02/N-04, ES, OB, SD, D-01 à D-03)

## Contexte

L'ordre 1 fait intervenir cinq agents en parallèle (data-model, domain-logic, ui-design-system, tasks-planning, routines, notifications, spaces-goals, desktop-tauri). Sans contrats communs posés avant T-01, chaque story réinventerait ses types, son accès base, son annulation et sa navigation, et les suivantes devraient tout refondre. Les ADR 0001 à 0003 fixent les couches, le driver SQLite et l'i18n ; il manque les entités, les repositories, le câblage des features et la coquille.

## Décision

### 1. Modèle du domaine (`src/domain/model/`, `src/domain/types.ts`)

- Un fichier par agrégat : `space` (Space, Project, QuietHours), `task`, `recurrence`, `routine` (Routine, RoutineLog), `reminder`, `goal`, `settings`, `icon`, plus `event` et `checklist` en forme minimale (lecture pour Aujourd'hui / Semaine, complétées à l'ordre 2 sans casser les champs existants).
- Entités en camelCase, `readonly`, qui étendent `SyncMeta` (id, createdAt, updatedAt, deletedAt, deviceId, hlc). Les repositories convertissent depuis les colonnes snake_case.
- Identifiants typés par entité (`TaskId`, `RoutineId`… marqués sur `Id`) ; `asEntityId<T>()` et `newEntityId<T>(ids)`.
- Nouveaux types de base : `LocalDateTime` ('YYYY-MM-DDTHH:mm', heure flottante des rappels), `HexColor`, `Weekday` (ISO, 1 = lundi).
- Pour chaque agrégat modifiable : `XFields` (champs métier), `NewX` (champs + id choisi par le cas d'usage), `XPatch` (partiel).
- Icône : un seul champ `icon`, `IconRef` = Lucide (nom kebab) ou emoji, stocké 'lucide:nom' / 'emoji:…' (`encodeIcon`, `parseIcon`).
- Réglages : `SettingsValues` (clé → type) et `SETTINGS_DEFINITIONS` (portée `local` / `shared`, valeur par défaut). La table `settings` reste clé / valeur JSON.
- Invariants documentés dans chaque type (ex. `someday` ⇒ pas de date) ; leur validation est écrite par domain-logic dans src/domain.

### 2. Repositories (`src/db/repositories/`)

- Une interface par agrégat, méthodes nommées par cas d'usage et annotées de l'ID de story : `SpaceRepository`, `ProjectRepository`, `TaskRepository`, `RecurrenceRepository`, `RoutineRepository`, `RoutineLogRepository`, `ReminderRepository`, `GoalRepository`, `SettingsRepository`, `SyncMetaRepository`, `EventRepository`, `ChecklistRepository`.
- Règles communes (`common.ts`) : lignes supprimées exclues par défaut ; filtre `SpaceFilter` ; un tampon `WriteStamper.next()` par ligne écrite ; aucun id ni horloge fabriqué par un repository ; toute écriture renvoie l'entité enregistrée ; `RepositoryError('not-found')` ; aucune règle métier.
- `Repositories` regroupe les repositories liés à un exécuteur ; `RepositoryFactory = (executor, stamper) => Repositories` ; `DataAccess = { repos, transaction(work) }` créé par `createDataAccess(driver, stamper, factory)`. Dans `transaction`, on n'utilise que les repositories reçus (sinon blocage, ADR 0002).
- En attendant data-model, `createPendingRepositories` lève `NotImplementedError` en nommant la méthode.

### 3. Features : conteneur, stores, cas d'usage

- Conteneur unique `AppContainer` (`src/features/app/container.ts`) : `clock`, `ids`, `hlc`, `data`, `undo`, `shortcuts`, `platform`. Créé par `bootstrapApp()` (base, migrations, identité d'appareil, graine HLC), fourni par `AppContainerProvider`, remplacé en test par `createAppContainer({...})`.
- Cas d'usage : fonctions de `src/features/<module>/` qui reçoivent un sous-ensemble explicite du conteneur (`Pick<AppContainer, 'clock' | 'ids' | 'data' | 'undo'>`), appliquent les règles de src/domain et écrivent via `data`. Contrat de référence : `src/features/tasks/taskUseCases.ts` (`TaskUseCases`).
- Stores : un store Zustand par feature, déclaré par `defineFeatureStore((container) => createStore(...))`, une instance par conteneur (isolation des tests), lu par `useFeatureStore(store, selecteur)`. Les états d'interface sans dépendance (navigation, `appStore`) restent des stores de module.
- Interdits : `getDatabase()` dans une feature, SQL hors repositories, `Date.now()` / `crypto.randomUUID()` hors `Clock` / `IdGenerator`.

### 4. Coquille et navigation (`src/features/app/navigation.ts`)

- Pas de routeur d'URL ni de dépendance : store `useNavigationStore` avec `route` (union typée par onglet), `lastRoutes` (dernier écran par onglet), `detail` (fiche détail : tâche, routine, objectif, événement, checklist), `overlays` (pile : fenêtre d'ajout, recherche, aide raccourcis, capture).
- Onglets `TABS` : tasks, week, routines, events, checklists, settings, avec clé i18n, variable de couleur et raccourci Alt+1 à Alt+6.
- Présentation choisie par `useLayout()` : détail en panneau à droite (PC) ou feuille plein écran (iPhone). Échap ferme la surcouche du dessus, puis le détail.
- Le filtre Pro / Perso / Tout reste dans `appStore.spaceFilter`, mémorisé dans le réglage local `spaces.filter`.

### 5. Raccourcis clavier (`src/features/app/shortcuts.ts`)

- Table unique `SHORTCUTS` (tous ceux du PRD section 5, avec portée et description i18n) ; registre `ShortcutRegistry` par conteneur : les écrans enregistrent un gestionnaire pour un identifiant (le dernier enregistré gagne).
- Correspondance compatible AZERTY : chiffres sur `event.code`, lettres et touches nommées sur `event.key`, symboles sans tenir compte de Maj ; Cmd et AltGr exclus. Dans un champ de saisie, seuls les raccourcis `inEditable` se déclenchent.
- Le raccourci global Ctrl+Alt+Espace est déclaré pour l'aide, mais enregistré côté système par desktop-tauri via src/platform.

### 6. i18n

- `PlainMessageKey` (clés sans paramètre) pour les tables de configuration (onglets, raccourcis, annulation), passables directement à `t()`. Nouvelles sections `nav`, `undo`, `shortcuts` dans fr.ts / en.ts.

## Conséquences

- Les stories de l'ordre 1 se branchent sans refonte : nouvelles méthodes de repository par ajout, nouveaux écrans par ajout d'un membre à `Route`, nouvelles actions annulables par ajout d'un `UndoKind`.
- `App.tsx` appelle encore `bootstrapDatabase` : il passera à `bootstrapApp` + `AppContainerProvider` dès que `createSqlRepositories` existe (sinon le démarrage échoue sur `NotImplementedError`).
- Toute modification d'un contrat (type d'entité, signature de repository, `AppContainer`) passe par l'architecte et met à jour cet ADR.

## Points ouverts (product-owner)

1. Ordre manuel mixte tâches + routines dans Aujourd'hui (A-02) : la table `routine` n'a pas de `sort_order` ; proposition : routines triées par heure, ordre manuel réservé aux tâches, ou colonne `routine.sort_order` à ajouter.
2. Valeur par défaut de T-06 (`tasks.carryOverUndone`) : fixée à vrai (comportement NoteCircle), à confirmer.
3. Liens tâche → checklist et tâche → événement externe (PRD 6, « option ») : pas de colonne à l'ordre 1 ; à ajouter par migration à l'ordre 2 (K-04, C-03).
4. Libellés d'annulation au singulier « Tâche … » : pluriel par lot (A-05) à traiter avec `Intl.PluralRules` (accessibility-i18n).

## Avenant (T-04) — Source unique des tâches chargées

- Contexte : T-04 a montré qu'une tâche écrite depuis un écran (case de la liste, fiche détail, « Annuler ») restait périmée dans les autres stores qui en gardaient une copie.
- Règle : `AppContainer.taskEntities` (`src/features/app/taskEntities.ts`) est le seul endroit où vivent les `Task` chargées, indexées par id. Un hlc inférieur n'écrase jamais une entité plus récente.
- Les cas d'usage y publient toute `Task` qu'ils lisent ou écrivent (création, mise à jour, terminer / rouvrir, commandes d'annulation, plus tard report, déplacement, duplication ; `remove` pour la corbeille). Les repositories ne publient pas. Les lectures de listes (`load`) publient aussi ce qu'elles chargent.
- Les stores d'écran (Aujourd'hui, fiche détail, demain Semaine, Un jour) ne gardent que des ids, des ordres et leurs états de chargement / d'erreur ; ils ne copient jamais une `Task`. Les composants lisent via `useTaskEntities()` puis calculent l'affichage (ex. `resolveTodayTasks`). Aucun « rafraîchissement après action » ni `setTaskInPlace` : toute nouvelle story branchée sur une tâche suit cette règle.
- Les actions sont idempotentes dans le domaine (ex. `completeTask` sur une tâche déjà terminée ne change rien), car deux écrans peuvent agir sur la même tâche.

## Avenant T-09 — occurrence détachée d'une série (2026-10-02)

Annuler la complétion d'une occurrence récurrente supprime logiquement l'occurrence suivante créée par cette complétion. Cette occurrence supprimée reçoit `series_index = -1` (`UNDONE_OCCURRENCE_INDEX`, src/features/tasks/recurrenceUseCases.ts) :

- elle ne compte plus dans la série vivante ;
- elle est exclue de la corbeille (`listTrash`), ce qui interdit de la restaurer et de créer un doublon ;
- sa trace de suppression est conservée pour la synchronisation (ordre 4), où `series_index` circule comme un entier ordinaire.

Conséquence : aucune contrainte `CHECK (series_index >= 0)` ne doit être ajoutée sur `task.series_index`. Le contrat de synchro (Y-*) devra mentionner ce marqueur.

## Avenant T-10 — valeurs de série et occurrence modifiée « cette occurrence » (2026-10-02)

Réponse à l'écart de la fiche T-10 (où garder les valeurs de série ?). Une récurrence ne stocke toujours que l'occurrence en cours (PRD 6) ; les valeurs de série (titre, note, icône, heure, espace, projet) restent celles de l'occurrence courante, que `buildNextOccurrence` recopie.

- « Toutes les suivantes » : l'occurrence courante change et redevient la référence (`series_template` effacé) ; les occurrences à faire déjà créées reprennent les valeurs ; les terminées et les passées ne sont jamais réécrites.
- « Cette occurrence » : migration 0003, colonne `task.series_template` (JSON, NULL par défaut) qui garde les valeurs de série d'avant la modification et la date prévue d'origine. L'occurrence suivante est construite depuis ce gabarit (`seriesSourceOf`) et sa date calculée depuis la date d'origine (`seriesAnchorDate`) : déplacer ou modifier une occurrence ne décale ni n'altère la série. Colonne ordinaire pour la synchro (ordre 4).
- Arrêt de la répétition et « toutes les suivantes » d'une suppression : `recurrence.deleted_at` posé (la règle n'existe plus pour `createNextOccurrence`) ; les occurrences à venir déjà créées deviennent des tâches simples (arrêt) ou partent en corbeille (suppression).
- Suppression « cette occurrence » : la suivante est générée immédiatement (`ignoreDue`) ; son annulation la retire avec le marqueur `series_index = -1` de l'avenant T-09.
- Annulation (kind `series`, ou `delete` pour la suppression) : commandes fondées sur le hlc, 'stale' si la tâche ou la règle a changé depuis.

## Avenant T-12 — copie écartée (`discarded`, 2026-10-02)

Annuler une duplication supprime la copie logiquement et pose `task.discarded = 1` (migration 0004). La copie est alors exclue de la corbeille, garde sa trace de suppression et est purgée à 30 jours comme les autres. `restore` remet `discarded` à 0. `discarded` est une colonne locale : elle ne circule pas dans les journaux de synchronisation, et l'ADR de synchro (ordre 4) devra le préciser.
