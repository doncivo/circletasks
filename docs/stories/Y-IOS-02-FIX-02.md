# Y-IOS-02-FIX-02 — Publication bloquée par un instantané orphelin resté dans iCloud

Module : M15 Synchronisation · Ordre de construction : 5 (correctifs de la séance iPhone 0.3.2, **avant REL-01**) · Agents : **sync-icloud** (moteur `src/sync/`, domaine `src/domain/sync/`, journal) et **ios-mobile** (vérification réelle sur l'iPhone, checklist de l'ordre 5) · Relectures : qa-test, code-reviewer · Statut : fait (code), vérification iPhone 0.3.3 en attente (décision d'Ali du 2026-10-16) ; fusionnée dans main (PR #36, suite CI verte), livrée en 0.3.3 PC et iPhone (PR #37, tags v0.3.3 et ios-v0.3.3). Décision d'origine : « corrige cette cause, sans réinitialiser »
Correctif rattaché à **Y-IOS-02** (abandon de l'époque orpheline, ADR 0011 §24 point 4 (e)). Aucun écart au PRD. **Lève le « `canPublish` inchangé » de Y-IOS-02-FIX-01** (fiche du 2026-10-10) : la règle de comptage de `canPublish` change ici, sur décision d'Ali.
Dépend de : Y-IOS-02 (fait), Y-07 (statuts, journal de synchro). Ne bloque aucune autre story ; Y-IOS-02-FIX-01 reste utile et indépendante (affichage d'un échec de suppression).
Code en parallèle dans ce worktree : `src/sync`, `src/domain/sync`, tests et ADR 0011 §24 (avenant) ; cette fiche ne touche que `docs/`.

## Contexte

Séance iPhone 0.3.2 d'Ali du 2026-10-16 (journaux exportés `circletasks-logs-20261016-1401`, lus directement depuis iCloud Drive sur le PC). Résultats : mise à jour 0.3.0 vers 0.3.2 correcte avec données conservées ; roue des heures correcte ; rappel reçu à 14:00 pile ; « Annuler la demande » (Y-10-FIX-01) correct. Reste un blocage de publication.

Cause prouvée. L'iPhone (`ef50b6f7`) a abandonné son époque orpheline `e0001-ef50…` (créée par la 0.2.3) et rejoint l'époque du PC `e0001-56d4…` ; il lit bien le journal du PC. Mais `devices/ef50…/e0001-ef50…/s-00000001.cts` (8 octobre) est **toujours dans iCloud** et `sync_meta.orphanEpoch` est **nul** : le journal de l'iPhone ne contient, depuis le 10 octobre, aucun `orphan-epoch-delete-failed`, `orphan-epoch-deleted` ni `orphan-epoch-cleared`, et ses 82 entrées sont toutes `publish-deferred {"reason":"own-state-unknown"}`. Le mémo a donc été effacé sans que le fichier le soit (chemin `orphan-epoch-cleared` sur un listing iCloud transitoire qui ne montrait pas l'époque, ou suppression locale non propagée par iCloud). `canPublish` (`src/domain/sync/epoch.ts`) compte cet instantané dans `listedFiles` (1) ; l'appareil n'a aucun état, aucun accusé, `stateSeq` 0 : la publication est refusée **pour toujours**, avec le seul bandeau « Cet appareil n'a pas encore publié son état », sans cause. Le moteur ne retente rien puisqu'il n'a plus de mémo : la prémisse de Y-IOS-02-FIX-01 (« le moteur retente et journalise ») était fausse dans ce cas réel.

Correctif décidé : (1) règle de comptage de `canPublish` ; (2) réarmement du mémo et suppression de l'orpheline ; (3) cause réelle dans `publish-deferred`. Aucune réinitialisation de la synchro, aucune réassociation.

## Références visuelles

Aucune maquette. Aucun élément visuel nouveau : le bandeau existant « Cet appareil n'a pas encore publié son état » disparaît une fois la publication faite. Relu par Ali sur l'iPhone.

**Périmètre élargi au plugin iOS, cause probable relevée le 2026-10-16** (deuxième relecture, déduite de la lecture du plugin, non prouvée par les journaux, à confirmer sur l'iPhone) : iOS aurait évincé `s-00000001.cts` (« Optimiser le stockage »), seul restait le substitut `.s-00000001.cts.icloud`, listé sous le nom réel ; `remove` du plugin folder-bookmark (`src-tauri/plugins/folder-bookmark/ios/Sources/FolderBookmarkPlugin.swift`) cherchait le nom réel et répondait « rien supprimé », `sync_delete_own` rendait 0, et le moteur journalisait `orphan-epoch-deleted` et effaçait le mémo. Correctif : `remove` supprime le substitut sous la coordination `forDeleting` (`removed: true`), `removeEmptyDir` passe sous `forDeleting` ; faux du plugin (`src-tauri/tests/desktop/support/fake_bookmark.rs`) et test desktop (`sync_publish_bound.rs`). Rust de la synchro (`src-tauri/src/sync/**`) toujours inchangé.

## Critères testables

Tests : Vitest (domaine pur pour `canPublish`, moteur sur faux `SyncFs` et horloge injectée), cargo test pour la parité avec `rebuild_own` (lecture seule, aucune modification Rust), vérification réelle sur l'iPhone (checklist de l'ordre 5) ; aucun parcours e2e `iphone` : le simulateur actuel ne peut pas reproduire un fichier iCloud orphelin. Références : ADR 0011 §24 point 4 (e) et son avenant de cette story.

### Règle de comptage (domaine)

1. **Étant donné** un appareil sans état propre, sans accusé et `stateSeq` 0, dont le seul fichier listé est un **instantané** (`s-*.cts`) d'une époque **non courante**, jamais annoncée et sans source authentifiée (même règle que `rebuild_own` en Rust), **quand** `canPublish` est évalué, **alors** cet instantané **ne compte pas** dans `listedFiles` et la publication est autorisée.
2. **Étant donné** des **segments** (`j-*`/journaux) listés, de **n'importe quelle époque**, **alors** ils comptent toujours (inchangé) et bornent la publication comme avant.
3. **Étant donné** un instantané de l'**époque courante**, **alors** il compte toujours (inchangé).
4. **Étant donné** une époque non courante **annoncée** (par un autre appareil ou par une source authentifiée) dont l'instantané est listé, **alors** cet instantané compte (la règle 1 ne s'applique qu'aux époques jamais annoncées) ; test par cas : annoncée / non annoncée, instantané seul / instantané plus segment, époque courante / non courante.
5. **Alors** la règle de `canPublish` est écrite **une seule fois** dans `src/domain/sync/epoch.ts` (aucun doublon dans le moteur) et un test de parité vérifie qu'elle donne le même verdict que `rebuild_own` (Rust) sur les mêmes cas.

### Réarmement et suppression (moteur)

6. **Étant donné** `sync_meta.orphanEpoch` nul et, dans le listing de l'appareil local, une époque propre **non courante** jamais annoncée dont il ne reste qu'un instantané (critère 1), **quand** un cycle s'exécute, **alors** `orphanEpoch` est **posé** sur cette époque et le journal reçoit `orphan-epoch-relisted` (identifiant d'époque tronqué comme les autres entrées, jamais de chemin ni de contenu).
7. **Alors** `retryOrphanDeletion` supprime ensuite l'époque comme pour une orpheline normale (`orphan-epoch-deleted`, mémo effacé) ; en cas d'échec, `orphan-epoch-delete-failed { code }` est journalisé, le mémo **reste posé** et la suppression est retentée au cycle suivant (comportement actuel).
8. **Alors** le réarmement ne se déclenche **jamais** sur : l'époque courante, une époque annoncée, une époque qui contient un segment, ni sur un dossier d'un **autre** appareil (aucune écriture ni suppression dans `devices/` d'un autre appareil, règle d'écrivain unique, ADR 0011 §1.1).
9. **Alors** un listing iCloud transitoire (époque absente un cycle, présente le suivant) ne provoque ni suppression erronée ni perte : le mémo n'est effacé (`orphan-epoch-cleared`) que par les règles existantes, et si l'époque réapparaît dans un listing, le critère 6 la réarme ; test avec un faux `SyncFs` dont le listing est incomplet puis complet.
10. **Alors** la lecture et la publication ne sont pas retardées par la suppression (comportement actuel de `retryOrphanDeletion`) ; une interruption de cycle (`isCycleInterrupted`) ne compte pas comme échec.

### Journal de report de publication

11. **Quand** `publish-deferred` est journalisé, **alors** il porte la **cause réelle** : le statut de l'état propre (par exemple absent, illisible, en attente de téléchargement), les compteurs utiles (fichiers listés comptés, fichiers ignorés par la règle 1, `stateSeq`), et un `reason` qui n'est plus `own-state-unknown` quand l'état est connu comme absent ; valeurs prises dans une liste fermée, jamais de chemin, de nom de fichier, de clé ni de contenu.
12. *(Hors de cette story, décision du 2026-10-16 : la répétition d'une entrée `publish-deferred` à chaque cycle est le comportement actuel de tous les événements du journal ; une déduplication éventuelle fera l'objet d'une story à part.)*

### Qualité et clôture

13. **Alors** tous les textes éventuels sont dans `src/i18n` (fr et en, parité) ; aucun texte en dur ; aucun journal ni `console.*` ne contient de clé, de titre ni de chemin système ; une écriture de `sync_meta` qui échoue n'est pas avalée (erreur propagée au cycle).
14. **Alors** aucun test ne dépend d'un délai réel (horloge injectée, faux `SyncFs`, aucun `setTimeout` ni `sleep`) ; aucun test désactivé ni allongé.
15. **Alors** la story n'ajoute **aucune migration** ni commande Rust, ne change pas le format sur disque (`sm`, `schema_version`, `hlc`) et laisse `src-tauri/src/sync/**` en lecture seule.
16. **Alors** un **cas de régression reproduit l'état réel** de la séance : appareil `ef50…` sur l'époque `e0001-56d4…`, `orphanEpoch` nul, `devices/ef50…/e0001-ef50…/s-00000001.cts` listé seul, journal du PC lisible, `stateSeq` 0 ; le cycle réarme, supprime, publie son état, et le bandeau disparaît. Preuve : banc Vitest à deux appareils (`tests/unit/sync/pairing/orphanRelisted.test.ts`), test Rust (`src-tauri/tests/desktop/sync_publish_bound.rs`) et vérification réelle sur l'iPhone (checklist de l'ordre 5) ; aucun parcours e2e `iphone` : le simulateur actuel ne peut pas reproduire un fichier iCloud orphelin.
17. **Alors** la story ne passe « fait » qu'avec les critères 1 à 16 verts, Vitest du domaine et du moteur verts, lint et typage propres, le banc Vitest à deux appareils et le test Rust verts, la suite verte en CI, la revue approuvée et les vérifications d'Ali sur l'iPhone.

## Hors de cette story

- Réinitialiser la synchro, réassocier l'iPhone ou effacer des données : exclu par la décision d'Ali (« sans réinitialiser »).
- Afficher un échec de suppression de l'orpheline avec sa cause : reste Y-IOS-02-FIX-01.
- Supprimer un fichier depuis le PC ou depuis un dossier d'un autre appareil : exclu (écrivain unique).
- Comprendre pourquoi le mémo a été effacé (listing transitoire ou suppression locale non propagée) au-delà de la parade du critère 9 : à investiguer à part si le cas se reproduit.
- Changer le format des fichiers de synchro ou de la clé.

## Décisions (options recommandées ; lignes ajoutées à docs/decisions.md)

- D1 — Un instantané seul dans une époque non courante jamais annoncée **ne borne rien** : c'est la même règle que `rebuild_own` en Rust, appliquée à `canPublish`. Les segments bornent toujours. Décidé par Ali le 2026-10-16.
- D2 — Réarmer le mémo à partir du listing (`orphan-epoch-relisted`) plutôt que d'ajouter un chemin de suppression parallèle : une seule voie de suppression (`retryOrphanDeletion`), un seul journal.
- D3 — Pas de nouvelle alerte visible : le bandeau existant disparaît à la résolution ; la cause réelle est dans le journal (critère 11). Si la publication reste refusée pour une autre cause, le bandeau garde son texte actuel : à signaler à Ali et à instruire séparément, pas à masquer.

## Fichiers

`src/domain/sync/epoch.ts` (`canPublish`, `listedFiles`) ; `src/sync/orphanEpoch.ts` (réarmement, `orphan-epoch-relisted`) ; `src/sync/engine.ts` ou module de publication (cause de `publish-deferred`) ; `src/sync/meta.ts` (aucune clé nouvelle) ; ADR 0011 §24 (avenant) ; tests `tests/unit/sync/**` et `src/domain/sync/*.test.ts`, test de parité avec `rebuild_own` (`src-tauri/tests/desktop/sync_publish_bound.rs`, table `tests/fixtures/sync/publish-bound.json`).
**Lus, jamais modifiés** : Rust (`src-tauri/src/sync/**`, y compris `rebuild_own`).

## Ordre des sous-tâches

1. sync-icloud (domaine) : règle de comptage de `canPublish` et tests de cas (critères 1 à 5).
2. sync-icloud (moteur) : réarmement `orphan-epoch-relisted`, suppression par `retryOrphanDeletion`, protection contre le listing transitoire (critères 6 à 10).
3. sync-icloud (journal) : cause réelle de `publish-deferred` (critère 11) ; cas de régression de la séance (critère 16).
4. sync-icloud puis ios-mobile : avenant ADR 0011 §24, vérification réelle sur l'iPhone (checklist de l'ordre 5) ; qa-test ; code-reviewer ; product-owner vérifie critère par critère et clôt (critères 13 à 15 et 17).

