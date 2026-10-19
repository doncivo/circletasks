# Y-FIX-03 — Une lecture de journal en échec n'est plus muette : « À jour » interdit, entretien sauté dit, appareil signalé

Module : M15 Synchronisation · Ordre de construction : palier 1.0, **étape 3** (après Y-FIX-02) · Agent : **sync-icloud** (`src/sync/engine.ts`, `src/sync/reader.ts` si besoin, `src/features/sync/syncText.ts`, tests de synchro) · Relecture : code-reviewer · Statut : **fait sur la branche** (2026-10-18 ; rouge a1964dee, vert d1baaf85 ; à fusionner après CI « suite verte » et relecture)
Story technique, sans équivalent au PRD (écart à noter dans docs/decisions.md). Bloquant **B3** de `docs/audit-1.0.md` (plan d'Ali, étape 3). Aucun écart au PRD ; la règle appliquée est celle de l'ADR 0011 section 24 point 5 (« À jour » interdit sans preuve).
Dépend de : Y-TECH-03 (fait : banc, plan de pannes, plan `scenario-3-lecture-io` déjà dans `tests/fixtures/sync/fault-plan.json` ligne 94), **Y-FIX-02 fusionnée** (même fichier `engine.ts`, voir « Ordre et dossiers partagés »).
Estimation : 3 h. Règle d'Ali : arrêt et alerte avant de continuer si l'estimation dérape de plus de 50 % (au-delà de 4 h 30).

## Contexte

- **Constat (audit B3)** : quand `readJournal` échoue pendant un cycle avec un code autre que `newer-format`, `key-mismatch` et `cloud-pending`, `readDevice` répond `status: 'error'` et le moteur se contente de `allRead = false`. Le cycle se termine « réussi » : `lastSyncAt` avance, la ligne d'état dit « À jour · à l'instant », l'étape 7 (instantané, purges, plafonds) est sautée sans que personne le sache. Fréquent sur Windows : iCloud pour Windows occupe un fichier jusqu'à une dizaine de minutes (verrou, code `io`, famille `transient` dans `src/domain/sync/errorFamily.ts`). Les modifications de l'autre appareil n'arrivent plus et l'écran affirme le contraire.
- **Adresses vérifiées le 2026-10-18 sur la branche `y-fix-03-lecture-en-echec` (depuis `main` c01e961b)**. Les lignes de l'audit ont glissé ; Y-FIX-02 les déplacera encore, l'agent les reconfirme après rebase :

  | Audit | Ligne actuelle | Constat |
  |---|---|---|
  | `reader.ts:133` | `src/sync/reader.ts:127-134` (`catch` de `deps.platform.readJournal`, `return finish('error', code)` ligne 133) | le journal `read-failed { device, code }` est écrit (ligne 129) ; seuls `newer-format`, `key-mismatch`, `cloud-pending` ont un statut propre |
  | `engine.ts:833` | `src/sync/engine.ts:858` | `if (outcome.status !== 'complete') allRead = false;` : le seul effet d'un `'error'` |
  | `engine.ts:845` | `src/sync/engine.ts:869-872` | statut de l'appareil écrit pour `truncated`, `clock-ahead`, `newer-major`, `foreign` ; **rien pour `'error'`** |
  | `engine.ts:1007` | `src/sync/engine.ts:998` (entretien `if (publishAllowed && allRead && publishError === null)`), `1060` (`lastSyncAt` enregistré si `publishError === null && pending.size === 0`), `1067-1068` (résultat `failed` ou `done`) | `allRead` n'est lu qu'à 998 ; `lastSyncAt` ne regarde jamais `allRead` |

- **Pourquoi aucun test ne l'attrapait** : aucun test ne faisait échouer `readJournal` pendant un cycle ; les tests de `reader.ts` vérifient `finish('error')` isolément, ceux d'`engine.ts` ne lisent jamais `lastSyncAt` après une lecture en échec. Le banc de Y-TECH-03 (scénario 3, `tests/unit/sync/hostile/scenario3ReadIo.test.ts`, rouge, conservé sur la branche `origin/y-tech-03-scenarios-rouges`) l'attrape : `expect(failed.lastSyncAt).toBe(lastSyncAt)` échoue, reçu `08:01`, attendu `08:00` (fiche Y-TECH-03, tableau des défauts, ligne 3 ; message exact à recopier dans « Preuves » au premier run).
- **Ce que le code a déjà** (donc réutilisable sans texte ni code nouveau) : la phase `error` avec `errorStreak` et `retryAt` (`status.ts:68`, `errorRepeat`), le texte `sync.status.errorGeneric` pour une erreur passagère, `errorSlowed` / `errorSlowedCause` après `SLOW_AFTER` = 3 échecs, `deviceStatusText` `stateCorrupt` (« Fichiers illisibles »), le bandeau `device-corrupt` (`DeviceTroubleCode`, `syncBanners.ts:42`), la ligne `sync.status.incomplete` (« Synchro incomplète : voir les avertissements »). **Il n'existe pas de code d'appareil pour « lecture impossible »** : `DeviceTroubleCode` = `device-foreign | device-corrupt | device-rollback`.
- **Pourquoi l'état `error` du cycle et non un avertissement** : un échec de lecture passager se traite exactement comme l'échec de publication déjà géré (`publishError`, lignes 946-954, 1060, 1067) : cycle `failed`, code réel, `lastSyncAt` gelé, `errorStreak`, ralentissement. Zéro texte nouveau, zéro octet de départ en plus ou presque.

## Décisions retenues

Décisions du product-owner, à valider par Ali (questions en fin de fiche) ; elles suivent la ligne de l'audit : « `'error'` = avertissement par appareil, `lastSyncAt` gelé, `io` dans `errorStreak` ».

1. **Une lecture en `'error'` n'avance jamais `lastSyncAt`, quel que soit le code.** Condition de l'étape 8 : `lastSyncAt` n'est enregistré et renvoyé que si `publishError === null`, `pending.size === 0` **et aucune lecture n'a échoué dans ce cycle**.
2. **Selon la famille du code (`syncErrorFamily`, `errorFamily.ts`)** :
   - **`transient`** (`io` surtout ; aussi `cloud-error`, `vault-unavailable`, `state-mismatch`…) : le cycle se termine `failed` avec ce code, comme un `publishError` (le premier code rencontré, journal `read-failed` pour chaque appareil). La publication, la lecture des autres appareils et la mise à jour de l'état publié du cycle ont lieu quand même (rien n'est bloqué : seules les conclusions du cycle changent). La ligne d'état est `errorText(code)` ; `errorStreak` compte les cycles consécutifs de même code ; **seuil de durabilité = `SLOW_AFTER` (3) : le 3e échec de suite pose `retryAt` (+30 min) et la ligne dit « Synchronisation ralentie : nouvel essai à HH:MM (code io) »**. Jamais d'arrêt des cycles périodiques (famille passagère).
   - **Toute autre famille** (`details` : `bad-header`, `decrypt-failed`, `too-large`, `bad-name`, `hlc-order`…) : l'appareil est traité comme un fichier illisible, par le chemin existant de `truncated` (reprise depuis l'instantané, une par cycle ; sinon appareil `corrupt`, bandeau `device-corrupt` qui le nomme, APPAREILS « Fichiers illisibles »). Le cycle reste `done` (une erreur permanente en cycle `failed` arrêterait le planificateur périodique : `isPermanentSyncError`), mais `lastSyncAt` est gelé (décision 1) et la ligne d'état n'est **jamais** « À jour » tant qu'un appareil autre que soi est `corrupt` : elle dit `sync.status.incomplete`.
