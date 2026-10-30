# TRI-13 — Les écritures vers Rappels Apple retrouvent le rappel par sa référence externe (audit 1.0, important « delete/upsert de rappel Apple sans externalRef »)

Module : M8 Agendas (Rappels Apple, K-06/K-07) · Palier : avant la 1.0 (arbitrage d'Ali du 2026-10-30, cinquième des cinq) · Agent : calendar-integration + ios-mobile · Ouverte le 2026-10-30 par Claude Code. Tri : `docs/audits/2026-10-30-tri-importants.md`, ligne TRI-13.

Statut : **code TypeScript, Swift et contrat verts en local ; Swift non compilé ici, CI et revue à consigner, vérification sur appareil avec la dernière IPA.** Estimation : 3 h ; réel : environ 2 h 30.

## Origine

Le plugin Swift `reminders` retrouve un rappel par `findReminder(store, id, externalRef)` : par identifiant, sinon par référence externe. `fetch` passait la référence externe ; `upsert`, `set_completed` et `delete` passaient `nil`. Or iCloud change l'identifiant (`calendarItemIdentifier`) d'un rappel après une resynchronisation. Conséquence, vue dans le code : `delete` est **idempotent par conception** (« un rappel déjà absent est un succès »), donc une suppression visant l'ancien identifiant répondait « réussi » sans rien supprimer ; CircleTasks retirait alors le lien et la tâche, et le rappel Apple restait, orphelin : un état faux muet. `upsert` et `set_completed` échouaient en `not-found` pour la même raison.

## Critères

1. `upsert`, `set_completed` et `delete` acceptent un champ `externalRef` (facultatif, nul si inconnu) côté TypeScript (`types.ts`, `tauriReminders.ts`), côté Swift (`UpsertArgs`, `CompletedArgs`, `DeleteArgs`) et dans le contrat partagé (`tests/fixtures/calendars/reminders-contract.json`), qui reste identique des deux côtés (test de cohérence).
2. Le Swift cherche avec l'identifiant puis la référence externe pour les trois commandes ; `delete` ne répond « déjà absent » que si le rappel est introuvable par l'un et par l'autre.
3. Les appelants (`remindersWrites.ts`) transmettent la référence externe du lien ou de l'élément lu : modification, complétion, suppression. Le lien est mis à jour avec l'identifiant renvoyé (`recordWritten`, inchangé).
4. Le faux (`fakeReminders.ts`) a la même règle de recherche et sait changer un identifiant (`reidentify`), pour que les tests modélisent le défaut.
5. Aucun changement de schéma, de format publié ni de bundle.

## Preuves

- **Rouge** : `bdceb1b7` (tests et contrat seuls) : `consistency.test.ts` (les structures Swift n'ont pas le champ du contrat), `reminders.test.ts` (l'adaptateur n'envoie pas `externalRef`), `remindersWrites.test.ts` (les trois écritures n'envoient pas la référence du lien). Trois échecs, tous pour la bonne raison.
- **Vert** : TypeScript (`types.ts`, `tauriReminders.ts`, `remindersWrites.ts`), Swift (`RemindersPlugin.swift` : trois champs, trois recherches), faux. Test ajouté au vert : après `reidentify`, `delete` sans référence « réussit » sans supprimer (le défaut), avec elle le rappel est supprimé ; idem complétion et modification. Les trois oracles exacts de la forme des appels (`reminders.test.ts`) sont complétés de `externalRef: null`, rien n'est affaibli.
- **Module** : `src/platform/reminders` et `src/features/calendars` : 46 fichiers, 407 tests verts. Lint vert. Typage (`tsc --noEmit`) vert.
- **Bundle** : 338 023 normalisés, marge 20 377, **+0** face à `main`.

## Ce qui n'est pas prouvé ici

Le Swift n'est ni compilé ni exécuté en local (pas de Mac) : les modifications sont trois champs `let externalRef: String?` et trois arguments, vérifiés par le test de cohérence du contrat (noms et champs) et par la lecture. Une erreur de compilation n'apparaîtrait qu'à la compilation iPhone de la CI (`build-ios.yml`), prévue une seule fois, pour la dernière IPA. Le comportement réel (identifiant changé par iCloud, puis suppression) ne se vérifie que sur l'appareil : à ajouter au guide d'essais (ligne Rappels Apple, K-05 à K-07), avec une suppression après resynchro.

## Passes

- **Product-owner** : critères relus contre le constat (« suppression qui réussit sans supprimer »).
- **Agent du module** : voir Preuves.
- **QA** : module vert ; le test de cohérence verrouille les noms de champs Swift/TS/contrat ; le défaut lui-même est modélisé par le faux (`reidentify`). Non couvert : le vrai `EKEventStore`.
- **Revue de code (à froid)** : (1) les trois recherches Swift passent la même valeur au même `findReminder` déjà utilisé par `fetch` ; (2) `delete` reste idempotent pour un rappel réellement absent ; (3) l'identifiant renvoyé par `upsert`/`set_completed` met à jour le lien (`recordWritten`), donc l'identifiant changé est rattrapé ; (4) pas de log ni de donnée nouvelle. Approuvée, sous réserve de la CI complète et de la compilation iPhone finale.
