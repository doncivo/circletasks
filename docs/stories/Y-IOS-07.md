# Y-IOS-07 — Segment de tête évincé par iOS : l'ajout au journal ouvre un segment suivant, sans jamais lire iCloud

Module : M15 Synchronisation · Ordre de construction : palier 1.0, **étape 3** (avec Y-FIX-02, Y-FIX-03, Y-IOS-02-FIX-01, Y-IOS-05) · Agents : **sync-icloud** (`src/sync/publisher.ts`, `src/platform/sync/memory.ts`, tests de synchro) + **desktop-tauri** (`src-tauri/src/sync/store.rs`, tests Rust) · Relecture : code-reviewer · Statut : **à faire** (décision d'Ali du 2026-10-17)
Story technique, sans équivalent au PRD (écart à noter dans docs/decisions.md : ligne du 2026-10-17). Défaut nouveau n° 1 du rapport de Y-TECH-03 (section « Défauts révélés »), classé bloquant, **ajouté à l'audit 1.0 comme B16** (2026-10-17). Aucun écart au PRD.
Dépend de : Y-TECH-03 (fait : banc, plan de pannes, `memory.ts` et `fake_bookmark` hostiles), Y-TECH-02 (champ `closed` de `state.ctx`, ADR 0011 §21 point 2). Indépendante de Y-FIX-02, Y-FIX-03, Y-IOS-05 ; touche `publisher.ts`, que Y-FIX-02 touche aussi (voir « Ordre et dossiers partagés »).
Estimation : 4 à 6 h. Règle d'Ali : arrêt et alerte avant de continuer si l'estimation dérape de plus de 50 % (au-delà de 9 h).

Décision d'Ali du 2026-10-17, mot pour mot : « Le défaut 1 passe avant la 1.0, à l'étape 3, avec B2, B3, B5 et B6. C'est le cas d'école de ce qu'on veut éliminer : perte silencieuse et définitive, et « Optimiser le stockage » est actif par défaut, donc le segment de tête devient candidat dès quelques jours sans ouvrir l'app. Ouvre la story. Sur le correctif, je tranche pour l'ouverture d'un segment suivant, pas le téléchargement du segment de tête avant l'ajout. Un journal est append-only : l'écriture n'a pas besoin de lire ce qui précède. Ouvrir un nouveau segment garde l'écriture locale indépendante d'iCloud, donc mes saisies réussissent même hors ligne ou avec le fichier évincé. Télécharger avant d'ajouter remettrait le réseau sur le chemin critique de l'écriture et recréerait une panne silencieuse sous une autre forme. Garde le téléchargement pour la lecture et la fusion, où l'échec doit de toute façon être visible. Si tu vois une raison technique de faire l'inverse, dis-la-moi avant de coder. Défauts 2 et 3 : d'accord, dans le périmètre de Y-IOS-02-FIX-01, pas de story nouvelle. »

## Contexte

- Constat du banc (Y-TECH-03, scénario 6, `tests/unit/sync/hostile/scenario6EvictedHeadSegment.test.ts`, rouge, conservé sur la branche `y-tech-03-scenarios-rouges`, commit c41d5d66) : quand iOS évince le segment de tête de l'iPhone (« Optimiser le stockage », actif par défaut), chaque ajout au journal échoue en `cloud-pending` pour toujours. Les saisies de l'iPhone n'arrivent plus au PC ; le statut dit « iCloud ne répond pas : vos modifications seront envoyées au retour » à chaque cycle, sans fin, même quand le réseau est parfait. Aucune perte locale immédiate, mais synchro sortante figée sans cause réelle ; la gravité tient à l'accumulation (tout ce qui est saisi reste dans la file locale, y compris si l'appareil est perdu ou restauré avant la résolution).
- Causes vérifiées à la rédaction (branche `plan-etape-3`, depuis `origin/main` 8f17c742, 2026-10-17) :
  - `src-tauri/src/sync/store.rs:1185` : l'ajout lit le segment de tête propre sans hydratation (`self.fs.read(&path, MAX_SEGMENT_BYTES, false)`) pour contrôler l'en-tête, le nombre de lignes et la place restante ; un fichier évincé répond `cloud-pending`. (Même règle dans `memory.ts` : `existing.availability !== 'local'`.)
  - `src/sync/publisher.ts:450` : le moteur n'ouvre un segment suivant que sur `segment-full` ou `segment-mismatch` (`attempt < 2`) ; tout autre code, dont `cloud-pending`, sort par `publish-failed` (ligne 458) et le cycle suivant recommence au même segment.
  - `src-tauri/src/sync/bookmark.rs:331` : `pin` est sans effet sur iPhone : rien ne maintient le segment de tête local.
- Le segment de tête n'est lu que pour contrôler ce que l'on est sur le point d'ajouter ; or l'appareil connaît déjà sa tête (`META.head` : segment, nombre d'enregistrements, dernier hlc) et le contrôle `expect_records` est refait par l'intention `inflight`. La lecture du segment ne sert donc qu'à des garde-fous (en-tête, tronqué par un tiers, taille), pas à écrire.
- Les adresses de lignes viennent de la rédaction ; l'agent les reconfirme avant de coder et note tout écart dans la fiche.

## Décisions retenues

- **Décision d'Ali (2026-10-17) : ouvrir un segment suivant, ne pas télécharger avant d'ajouter.** Sur `cloud-pending` à l'ajout dans le segment de tête propre, le moteur ouvre le segment `max + 1` (comme sur `segment-full`) et ajoute là, avec `expectRecords: 0`.
- **Règle : l'écriture ne lit jamais iCloud.** Aucun appel `hydrate` ni `read` bloquant sur le chemin de l'ajout au journal. Le téléchargement reste réservé à la lecture et à la fusion, où l'échec est de toute façon visible. Cette règle est consignée dans l'ADR 0011 (avenant §26).
- **Une seule rotation sur `cloud-pending` par cycle** (plafond contre une boucle de création de segments) ; indépendante du compteur `attempt < 2` de `segment-full` / `segment-mismatch`, qui ne change pas.
- **Si l'ajout échoue encore après la rotation** (le nouveau segment aussi en `cloud-pending`, ou toute autre erreur) : l'échec devient **visible** (avertissement durable dans Détails avec la cause et, au-delà du journal technique, un état lisible dans l'app), conformément à la règle « aucun échec silencieux ». Il se résout au premier ajout réussi.
- Le segment évincé reste dans iCloud, tel quel, avec son `closed` (nombre d'enregistrements) enregistré dans `state.ctx` (Y-TECH-02). On ne le supprime pas, on ne le réécrit pas.
- **Défauts 2 et 3 du rapport du banc : dans le périmètre de Y-IOS-02-FIX-01**, pas de story nouvelle (décision d'Ali du 2026-10-17). Hors de cette fiche.

## Raison technique de faire l'inverse ? (à répondre avant de coder)

Ali veut être prévenu s'il en existe une. **Avant d'écrire une ligne de code, l'agent d'implémentation répond par écrit dans cette section** (réponse datée, signée de l'agent) : « aucune raison trouvée » ou la liste précise des raisons, et alors **arrêt et question à Ali, pas de code**. Les points à vérifier, chacun avec le fichier et la ligne lus :

1. **`authenticated_tail` refuse l'ajout** quand un segment authentifié plus haut existe (`store.rs` ~1165-1181, `SegmentMismatch`). Après une rotation vers `n + 1`, un ajout au segment `n` (rejeu d'un `inflight` ancien) serait refusé : vérifier que le moteur ne retombe jamais sur `n` après avoir ouvert `n + 1`, y compris après redémarrage de l'app entre la rotation et le retrait de la file. Vérifier aussi qu'un `n + 1` déposé en échec partiel (écriture refusée avant tout octet) ne laisse pas un fichier qui fait ensuite refuser `n + 2`.
2. **`cloud-pending` peut venir de l'écriture, pas seulement de la lecture** (`fs.append`, `fs.write` atomique). Si le code est levé après un octet écrit, ouvrir `n + 1` dupliquerait des enregistrements. Prouver, par la lecture du code Rust et par un cas du banc (`write` en `cloud-pending`, `partialLastLine`), que la rotation n'est déclenchée que pour un échec **avant toute écriture** (lecture du segment de tête), ou que l'intention `inflight` et le contrôle d'hlc croissants rendent le doublon inoffensif. Si ce n'est pas démontrable, la rotation est limitée à l'origine « lecture du segment de tête » (code distinct ou indice porté par l'erreur) : c'est un point à remonter à Ali.
3. **`deleteOwn`, règle « le segment de la tête courante n'est jamais supprimé »** : après rotation, la tête est `n + 1` et le segment `n` (évincé) devient supprimable par l'entretien. Vérifier que la purge ne supprime pas `n` avant que tous les appareils l'aient lu (accusés), et que sa suppression, sur un fichier évincé, passe par le chemin correct (substitut `.icloud`, Y-IOS-02-FIX-02).
4. **Purge et instantané doivent accepter des segments courts en nombre** : un iPhone peu utilisé produit un segment par éviction, donc beaucoup de segments de 1 à quelques enregistrements. Vérifier les plafonds (nombre de segments listés, `MAX_SCAN_ENTRIES_PER_FOLDER`, `folder-too-large`), la règle de l'instantané (déclencheurs au nombre de segments ou d'octets) et le coût du scan sur iPhone. Si un plafond se déclenche, c'est une raison de remonter la question.
5. **Lecture par le PC d'un segment `n` évincé puis d'un `n + 1` présent** : le PC lit `n` par hydratation (échec visible s'il ne vient pas) puis `n + 1`, dans l'ordre, sans trou ni ligne perdue ; le lecteur ne doit pas passer à `n + 1` sans avoir lu `n` en entier (contrôle par `closed`) et ne doit pas se bloquer si `n` est lisible mais `n + 1` pas encore téléchargé.
6. **Boucle de rotation sur une panne durable** : si `cloud-pending` vient de iCloud lui-même (et non de l'éviction), chaque cycle ouvrirait un segment de plus. Le plafond d'une rotation par cycle borne le rythme mais pas la croissance : vérifier que l'échec de la rotation ne laisse aucun fichier (écriture refusée avant tout octet) et que le cycle suivant ne rouvre pas un nouveau numéro tant que l'ajout au précédent n'a pas réussi.
7. **Ordre des hlc** : l'ajout dans `n + 1` reprend le contrôle « hlc strictement croissants d'un ajout à l'autre dans une époque » depuis la tête connue (`store.rs` ~1209 et suivantes) ; vérifier qu'il ne dépend pas de la lecture du segment `n` pour connaître le dernier hlc.

Réponse de l'agent d'implémentation : *à remplir avant le premier commit de code.*

## Critères testables

### Rouge puis vert (règle d'Ali : aucun bloquant clos sans un test qui échoue avant le correctif et passe après)

1. **Scénario 6 du banc.** **Étant donné** le fichier `tests/unit/sync/hostile/scenario6EvictedHeadSegment.test.ts` repris de la branche `y-tech-03-scenarios-rouges` (commit c41d5d66, plan `list` en `placeholder` au rang 1 sur `devices/ef50…/*/j-*.ctj` avec téléchargement simulé de 1 s), **quand** l'iPhone enchaîne les cycles avec le segment de tête évincé, **alors** l'ajout aboutit dès le premier cycle (au plus un `publish-failed` sur les trois cycles, aucun `publish-failed { cloud-pending }` durable), le PC reçoit les saisies et le statut n'affiche pas « iCloud ne répond pas ». **Preuve** : le test est commité **d'abord seul** sur la branche de la story et lancé rouge avec le code actuel (commit et numéro de run CI cités dans la fiche, section « Preuves »), puis vert après le correctif (commit et run cités). Jamais de `skip` ni de test allongé.

### Rust : `store.rs`

2. **Étant donné** un segment de tête propre évincé (faux hostile armé en `evict-after-read` ou en `placeholder` sur le segment de tête, `MemFs` et `fake_bookmark`), **quand** le moteur Rust ajoute au segment de tête, **alors** il répond `cloud-pending` **sans jamais tenter d'hydratation** : la lecture est comptée et aucun `hydrate` n'est consommé (plan armé en `download-error` ou `mute` sur `hydrate` : `unfired()` contient l'entrée, non consommée), et aucun octet n'est écrit (le fichier évincé garde son contenu, aucun fichier partiel). Le comportement actuel (réponse `cloud-pending` sur un fichier non local) est donc **conservé et figé par un test**, la rotation étant décidée par le moteur TypeScript.
3. **Étant donné** le même segment évincé, **quand** le moteur ajoute au segment `max + 1` avec `expectRecords: 0`, **alors** l'ajout réussit sans lire le segment évincé : la tête devient `n + 1`, record 1 ou le nombre de lignes ajoutées, l'hlc contrôlé depuis la tête connue, et le fichier évincé n'est ni lu ni modifié (aucun rang `read` ni `hydrate` consommé sur `j-n`).

### TypeScript : `publisher.ts`

4. **Étant donné** un `appendJournal` qui répond `cloud-pending` pour le segment de tête, **quand** `publisher.ts` traite le lot, **alors** il passe à `max + 1` à la tentative suivante avec `expectRecords: 0`, réussit, met à jour `META.head` sur le nouveau segment et `META.segments`, et retire les entrées de la file ; `maxSegment` tient compte du plus grand fichier listé (règle 1 de l'ADR), pas seulement du segment courant.
5. **Étant donné** la rotation du critère 4, **alors** le `closed` du segment évincé (nombre d'enregistrements qu'il contient) est enregistré dans `state.ctx` (Y-TECH-02), identique à celui d'une rotation sur `segment-full` ; un test de table (`tests/fixtures/sync/closed-segments.json` ou cas dédié) le fige.
6. **Étant donné** un cycle où le segment de tête est évincé **et** où le moteur reprend après une app tuée entre la rotation et le retrait de la file (`inflight` résiduel), **quand** le moteur redémarre, **alors** il reprend sur `n + 1` sans ajouter de doublon ni retomber sur `n` (test d'arrêt brutal avec `armCrash`, à la manière des scénarios du banc).

### Échec visible

7. **Étant donné** que la rotation est impossible (le nouveau segment `n + 1` aussi en `cloud-pending`, cas armé dans le plan), **quand** deux cycles consécutifs s'enchaînent, **alors** (a) **au plus une rotation par cycle** : aucun segment `n + 2`, `n + 3`… créé dans un même cycle, et aucun segment créé du tout si l'écriture est refusée avant tout octet ; (b) un **avertissement durable visible** apparaît dans Détails avec la cause (code traduit comme les autres motifs de synchro) et un texte lisible dans l'app, pas seulement une entrée du journal technique ; (c) il se résout dès que l'ajout réussit, et l'état persiste au redémarrage tant que l'échec dure ; (d) aucune boucle de création de segments : le nombre de fichiers `j-*.ctj` de l'appareil après N cycles en panne est borné (test avec N = 10).

### Hors ligne

8. **Étant donné** un faux armé de façon que **tout `read` et tout `hydrate`** soit en `mute` ou en `error` (hors ligne, fichier évincé ou non), **quand** l'utilisateur saisit puis que le moteur ajoute au journal, **alors** l'ajout aboutit localement : aucune lecture iCloud n'est faite sur le chemin de l'écriture (`unfired()` des entrées `read` et `hydrate` non consommées après l'ajout au segment `n + 1` ; le seul appel permis sur le chemin est le listage du dossier de l'époque, borné par `MAX_SCAN_ENTRIES_PER_FOLDER`). Si le listage lui-même est en `error`, l'échec est visible (critère 7) et la saisie reste dans la file locale, jamais perdue.

### Lecteur (PC)

9. **Étant donné** deux appareils (banc `syncCloudSim`), l'iPhone ayant son segment `n` évincé sur le PC (substitut `cloud` côté PC, hydratation simulée) et un segment `n + 1` présent, **quand** le PC lit le journal de l'iPhone, **alors** il hydrate `n`, lit tous ses enregistrements, puis lit `n + 1`, dans l'ordre des hlc, sans ligne perdue ni doublon ; si l'hydratation de `n` échoue, l'appareil est signalé en avertissement (lien avec Y-FIX-03) et `n + 1` n'est **pas** appliqué avant `n` (pas de trou).

### Purge, instantané, suppression

10. **Étant donné** une suite de segments courts créés par éviction (par exemple 20 segments de 1 à 3 enregistrements), **quand** l'entretien tourne (purge des segments accusés, instantané), **alors** la règle « le segment de la tête courante n'est jamais supprimé » tient pour `n + 1`, les segments déjà lus par tous les appareils sont purgés, les autres sont conservés, aucun plafond de listage ni `folder-too-large` n'est franchi à tort, et l'instantané couvre l'ensemble sans trou.

### Non-régression

11. **Étant donné** les cas existants `segment-full` et `segment-mismatch`, **alors** leur comportement est inchangé (même compteur `attempt < 2`, mêmes numéros de segment) : les tests existants de `publisher.ts` passent sans modification d'attente.
12. **Alors** : `CT_TEST_WORKERS=1 npx vitest run src/sync src/platform/sync src/features/sync tests/sim tests/unit/sync --coverage.enabled=false` vert ; `cd src-tauri && cargo test --test desktop --features test-hooks -- sync_` vert ; lint et typage verts ; aucun `skip`, délai, retry ni test allongé ; **CI « suite verte » sur la branche** avant fusion.
13. **Alors** le **bundle de départ est mesuré** : `tests/bundle/startBundle.test.ts` lancé avant tout push (état de départ : 358 045 octets gzip, marge de 355 octets sur le seuil de 358 400, soit 349,67 Ko sur 350 : **aucune marge**). La mesure (en octets) est notée dans la fiche. Le texte de l'avertissement et son composant d'affichage sont chargés à la demande ou rangés dans un bloc déjà hors départ ; si le départ dépasse, les leviers connus sont appliqués avant le push (mémoire projet « Bundle de départ saturé »).
14. **Alors** le texte de l'avertissement vit dans `src/i18n` (français, 24 h), jamais en dur, et reste sous un nom de motif de synchro existant si c'est possible.

### Documentation

15. **Alors** : ADR 0011, **avenant §26** (prochain numéro libre après §25, à reconfirmer par l'agent) : règle « l'écriture ne lit jamais iCloud », raison d'Ali (citation), rotation sur `cloud-pending` à l'ajout, plafond d'une rotation par cycle, échec visible, réponse à la section « Raison technique de faire l'inverse ? » ; `docs/dettes.md` : segments courts en nombre, rotation sur une panne durable ; `docs/journal.md` : entrée du jour ; `docs/backlog.md` : statut de Y-IOS-07 ; `docs/audit-1.0.md` : état de B16.

## Limites assumées

- Le banc ne prouve pas le comportement réel d'iOS : quand il évince, quel délai, et ce que `NSFileCoordinator` répond sur un substitut. Le faux modélise l'éviction par un rang d'appel (Y-TECH-03). Le comportement réel est à observer à la séance iPhone suivante (journal : `append-rotate-cloud-pending` ou le nom retenu, nombre de segments de l'iPhone dans iCloud).
- Un iPhone peu utilisé produit un segment court par éviction : plus de fichiers, plus petits. Accepté par Ali (« Ouvrir un nouveau segment garde l'écriture locale indépendante d'iCloud »). La consolidation des segments courts (instantané, purge) existe déjà ; son efficacité est vérifiée au critère 10, pas réécrite ici.
- La rotation protège l'écriture, pas la lecture : si iCloud ne livre jamais le segment évincé au PC, le PC l'affiche (Y-FIX-03) mais ne peut pas le lire. Cas hors de cette story.
- Aucun comportement n'est ajouté pour un segment de tête **tronqué ou modifié par un tiers** (reste `segment-mismatch`).

## Hors de cette story

- Défauts 2 et 3 du rapport de Y-TECH-03 (instantanés qui reviennent après une suppression acceptée puis non propagée ; substitut persistant qui fait réarmer puis journaliser `orphan-epoch-already-gone` à chaque cycle) : **Y-IOS-02-FIX-01**.
- L'échéance par appel du transport (`call_with_deadline`, `mute`) : Y-IOS-05.
- Les lectures en échec muettes côté PC : Y-FIX-03.
- L'impasse de première publication : Y-FIX-02.
- Toute option de téléchargement ou d'épinglage (`pin`) du segment de tête : écartée par Ali.
- Toute fonction de la liste « Hors périmètre » du PRD.

## Ordre et dossiers partagés

- `publisher.ts` est aussi touché par Y-FIX-02 (impasse de première publication, `inflight`) : **un seul des deux lots à la fois sur `src/sync/publisher.ts`** ; Y-IOS-07 après Y-FIX-02, ou rebase explicite. `store.rs` est partagé avec Y-IOS-05 (délai sur le transport) pour le seul appel de lecture ; fusion de Y-IOS-05 d'abord s'il y a conflit.
- `memory.ts` et `fake_bookmark.rs` : seulement si le banc manque d'un point de panne (par exemple un code d'erreur d'ajout distinct) ; toute extension du plan de pannes passe par la fixture commune et ses refus (`fault-plan-invalid.json`).

## Ordre des sous-tâches

1. **Réponse écrite à « Raison technique de faire l'inverse ? »** (lecture de `store.rs` ~1130-1260, `publisher.ts` ~405-465, `deleteOwn` et purge de `maintenance.ts` / `engine.ts`, lecteur `reader.ts`). Arrêt et alerte à Ali s'il existe une raison.
2. Reprise du scénario 6 depuis `y-tech-03-scenarios-rouges` (c41d5d66) ; commit seul ; run rouge cité (critère 1).
3. Rust `store.rs` : tests des critères 2 et 3 (le code Rust ne change que si la lecture du critère 2 révèle un écart) ; tests rouges ou verts selon l'état.
4. `publisher.ts` : rotation sur `cloud-pending`, plafond d'une rotation par cycle, `closed` (critères 4, 5, 6).
5. Échec visible : état durable, avertissement dans Détails, texte i18n (critère 7, 14).
6. Hors ligne et lecteur : critères 8 et 9 ; purge et instantané : critère 10.
7. Non-régression locale (module) ; mesure du bundle de départ (critères 11 à 13) ; push, CI « suite verte ».
8. Documentation (critère 15) ; qa-test, puis code-reviewer.

## Vérifications

- Local : seulement les tests du module (commande du critère 12) ; la suite complète tourne en CI, jamais en local.
- CI : branche verte, statut « suite verte » ; aucun test désactivé ni délai allongé ; aucun échec silencieux.
- Preuve de détection : le scénario 6 rouge avec le code actuel (run cité) puis vert.
- Aucun fichier écrit hors du dépôt ; aucun secret ; consigne à rappeler à l'agent : fichiers temporaires dans le worktree.
- Clôture refusée si un critère manque : le product-owner vérifie les 15 critères avant « fait » et que la section « Raison technique de faire l'inverse ? » porte une réponse écrite.

## Preuves (à remplir)

| Élément | Valeur |
|---|---|
| Scénario 6 rouge avec le code actuel | commit et run : *à compléter* |
| Scénario 6 vert après correctif | commit et run : *à compléter* |
| Bundle de départ (octets gzip, seuil 358 400) | *à compléter* |
| Réponse « raison technique de faire l'inverse » | *à compléter avant le code* |