3. **Pas de nouveau code de bandeau, pas de nouveau texte**, sauf si le critère 9 l'exige. Si l'agent estime qu'un texte ou un code est indispensable : arrêt et question (bundle saturé, voir ci-dessous).
4. **L'entretien sauté est dit** par l'état du cycle, pas par un message de plus : tant qu'une lecture échoue, la ligne d'état est l'erreur (passager) ou « Synchro incomplète » (permanent), jamais « À jour » ; l'entretien (`maintain`, instantané, purges) est sauté parce que `allRead` est faux (inchangé) et reprend au premier cycle dont toutes les lectures réussissent. Journal : `read-failed` existant ; une entrée `maintenance-skipped { reason: 'read-failed' }` seulement si le scénario 3 l'attend (l'agent lit les assertions avant, sous-tâche 1).
5. **Aucun curseur ni accusé n'avance sur une page non lue** (déjà vrai : `flush` ne s'exécute que sur une page lue) ; figé par un test (critère 5).
6. **Pas de relance dans le cycle, pas de délai, pas de `retry` ajouté** : le nouvel essai est le cycle suivant (règle d'Ali : jamais de test allongé, jamais de délai pour cacher une panne).
7. **Retour à « À jour »** : dès qu'un cycle lit tout sans erreur, `lastSyncAt` avance, `errorStreak` et `retryAt` disparaissent (déjà le cas dans `statusFromFacts`), la phase redevient `idle` et la ligne dit « À jour · à l'instant ».
8. **Soi-même** : une lecture de son propre journal en échec (reprise) suit la même règle que celle d'un autre appareil.

## Critères testables

### Rouge puis vert (règle d'Ali : aucun bloquant clos sans un test qui échoue avant le correctif et passe après)

1. **Scénario 3 du banc.** **Étant donné** le fichier `tests/unit/sync/hostile/scenario3ReadIo.test.ts` repris **tel quel** de la branche `origin/y-tech-03-scenarios-rouges` (plan `scenario-3-lecture-io`, `read` en `io` au rang 1 sur `devices/56d4eec1-…/*/j-*.ctj`), **quand** le cycle lit le journal de l'autre appareil et que la lecture échoue, **alors** l'appareil lu est signalé, `lastSyncAt` n'avance pas, le statut n'est pas « À jour », l'entretien est sauté visiblement, et au cycle suivant (panne consommée) tout se lit et « À jour » revient. **Preuve** : le test est commité **d'abord seul** et lancé rouge avec le code actuel (message d'erreur recopié dans « Preuves »), puis vert après le correctif. Les attentes ne sont modifiées que si elles sont **fausses**, avec justification écrite dans la fiche ; si une attente suppose une forme de signal autre que la décision 2 (par exemple un avertissement `warnings` plutôt qu'un cycle `failed`), l'agent s'arrête et le remonte au product-owner, il ne plie ni le test ni la décision seul. Jamais de `skip`, de délai ni de test allongé.

### Moteur : famille passagère (`io`)

2. **Étant donné** la lecture du journal d'un autre appareil en `io` pendant un cycle, **quand** le cycle se termine, **alors** `outcome` vaut `failed`, `errorCode` vaut `'io'`, `lastSyncAt` du résultat est `null` (le service garde l'ancienne valeur) et la ligne `sync_state` de soi garde son ancien `lastSyncAt` (base lue, pas seulement le statut).
3. **Étant donné** le même cycle, **alors** une écriture locale en file est publiée (`outboxCount` à 0 après le cycle) et un second appareil sain est lu jusqu'à sa tête : l'échec d'un appareil ne bloque ni la publication ni la lecture des autres.
4. **Étant donné** le même cycle, **alors** l'entretien est sauté : aucun instantané écrit, `maintain` non appelé, aucune suppression de fichier propre ; au cycle suivant sans panne, l'entretien dû s'exécute (instantané écrit si dû).
5. **Étant donné** le même cycle, **alors** curseur et accusé de l'appareil en échec sont inchangés dans `sync_state`, et au cycle suivant chaque enregistrement est appliqué **une seule fois** (aucun doublon, aucune perte).
6. **Étant donné** le cycle suivant (panne consommée), **alors** `outcome` vaut `done`, `lastSyncAt` avance, la phase est `idle`, la ligne dit `sync.status.upToDate` avec « à l’instant », `errorStreak` et `retryAt` sont absents.

