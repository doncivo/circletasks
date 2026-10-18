# Y-FIX-02 — Plus d'impasse de première publication : un segment écrit sans état est repris par la tête locale, Rust juge

Module : M15 Synchronisation · Ordre de construction : palier 1.0, **étape 3** (après Y-FIX-04 et Y-TECH-05, avant Y-FIX-03 ; ordre recommandé : Y-FIX-02, Y-IOS-07, Y-FIX-03, Y-IOS-05, car ces quatre stories touchent `engine.ts`, jamais en parallèle) · Agents : **sync-icloud** ; **desktop-tauri** seulement si `src-tauri/src/sync/store.rs` doit changer (voir « Décisions », point 6) · Relecture : code-reviewer (qa-test avant) · Estimation : **5 h** (audit B2) ; règle d'Ali : arrêt et alerte avant de continuer au-delà de **7 h 30** (+50 %) · Statut : **développée, revue « à corriger » appliquée (B1, I1, I2, M1, M3, M5), en attente de contre-revue**
Story technique, sans équivalent au PRD. Correctif du bloquant **B2** de `docs/audit-1.0.md` (section 3). Aucun écart au PRD à décider ici (voir « Écarts »). Avenant ADR 0011 réservé : **§30**.

## Constat de l'audit (B2, mot pour mot)

« Impasse de première publication (`epoch.ts:89-92`, `engine.ts:542-566`) : segment écrit, état non écrit (échéance `hide`, app tuée, `io`) → aucun état, aucun accusé, un fichier listé → `publish-blocked` pour toujours, `inflight` jamais résolu, aucune action dans Détails. Rust connaît la tête et accepterait. » Correctif proposé : « Tête locale (`META.head`/`stateSeq`) comme borne, Rust juge ; résoudre `inflight` hors `publishAllowed` ; scénario `crashPoints` ; ADR §1.4 ».

## Contexte

### Lignes de l'audit, reconfirmées sur `main` c01e961b (2026-10-18)

| Audit | Code aujourd'hui | Contenu |
|---|---|---|
| `epoch.ts:89-92` | **`src/domain/sync/epoch.ts` 90-93** (le fichier est dans le domaine, pas dans `src/sync`) | `canPublish` : `ownStateOk \|\| acksOnSelf > 0` vrai, sinon `listedFiles === 0 && localStateSeq === 0` |
| `engine.ts:542-566` | **`src/sync/engine.ts` 539-567** (commentaire de l'exception Y-IOS-02, `listedFilesForPublish` 555, `deferPublish` 562-567 qui lève `publish-blocked` en 566) puis **568-590** (`openedHere`, `publishAllowed`) | décision de publier |
| (non cité) | `engine.ts` 627-633 | `resolveInflight` appelé **seulement** `if (publishAllowed)` |
| (non cité) | `engine.ts` 136-149 | `resolveInflight` : hypothèse « ajout réussi », `writeOwnState(head = expect + count)`, puis `clearPublished` et `META.head` si accepté, `inflight` remis à nul dans tous les cas |
| (non cité) | `engine.ts` 947-958, 964-969 | publication si `publishAllowed`, sinon `deferPublish(false)` ; écriture de l'état, refus Rust → `deferPublish(true)` |
| (non cité) | `src/sync/publisher.ts` 431-448 | `META.inflight` écrit **avant** `appendJournal` (431-432), retiré dans la même transaction que `META.head` et la file (436-442), ou remis à nul sur échec (448) |
| (non cité) | `src/domain/sync/epoch.ts` 149-162 | `isOrphanEpoch` : l'exception Y-IOS-02 ne couvre que « un instantané listé, **aucun segment** » (`listed.segments.length === 0`) : un segment écrit en sort |
| (non cité) | `src-tauri/src/sync/store.rs` 1124-1246 | `append_journal` : met à jour `own` (époque, segment, `record`, `max_hlc`) que l'appelant persiste |
| (non cité) | `store.rs` 1299-1306 | `write_state` : refuse un `stateSeq` non croissant et une tête différente de `own` (`state-mismatch`) ; **accepte** une tête égale à celle de `own` |

Aucun écart de fond avec l'audit : seules les adresses ont bougé (+1 ligne, fichier du domaine). L'agent reconfirme les lignes avant de coder et note tout écart dans « Preuves ».

### Chaîne du défaut

1. Premier cycle d'un appareil qui n'a jamais publié : `publishOutbox` écrit `META.inflight` (publisher 431-432), `appendJournal` crée le segment 1, puis la transaction 436-442 retire la file et écrit `META.head`. L'état `state.ctx` n'est écrit qu'ensuite (engine 964).
2. L'application est arrêtée dans cet intervalle (échéance du cycle `hide` de l'iPhone, `kill`, erreur `io` sur `writeState`). Reste : un segment listé, **aucun** `state.ctx`, `stateSeq` local à 0 (jamais écrit), aucun accusé d'un autre appareil, `META.inflight` encore posé (arrêt avant la transaction) **ou** `META.head` posé (arrêt après).
3. Au cycle suivant : `canPublish` = faux (un fichier listé, `ownStateOk` faux, `acksOnSelf` nul) ; `openedHere` = faux (`isOrphanEpoch` exige zéro segment) ; `publishAllowed` = faux.
4. Conséquences, pour toujours : aucune publication, aucun état, **`resolveInflight` jamais appelé** (engine 627), `deferPublish(false)` lève `publish-blocked` à chaque cycle, aucune action dans Détails. L'autre appareil n'a aucun état à lire : il n'accepte rien de cet appareil. Pourtant Rust connaît la tête (`own.json`) et accepterait l'état.
5. La règle qui bloque est volontaire (ADR 0011 §1.4 et §24 point 10) : un appareil qui a un historique local mais perd son état publié ne doit pas republier à l'aveugle (état supprimé par un tiers avec base restaurée). La preuve locale de l'exception existe déjà pour l'instantané seul (`openedHere`) ; elle manque pour le segment, alors que l'appareil **sait** ce qu'il a écrit (`inflight`, `META.head`).

