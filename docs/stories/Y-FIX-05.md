# Y-FIX-05 : un segment tronqué jamais enregistré ne bloque plus le lecteur (bloquant B18)

## En-tête

| Champ | Valeur |
| --- | --- |
| Module | M15 (synchronisation iCloud) |
| Palier | 1.0, étape 3, après Y-FIX-02 (le test du critère 5 et le point d'arrêt `partialLastLine` viennent de cette story) |
| Agents | sync-icloud (lecteur, faux `memory.ts`, banc), desktop-tauri (`read_journal`, tests Rust) ; relecture code-reviewer ; qa-test |
| Constat | `docs/audit-1.0.md`, B18 (ajouté le 2026-10-18) |
| Estimation | 3 à 4 h ; alerte à 6 h (règle d'Ali : arrêt et prévenir si l'estimation dérape de plus de 50 %) |
| Statut | QA et revue approuvées le 2026-10-19 ; en attente de la suite complète CI sur le commit final avant fusion et clôture (rouge 89d5ef7d, vert 528bb5f2 ; C13 rouge b1253508, vert 15b8cab1) |
| Branche | `y-fix-05-segment-tronque`, rebasée sur `main` c76bc718 après fusion de #62 |
| Règle d'Ali (2026-10-18) | un défaut qui fait perdre des données ou affiche un état faux sans le dire passe avant la 1.0 d'office |

## Contexte

**Ce qu'Ali voit** : le PC affiche « En attente d'iCloud » sans fin et ne reçoit plus rien de l'iPhone, pendant que l'iPhone affiche « À jour ». Les deux états sont faux et aucun message ne l'explique avant les 24 h de l'attente prolongée.

**Mécanisme** (révélé par Y-FIX-02, critère 5 partiel, confirmé par la revue) :

1. Un ajout au journal est coupé net (ligne partielle, `partialLastLine` du banc). Le segment 1 existe, tronqué, mais Rust n'a jamais enregistré l'ajout : `own.json` inchangé, `own.segment = 0`, `own.record = 0`.
2. L'ajout suivant ouvre le segment 2. `append_journal` (`src-tauri/src/sync/store.rs:1234`) ne ferme `own.segment` que si `own.segment >= 1 && own.record > 0` : le segment 1 n'a jamais d'entrée `closed` dans `state.ctx`.
3. Le lecteur (`read_journal`, `store.rs:969-977`) arrive au bout des lignes complètes du segment 1 : ligne absente, aucun nombre annoncé (`closed_count` vaut `None`), `partial_tail` vrai. La condition de passage au segment suivant (`count.is_none() && segment < head.segment && !file.partial_tail`) est fausse à cause de `!file.partial_tail` : statut `cloud-pending`, pour toujours.
4. Plus général que le premier ajout : tout ajout coupé qui ouvre `own.segment + 1` (jamais enregistré), suivi d'un `max + 1` (le moteur ouvre le plus grand segment authentifié listé, plus un), laisse `own.segment + 1` sans entrée et produit le même blocage.

**Lignes vérifiées dans le worktree le 2026-10-18** (branche issue de `main`) :

| Fichier et lignes | Constat |
| --- | --- |
| `src-tauri/src/sync/store.rs:934` | `closed_count(n)` : vaut `Some` seulement si `n < head.segment` ET une entrée existe dans `state.closed`. |
| `store.rs:969-977` | la branche « ligne absente » : passage au segment suivant seulement si `!file.partial_tail`, sinon `cloud-pending`. |
| `store.rs:948-956` | lecture du segment avec hydratation (`self.fs.read(..., true)`) ; absent ou dans le nuage : `cloud-pending`, jamais sauté. Un fichier lu avec succès est donc matérialisé en entier. |
| `store.rs:1198-1199` | l'ajout dans un fichier à `partial_tail` répond `segment-mismatch` : le moteur ne répare jamais un segment tronqué, il en ouvre un autre. |
| `store.rs:1232-1237` | la fermeture du segment précédent exige `own.segment >= 1 && own.record > 0`. |
| `src-tauri/src/sync/state.rs:73-78` | `closed_is_valid` : `records` entre 1 et `MAX_SAFE_INTEGER`, segments croissants, < `head.segment`. **Une entrée `closed` à 0 enregistrement est refusée.** |
| `docs/adr/0011-synchronisation-icloud.md` §21 point 2 (l. 1309 (iii), 1311, 1319, 1326) | « Sans entrée : règle actuelle, inchangée » ; test exigé « `records` à 0 → refusé ». §21 point 2 (iii) décrit déjà l'attente sans fin d'un segment clos à ligne incomplète et ne l'a réglée que pour un segment avec entrée. |
| `tests/fixtures/sync/closed-segments.json:61-67` | le cas « aucune entrée, ligne incomplète : règle d'aujourd'hui (attente) » attend `cloud-pending`, curseur `(1, 3)` : c'est lui qui change (voir critère 1). |
| `src/sync/reader.ts:132, 190` | ne fait que traduire `cloud-pending` ; la décision est dans Rust (`read_journal`) et son faux `src/platform/sync/memory.ts`. |
| `src/sync/engine.ts:860, 1059-1068` | un statut `cloud-pending` ajoute `<appareil>/<époque>` à `pending` et gèle `lastSyncAt`. |
| `src/features/sync/syncText.ts:152-156, 184-187` et `src/domain/sync/limits.ts:104` | `waitingLong` : au bout de 24 h (`WAITING_ICLOUD_LONG_MS`) la ligne de Réglages passe à « Synchro incomplète depuis plus de 24 h, en attente d’iCloud : vérifiez ... » (`fr.syncEngine.ts:22-24`, texte selon la plateforme) ; `pendingOne` / `pendingMany` (`fr.syncEngine.ts:79-80`) listent « N fichier(s) en attente d’iCloud ». |

**Verdict sur la visibilité** : le blocage réel est visible, mais seulement après 24 h et avec un texte qui renvoie à iCloud alors que la cause est un fichier tronqué. C'est pourquoi la correction porte sur la cause, pas sur un message de plus. Un segment réellement en téléchargement garde exactement ce comportement (critère 5).

## Décisions retenues

**D1. Règle : tolérance du lecteur seule, aucun changement de format.** Un segment `k` est tenu pour abandonné et le lecteur passe à `k + 1` lorsque, à la fin de ses lignes complètes :

- `k < head.segment` (la tête authentifiée de l'appareil est dans un segment plus grand : son auteur a ouvert un segment suivant) ;
- aucune entrée `closed` n'annonce `k` ;
- le fichier a été lu avec succès (hydraté, en-tête authentifié par `check_header`) et finit sur une ligne incomplète (`partial_tail`).

Les lignes complètes de `k` sont lues d'abord et appliquées normalement ; seule la ligne incomplète, que personne n'a jamais annoncée, est abandonnée (l'ajout qui l'a écrite n'a pas été enregistré par Rust, ses entrées de file sont republiées dans le segment suivant, ADR 0011 §21 point 2).

**D2. Écart avec la piste de la revue, à signaler (et pourquoi).** La piste proposait que Rust ferme à son tour les segments intermédiaires « à 0 enregistrement ». Ce n'est pas retenu :

1. une entrée `closed` à 0 est **refusée par le schéma** (`closed_is_valid`, ADR 0011 §21 : « `records` ≥ 1 », test exigé « `records` à 0 → refusé ») ; l'écrire ferait refuser l'état par Rust lui-même ;
2. l'autoriser (`records` ≥ 0) est une extension du texte publié après l'association du premier iPhone : elle suit l'ADR 0011 §7.2 (majeure, ou champ que toutes les versions en service savent déjà ignorer) et ferait déclarer l'appareil `corrupt` (bandeau `device-corrupt`) par toute version en service qui lit cet état ;
3. même sans cela, la fermeture côté Rust ne débloquerait pas les états déjà publiés dans iCloud (l'ancien code ne les refermera jamais) : la tolérance du lecteur est de toute façon nécessaire, et elle suffit.

**Alternative écartée et conservée** : fermer à 0 reste possible plus tard par une story de format (§7.2) si Ali veut un état qui nomme explicitement les segments abandonnés ; rien dans cette fiche ne l'empêche.

**D3. `append_journal` ne change pas** (le test de non-régression du critère 8 le fige). `reader.ts` ne change pas non plus : le faux `memory.ts` change avec Rust parce que la fixture est partagée.

**D4. Ce qui reste volontairement hors de la tolérance** : un segment dans le nuage ou absent (reste `cloud-pending`), un segment de tête (`head.record` fait foi), un segment sans ligne incomplète mais avec moins de lignes qu'annoncé par une entrée (reste `cloud-pending`, ADR §21), une ligne complète indéchiffrable (reste `truncated`).

**D5. Risque résiduel, assumé et écrit** : un segment clos sans entrée dont la dernière version, livrée plus tard par iCloud, aurait des lignes complètes de plus qu'une version ancienne finissant en ligne incomplète serait sauté une fois. La lecture hydratée (`store.rs:948`) rend ce cas improbable (iCloud livre des fichiers entiers, pas des octets en cours) et les états écrits depuis Y-TECH-02 portent une entrée qui l'exclut. Le saut est journalisé (`segment-tail-skipped`, critère 11) pour qu'une divergence soit retrouvable.

**D6. ADR** : avenant **§33** de `docs/adr/0011-synchronisation-icloud.md` (prochain numéro libre ; §27 reste réservé à Y-IOS-07, §31 à Y-FIX-03) : amende §21 point 2 (iii) et la ligne « Sans entrée : règle actuelle, inchangée » pour le seul cas « ligne incomplète sous une tête plus grande » ; écrit D1 à D5 ; ligne dans `docs/decisions.md`. À écrire **avant** le code (sous-tâche 1).

## Critères testables

Identifiants **C1 à C14**. Rouge avant : C1, C2, C3, C4, C11 et C12 (et la lecture de C9) doivent échouer sur le code actuel de `read_journal`, avec l'assertion exacte indiquée, avant tout correctif ; C5 à C8, C10 et C13 sont des non-régressions vertes avant et après.

**Table partagée** `tests/fixtures/sync/closed-segments.json` (rejouée par `src-tauri/tests/desktop/sync_closed_segments.rs` et `tests/unit/sync/closedSegments.test.ts`) :

- **C1. Étant donné** un appareil dont l'état n'a aucune entrée `closed`, un segment 1 de 3 lignes complètes suivies d'une ligne incomplète, un segment 2 de 2 lignes, tête `(2, 2)`, **quand** le lecteur part de `(0, 0)`, **alors** statut `complete`, 5 enregistrements, curseur `(2, 2)`. Le cas existant « aucune entrée, ligne incomplète : règle d'aujourd'hui (attente) » (`cloud-pending`, `(1, 3)`, 3 enregistrements) est **réécrit** avec ce résultat. Rouge avant : le lecteur rend `cloud-pending`, curseur `(1, 3)`.
- **C2. Étant donné** le cas exact de B18 : segment 1 réduit à son en-tête et à une demi-ligne (0 ligne complète), segment 2 de 2 lignes, tête `(2, 2)`, aucune entrée, **quand** le lecteur part de `(0, 0)`, **alors** `complete`, 2 enregistrements, curseur `(2, 2)`. Rouge avant : `cloud-pending`, curseur `(1, 0)`, 0 enregistrement. (Ajouter à la fixture un segment `{ "written": 0, "partial": true }` si le constructeur de la fixture ne le permet pas encore.)
- **C3. Étant donné** le cas général : entrée `{ 1, 3 }`, segment 1 de 3 lignes, segment 2 tronqué (1 ligne complète puis ligne incomplète, jamais enregistré, sans entrée), segment 3 de 2 lignes, tête `(3, 2)`, **quand** le lecteur part de `(0, 0)`, **alors** `complete`, 6 enregistrements, curseur `(3, 2)`.
- **C4. Étant donné** un curseur déjà posé par l'ancien code sur le segment bloqué (état réel d'un PC en attente : curseur `(1, 3)`, tête `(2, 2)`), **quand** le lecteur reprend, **alors** il atteint `(2, 2)` au premier cycle, sans réassociation ni réinitialisation (déblocage sur place des PC déjà coincés).
- **C5. Étant donné** le même état que C1 mais le fichier du segment 1 resté dans le nuage (`"cloud": true`), **quand** le lecteur lit, **alors** `cloud-pending` (curseur sur le premier enregistrement non lu) : aucun saut sans lecture hydratée. Non-régression (vert avant et après).
- **C6. Étant donné** une entrée `{ 1, 3 }` et seulement 2 lignes complètes dans le segment 1, **quand** le lecteur lit, **alors** `cloud-pending`, curseur `(1, 2)`, jamais le segment 2. Non-régression d'ADR §21 (cas existant, inchangé).
- **C7. Étant donné** le segment de tête avec ligne incomplète et moins de lignes complètes que `head.record`, **quand** le lecteur lit, **alors** `cloud-pending` (jamais de saut au-delà de la tête). Cas existants « segment de tête » inchangés.
- **C8. Étant donné** une ligne complète indéchiffrable (rang < nombre de lignes complètes) dans un segment tronqué sans entrée, **quand** le lecteur lit, **alors** `truncated` à ce rang, rien au-delà : la tolérance ne masque jamais une corruption.

**Rust, `append_journal`** (`src-tauri/tests/desktop/sync_store.rs`) :

- **C9. Étant donné** `own.segment = 0`, un segment 1 tronqué sur disque (ligne incomplète, non enregistré), **quand** `append_journal` ajoute au segment 2 (`expect_records` 0), **alors** l'ajout réussit, `own.closed` reste vide, `closed_is_valid(&own.closed, own.segment)` est vrai, et le fichier d'état écrit ensuite est accepté tel quel par le lecteur (aller-retour `write_state` puis `read_journal` du PC). Figé : aucune entrée à 0. Vert avant et après pour la partie append ; rouge avant sur la lecture qui suit (C2).
- **C10. Étant donné** `own.segment = 1`, `own.record = 3`, un segment 2 tronqué non enregistré, **quand** `append_journal` ajoute au segment 3, **alors** `own.closed == [{ 1, 3 }]` exactement (le segment 2 n'a pas d'entrée), `own.segment == 3`.

**Banc (extension du critère 5 de Y-FIX-02, côté PC)** :

- **C11. Étant donné** le scénario de `tests/unit/sync/firstPublicationCrashPoints.test.ts` (iPhone, première publication coupée au point `partialLastLine`, puis redémarrage et nouvel ajout), **quand** le PC (lecteur, `tests/sim` à deux appareils) enchaîne des cycles jusqu'au calme, **alors** : (a) l'ensemble des identifiants d'enregistrements reçus par le PC est **égal** à l'ensemble de ceux de l'iPhone (aucun perdu, aucun doublon) ; (b) la phase du PC n'est pas `waiting-icloud` et `pendingFiles` est vide ; (c) `lastSyncAt` du PC avance au dernier cycle ; (d) le journal du PC contient un événement `segment-tail-skipped` avec le seul numéro de segment (pas de contenu, pas de clé). Rouge avant : le PC reste en `waiting-icloud` avec `pendingFiles` non vide et reçoit 0 enregistrement de l'iPhone. Une variante du même test avec `own.segment >= 1` (cas général, C3 au niveau moteur).
- **C12. Étant donné** le test C11 rejoué sur 20 cycles supplémentaires après le déblocage, **alors** aucun nouvel `segment-tail-skipped` (le saut a lieu une fois par segment, curseur définitivement passé) et l'état du PC ne change plus.

**Visible (échec silencieux)** :

- **C13. Étant donné** un segment réellement non disponible (fichier dans le nuage, C5) pendant plus de 24 h simulées (horloge injectée), **quand** l'état est calculé, **alors** la ligne de Réglages affiche `sync.status.waitingIcloudLong*` selon la plateforme et Détails liste « 1 fichier en attente d’iCloud » (`pendingOne`). Ces tests existent déjà (`src/features/sync/waitingLong.test.tsx`) : vérifier qu'ils sont verts et que l'un d'eux part d'un lecteur à `cloud-pending` issu du cas C5, sinon l'ajouter. Aucun texte nouveau, aucun texte en dur.

**Qualité** :

- **C14. Lint et typage propres ; Rust `cargo clippy` propre ; `cargo test --test desktop --features test-hooks` vert ; module synchro Vitest vert.** Taille : `reader.ts` (dans le bundle de départ) n'est pas modifié ; le plafond de 358 400 octets reste inamovible, net ≤ 0 ; si un fichier du départ change malgré tout, mesurer `startBundle.test.ts` avant tout push et s'arrêter en cas de dépassement.

## Hors périmètre

- **Y-IOS-07** : la rotation vers `max + 1` quand le segment de tête est évincé par iOS (`cloud-pending` à l'ajout, `publisher.ts:450`, ADR 0011 §27 réservé) est une autre story ; ne pas y toucher. La présente story ne change ni le chemin d'écriture ni le moteur de publication.
- **Y-FIX-02** : la publication du premier état, `inflight`, la tête locale comme borne.
- **Y-FIX-03** : une lecture en échec (`io`, `bad-header`) n'est plus muette (avertissement par appareil) ; le texte d'attente de 24 h reste tel quel ici.
- Format publié : aucun changement (`closed` à 0, `sm`, `sv`, schéma) ; un éventuel état qui nomme les segments abandonnés serait une story de format (§7.2).
- Réparer ou supprimer le fichier tronqué dans iCloud (purge, `sync_delete_own`) : inchangé.

## Plan (ordre des sous-tâches)

1. **ADR 0011 §33 et `docs/decisions.md`** (architect, avant tout code) : D1 à D6. Mise à jour d'une phrase de §21 point 2 (iii).
2. **Rouge** (qa-test + sync-icloud) : fixture `closed-segments.json` (C1 réécrit, C2, C3, C4, C5, C7, C8) ; test C9 et C10 ; scénario C11 étendu sur `firstPublicationCrashPoints.test.ts` ; lancer, constater les échecs listés ; **commit du rouge seul** (identifiant de commit noté dans la fiche) et run CI du rouge si possible.
3. **Rust** (desktop-tauri) : `read_journal`, branche « ligne absente » : retirer la condition `!file.partial_tail` pour un segment sans entrée sous une tête plus grande, écrire l'événement `segment-tail-skipped` (numéro de segment seulement) ; `append_journal` inchangé.
4. **Faux TypeScript** `src/platform/sync/memory.ts` : même règle, même événement ; `closedSegments.test.ts` vert sur la même fixture.
5. **Vert** : C1 à C12 verts ; C13 vérifié ; lint, typage, clippy.
6. **Vérifications locales du module seulement** ; suite complète dans la CI de la branche (CLAUDE.md, méthode du 2026-10-08).
7. **Revue** (code-reviewer) ; correctifs ; fiche mise à jour (Preuves) ; audit B18 passé à « corrigé » ; backlog.

## Vérifications

- Local : `cargo test --test desktop --features test-hooks` (sync_closed_segments, sync_store) ; `npx vitest run tests/unit/sync src/platform/sync src/features/sync/waitingLong.test.tsx` ; `npm run lint` ; `npm run typecheck`.
- CI : statut « suite verte » sur la branche avant fusion ; aucune compilation iPhone n'est nécessaire (aucun fichier Swift ni iOS touché), à confirmer à la revue.
- Bundle : voir C14.
- Jamais de test désactivé ni de délai allongé ; tout dépassement de durée sous charge est noté au journal avec sa cause.

## Preuves

Commits : ADR 0011 §33 `0a4a75c6` (avant le code) ; **rouge seul `89d5ef7d`** ; **vert `528bb5f2`** (correctif Rust `read_journal` et faux `memory.ts`) ; C13 `253bed8d`. Aucun run CI (pas de push, consigne).

| Critère | Rouge avant (commit, assertion) | Vert après (commit) | Run CI |
| --- | --- | --- | --- |
| C1 | `89d5ef7d` ; Rust `sync_closed_segments` : « assertion `left == right` failed: aucune entrée, ligne incomplète sous une tête plus grande ... (Y-FIX-05 C1) ; left: "cloud-pending", right: "complete" » ; Vitest : cloud-pending, (1, 3), 3 | `528bb5f2` | à faire |
| C2 | `89d5ef7d` ; Vitest : cloud-pending, (1, 0), 0 (Rust : même table, arrêtée au premier cas rouge, C1) | `528bb5f2` | à faire |
| C3 | `89d5ef7d` ; Vitest : cloud-pending, (2, 1), 4 | `528bb5f2` | à faire |
| C4 | `89d5ef7d` ; Vitest : cloud-pending, (1, 3), 0 | `528bb5f2` | à faire |
| C5 | non-régression, verte avant (`89d5ef7d`) | `528bb5f2` | à faire |
| C6 | non-régression (cas existant inchangé), verte avant | `528bb5f2` | à faire |
| C7 | non-régression (cas ajouté), verte avant | `528bb5f2` | à faire |
| C8 | non-régression (cas ajouté), verte avant | `528bb5f2` | à faire |
| C9 | `89d5ef7d` ; partie append verte ; lecture du PC : left ("cloud-pending", RecordCursor { segment: 1, record: 0 }, 0), right ("complete", RecordCursor { segment: 2, record: 2 }, 2) | `528bb5f2` (et `sync:segment-tail-skipped 1` capturé) | à faire |
| C10 | `89d5ef7d` ; partie append verte (`own.closed == [(1, 3)]`) ; lecture ajoutée, rouge : left ("cloud-pending", RecordCursor { segment: 2, record: 1 }, 4), right ("complete", RecordCursor { segment: 3, record: 2 }, 6) | `528bb5f2` | à faire |
| C11 | `89d5ef7d` ; « expected Set{ '7a000001-…' } to deeply equal Set{ …(4) } » (le PC ne reçoit rien de l'iPhone) ; variante own.segment ≥ 1 : « expected Set{ …(2) } to deeply equal Set{ …(3) } » | `528bb5f2` | à faire |
| C12 | `89d5ef7d` (même test que C11, non atteint) | `528bb5f2` | à faire |
| C13 | test ajouté dans `firstPublicationCrashPoints.test.ts` (`253bed8d`), vert sur le faux d'avant le correctif et après | `253bed8d` | à faire |
| C14 | sans objet | lint, typage propres ; `cargo test --test desktop --features test-hooks` : 800 passés, 0 échec, 2 ignorés (préexistants) ; Vitest du module (`src/sync src/platform/sync tests/unit/sync tests/fixtures waitingLong`) : 1 743 / 1 744, l'échec étant un délai de 5 s dépassé sous charge par `epochCarryReplacedParent` critère 4 (5 030 ms, hors story, vert seul : 14/14) ; `test:bundle` 27/27 (`memory.ts` hors du build livré, `reader.ts` inchangé, départ non touché) | à faire |

## Écarts

1. **Piste de la revue écartée** (fermeture à 0 par Rust) : raison de schéma (D2), inchangé.
2. **C2 construit par une panne réelle** : la fixture gagne un champ `cut` (ajout coupé par `partialLastLine`, refusé en `io`, jamais enregistré) au lieu de `{ "written": 0, "partial": true }` : même fichier (en-tête et une demi-ligne), produit par le même mécanisme que B18. Champ `readFaults` ajouté pour C5 (téléchargement en échec), car les deux faux téléchargent un fichier `cloud` sans panne armée. Les deux exécutants de la table (`sync_closed_segments.rs`, `closedSegments.test.ts`) lisent ces champs.
3. **Journal du saut côté TypeScript** : le journal natif de Rust (`log::event`) n'est pas le journal du moteur ; le faux `memory.ts` tient le sien (`testing.nativeEvents()`, crochet de test ajouté au commit rouge, sans comportement) et C11 (d) le lit. Rust : `sync:segment-tail-skipped <n>` (en production, l'identifiant seul, ADR 0014).
4. **C13 placé dans `firstPublicationCrashPoints.test.ts`** et non dans `src/features/sync/waitingLong.test.tsx` (dossier de Y-FIX-03). **Constat** : pour un seul segment en attente, `pendingFiles` du PC contient deux entrées (le fichier et « appareil/époque », `engine.ts`) : Détails afficherait « 2 fichiers en attente d’iCloud » au lieu de `pendingOne`. Défaut d'affichage préexistant, hors périmètre (moteur), non corrigé : à trancher (Y-FIX-03 ou story dédiée).
5. **`cargo clippy -D warnings`** échoue sur des fichiers non touchés (`src/backup.rs`, `src/sync/mod.rs:219`, avertissements de tests existants) ; aucun avertissement dans `store.rs`, `sync_store.rs`, `sync_closed_segments.rs`. La CI ne lance pas clippy.
6. Signature des commits : `Co-Authored-By: Claude Opus 5.5` (consigne de l'environnement), non la ligne demandée par le coordinateur.

## Fichiers modifiés

- `src-tauri/src/sync/store.rs` (`read_journal`, branche « ligne absente »)
- `src/platform/sync/memory.ts` (même règle, journal natif `nativeEvents`)
- `tests/fixtures/sync/closed-segments.json` (C1 réécrit, C2 à C5, C7, C8 ; champs `cut`, `readFaults`)
- `src-tauri/tests/desktop/sync_closed_segments.rs`, `tests/unit/sync/closedSegments.test.ts` (exécutants de la table)
- `src-tauri/tests/desktop/sync_store.rs` (`y_fix_05_c9_*`, `y_fix_05_c10_*`)
- `tests/unit/sync/firstPublicationCrashPoints.test.ts` (C11, variante, C12, C13)
- `docs/adr/0011-synchronisation-icloud.md` (§33, renvoi depuis §21 point 2), `docs/stories/Y-FIX-05.md`, `docs/journal.md`

## Questions à Ali

Aucune bloquante. Un seul point d'information : la règle retenue ne publie rien de nouveau (pas d'état, pas de format) ; si vous préférez que Rust nomme les segments abandonnés, il faut une story de format (§7.2) qui rendrait les anciennes versions `corrupt` jusqu'à leur mise à jour.

## Reprise Codex du 2026-10-19 — passes séparées

- Product-owner : critères C1 à C14 relus ; lecteur seul, format inchangé. B18 reste ouvert tant que les écarts de validation ne sont pas levés.
- Module : diff Rust et faux TypeScript relus ; hydratation, tête authentifiée et entrées `closed` restent les gardes du saut. Aucun code modifié.
- QA : `npx vitest run --coverage.enabled=false tests/unit/sync/closedSegments.test.ts tests/unit/sync/firstPublicationCrashPoints.test.ts src/features/sync/waitingLong.test.tsx` : 47 tests verts, 3 fichiers, 39,82 s. CI complète avec couverture : runs 39139398906 et 39139403003 verts sur `a0b725d8`. Ces résultats ne lèvent pas les écarts C13/C14 consignés ci-dessus.
- Revue distincte : non approuvée pour clôture ; C13 ne prouve pas le compte exact affiché et C14 garde des écarts historiques. Mentions prématurées « fait » retirées de B18 et du backlog. Aucun test désactivé, délai allongé ni seuil abaissé.

## Complément de QA et revue du 2026-10-19

- C13 : preuve rouge `b1253508`, l'écran Détails affiche deux fichiers pour un segment et son marqueur appareil/époque. Correctif `15b8cab1` : les marqueurs sont remplacés dans le compte par leurs fichiers détaillés. Le scénario moteur C5 après 24 h vérifie aussi le compte exact ; le test d'écran vérifie le texte `pendingOne`. Les attentes distinctes, les doublons et les préfixes proches sont couverts : 55 tests ciblés verts, 5 fichiers. Aucun nouveau texte ni module de départ.
- Rust : 6 tests `sync_closed_segments` et 2 tests C9/C10 verts. Clippy vérifié avec `-- -D warnings` : vert après retrait des avertissements préexistants (documentation, conversions identiques, alias de types de tests et formes équivalentes d'assertions). Aucune attente modifiée, aucun test désactivé.
- Non-régression des fichiers Rust touchés par le nettoyage Clippy : 125 tests verts (sauvegarde, journal, export, OCR et synchro). Aucun avertissement Clippy ne subsiste ; les messages de création de bibliothèques du lieur ne sont pas des diagnostics Clippy.
- Lint et typecheck verts ; bundle : 27 tests verts, plafond inchangé. La suite complète avec couverture reste exigée en CI sur le commit à fusionner.
- Revue distincte : diff du lecteur, faux, fixture et tests relu ; les gardes de tête authentifiée, hydratation et `closed` empêchent un saut hors des conditions prévues. Le double compte C13 est corrigé dans l'écran à la demande, sans modifier le moteur ni la publication. Les corrections Clippy n'affectent pas les décisions métier. Revue approuvée, sous réserve de la suite verte du commit final ; B18 n'est pas clos avant celle-ci.
- Après rebase sur #62 fusionnée : 101 tests ciblés verts sur 7 fichiers (scénarios de #62 inclus), bundle 27/27 vert. Conflits limités au journal, résolus en gardant les deux stories et les bons identifiants de preuve ; diff final relu, aucun conflit de code. Revue maintenue approuvée ; suite CI finale requise.