### Durabilité

7. **Étant donné** une panne durable (nouveau plan `scenario-3-lecture-io-durable` dans la fixture commune : `read` en `io`, `times: all`, même fichier), **quand** trois cycles consécutifs échouent, **alors** `errorStreak` vaut 2 au 2e cycle et 3 au 3e, `retryAt` est posé au 3e (instant du cycle + `SLOW_RETRY_MS`), la ligne du 3e cycle est « Synchronisation ralentie : nouvel essai à HH:MM (code io), ou « Synchroniser » maintenant » (24 h), le planificateur n'est jamais arrêté (`isPermanentSyncError('io')` faux), et `lastSyncAt` reste celui d'avant la première panne. Le plan passe les refus de la fixture (`fault-plan-invalid.json`) et est rejoué par `memory.ts`.

### Moteur : famille permanente (`bad-header`, `decrypt-failed`)

8. **Étant donné** la lecture d'un journal en `bad-header` puis en `decrypt-failed` (deux plans ajoutés à la fixture, `read` en `error` avec ces codes), **quand** le cycle se termine, **alors** : une reprise depuis l'instantané est tentée (une par cycle) ; sans instantané lisible l'appareil est `corrupt` ; le cycle reste `done` ; `lastSyncAt` n'avance pas ; la publication et la lecture des autres appareils ont lieu ; l'entretien est sauté.
9. **Étant donné** un appareil autre que soi `corrupt`, **alors** `statusLine` (phase `idle`) rend `sync.status.incomplete` (« Synchro incomplète : voir les avertissements »), jamais « À jour », et le bandeau `device-corrupt` nomme l'appareil comme dans APPAREILS (« Fichiers illisibles »). Test unitaire de `statusLine` et de `syncBannerFor`. Si cette règle ne tient pas dans la marge du bundle : arrêt et question à Ali (hors décision, la règle reste vraie pour `truncated` déjà aujourd'hui).
10. **Étant donné** une table (un cas par `SyncErrorCode` que `readJournal` peut lever, construite sur `FAMILIES` de `errorFamily.ts`), **alors** chaque code est classé par le moteur selon sa famille : `transient` → cycle `failed` avec ce code ; autre famille → chemin `corrupt` ; `newer-format`, `key-mismatch`, `cloud-pending` gardent leur traitement propre. Un code ajouté à `SyncErrorCode` sans classement fait échouer la table.