## Clôture (product-owner, 2026-10-16)

Statut : **fait (code)** ; **vérification iPhone 0.3.3 en attente** (décision d'Ali du 2026-10-16). La story ne passe pas à « fait » complet tant que les vérifications manuelles ci-dessous ne sont pas consignées par Ali.

Vérification critère par critère :
- **Critères 1 à 5** (règle de comptage) : vérifiés par `src/domain/sync/epochPublishBound.test.ts` (cas annoncée / non annoncée, instantané seul / plus segment, époque courante / non courante) et par la parité avec `rebuild_own` dans `src-tauri/tests/desktop/sync_publish_bound.rs` (table `tests/fixtures/sync/publish-bound.json`).
- **Critères 6 à 10** (réarmement et suppression) : vérifiés par `tests/unit/sync/pairing/orphanRelisted.test.ts` (faux `SyncFs`, horloge injectée, listing transitoire, jamais un autre appareil ni l'époque courante). Ajouts de la revue : réarmement bloqué tant qu'un autre appareil est illisible, `orphan-epoch-already-gone` (fichier déjà absent).
- **Critère 11** (cause réelle de `publish-deferred`) : vérifié par `orphanRelisted.test.ts` ; un état refusé par Rust est rendu visible (`publish-deferred` raison `state-refused` plus `publish-blocked` levé, jamais « À jour »).
- **Critère 12** : hors story (décision du 2026-10-16), non évalué.
- **Critères 13 à 16** (qualité, absence de migration, régression de la séance) : vérifiés par les mêmes fichiers ; le cas de régression de la séance (appareil `ef50…`, `orphanEpoch` nul, instantané seul, `stateSeq` 0) est joué par `orphanRelisted.test.ts` et `sync_publish_bound.rs` ; plugin iOS : faux `src-tauri/tests/desktop/support/fake_bookmark.rs`. Bundle de départ : `tests/bundle/startBundle.test.ts` et `tests/bundle/pairingBundle.test.ts`.
- **Critère 17** : **remplacé** par le banc Vitest à deux appareils, le test Rust et la vérification réelle sur l'iPhone (le simulateur ne peut pas reproduire le fichier iCloud orphelin). Les deux premiers sont verts ; la vérification réelle reste à faire par Ali.

Revue code-reviewer : **trois passes**, approuvée à la troisième. Points traités : réarmement chargé à la demande (bundle de départ ramené de 350,3 à 349,67 Ko après l'incident CI du budget de bundle) ; `pairingStatus` sorti du bundle de départ (`src/features/sync/pairingHub.ts`) ; refus d'état Rust visible (`state-refused`, `publish-blocked`) ; réarmement bloqué tant qu'un autre appareil est illisible ; journal `orphan-epoch-already-gone` ; plugin iOS folder-bookmark qui supprime le substitut `.icloud` (cause probable, **à confirmer sur l'iPhone**, vérification 8). QA approuvée.

Reste à faire par Ali : les vérifications manuelles 1 à 8 ci-dessous sur l'iPhone en 0.3.3. Si la vérification 8 infirme l'hypothèse du substitut, la dette de `docs/dettes.md` reste ouverte.

## Vérifications manuelles d'Ali (iPhone, ordre 5)

1. Mettre à jour l'iPhone avec l'IPA contenant ce correctif (SideStore), sans réassocier ni réinitialiser.
2. Au **premier cycle** de synchro, le bandeau « Cet appareil n'a pas encore publié son état » disparaît.
3. Le PC voit l'iPhone dans la liste des appareils de Réglages > Synchronisation > Détails.
4. Tâche de test : créer une tâche sur le PC, elle apparaît sur l'iPhone ; en créer une sur l'iPhone, elle apparaît sur le PC (les deux sens).
5. Dans l'app Fichiers (iCloud Drive > CircleTasks > devices > dossier de l'iPhone), le fichier `s-00000001.cts` de l'ancienne époque `e0001-ef50…` a **disparu**.
6. Si une tâche du PC manque encore sur l'iPhone, appuyer sur « Lancer une reprise complète » (fusion, rien n'est effacé).
7. Exporter les journaux : on voit `orphan-epoch-relisted`, puis `orphan-epoch-deleted`, et plus aucun `publish-deferred` sur l'orpheline. Consigner dans la checklist de l'ordre 5.
8. **Confirmation de la cause probable** (substitut iCloud) : si le journal montre `orphan-epoch-already-gone` à chaque cycle au lieu de `orphan-epoch-deleted`, ou si le fichier reste visible dans l'app Fichiers au cycle suivant, l'hypothèse est fausse : la dette de `docs/dettes.md` reste ouverte et une nouvelle cause est à chercher (essai suivant : `FileManager.removeItem` sur l'adresse logique dans le bloc `forDeleting`).
