# Y-TECH-03 — Banc des faux iCloud hostiles (plan de pannes partagé)

Module : M15 Synchronisation · Ordre de construction : palier 1.0, **étape 1** (avant tout autre bloquant du palier, décision d'Ali du 2026-10-17) · Agents : **sync-icloud** (`src/platform/sync/memory.ts`, scénarios de bout en bout) + **qa-test** (fixture de conformité, faux Rust, simulateurs) · Relecture : code-reviewer · Statut : **en cours, phase A faite** (2026-10-17, branche `y-tech-03-banc-icloud` ; phase A côté TypeScript faite et commitée, critères 1 à 11, 16 et 18 côté TypeScript, 19 à 27 ; phase B côté Rust à faire : `MemFs`, `fake_bookmark`, critères 12 à 15, conformité Rust des critères 16 et 17, partie Rust du 18, puis critère 28)
Story technique, sans équivalent au PRD (écart à noter dans docs/decisions.md : fait, ligne du 2026-10-17). Constat B13 de `docs/audit-1.0.md` et bloquant Q3 de `docs/audits/2026-10-16/06-qa.md`. Décision d'Ali du 2026-10-17 : « B13, le banc d'essai des faux iCloud hostiles, d'abord (16 h). B2, B3, B5 et B6 sont tous des pannes iCloud : sans ce harnais tu les corriges à l'aveugle et je n'ai aucune preuve que ça tienne. Si le banc révèle d'autres défauts de la même famille, remonte-les-moi avant de continuer. »
Dépend de : Y-IOS-02-FIX-02 (fait, livrée en 0.3.3), Y-IOS-01 (plugin folder-bookmark), `tests/fixtures/sync/syncfs-conformance.json`. Ne touche ni `src/domain` ni `src/db` ni le code de production de synchro : **code de test seulement**, sauf `src/platform/sync/memory.ts` qui est un faux (déjà utilisé par le mode dev).
Estimation de l'audit : 16 h. Règle d'Ali : si l'estimation dérape de plus de 50 % (au-delà de 24 h), arrêt et alerte avant de continuer.

## Contexte

- Les six défauts des séances iPhone tombent dans les zones aveugles de B13. Cause du blocage du 8 octobre (B1, P1) : l'instantané orphelin `s-00000001.cts` resté dans iCloud ; aucun test ne l'a vu parce que les faux iCloud sont complaisants.
- Constat Q3 : suppression toujours réussie, immédiate, atomique, propagée instantanément ; substitut `.<nom>.icloud` géré en Swift (`src-tauri/plugins/folder-bookmark/ios/Sources/FolderBookmarkPlugin.swift`, lignes ~360-370, 647, 1041-1102 : le listing présente un substitut sous son vrai nom avec disponibilité `cloud` ; depuis Y-IOS-02-FIX-02, `remove` supprime aussi le substitut sous coordination `forDeleting`) mais modélisé dans aucun faux ; fichier jamais évincé après lecture ; aucune résurrection ni écrasement concurrent ; suppression ou écriture « dans le nuage » qui n'échoue jamais ; seule `mirrorDeviceFolder` (`tests/sim/syncCloudSim.ts`) propage une suppression.
- Les trois faux à rendre hostiles :
  - (a) TypeScript `src/platform/sync/memory.ts` (classe `MemorySyncFolder`, environ 2 588 lignes ; disponibilité `local` / `cloud`, `setAvailability`, `setPartialTail`, `corruptRecord`, `removeFile`, `hydrationDelay` via `testing.setHydrationDelay`) et son simulateur à deux dossiers `tests/sim/syncCloudSim.ts` (`propagate` avec options `partialLastLine`, `placeholder`, `drop`, `conflictCopy`, `staleState` ; `mirrorDeviceFolder` ; `hydrate`) ;
  - (b) Rust `MemFs` dans `src-tauri/tests/desktop/sync_support.rs` (`remove_file` retourne toujours `Ok(bool)`, jamais d'erreur) ;
  - (c) Rust `fake_bookmark.rs` dans `src-tauri/tests/desktop/support/` (faux du plugin Swift : `Node::File { bytes, cloud, delay_ms, download_error }`, opérations `list`, `read`, `writeAtomic`, `rename`, `createDir`, `remove`, substitut géré par `placeholder_key`).
- Conformité existante : `tests/fixtures/sync/syncfs-conformance.json`, rejouée par `src-tauri/tests/desktop/sync_fs_conformance.rs` (trois implémentations Rust : `StdFs`, `BookmarkFs` sur le faux, `MemFs`) et par `src/platform/sync/syncFsConformance.test.ts` (3 cas observables sur `memory.ts`). Écart relevé par l'audit : `memory.ts` est le seul faux pour tout le TypeScript et peut diverger du Rust en silence.
- Arrêt brutal : `tests/sim/syncCrash.ts` (`armCrash(device, crashBeforeWrite)`, compteur d'écritures, jamais de délai).
- Les adresses de lignes ci-dessus viennent de l'audit et de la vérification du 2026-10-17 ; l'agent les reconfirme avant de coder et note tout écart dans la fiche.

## Décisions retenues

- **Un seul plan de pannes, un seul format** : une fixture JSON (« FaultPlan »), lue telle quelle par les trois faux et par les simulateurs. Chaque panne est armée **par nom de fichier et par rang d'appel**, jamais par le temps : aucun délai, aucun retry, aucune attente dans les tests (règle du projet).
- **Un « cycle » est un compteur explicite** (`advanceCycle()` du simulateur ou `cycle` d'un scénario), jamais une durée.
- **Règle d'Ali sur les bloquants** : « aucun bloquant n'est clos sans un test qui échoue avant le correctif et passe après ». Conséquence sur ce banc : les scénarios 2 à 5 sont **écrits ici** ; s'ils sont rouges avec le code actuel, ils **ne sont pas fusionnés dans la branche du banc** (jamais de test désactivé, jamais de fusion en rouge). Ils sont livrés sur la branche de la story du correctif (Y-FIX-02, Y-FIX-03, Y-IOS-02-FIX-01, Y-IOS-05), où ils constituent la preuve rouge puis verte. La branche du banc fusionne **verte**.
- **Rapport des défauts révélés** remis à Ali avant de continuer (sa consigne : « Si le banc révèle d'autres défauts de la même famille, remonte-les-moi avant de continuer »).
- Le faux Swift n'est pas exécuté (B13 : job macOS hors palier) ; `fake_bookmark.rs` est la modélisation Rust du comportement observé du plugin, et la conformité garantit qu'elle ne diverge pas de `memory.ts` et de `StdFs`.

## Critères testables

### Plan de pannes (FaultPlan)

1. **Étant donné** la fixture `tests/fixtures/sync/fault-plan.json` (chemin à confirmer par l'agent), **quand** on la lit, **alors** chaque entrée porte : un identifiant, une opération (`list`, `read`, `write`, `rename`, `remove`, `hydrate`), un nom de fichier ou un motif de nom (jamais d'horodatage), un rang d'appel (`nth`, à partir de 1) et un effet parmi : `error` (avec code `io` ou `cloud-pending`), `accept-not-propagated` (avec `resurrectAfterCycles` N), `evict-after-read`, `placeholder`, `overwrite-before-read` (avec le contenu de l'autre appareil), `download-error`. Un schéma (test Vitest) refuse un champ inconnu, un effet inconnu, un rang absent ou un champ de durée.
2. **Étant donné** un plan qui arme `remove` sur `s-00000001.cts` au rang 1, **quand** le faux reçoit une suppression d'un autre fichier, ou la deuxième suppression du même fichier, **alors** il se comporte normalement ; seule la première suppression du fichier désigné échoue. Preuve par un test par faux (TypeScript, `MemFs`, `fake_bookmark`).
3. **Étant donné** un plan qui contient une entrée que le faux ne sait pas rejouer (effet non implémenté, opération inconnue), **quand** il le charge, **alors** il échoue avec un message qui nomme l'entrée : jamais une panne ignorée en silence.
4. **Étant donné** deux exécutions successives du même plan et de la même séquence d'appels, **alors** les résultats sont identiques (déterminisme) ; aucun test du banc ne contient de délai, de `setTimeout`, de retry ni de `skip` (vérifié par recherche dans les fichiers ajoutés).

### Faux TypeScript : `memory.ts` et `syncCloudSim`

5. **Étant donné** `MemorySyncFolder` armé d'une suppression en échec (`io`, puis `cloud-pending`), **quand** le moteur supprime le fichier, **alors** l'appel rejette avec le code armé, le fichier reste listé et lisible, et la deuxième suppression du même fichier réussit.
6. **Étant donné** une suppression armée « acceptée mais non propagée » avec `resurrectAfterCycles` = 2, **quand** le moteur supprime puis que le simulateur avance de cycles, **alors** le fichier disparaît du listing local, puis **revient** (même nom, même contenu) après exactement 2 appels à `advanceCycle()` ; avec N = 0 il ne revient jamais (cas de référence, identique au comportement actuel).
7. **Étant donné** un fichier évincé après lecture (`evict-after-read`), **quand** le moteur le lit puis relit le listing, **alors** sa disponibilité repasse à `cloud` et une nouvelle lecture suppose une hydratation (cohérent avec `setAvailability`).
8. **Étant donné** un `overwrite-before-read`, **quand** un listing est suivi de la lecture du même fichier, **alors** la lecture rend le contenu de l'autre appareil (et non celui listé), et le listing suivant montre sa nouvelle taille.
9. **Étant donné** une écriture armée « refusée dans le nuage » (`cloud-pending` ou `io`), **quand** le moteur écrit un segment ou un état, **alors** l'écriture échoue avec le code armé et **aucun octet partiel** n'est visible (écriture atomique conservée), sauf si la panne demande explicitement `partialLastLine` (option existante de `propagate`).
10. **Étant donné** `tests/sim/syncCloudSim.ts`, **quand** un appareil supprime un fichier, **alors** `propagate` transmet la suppression à l'autre dossier selon le plan (immédiate par défaut, différée ou refusée si le plan l'arme), et les options existantes (`partialLastLine`, `placeholder`, `drop`, `conflictCopy`, `staleState`, `hydrate`, `mirrorDeviceFolder`) se comportent comme avant (suite existante verte sans modification de ses attentes).
11. **Étant donné** une hydratation en échec (`download-error`), **quand** le moteur lit un fichier `cloud`, **alors** la lecture échoue avec l'erreur de téléchargement armée, le fichier reste `cloud`, et le plan ne réussit pas à la lecture suivante tant que l'entrée n'a pas été consommée (rang d'appel).

### Faux Rust : `MemFs` et `fake_bookmark`

12. **Étant donné** `MemFs` (`sync_support.rs`), **quand** une suppression est armée en échec, **alors** `remove_file` retourne une erreur de code `io` (ou `cloud-pending`) au lieu de toujours `Ok(bool)`, et les chemins existants qui l'utilisent restent verts sans changement d'attente.
13. **Étant donné** `fake_bookmark.rs`, **quand** le plan arme un `placeholder` sur un fichier, **alors** `list` présente le substitut `.<nom>.icloud` sous le vrai nom avec disponibilité `cloud` (comme le plugin Swift), `read` déclenche l'hydratation, et `remove` du vrai nom **supprime aussi le substitut** (chemin de Y-IOS-02-FIX-02, mode « correct »).
14. **Étant donné** le même faux en mode « historique » (option explicite `removeLeavesPlaceholder`, réservée aux tests de régression), **quand** le code supprime le vrai nom, **alors** le substitut reste et le fichier réapparaît au listing suivant : le bug du 8 octobre est reproductible à volonté (le test de régression du scénario 1 s'en sert).
15. **Étant donné** `Node::File { bytes, cloud, delay_ms, download_error }`, **alors** les pannes d'éviction après lecture, d'écrasement avant lecture et d'hydratation en échec sont armées par nom et par rang comme en TypeScript, et `delay_ms` n'est jamais utilisé pour un test du banc (rang d'appel seulement).

### Conformité partagée

16. **Étant donné** `tests/fixtures/sync/syncfs-conformance.json` étendue avec les cas de pannes des critères 5 à 15 (suppression en échec, résurrection après N cycles, éviction, substitut, écriture refusée, écrasement, hydratation en échec) avec leur attendu (code d'erreur, listing après chaque pas), **quand** elle est rejouée, **alors** les **quatre** implémentations la passent à l'identique : `StdFs` (cas applicables à un vrai système de fichiers), `BookmarkFs` sur `fake_bookmark`, `MemFs` (Rust) et `memory.ts` (TypeScript, via `syncFsConformance.test.ts`), avec les mêmes codes d'erreur et les mêmes listings.
17. **Étant donné** un cas de conformité volontairement faussé (preuve jetable, non laissée dans le dépôt), **alors** la lecture Rust ET la lecture TypeScript échouent et nomment le cas : le faux TypeScript ne peut plus diverger du Rust en silence. Un cas qu'une implémentation ne peut pas rejouer est déclaré « non applicable » avec sa raison dans la fixture, jamais ignoré.
18. **Étant donné** une règle du projet « tout faux iCloud rejoue la même fixture », **alors** un test vérifie que chaque faux du dépôt (liste fixe dans le test : `memory.ts`, `MemFs`, `fake_bookmark`) charge `syncfs-conformance.json` et `fault-plan.json` ; l'ajout d'un nouveau faux sans cette lecture fait échouer le test avec le nom du fichier fautif.

### Scénarios de bout en bout

19. **Scénario 1 : l'instantané orphelin du 8 octobre (B1).** **Étant donné** un appareil qui a abandonné son époque orpheline, un instantané `s-00000001.cts` dans iCloud sous forme de substitut évincé, `orphanEpoch` nul et la première suppression armée en échec, **quand** le moteur enchaîne les cycles, **alors** (a) avec le code actuel : `orphan-epoch-relisted` puis `orphan-epoch-deleted`, le dossier orphelin disparaît, la publication reprend et aucun `publish-deferred own-state-unknown` ne dure ; **vert**. (b) Le même scénario est **rouge** si la règle de comptage de `canPublish` revient à l'ancienne (preuve par un second test qui rejoue le scénario avec l'ancienne règle injectée dans un module de test, non livré dans le code de production : le banc aurait vu la P1). (c) Avec le faux en mode historique (critère 14), le scénario prouve que le code actuel supprime aussi le substitut.
20. **Scénario 2 : arrêt brutal entre l'ajout du segment et l'écriture de `state.ctx` (cousin S2, B2).** **Étant donné** `armCrash` posé entre l'écriture du premier segment et celle de l'état, **quand** l'appareil redémarre, **alors** il détecte l'état manquant et publie ou signale visiblement (jamais `publish-blocked` pour toujours). Écrit dans le banc ; **s'il est rouge, il est livré sur la branche de Y-FIX-02**.
21. **Scénario 3 : lecture d'un journal en échec `io` pendant un cycle (B3).** **Étant donné** `readJournal` armé en `io` sur le journal d'un autre appareil au rang 1, **quand** le cycle se termine, **alors** l'appareil est signalé en avertissement, `lastSyncAt` n'avance pas, le statut n'est pas « À jour » et l'entretien est sauté visiblement. Écrit dans le banc ; **s'il est rouge, livré sur la branche de Y-FIX-03**.
22. **Scénario 4 : `deleteOwn` et suppression d'époque orpheline en échec durable (B5).** **Étant donné** une suppression armée en échec à chaque rang pour `s-00000001.cts` puis pour un segment propre (`delete-own-failed`), **quand** les cycles s'enchaînent, **alors** un état visible durable existe (avertissement dans Détails, bandeau, cause, chemin du dossier) et se résout dès que la suppression réussit. Écrit dans le banc ; **s'il est rouge, livré sur la branche de Y-IOS-02-FIX-01**.
23. **Scénario 5 : transport muet et hydratation qui ne répond pas (B6).** **Étant donné** un appel `list` ou `read` qui ne répond jamais (panne « muette » armée par rang, modélisée par une promesse jamais résolue côté `memory.ts` et par un appel sans retour côté `fake_bookmark`), **quand** le moteur appelle le transport, **alors** il sort par `cloud-pending` à l'échéance de l'appel (échéance simulée par le compteur du test, jamais par une attente réelle) et la synchro n'affiche pas « Synchro en cours » indéfiniment. Écrit dans le banc ; **s'il est rouge, livré sur la branche de Y-IOS-05**.
24. **Étant donné** la règle d'Ali, **quand** un scénario 2 à 5 est rouge avec le code actuel, **alors** son fichier de test n'est pas dans la branche du banc : il est conservé non suivi dans le worktree (jamais hors du dépôt) puis commité sur la branche de la story du correctif, et le rapport du critère 25 cite son nom, la panne armée, la cause observée et l'assertion qui échoue. Aucun scénario n'est désactivé (`skip`, `todo`, `xit`) ni fusionné rouge.

### Rapport des défauts révélés

25. **Alors** à la fin de la story, un rapport remis à Ali (dans la réponse de l'agent et dans la fiche, section « Défauts révélés ») liste : chaque scénario du banc, son résultat avec le code actuel (vert / rouge), pour les rouges la cause observée (fichier et ligne), la story qui le corrige, et **tout défaut nouveau de la même famille** (panne iCloud mal gérée) découvert par les faux hostiles, hors des cinq scénarios. Les défauts nouveaux sont classés (bloquant, important) et **remontés à Ali avant de passer à l'étape 2** : le product-owner n'enchaîne pas sans sa réponse.

### Non-régression

26. **Alors** : `CT_TEST_WORKERS=1 npx vitest run src/platform/sync src/features/sync tests/sim --coverage.enabled=false` vert ; `cargo test --test desktop --features test-hooks` vert ; lint et typage verts ; aucun `skip`, aucun délai, aucun retry, aucun test allongé ; suite complète verte en CI sur la branche (« suite verte »).
27. **Alors** le bundle de départ n'est pas modifié : aucun nouveau fichier de test n'entre dans le bundle de production, `memory.ts` (déjà utilisé par le mode dev) n'y entre pas plus qu'avant ; `startBundle.test.ts` est lancé quand même (rappel : 349,67 / 350 Ko, aucun octet de marge) et sa mesure est notée dans la fiche.

### Documentation

28. **Alors** : ADR 0011, **avenant §25** (le dernier avenant existant est le §24 ; numéro à reconfirmer par l'agent au moment de l'écriture) : plan de pannes, effets pris en charge, règle « tout faux iCloud rejoue la même fixture », mode historique du faux et limites (le Swift n'est pas exécuté) ; `docs/dettes.md` : le job macOS XCTest / simulateur reste une dette (hors palier) et les pannes non modélisées sont listées ; `docs/journal.md` : entrée du jour ; `docs/backlog.md` : statut de Y-TECH-03.

## Limites assumées

- Aucune ligne Swift n'est exécutée par ce banc : il garantit la conformité des faux entre eux et la tenue du moteur face à leurs pannes, pas le comportement réel de `NSFileCoordinator` ni de l'éviction d'iCloud. Le job macOS XCTest et simulateur (24 à 40 h) reste hors palier.
- Une panne réelle d'iCloud dépend du temps ; le banc la remplace par un rang d'appel et un compteur de cycles. Une panne qui n'a de sens qu'en durée n'est pas modélisée (listée dans la dette).
- Les scénarios 2 à 5 ne prouvent le rouge → vert qu'une fois leur story livrée ; avant, le banc ne prouve que leur écriture et le rouge observé.

## Hors de cette story

- Tout correctif de production (Y-FIX-02, Y-FIX-03, Y-IOS-02-FIX-01, Y-IOS-05, Y-FIX-04) : chacun est livré par sa propre story avec le scénario qui le concerne.
- Le projet Playwright 393×852, safe areas et atteignabilité au doigt (autre partie de B13, non retenue au palier).
- Le job macOS XCTest et simulateur.
- Toute fonction de la liste « Hors périmètre » du PRD.

## Ordre des sous-tâches

1. Format et schéma du FaultPlan, fixture `fault-plan.json`, test de schéma (critères 1 à 4).
2. `memory.ts` : pannes de suppression, résurrection, éviction, écrasement, écriture refusée, hydratation en échec, `advanceCycle()` (critères 5 à 9, 11).
3. `syncCloudSim` : propagation des suppressions selon le plan (critère 10).
4. `MemFs` : suppression en échec (critère 12).
5. `fake_bookmark.rs` : substitut, mode correct et mode historique, éviction, écrasement, hydratation (critères 13 à 15).
6. Extension de `syncfs-conformance.json` et rejeu sur les quatre implémentations ; test « tout faux rejoue la fixture » ; preuve jetable du critère 17 (critères 16 à 18).
7. Scénario 1 vert et sa preuve rouge avec l'ancienne règle (critère 19).
8. Scénarios 2 à 5 écrits et exécutés ; tri : verts dans le banc, rouges conservés pour leur story (critères 20 à 24).
9. Rapport des défauts révélés remis à Ali (critère 25), puis non-régression locale (module) et CI (critères 26, 27).
10. Documentation (critère 28) ; qa-test, puis code-reviewer.

## Vérifications

- Local : seulement les tests du module (commande du critère 26) ; la suite complète tourne en CI.
- CI : branche verte, statut « suite verte » ; aucun test désactivé ni délai allongé ; aucun échec silencieux.
- Preuves de détection : critère 17 (conformité faussée), critère 19 (b) (ancienne règle de `canPublish`).
- Aucun fichier écrit hors du dépôt ; aucun secret.
- Clôture refusée si un critère manque : le product-owner vérifie les 28 critères avant « fait », puis remet le rapport (critère 25) à Ali et attend sa réponse avant l'étape 2 (Y-TECH-04).

## Défauts révélés

Rapport de la phase A (côté TypeScript, 2026-10-17), à remettre à Ali avant l'étape 2 (critère 25). Complété par la phase B (Rust).

### Ce que la phase A livre (rappel)

- Plan de pannes : `tests/fixtures/sync/fault-plan.json` (schéma décrit dans son `$comment`, un plan d'exemple par effet, plans des scénarios), lu strictement par `src/platform/sync/faultPlan.ts` ; effet `mute` ajouté aux six effets du critère 1 pour le scénario 5.
- `memory.ts` : `MemorySyncFolder.armFaults(plan)`, `disarmFaults()`, `advanceCycle()`, `evict()`, `faultLog()`, `unfiredFaults()`, `mutedCalls()`, `releaseMuted(id, 'complete' | code)` ; points de panne dans le listage du scan, les lectures d'état, de segment et d'instantané, l'hydratation, les écritures (segment, état, `.tmp` et renommage d'instantané) et `deleteOwn` (fichier par fichier, comme `delete_own` de Rust). Sans plan armé : comportement identique (suite du module verte sans changement d'attente, aucun tour de micro-tâche ajouté). Non gardés en phase A (listés pour la dette) : `forget.deleteFiles` (suppression des fichiers d'un appareil oublié), les lectures internes de `rebuildOwn` hors scan pour une panne muette.
- `syncCloudSim.propagate` : suppression transmise aussitôt par défaut, différée par `deferDeletions`, refusée tant qu'une suppression « acceptée mais non propagée » de l'émetteur attend son retour.
- Conformité : `faultCases` (14 cas) ajoutés à `syncfs-conformance.json`, rejoués sur `memory.ts` par une vue fichier passant par les mêmes points de panne ; `cases` d'origine inchangés (le Rust actuel ne lit que `cases` : il reste vert, il rejouera `faultCases` en phase B). Preuve jetable du critère 17 côté TypeScript : un attendu faussé (`faultCases[2]`, étape 5) fait échouer la lecture TypeScript avec le nom du cas, puis la fixture est restaurée.
- Écart d'adresse relevé à la reconfirmation : `memory.ts` compte maintenant environ 3 000 lignes (2 588 avant la story) ; `MemFs::remove_file` et `fake_bookmark.rs` aux adresses de l'audit (non modifiés en phase A).

### Scénarios du banc

| Scénario | Résultat avec le code actuel | Panne armée | Cause observée | Assertion qui échoue | Story du correctif |
|---|---|---|---|---|---|
| 1 (a) orphelin du 8 octobre (B1) | **vert**, commité (`tests/unit/sync/hostile/scenario1Orphan.test.ts`) | substitut au 1er listage + 1re suppression en `io` (plan `scenario-1-orphelin`) | — : `orphan-epoch-relisted` puis `orphan-epoch-delete-failed { io }` au cycle 1, `orphan-epoch-deleted` au cycle 2 ; publication dès le cycle 1, aucun `publish-deferred` | — | Y-IOS-02-FIX-02 (fait) |
| 1 (b) ancienne règle de `canPublish` | **vert** (le test constate que le scénario devient rouge), commité (`scenario1OldRule.test.ts`, règle d'avant edb5b925 injectée par `vi.mock` du module du domaine, dans ce fichier seulement) | même plan | publication bloquée à chaque cycle (`publish-deferred` × 5, `publish-blocked`), jamais réarmé, orphelin conservé : le banc aurait vu la P1 | — | — |
| 1 (c) mode historique du faux | **vert**, commité (même fichier que 1 (a)) | substitut + `removeLeavesPlaceholder` | le substitut reste ; `orphan-epoch-relisted` puis `orphan-epoch-already-gone` à chaque cycle (bug du 8 octobre reproduit) ; en mode correct (plugin actuel) la suppression du vrai nom emporte le substitut | — | — |
| 2 arrêt entre segment et `state.ctx` (B2) | **rouge**, non suivi (`tests/unit/sync/hostile/scenario2CrashBeforeState.test.ts`) | `armCrash` au rang de l'écriture de l'état qui suit le 1er ajout (rang compté sur un jeu identique) | `src/domain/sync/epoch.ts:90` `canPublish` (aucun état, aucun accusé, 1 segment listé, `localSeq` 0) via `src/sync/engine.ts:554` et `:581` : `publish-deferred { own-state-missing, files: 1, acks: 0, localSeq: 0 }` à chaque cycle, `publish-blocked` pour toujours | `expect(b.folder.fileNames(b.id)).toContain('state.ctx')` (ligne 80) | Y-FIX-02 |
| 3 lecture d'un journal en `io` (B3) | **rouge**, non suivi (`scenario3ReadIo.test.ts`) | `read` en `io` au rang 1 sur `devices/56d4…/*/j-*.ctj` (plan `scenario-3-lecture-io`) | `src/sync/reader.ts:133` (`finish('error')`) → `src/sync/engine.ts:857` (`allRead = false` seulement) → `src/sync/engine.ts:1044` : `lastSyncAt` enregistré (ni `publishError` ni attente) | `expect(failed.lastSyncAt).toBe(lastSyncAt)` (ligne 51) : reçu `08:01`, attendu `08:00` | Y-FIX-03 |
| 4 suppression en échec durable (B5) | **rouge** (2 tests), non suivi (`scenario4DurableDelete.test.ts`) | `remove` en `io` à chaque rang (`times: all`), instantané orphelin puis ancien instantané propre | journal seulement : `src/sync/orphanEpoch.ts:84`, `src/sync/engine.ts:1029` (`orphan-epoch-delete-failed`), `src/sync/engine.ts:1004` (`delete-own-failed` kind `s` par `.catch`), `src/sync/maintenance.ts:177` et `:191` ; statut `idle`, aucun avertissement, « À jour » | `expect(visible(status, …)).toBe(true)` (lignes 38 et 60) | Y-IOS-02-FIX-01 (B5 réduit) |
| 5 transport muet (B6) | **rouge**, non suivi (`scenario5MuteTransport.test.ts`) | `list` muet au rang 1 sur `devices/56d4…/` (plan `scenario-5-transport-muet`) | aucune échéance par appel : le scan reste en suspens (`src/sync/engine.ts:260` attend `platform.scan` sans borne ; `memory.ts` modélise le Rust actuel, sans `call_with_deadline`) ; le cycle ne se termine pas après 500 tours comptés | `expect(muted).toEqual([])` (ligne 52) | Y-IOS-05 (le correctif modélise aussi l'échéance dans `memory.ts`) |
| critère 18 (tout faux rejoue la fixture) | **rouge pour Rust**, non suivi (`tests/unit/sync/hostile/fakesLoadFixtures.test.ts`) ; `memory.ts` vert | — | `MemFs` et `fake_bookmark` : aucun fichier Rust ne fait `include_str!` de `fault-plan.json` (phase B) | `expect(replaying).not.toEqual([])` pour MemFs et fake_bookmark | Y-TECH-03 phase B |

### Défauts nouveaux de la même famille (pannes iCloud mal gérées), à remonter à Ali avant l'étape 2

1. **Bloquant (iOS)** : segment de tête de l'appareil évincé par iOS (« optimiser le stockage ») : l'ajout lit le segment sans hydratation (`src-tauri/src/sync/store.rs:1185`, `fs.read(&path, MAX_SEGMENT_BYTES, false)` ; même règle dans `memory.ts`, `existing.availability !== 'local'`) et répond `cloud-pending` ; le moteur ne télécharge pas ce fichier et n'ouvre pas de segment suivant : `publish-failed { cloud-pending }` à chaque cycle, statut « iCloud ne répond pas : vos modifications seront envoyées au retour » pour toujours, les écritures de l'iPhone n'arrivent jamais au PC, même quand le téléchargement est possible (sonde jetable, deux variantes : sans téléchargement et téléchargement en 1 s). Aucune perte locale, mais synchro sortante figée sans cause réelle affichée. Correctif à décider (hydratation du segment de tête avant l'ajout, ou rotation vers `max + 1` sur `cloud-pending`) ; aucune story existante ne le couvre.
2. **Important** : suppression acceptée mais non propagée de ses anciens instantanés (le fichier revient) : le moteur les resupprime à chaque nouvel instantané, ils reviennent, le dossier grossit sans fin (s-1 à s-6 après 5 semaines au lieu de 2) avec « À jour » : même famille que B5 (échec de suppression invisible), mais aucun code `*-failed` n'est émis puisque la suppression répond « réussie ». À couvrir dans Y-IOS-02-FIX-01 (fichier revenu après suppression = échec durable visible) ou en story dédiée.
3. **Important (observation du scénario 1 c)** : avec un plugin qui laisse un substitut (mode historique, ou toute suppression que iCloud ne fait pas), le moteur réarme puis journalise `orphan-epoch-already-gone` à chaque cycle sans jamais rien rendre visible ; même famille que B5, à couvrir dans Y-IOS-02-FIX-01.

### Mesures de la phase A

- `CT_TEST_WORKERS=1 npx vitest run src/platform/sync src/features/sync tests/sim tests/unit/sync --coverage.enabled=false` (fichiers rouges non suivis mis de côté dans le worktree) : 154 fichiers, 1 990 tests, tous verts (dont 5 contrôles d'hygiène de `forgetHygiene` sur les fichiers rouges remis en place pendant la passe).
- Fichiers rouges seuls (scénarios 2 à 5 et critère 18) : 5 fichiers, 7 tests rouges, 2 verts (`memory.ts` rejoue les deux fixtures ; aucun faux hors de la liste).
- `npm run lint` et `npm run typecheck` : verts.
- Bundle de départ (`tests/bundle/startBundle.test.ts`, `vitest.bundle.config.ts`) : 86 blocs, **349,7 Ko gzip** (seuil 350 Ko ; 349,67 Ko avant la story, inchangé à l'arrondi affiché), 8 tests verts ; `memory.ts` et `faultPlan.ts` restent hors du départ (aucune constante construite au chargement de `faultPlan.ts`).
- `cargo test` non lancé en phase A (aucun fichier Rust touché ; `sync_fs_conformance.rs` ne lit que `cases`, inchangés) : à lancer en phase B et en CI.
- Temps passé en phase A : environ 4 h (estimation de la phase A : 10 h).