### Visibilité (aucun échec silencieux)

11. **Étant donné** chacun des cas 2 et 8, **alors** l'échec est visible **dans l'application** et pas seulement au journal : phase `error` avec code dans Réglages > Synchronisation et bandeau (cas passager) ; appareil « Fichiers illisibles » dans APPAREILS, bandeau `device-corrupt` et ligne « Synchro incomplète » (cas permanent). Test sur `syncBannerFor` + `statusLine` avec l'état produit par le moteur (pas un état construit à la main).
12. **Alors** le journal `read-failed { device, code }` existant est conservé (identifiants courts, aucun contenu) et, si le critère 1 l'exige, `maintenance-skipped`.

### Non-régression

13. **Étant donné** les lectures en `cloud-pending`, `newer-format`, `key-mismatch`, `truncated`, `clock-ahead`, **alors** leur comportement est inchangé : les tests existants de `reader.ts`, `engine.ts` et de la ligne d'état passent **sans modification d'attente**.
14. **Alors** : `CT_TEST_WORKERS=1 npx vitest run src/sync src/domain tests/unit/sync --coverage.enabled=false` vert ; lint et typage verts ; aucun `skip`, délai, retry ni test allongé ; **CI « suite verte » sur la branche** avant fusion (suite complète en CI seulement, jamais en local).

### Bundle de départ (saturé)