### Pourquoi les tests existants ne l'attrapaient pas

- `joinAfterRecords.test.ts` (dossier `tests/unit/sync/pairing/`), test ligne 97 « état propre non publiable (état absent, historique local) : avertissement, jamais « À jour » » : il supprime l'état **après** une publication réussie (`stateSeq` local > 0) et attend `publish-blocked`. C'est la règle de §24 point 10, pas l'impasse de B2 : l'attente de ce test **ne change pas** (voir « Décisions » point 5). Mais il a donné l'impression que l'état absent + fichier listé était un cas voulu partout, y compris à `stateSeq` 0 avec une tête locale qui explique le fichier.
- `Y-IOS-02-FIX-02` et `scenario1*.test.ts` (banc) couvrent l'instantané orphelin (aucun segment). Aucun test n'arme un arrêt **entre `appendJournal` et `writeState`** : `tests/sim/syncCrash.ts` (`armCrash`, compteur d'écritures) existait mais n'était pas posé sur ce point. Le scénario 2 de Y-TECH-03 (critère 20) est le test manquant ; il est **rouge** avec le code actuel et livré sur cette branche (critère 24 de Y-TECH-03).
- `resolveInflight` n'est testé que dans le cas où la publication est autorisée (`publishAllowed` vrai).

## Scénario rouge déjà écrit (repris tel quel)

Fichier `tests/unit/sync/hostile/scenario2CrashBeforeState.test.ts`, branche `origin/y-tech-03-scenarios-rouges`. Il arme un arrêt brutal par compteur d'écritures (`armCrash`) entre l'ajout du premier segment et l'écriture de `state.ctx`, puis attend qu'au redémarrage l'appareil publie son état (ou le signale visiblement), jamais `publish-blocked` pour toujours, et que le PC voie l'iPhone.

- **Reprise** : `git show origin/y-tech-03-scenarios-rouges:tests/unit/sync/hostile/scenario2CrashBeforeState.test.ts` écrit dans le même chemin du worktree (ou cherry-pick du commit qui l'ajoute). **Contenu non modifié** : un octet de différence avec la branche est une anomalie à justifier par écrit dans « Écarts ».
- **Commit rouge d'abord**, seul, avant tout code de correctif ; le message d'erreur exact est copié dans « Preuves » (l'auteur de la fiche n'a pas pu lire le fichier : voir « Écarts »).
- Ses attentes ne se modifient que si elles sont **fausses**, avec justification écrite dans « Écarts » (jamais pour les faire passer). L'agent relit le fichier avant de coder et signale toute attente qui contredit les décisions ci-dessous : le product-owner arbitre.

## Décisions retenues

1. **Qui juge : Rust.** Le moteur ne devine pas si l'ajout a réussi. Il présente à Rust l'état avec la tête que sa trace locale désigne ; `write_state` l'accepte si elle égale `own` (store.rs 1304-1306) et la refuse sinon (`state-mismatch`). Le moteur n'ajoute aucun contrôle de tête de son côté.
2. **Borne locale (nouvelle règle pure de `src/domain/sync/epoch.ts`).** Une **trace locale d'ajout** est : `META.inflight` de l'époque courante, ou `META.head` de l'époque courante avec `segment >= 1`. La borne de publication est « ouverte » (`publishAllowed` vrai sans état ni accusé) **si et seulement si** : (a) trace locale d'ajout présente ; (b) `localStateSeq === 0` (jamais d'état écrit : la fenêtre de première publication) ; (c) **chaque fichier compté** par `listedFilesForPublish` est expliqué par la trace : segments de l'époque courante de numéro `<=` max(`head.segment`, `inflight.segment`), et l'instantané enregistré localement (`META.snapshot`) de l'époque courante ; (d) aucun fichier non lisible dans le scan (`unreadable.length === 0`, comme `openedHere`). Un fichier que la trace n'explique pas (segment plus grand, segment d'une autre époque, instantané inconnu) laisse la règle actuelle : `publish-blocked`. Fonction pure `localBoundCovers` à côté de `listedFilesForPublish`, jamais de SQL dans le domaine.
3. **Au redémarrage, quand un segment existe sans `state.ctx`** :
   - `inflight` présent : `resolveInflight` (hypothèse « ajout réussi », 136-149) écrit l'état avec `head = expect + count` ; Rust accepte → `clearPublished`, `META.head`, `inflight` nul ; Rust refuse → `inflight` remis à nul, la file est gardée (hypothèse « ajout manqué »), la publication reprend au cycle suivant par l'existant (`segment-full` / `segment-mismatch` ouvrent `max + 1`, publisher 450-457).
   - `inflight` absent, `META.head` présent : l'état est écrit au point 6 du cycle avec la tête de `ownBounds` (`META.head`), sans rien republier.
   - Le journal technique reçoit `own-state-recovered` avec `{ epoch, source: 'local-head' }` (source `'inflight'` ou `'local-head'`), codes et compteurs seulement.
4. **Intention gardée tant que la publication est refusée** (révisé en revue, B1, option (a) ; la première version résolvait `inflight` hors `publishAllowed`, ce qui republiait l'état d'un appareil bloqué). `resolveInflight` ne s'exécute que si `publishAllowed` est vrai : par la règle actuelle, ou par la borne locale dont la trace est l'intention elle-même (source `inflight`, P2). Rust juge la tête. Publication refusée (fichier non expliqué, état supprimé après publication) : l'intention reste posée et stable d'un cycle à l'autre, aucun état n'est écrit.
5. **Ce que la règle ne change pas.**
   - `localStateSeq > 0` et état absent (test `joinAfterRecords.test.ts:97`) : **inchangé**, `publish-blocked` reste le verdict (§24 point 10 : état supprimé par un tiers, base éventuellement restaurée ; Rust maître de `stateSeq`). L'attente de ce test n'est pas touchée. Question 1 plus bas.
   - La rotation de segment sur `cloud-pending` à l'ajout appartient à **Y-IOS-07 (ADR 0011 §27)** : cette story ne touche ni `catch` de `publishOutbox` (publisher 447-460), ni `closed`, ni l'ouverture de `max + 1` hors reprise. Si Y-IOS-07 est fusionnée avant, la reprise de `inflight` réutilise son chemin sans le modifier.
6. **Rust : pas de changement attendu.** `write_state` accepte déjà une tête égale à `own`. Vérification avant le code : `own.json` est bien persisté après `append_journal` avant la réponse au moteur (sinon l'arrêt « avant persistance » est un autre défaut : l'agent s'arrête et le remonte). Si `store.rs` doit changer, desktop-tauri intervient, `cargo test --test desktop --features test-hooks` passe, et l'estimation est réévaluée avant de continuer.
7. **Visible, pendant et en cas d'échec durable** (règle d'Ali : aucun blocage durable seulement dans les logs) :
   - Pendant : la reprise tient dans un cycle ; aucun avertissement n'est levé quand elle réussit (journal `inflight-resolved`, `own-state-recovered`).
   - Échec durable (état refusé à chaque cycle, `io` persistant, fichier non expliqué) : `publish-blocked` reste levé à chaque cycle, interdit « À jour », est affiché dans **AVERTISSEMENTS de Détails et dans le bandeau**, avec une **cause nommée** (texte du catalogue à la demande, Question 2) : « première publication interrompue : l'état de cet appareil n'a pas pu être écrit » (refus Rust ou `io`) ou « fichier inconnu dans le dossier de cet appareil » (fichier non expliqué). La cause est le champ `reason` de `publish-deferred` (ajouter `first-publication-state-refused` et `unexplained-files`, valeurs fermées, aucun nom de fichier).
   - Aucune action nouvelle dans cette story (voir Question 2).
8. **Zéro octet net dans le bundle de départ** (voir « Contraintes »).
9. **Journal** : codes et compteurs seulement (`reason`, `source`, `files`, `unexplained`) ; jamais un nom de fichier, un chemin, une clé ou un contenu.

## Contraintes

- **Bundle de départ saturé** : **358 357 / 358 400 octets gzip** (`tests/bundle/startBundle.test.ts`), marge **43 octets**, plafond **inamovible**. `engine.ts`, `publisher.ts` et `src/domain/sync/epoch.ts` sont dans le départ. L'agent :
  1. lance `npm run test:bundle` **après chaque commit** (pas seulement avant le push) et note les octets dans « Preuves » ;
  2. conçoit le correctif pour **zéro octet net** : déplacer le chemin rare dans un module à la demande (modèles : `epochSwitch.ts`, `orphanEpoch.ts`), ou compenser dans les mêmes fichiers ; les textes de cause vont dans le catalogue à la demande, jamais dans `syncText` du départ ;
  3. **piège connu** : un bloc à la demande qui importe un module du départ le sort du bloc principal et coûte des kilo-octets (voir Y-FIX-04 : 3 376 octets) ; vérifier chaque `import()` ajouté ;
  4. **si la marge de 43 octets ne suffit pas, l'agent s'arrête et le remonte** ; la décision des paliers de BUNDLE-01 appartient à Ali ; aucun autre écran n'est touché ; aucun levier n'est tiré seul.
- **Banc** : horloge `ManualClock`, aucun délai, aucun `skip`, aucun seuil relâché ; pannes par compteur d'écritures ou plan de pannes `fault-plan.json` (jamais par le temps).
- **Fichiers temporaires** dans le worktree, jamais hors du dépôt.
- **Tests locaux du module seulement** : `CT_TEST_WORKERS=1 npx vitest run src/sync src/domain/sync tests/unit/sync tests/sim --coverage.enabled=false`, et `cargo test --test desktop --features test-hooks` seulement si `store.rs` change ; suite complète en CI.

## Critères testables

### Rouge puis vert

1. **Scénario 2 repris tel quel.** **Étant donné** le fichier `scenario2CrashBeforeState.test.ts` de la branche `origin/y-tech-03-scenarios-rouges`, copié sans modification, **quand** il est lancé avec le code actuel, **alors** il échoue sur l'assertion « l'appareil publie son état ou le signale visiblement, jamais `publish-blocked` pour toujours » (message exact copié dans « Preuves », assertions de départ vertes) ; il est commité **seul et en premier** ; **après** le correctif il passe sans changement d'attente (ou avec une attente corrigée et justifiée dans « Écarts »). Commit rouge et run CI cités.
2. **Reprise complète après l'arrêt du critère 1.** **Étant donné** l'arrêt entre l'ajout du segment 1 (une tâche `T` en file) et l'écriture de `state.ctx`, avec `META.inflight` posé et `stateSeq` local 0, **quand** l'appareil redémarre et enchaîne **un seul** cycle, **alors** : (a) `META.inflight` est nul ; (b) `state.ctx` est publié avec `head = { segment: 1, record: 1 }` et `stateSeq = 1` ; (c) `META.head` vaut `{ segment: 1, record: 1 }` et la file est vide ; (d) le tableau `warnings` du résultat ne contient pas `publish-blocked` ; (e) le journal contient `inflight-resolved { appended: true }` une fois et `own-state-recovered { source: 'inflight' }` une fois ; (f) après un cycle du PC, `T` existe chez le PC une seule fois et les tables des deux bases sont identiques.

### `crashPoints` (scénario d'arrêt du banc)

3. **Quatre points d'arrêt, un résultat.** Fichier `tests/unit/sync/firstPublicationCrashPoints.test.ts`, table `crashPoints` : (P1) après l'écriture de `inflight`, avant `appendJournal` ; (P2) après `appendJournal`, avant la transaction ; (P3) après la transaction (`META.head` posé, `inflight` nul), avant `writeState` ; (P4) après `writeState`, avant la sauvegarde de `sync_state`. **Étant donné** un arrêt à chaque point, **quand** l'appareil redémarre, **alors** pour chacun : `publish-blocked` n'apparaît dans aucun des cycles qui suivent ; au plus **deux** cycles jusqu'à `state.ctx` publié ; `T` arrive chez le PC **une seule fois** ; les bases sont identiques à celles d'une exécution sans arrêt (comparaison des tables `task`, `sync_outbox` vide, `META.head` égal) ; aucun doublon d'enregistrement dans le segment (nombre de lignes du fichier = 1).
4. **P1 et ajout manqué : Rust refuse, la file est gardée.** **Étant donné** P1 (aucun segment écrit, `inflight` posé), **quand** le cycle reprend, **alors** Rust refuse l'état annoncé à la tête `expect + count` (`state-mismatch`), `inflight` est remis à nul, `clearPublished` n'a **pas** été appelé, la file contient encore `T`, le cycle suivant publie `T` dans le segment 1 (`first_record = 0`) et l'état avec `head = { 1, 1 }`. Assertion : `inflight-resolved { appended: false }` une fois.
5. **Ajout à moitié écrit (`partialLastLine`)** (partiellement tenu, voir Écarts : B18). **Étant donné** un plan de pannes `write` avec `partialLastLine` sur le premier ajout (lignes complètes écrites, dernière coupée, appel en échec), **quand** l'appareil redémarre, **alors** aucun enregistrement n'est perdu ni appliqué deux fois chez le PC (`T` et chaque autre tâche du lot présentes une fois), le segment utilisé est celui que Rust accepte (`segment-mismatch` → `max + 1` si le fichier tronqué ne se laisse pas continuer) et l'état publié a la tête de Rust. Aucun message d'erreur ne reste en bandeau après convergence.
6. **Arrêt pendant la reprise elle-même.** **Étant donné** un arrêt posé pendant la reprise du critère 2 (avant `writeState`, entre `writeState` et la transaction de reprise), **quand** l'appareil redémarre de nouveau, **alors** le résultat final est celui du critère 2 (état publié une fois, `stateSeq = 1` ou `2` selon le point mais **croissant**, jamais deux fois le même numéro, aucun doublon dans le journal ni dans `sync_outbox`).
7. **Échéance `hide` entre l'ajout et l'état.** **Étant donné** une échéance du cycle (`deadlineAt`, `deadlineProbe` de `deadline.ts`) qui expire entre la transaction d'ajout et l'écriture de l'état, **quand** le cycle suivant s'exécute avec une nouvelle échéance, **alors** `state.ctx` est publié et `publish-blocked` n'a pas été levé ; aucun `skip`, aucun délai.

### La règle de la borne locale

8. **Règle pure testée en table.** `localBoundCovers` (et la forme de `publishAllowed` qui s'en sert) est testée en table, fixture `tests/fixtures/sync/publish-bound.json` complétée (ou fixture voisine si le lecteur Rust de `publish-bound.json` refuse les clés inconnues : l'agent vérifie et ne casse pas `sync_publish_bound` côté Rust). Cas exacts : (a) `inflight` seul + segment 1 listé → ouvert ; (b) `META.head` `{1, n}` + segment 1 listé → ouvert ; (c) trace + segment 2 listé alors que la trace dit 1 → **fermé** ; (d) trace + segment d'une autre époque → **fermé** ; (e) trace + `localStateSeq = 1` → **fermé** (règle actuelle) ; (f) aucune trace + un segment listé → **fermé** ; (g) trace + fichier illisible dans le scan → **fermé** ; (h) aucun fichier listé, `stateSeq` 0 → ouvert (règle actuelle, inchangée) ; (i) trace sur une autre époque que la courante → **fermé**.
9. **Fichier non expliqué : toujours bloqué, visible, intention gardée tant que la publication est refusée** (révisé en revue, B1). **Étant donné** `inflight` posé et un segment 2 déposé dans le dossier de l'appareil (non expliqué), **quand** deux cycles s'exécutent, **alors** à chacun : aucun `state.ctx` n'est écrit, aucune publication n'est faite, `META.inflight` reste posé et identique, la file est inchangée, aucun `inflight-resolved` n'est journalisé, `publish-blocked` est levé, `publish-deferred` porte `reason: 'unexplained-files'` et `unexplained: 1`, et le texte de Détails nomme la cause (critère 11).
10. **Le test de la règle actuelle reste vert, attente inchangée.** `joinAfterRecords.test.ts` ligne 97 (état supprimé après publication, `stateSeq` local > 0) passe **sans modification** : `warnings` contient `publish-blocked`, la ligne d'état ne contient pas « À jour ». Idem `scenario1OldRule.test.ts`, `scenario1Orphan.test.ts`, `orphanEpoch*.test.ts`, `Y-IOS-02-FIX-02` et les tests de `publish-bound`.

### Visibilité et absence d'échec silencieux

11. **Échec durable visible.** **Étant donné** un refus persistant de `writeState` pendant la reprise (enveloppe de plateforme comme au test `joinAfterRecords.test.ts:111-128`, code `io` puis `state-mismatch`), **quand** dix cycles s'enchaînent, **alors** à chacun : `publish-blocked` est levé, la ligne d'état ne contient pas « À jour », la section AVERTISSEMENTS de Détails (Testing Library) affiche le texte de la cause (`first-publication-state-refused`), le bandeau affiche l'avertissement ; `inflight` reste résolu ou gardé de façon déterministe (jamais un état intermédiaire qui change à chaque cycle) ; quand le refus cesse, **le cycle suivant** publie l'état, l'avertissement disparaît et « À jour » revient. Le texte vient de `src/i18n` (catalogue à la demande), en français.
12. **Journal sans contenu.** **Étant donné** les critères 2, 4, 9 et 11, **alors** les événements `inflight-resolved`, `own-state-recovered` et `publish-deferred` n'ont que `reason`, `source`, `appended`, `files`, `unexplained`, `ignored`, `acks`, `localSeq`, `epoch` ; une recherche du titre de `T`, d'un nom de fichier de segment et de `state.ctx` dans le journal du scénario ne trouve rien.

### Rust et frontière

13. **Rust juge.** **Étant donné** `own.json` à `{ epoch, segment 1, record 1, max_hlc }` après un `append_journal` et aucun `state.ctx`, **quand** `write_state` reçoit l'état de `stateSeq` 1 avec cette tête, **alors** il l'accepte ; avec une tête de `record 2` ou un segment 2, il répond `state-mismatch`. Test Rust de caractérisation (nouveau seulement s'il n'existe pas déjà, sans modification de `store.rs`) ; si `store.rs` change, `cargo test --test desktop --features test-hooks` vert.
14. **Y-IOS-07 non empiété.** **Étant donné** le diff de la story, **alors** ni le `catch` de `publishOutbox` (publisher 447-460), ni `closed`, ni l'ouverture de `max + 1` sur `cloud-pending` ne sont modifiés ; aucun test de rotation n'est ajouté ici.

### Architecture et non-régression

15. **Séparation.** La règle vit dans `src/domain/sync/epoch.ts` (fonction pure, aucun SQL) ; `src/sync` l'appelle ; la base n'est atteinte que par `src/db/repositories` ; **aucune migration** ; tout texte nouveau dans `src/i18n`, en français.
16. **Aucune attente modifiée.** `src/sync`, `tests/unit/sync` (dont `pairing/`, `hostile/scenario1*`, `positionsQa`, `restore*`, `reset/*`, `publish-bound`) et `tests/sim` passent **sans modification d'attente** ; aucun test désactivé, allongé, ni retry ; aucun seuil relâché.
17. **Commandes (module seulement, local)** : `CT_TEST_WORKERS=1 npx vitest run src/sync src/domain/sync tests/unit/sync tests/sim --coverage.enabled=false` vert ; `npm run lint` et `npm run typecheck` verts ; `cargo test --test desktop --features test-hooks` si Rust touché ; **suite complète en CI « suite verte »** avant fusion.
18. **Bundle de départ mesuré après chaque commit** : `npm run test:bundle` vert, départ <= 358 400, **net <= 0 par rapport à 358 357**, chaque mesure notée dans « Preuves » ; marge insuffisante : arrêt et remontée à Ali (aucun levier tiré seul).
19. **Documentation** : ADR 0011 avenant **§30** (à reconfirmer à l'écriture ; §27 reste à Y-IOS-07) : règle de la borne locale, trace locale d'ajout, intention résolue seulement si la publication est permise (option a), Rust juge, §1.4 complétée (première publication), tableau des fenêtres d'arrêt (`crashPoints`) ; `docs/decisions.md` (ligne du jour) ; `docs/journal.md` ; `docs/backlog.md` ; `docs/audit-1.0.md` (ligne B2 à « fait » avec renvoi au run rouge et au run vert) ; `docs/dettes.md` si une dette est trouvée.

## Questions à Ali (sans bloquer la fiche)

1. **Le cas « état supprimé après publication » (`stateSeq` local > 0, test `joinAfterRecords.test.ts:97`) reste-t-il un blocage permanent ?** Il est visible (`publish-blocked`), mais l'appareil ne peut plus rien publier tant que l'état manque, alors que Rust accepterait aussi (`stateSeq` local = celui de Rust). Cas rare : un tiers supprime `state.ctx` (ou base restaurée). **Recommandation** : ne pas l'ouvrir dans B2 ; le §24 point 10 le tranche pour le cas de la base restaurée, que le moteur ne distingue pas d'une suppression par un tiers ; l'ouvrir demande de lire l'`own.json` de Rust avant de publier (nouvelle commande), donc une autre story. Le noter en dette. Si Ali veut l'ouvrir, l'estimation passe à environ 8 h et le test de la ligne 97 change d'attente : décision d'Ali avant le code.
2. **Une action dans Détails pour l'échec durable ?** L'audit relève « aucune action dans Détails ». Cette fiche rend la cause visible et nommée, et la reprise automatique à chaque cycle ; elle n'ajoute **pas** de bouton. **Recommandation** : s'en tenir au texte de cause (le bouton « Synchroniser maintenant » existant retente) ; un bouton « Réécrire l'état » demanderait un choix de l'utilisateur sur une action que le moteur sait faire seul et dépasserait le bundle.

## Limites assumées

- La reprise suppose que `own.json` de Rust a été persisté après l'ajout ; sinon (arrêt entre l'ajout et la persistance), le fichier existe mais Rust ne le connaît pas : Rust refuse l'état, `inflight` est remis à nul, la file est gardée et le cycle suivant bute sur `segment-mismatch` puis ouvre le segment `max + 1`. Le segment 1 reste en doublon partiel côté lecteurs : sans perte, application idempotente par hlc. Cas à confirmer au critère 3 (P2).
- Un fichier non expliqué (déposé par un tiers, reste d'une autre époque) garde le blocage actuel, visible mais sans action ; une intention d'ajout éventuelle reste posée, sans être résolue, tant que la publication est refusée (revue B1).
- Le cas « état supprimé après publication » n'est pas rouvert (Question 1).
- **Refus mal attribués (revue M2).** Un refus de Rust pour une autre raison que la tête (numéro d'état, `reset`, `forgotten`) est lu par `resolveInflight` comme « ajout manqué » : la file est gardée et republiée ; le doublon est sans perte, appliqué une seule fois grâce au hlc. Ce comportement existait déjà ; avec l'option (a) de B1, il ne s'applique de nouveau que si la publication est permise.
- **Appareil illisible sans cause nommée (revue M4, cas (g) de la table de la règle).** Seul l'avertissement générique `publish-blocked` s'affiche, sans cause nommée dans Détails. Accepté comme limite.

## Écarts

- Aucun écart au PRD ni à l'ADR 0011 : l'avenant §30 complète §1.4 et §24 point 10 sans en modifier une règle.
- **Questions à Ali : recommandations suivies, en hypothèses** (à confirmer). Q1 : le cas « état supprimé après publication »
  (`stateSeq` local > 0) n'est pas rouvert, `joinAfterRecords.test.ts:97` est inchangé et vert. Q2 : aucun bouton nouveau, la cause est
  nommée dans Détails et « Synchroniser maintenant » retente.
- **Scénario 2 : point d'arrêt P3, pas P2.** Fichier identique à `origin/y-tech-03-scenarios-rouges` (empreinte
  `9f874aa6784f4c88a439cc57a248150b5e07048e` des deux côtés) ; son arrêt tombe sur l'écriture de `state.ctx` qui suit le premier
  `appendJournal`, donc après la transaction d'ajout (`META.head` posé, `inflight` nul) : P3 du critère 3. P2 est couvert par
  `firstPublicationCrashPoints.test.ts`. Aucune attente du scénario modifiée.
- **Règle pure dans `src/domain/sync/firstPublication.ts`, pas dans `epoch.ts`** (bundle de départ : une fonction de `epoch.ts` y reste
  même si seul un bloc à la demande l'appelle). Elle reçoit `files` (le `counted` de `listedFilesForPublish`) déjà calculé par le moteur et
  n'importe que des types : un import d'`epoch.ts` depuis un bloc nouveau sortait `retention.ts` du bloc de départ (+4 016 octets mesurés).
- **Chemins rares dans le bloc à la demande existant `src/sync/orphanEpoch.ts`** (`bound`, `deferred`, `resolveInflight` déplacé), pas
  dans un bloc nouveau : un bloc nouveau qui importait `meta.ts` le sortait de `purge` (+4 945 octets) et ajoutait son nom haché au départ.
  Conséquence : un échec de chargement de ce bloc pendant un cycle bloqué (ou avec une intention) fait échouer le cycle (erreur visible),
  au lieu d'un `publish-deferred` journalisé ; `publish-blocked` est levé avant le chargement.
- **Compensation dans `engine.ts`** : `openedHere` réutilise `orphanProof` (mêmes entrées dès que `currentEpoch === localEpoch` ; les
  seules branches qui réécrivent `localEpoch` ou `META.snapshot` rendent cette égalité fausse ; `unreadable` est vide à cet endroit, sinon
  l'étape (iii) a déjà rendu l'attente) ; son journal `own-state-recovered { epoch }` est écrit par le bloc à la demande (même forme).
  `orphanEpoch*.test.ts`, `Y-IOS-02-FIX-02` et `scenario1*.test.ts` passent sans modification.
- **Fixture voisine `tests/fixtures/sync/first-publication-bound.json`** (critère 8) : `publish-bound.json` est lue par Rust
  (`sync_publish_bound.rs`) et n'est pas touchée. Cas (a) à (i) de la fiche, plus (c2), (j), (k), (l).
- **Critère 2 (b)** : sans correction, l'état écrit par la reprise d'`inflight` était réécrit à l'étape 6 (`stateSeq` 2) ; `lastStateMeta`
  suit désormais l'état écrit dans le cycle, la tête de l'étape 6 tient compte de `lastWritten` : `stateSeq` 1.
- **Critère 4** : la file gardée est republiée **dans le même cycle** que la reprise (segment 1, `first_record` 0), pas au cycle suivant :
  plus tôt que la fiche, dans la borne « au plus deux cycles » du critère 3.
- **Critère 5 : partiellement tenu, côté iPhone seulement ; côté PC, défaut distinct B18** (constat B18 et story Y-FIX-05 proposés par
  la revue, décision d'Ali attendue ; aucun code ici). Côté iPhone : segment 1 tronqué sans ligne complète, lot publié une fois au
  segment 2 par `max + 1`, état à la tête de Rust, aucun avertissement. Côté PC, « en attente d'iCloud » pour toujours. Mécanisme confirmé
  par la revue : l'ajout coupé laisse `own.segment = 0` ; l'ajout suivant ne ferme `own.segment` que si `own.record > 0`
  (`store.rs` 1234) ; le segment 1 n'a donc jamais d'entrée `closed` ; le lecteur (`store.rs` 969-977) voit `partial_tail` vrai et répond
  `cloud-pending` pour toujours. Plus général que le premier ajout : tout ajout coupé qui ouvre `own.segment + 1`, suivi d'un `max + 1`.
  Déjà présent sur `main`. Piste pour la story : `append_journal` à `segment > own.segment + 1` dans la même époque ferme les segments
  intermédiaires à 0 enregistrement, Rust maître de `closed`.
- **Critère 6** : trois points d'arrêt pendant la reprise (avant `writeState`, entre `writeState` et sa transaction, entre cette
  transaction et celle de `resolveInflight`), rangs comptés sur un passage identique sans arrêt.
- **Critère 11** : avec `io`, la phase est l'erreur (bandeau d'erreur en tête) et `publish-blocked` suit avec sa cause ; avec
  `state-mismatch`, le bandeau montre `publish-blocked`. La cause est nommée dans AVERTISSEMENTS de Détails, jamais en bandeau à part.
  Arrêt P3 (aucune intention) : rien ne change d'un cycle à l'autre.
- **Critère 13** : test Rust déjà présent, `y01_15_write_state_compares_head_paired_by_and_reserved_fields` (`sync_store.rs` 424) :
  ajout du segment 1 sans état, `write_state` de `stateSeq` 1 accepté à la tête de `own`, `state-mismatch` sur un autre `record` ou
  segment. Aucun test Rust nouveau, `store.rs` inchangé, `cargo test` non lancé.
- **Instabilité constatée, non touchée** : `tests/unit/sync/epochCarryReportRules.test.ts` (501 tâches) dépasse parfois 5 s sur ce poste,
  **aussi sur le code de référence** (2 dépassements mesurés sans le correctif), vert seul et dans la suite complète du module ensuite.
  Délai jamais allongé ; à instruire à part.
- **Limite de la rédaction de cette fiche** (inchangée) : le scénario 2 n'avait pas pu être lu par l'auteur ; lu par l'agent, voir
  ci-dessus.

## Revue

Revue de code du 2026-10-18 : « à corriger ». Un commit par point ; bundle de départ mesuré après chaque commit (plafond 358 400, net
<= 0 par rapport à 358 303).

| Point | Commit | Rouge / vert | Départ |
|---|---|---|---|
| **B1** (bloquant) : `resolveInflight` publiait l'état d'un appareil bloqué. Option (a) : `if (inflight && publishAllowed)` | rouge `ac9a9dc4` (critère 9 récrit : aucun `state.ctx`, intention posée et stable ; nouveau `tests/unit/sync/pairing/stateDeletedInflight.test.ts`, voisin de `joinAfterRecords.test.ts:97` non modifié), vert `28e02051` | rouge : `firstPublicationCrashPoints.test.ts:343` `AssertionError: cycle 1: expected [ …(3) ] to not include 'state.ctx'` ; `stateDeletedInflight.test.ts:73` `AssertionError: expected [ …(3) ] to not include 'state.ctx'` ; vert après | 358 303 puis 358 260 (compensation : `relistOrphanEpoch` et `retryOrphanDeletion` chargés par le même site `firstModule`) |
| **I1** : `orphanEpoch.ts` et les textes de cause gardés hors du départ | `64ca21bd` | rouge par sondes temporaires non commitées : `publishCauseText` utilisé dans `warningText` → « le texte de cause … est hors du départ » ×2, `assets/main-….js: expected true to be false` (départ 358 627) ; `import './orphanEpoch'` statique dans le moteur → « src/sync/orphanEpoch.ts est un bloc à la demande, hors du départ » rouge (départ 365 126) ; vert sans sonde, 27/27 | 358 260 |
| **I2** : défaut du segment tronqué hors B2 | ce commit de documentation | Écarts, critère 5 (mécanisme et piste) ; aucun code | 358 273 |
| **M1** : refus `openedHere` nommé `first-publication-state-refused` | `32b15d60` | `src/sync/publishDeferred.test.ts` ; sans le correctif : `AssertionError: expected { …(2) } to deeply equal { reason: 'state-refused', …(1) }` | 358 273 (variation dans le nom haché du bloc cité par `main`) |
| **M3** : échec de chargement du bloc `orphanEpoch` | `4749da34` | `tests/unit/sync/firstPublicationLoadFailure.test.ts` : borne (P3) et reprise d'`inflight` (P1) : phase `error`, code `io`, jamais « À jour », intention et file gardées ; `publish-blocked` n'est pas levé (l'erreur passe avant), accepté par la revue. Aucun changement de code | 358 273 |
| **M5** : objet `facts` sur plusieurs lignes | `1813cd07` | mise en forme seule | 358 273 |
| **M2, M4** | notés dans « Limites assumées » (refus mal attribués ; appareil illisible sans cause nommée), sans code | - | 358 273 |

Commandes après la revue : `CT_TEST_WORKERS=1 npx vitest run src/sync src/domain/sync tests/unit/sync src/features/sync src/i18n tests/bundle --coverage.enabled=false` : 204 fichiers, 2 332 tests verts, 2 dépassements de 5 s dans `tests/unit/sync/epochCarryReportRules.test.ts` (instabilité déjà constatée sur le code de référence, voir Écarts ; fichier relancé seul : 20/20 vert ; délai non allongé) ; `npm run lint` et `npm run typecheck` verts.

## Hors de cette story

- La rotation de segment sur `cloud-pending` (Y-IOS-07, §27) ; la lecture muette d'un journal (Y-FIX-03) ; le transport muet (Y-IOS-05).
- L'ouverture du cas « état supprimé après publication » (Question 1).
- Le segment tronqué jamais clos qui tient le lecteur en attente (Écarts, critère 5).
- Tout changement du format publié, de `state.ctx`, du PRD ou des paliers de BUNDLE-01 ; toute fonction de la liste « Hors périmètre » du PRD (section 1).

## Plan par phases

Suivi (voir Preuves) : lecture seule, rouge d'abord (scénario 2 puis crashPoints), règle pure, moteur, visibilité, non-régression,
documentation. Temps passé : environ 2 h 45 (estimation 5 h, alerte 7 h 30).

## Vérifications

- Local : seulement les tests du module (critère 17) ; suite complète en CI (branche non poussée par l'agent : consigne).
- Aucun test désactivé, allongé ni relancé ; aucun fichier écrit hors du dépôt (outils et mesures dans `test-results/yfix02/`, ignoré).

## Preuves

| Élément | Valeur |
|---|---|
| Lignes reconfirmées avant le code | Tableau « Contexte » confirmé sur c01e961b, sans écart : `canPublish` `epoch.ts` 89-93, décision de publier `engine.ts` 539-590, `resolveInflight` 136-149 et 627-633, publication et état 947-969, `publisher.ts` 431-448, `isOrphanEpoch` `epoch.ts` 149-162 |
| `own.json` persisté après `append_journal` (décision 6) | Oui : `SyncCore::append_journal` (`service.rs` 980-1008) appelle `save_own` (écriture de `sync/own.json`) avant de rendre le résultat ; `write_state` (`store.rs` 1299-1306) refuse `stateSeq` non croissant et toute tête différente de `own`. Le simulateur (`memory.ts` 1747-1790) applique les mêmes refus. Aucun changement Rust |
| Scénario 2 : fichier identique à la branche | Oui, empreinte `9f874aa6784f4c88a439cc57a248150b5e07048e` (blob de `origin/y-tech-03-scenarios-rouges` et du worktree), commit `2c7a3191` (seul) |
| Critère 1 rouge avec le code actuel | `2c7a3191` : `AssertionError: expected [ Array(1) ] to include 'state.ctx'` (`scenario2CrashBeforeState.test.ts:80:38`), assertions de départ vertes. Run CI : aucun (pas de push, consigne) |
| Critères 2 à 7, 9, 11, 12 rouges avec le code actuel | `fa7fadf9` (seul) : 10 rouges, 4 verts (P1, P4, critères 4 et 5 ne passent pas par l'impasse). P2, P3, critère 7 : `expected [ Array(1) ] to include 'state.ctx'` ; critère 2 : `expected { …(6) } to be null` (`META.inflight` jamais résolu) ; critère 6 : `Error: aucun état écrit pendant la reprise` ; critère 9 : `expected [] to have a length of 1 but got +0` (`inflight-resolved` absent) ; critère 11 : `cycle 1: expected [ 'publish-blocked' ] to deeply equal ArrayContaining{…}` ; critère 12 : `expected [ 'publish-deferred', …(1) ] to deeply equal ArrayContaining{…}` |
| Critères 1 à 12 verts après correctif | `cc84c304` (correctif), `1917baf1` (commentaires) : scénario 2 vert sans changement, 14/14 crashPoints, 14 cas de la table, 4 tests de Détails et bandeau. Run CI : à lancer au push |
| Bundle de départ (octets gzip, seuil 358 400) | départ 358 357 ; `2c7a3191` : 358 357 ; `fa7fadf9` : 358 357 ; `cc84c304` : 358 303 ; `1917baf1` : 358 303 ; final : **358 303 (net −54, marge 97)**. Consommation : `engine.ts` (borne demandée au bloc, `resolveInflight` sans condition, rappel `io`, `stateSeq` 1 après reprise) ; compensé par `openedHere` sur `orphanProof`, `publish-deferred` et `resolveInflight` dans le bloc à la demande `orphanEpoch`. `npm run test:bundle` : 24/24 vert après chaque commit |
| Test `joinAfterRecords.test.ts:97` inchangé et vert | Oui (aucune modification de `tests/unit/sync/pairing/`) |
| Avenant ADR | **§30** écrit (§27 réservé à Y-IOS-07) |
| Commandes (module seulement) | `CT_TEST_WORKERS=1 npx vitest run src/sync src/domain/sync tests/unit/sync tests/sim src/features/sync src/i18n --coverage.enabled=false` : 201 fichiers, 2 325 tests verts ; `npm run lint` vert ; `npm run typecheck` vert |
| Revue qa-test / code-reviewer | code-reviewer : « à corriger », points appliqués (section « Revue ») ; contre-revue et qa-test à faire |
| Bundle de départ après la revue | 358 273 (net −84 par rapport à 358 357, −30 par rapport à 358 303) |