15. **Alors** le **bundle de départ est mesuré** par `npm run test:bundle` **après chaque commit** qui touche `engine.ts`, `reader.ts`, `syncBanners.ts`, `syncText.ts` ou `fr.syncEngine.ts` (tous dans le départ). État de départ : **358 357 / 358 400 octets gzip, marge de 43 octets, plafond inamovible** (350 Ko). Exigence : **net ≤ 0** (la décision 2 réutilise `publishError`, les codes et les textes existants ; la règle du critère 9 est la seule addition prévisible, quelques dizaines d'octets, à compenser dans le même commit par un gain équivalent). Si la marge ne suffit pas : **l'agent s'arrête et le remonte** ; les paliers de BUNDLE-01 sont une décision d'Ali (mémoire projet « Bundle de départ saturé » : leviers connus, écrans à la demande). Mesures notées en octets dans « Preuves ».
16. **Alors** tout texte ajouté (en principe aucun) vit dans `src/i18n` (français, 24 h), jamais en dur.

### Documentation (à la clôture)

17. **Alors** : ADR 0011 **avenant §31** (§27 réservé à Y-IOS-07, §28 Y-FIX-04, §29 Y-TECH-05, **§30 réservé à Y-FIX-02** ; reconfirmer le numéro libre) : règle « une lecture en échec n'est jamais muette » et sa classification par famille, gel de `lastSyncAt`, seuil `SLOW_AFTER`, lien avec la section 24 point 5 ; `docs/decisions.md` (ligne du jour, décision d'Ali sur les questions ci-dessous) ; `docs/journal.md` (entrée du jour) ; `docs/backlog.md` (statut de Y-FIX-03) ; `docs/audit-1.0.md` (ligne B3 : état et preuves).

## Hors périmètre

- Les lectures en attente d'iCloud (`cloud-pending`, déjà `pendingFiles` et `waiting-icloud`), les segments évincés : Y-IOS-07 (son critère 9 renvoie à cette story pour le signalement d'un segment qui ne vient jamais) et Y-IOS-05 (appel muet).
- Le nom de l'appareil dans la ligne d'erreur passagère (voir question 3).
- Toute relance dans le cycle, tout délai, tout nouveau mécanisme de reprise : la reprise depuis l'instantané existante est réutilisée telle quelle.
- La règle générale « jamais À jour avec un appareil `corrupt` » pour d'autres chemins que la lecture en `'error'` : couverte seulement par le critère 9 (même effet pour `truncated`), pas d'autre refonte de `statusLine`.
- Toute fonction de la liste « Hors périmètre » du PRD.

## Ordre et dossiers partagés

- **Y-FIX-02 est en cours en parallèle sur `src/sync/engine.ts`** : cette story se développe **après la fusion de Y-FIX-02** (rebase sur `main`), **jamais en parallèle sur le même fichier**. Les lignes citées sont à reconfirmer après le rebase.
- Y-IOS-07 touche `publisher.ts` et `store.rs`, pas `engine.ts` : pas de conflit attendu ; son critère 9 (lecteur) dépend du comportement décrit ici pour le cas « hydratation échouée ».
- Fixture `tests/fixtures/sync/fault-plan.json` : toute extension (plans durable, `bad-header`, `decrypt-failed`) passe par la fixture commune et ses refus ; les trois faux la rejouent (règle du projet). Vérifier d'abord que le champ `code` d'un effet `error` accepte ces valeurs.

## Ordre des sous-tâches

1. **Lecture avant code** : relire `scenario3ReadIo.test.ts` (branche `y-tech-03-scenarios-rouges`) et noter ses assertions exactes dans « Preuves » ; confirmer les lignes de `reader.ts` et `engine.ts` après rebase sur Y-FIX-02 ; mesurer le bundle de départ. Écart avec la décision 2 : arrêt et question au product-owner.
2. Reprise du scénario 3 tel quel, commit **seul**, run rouge, message d'erreur noté (critère 1).
3. `engine.ts` : famille passagère (échec de lecture mémorisé, `lastSyncAt` gelé, résultat `failed`) ; critères 2 à 6 ; mesure du bundle.
4. Plan durable dans la fixture ; critère 7 ; mesure du bundle.
5. Famille permanente (chemin `truncated`/`corrupt`), `statusLine` du critère 9 ; critères 8 à 10 ; mesure du bundle.
6. Visibilité et non-régression (critères 11 à 13) ; tests du module (critère 14) ; push, CI « suite verte ».
7. Documentation (critère 17) ; qa-test, puis code-reviewer.

## Vérifications

- Local : seulement `CT_TEST_WORKERS=1 npx vitest run src/sync src/domain tests/unit/sync --coverage.enabled=false` ; la suite complète tourne en CI.
- CI : branche verte, statut « suite verte » ; aucun test désactivé ni délai allongé ; aucun échec silencieux.
- Preuve de détection : le scénario 3 rouge avec le code actuel (message cité), puis vert.
- Aucun fichier écrit hors du dépôt ; aucun secret ; consigne à rappeler à l'agent : fichiers temporaires dans le worktree.
- Clôture refusée si un critère manque : le product-owner vérifie les 17 critères avant « fait ».

## Preuves

| Élément | Valeur |
|---|---|
| Assertions exactes de `scenario3ReadIo.test.ts` (lues avant le code) | `faultLog` = `['read-journal-io']` ; `read-failed` avec `code: 'io'` ; tâche tardive absente ; `expect(failed.lastSyncAt).toBe(lastSyncAt)` ; `statusLine(failed)` sans « À jour » ; signal = `phase === 'error'` **ou** `warnings` non vide **ou** appareil lu non `active` (compatible avec la décision 2, aucun `maintenance-skipped` attendu) ; cycle suivant : tâche lue, « À jour », `lastSyncAt` changé |
| Scénario 3 rouge avec le code actuel (message d'erreur) | commit `a1964dee` (test seul) : `AssertionError: expected '2026-10-05T08:01:00.000Z' to be '2026-10-05T08:00:00.000Z' // Object.is equality`, `scenario3ReadIo.test.ts:51:31` (`expect(failed.lastSyncAt).toBe(lastSyncAt)`) |
| Scénario 3 vert après correctif | commit `d1baaf85` : 1/1 vert ; `readFailure.test.ts` (critères 2 à 12) 45/45 vert |
| Bundle de départ (octets gzip, plafond 358 400) | après la fusion de `main` : **358 273** ; après `d1baaf85` : **358 348 (+75)**, répartition mesurée : `engine.ts` environ +68, `reader.ts` environ +7, règle du critère 9 (`syncText.ts`) environ 0 ; `npm run test:bundle` 27/27 vert ; +75 accepté (plafond respecté, marge libérée par T-TECH-01 et BUNDLE-01) |
| Lignes de `engine.ts` et `reader.ts` reconfirmées après rebase | `reader.ts` 128-137 (`catch` de `readJournal`) ; `engine.ts` : déclaration de `publishError` et `readFailed` avant la boucle de lecture (733-735), classement après `readDevice` (871-872), publication `publishError ??= result.error` (965), entretien (1010, inchangé), `lastSyncAt` (1072), résultat (1079-1080) |
| Numéro d'avenant ADR libre | §31 (inséré entre §30 et §32) |
| Commandes | `CT_TEST_WORKERS=1 npx vitest run src/sync src/domain tests/unit/sync src/features/sync --coverage.enabled=false` : 285 fichiers, 3 652 tests verts ; `npm run typecheck` et `npm run lint` verts |

## Écarts

## Revue Codex du 2026-10-19 — approuvée

- Product-owner : les 17 critères et les preuves rouge `a1964dee` / vert `d1baaf85` ont été relus. Aucun changement de format ni de texte requis.
- Module : diff relu sans modification du code ; classification par famille dans le lecteur, première erreur passagère conservée par le moteur, publication et lectures saines poursuivies, entretien suspendu et heure gelée tant qu'une lecture échoue.
- QA : 46 tests ciblés verts (`scenario3ReadIo` et `readFailure`). Suite complète avec couverture, lint et typage verts sur `39e1b79b`, runs 39228783679 et 39228790388. Les erreurs permanentes, la reprise, les trois échecs consécutifs et le retour au succès sont couverts.
- Revue distincte : approuvée sur le diff et les tests. Les écarts historiques de fixture et de taille sont explicites ; aucun seuil ni délai modifié. La CI du nouveau commit documentaire doit rester verte avant fusion. La revue consignée ici est la trace requise ; aucune auto-approbation GitHub.

### Écarts historiques

1. **Hypothèses sur les questions à Ali** (recommandations appliquées, à confirmer) : question 1, cycle `failed` pour un code passager et appareil `corrupt` pour un code permanent ; question 2, un seul `bad-header` ou `decrypt-failed` suffit ; question 3, pas de nom d'appareil dans la ligne passagère ; question 4, règle « Synchro incomplète » avec un appareil `corrupt` faite (environ 0 octet), rien reporté dans `docs/dettes.md`.
2. **Codes permanents hors du plan de pannes** : `bad-header` et `decrypt-failed` sont levés par la plateforme simulée (`readJournal` remplacé dans le test), pas par la fixture : le plan commun n'accepte que `io` et `cloud-pending` et il est lu aussi par MemFs et `fake_bookmark.rs` ; l'étendre toucherait `faultPlan.ts` et les faux de Rust, hors périmètre. Le critère 10 est vérifié au niveau de `readDevice` (table de tous les `SYNC_ERROR_CODES`), le moteur par des cas représentatifs.
3. **Reprise réussie** : un code permanent dont la reprise depuis l'instantané récupère tout gèle quand même `lastSyncAt` pour ce cycle (décision 1) : la ligne dit « À jour · il y a N » avec l'heure ancienne, jamais « à l'instant », puis « À jour · à l'instant » au cycle suivant (testé).
4. **Bundle net > 0** : +75 octets au lieu de net ≤ 0, accepté par le coordinateur (358 348 / 358 400) ; aucune refactorisation hors de la story. Premier passage local de la suite du module : 16 dépassements de 5 s sous la charge de la machine (mêmes échecs sans le correctif) ; second passage entièrement vert, aucun délai allongé.

## Questions à Ali (sans bloquer le développement)

1. **Forme du signal, écart de lecture avec l'audit.** L'audit dit « avertissement par appareil ». Je propose, pour l'échec passager (`io`), un **cycle `failed`** (même chemin que l'échec de publication : ligne d'état, `errorStreak`, ralentissement après 3 échecs, zéro texte nouveau), et pour l'échec permanent, l'**appareil `corrupt`** nommé (bandeau et APPAREILS existants). Raison : aucun code d'appareil « lecture impossible » n'existe, et en créer un (code, texte, rang dans `SYNC_TROUBLE_ORDER`) dépasse les 43 octets de marge. Recommandation : accepter. Alternative : un avertissement `read-failed` avec le nom de l'appareil, au prix d'un palier de bundle (BUNDLE-01).
2. **Seuil pour l'échec permanent.** Un seul `bad-header` ou `decrypt-failed` suffit-il à tenter la reprise puis à marquer l'appareil `corrupt` ? Recommandation : oui (Rust répond déjà `truncated` pour un fichier partiel d'iCloud, donc ces codes sont de vraies corruptions ; la reprise est une fusion qui n'efface rien). Alternative : trois cycles de suite avant d'agir, au prix d'un compteur persistant par appareil.
3. **Nommer l'appareil dans la ligne d'erreur passagère** (« PC 56d4 : fichier occupé par iCloud ») : non retenu, texte nouveau. À reprendre après la 1.0 si le journal montre des échecs fréquents.
4. **Marge du bundle.** 43 octets : la règle du critère 9 (ligne « Synchro incomplète » avec un appareil `corrupt`) est la seule addition prévisible. Si elle ne tient pas sans compensation, faut-il la reporter (le défaut existe déjà pour `truncated`) plutôt que de toucher aux paliers de BUNDLE-01 ? Recommandation : la reporter et le consigner dans `docs/dettes.md`.
