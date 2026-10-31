# TRI-24 — Un enregistrement refusé par la base locale ne bloque plus toute la synchro (audit 1.0, important « un enregistrement fautif bloque toute la synchro »)

Module : M15 Synchronisation · Palier : avant la 1.0 (arbitrage d'Ali du 2026-10-30, troisième des cinq) · Agent : sync-icloud · Ouverte le 2026-10-30 par Claude Code. Tri : `docs/audits/2026-10-30-tri-importants.md`, ligne TRI-24.

Statut : **code, tests, lint, typage, bundle et revue verts en local ; CI complète à attendre avant fusion.** Estimation : 4 h (audit : 3 à 4 h) ; réel : environ 3 h 30.

## Origine

Les opérations reçues sont appliquées par lots de 500 dans une seule transaction (`guarded`). Une opération que la base locale refuse (unicité, NOT NULL, CHECK, clé étrangère : par exemple un enregistrement d'une version plus récente, ou un identifiant naturel mal formé) fait échouer l'`INSERT` simple, donc le lot entier. Le curseur reste avant le lot, qui est rejoué et refusé à chaque cycle : **plus rien d'autre n'arrive** de cet appareil. Constat reproduit par un test rouge : l'iPhone simulé ne reçoit aucune des quatre tâches d'un lot dont une est refusée, ni les suivantes.

## Critères

1. Le lot est d'abord tenté entier dans un point de sauvegarde (cas normal : un seul passage, aucun surcoût d'instructions autre que `SAVEPOINT` et `RELEASE`).
2. Sur une erreur de contrainte (`DbError.code === 'constraint'`) seulement, le lot est annulé puis rejoué opération par opération, chacune dans son point de sauvegarde ; l'opération refusée est écartée, les autres sont appliquées, le curseur avance.
3. Toute autre erreur (verrou, transaction perdue, E/S, syntaxe) est relancée telle quelle : jamais prise pour une donnée fautive.
4. Jamais muet : `apply-rejected` est journalisé (table et code, **jamais le contenu**), le compteur et les tables sont mémorisés dans `sync_meta.applyRejected` (écrit dans la même transaction que le curseur), l'avertissement `received-unapplied` est levé à chaque cycle et survit au redémarrage ; il est effacé par « Lancer une reprise complète » (même acquittement que les traces d'orpheline), qui rejoue les journaux. L'enregistrement reste dans le journal : il n'est pas perdu, il n'est pas appliqué.
5. Les trois chemins d'application sont couverts : lecture des journaux (`reader.ts`), instantanés (`snapshot.ts`), rejeu des opérations mises de côté (`maintenance.ts`). Le report d'époque (`epochSwitch.ts`, une opération à la fois, politique propre) n'est pas modifié.
6. Texte de l'avertissement corrigé (fr et en) : il parlait d'« élément manquant » seulement ; il dit désormais « élément manquant, ou refusé par la base » et propose la reprise complète.
7. Aucun changement de schéma, de format publié ni de bundle notable ; aucune migration (clé de `sync_meta`).

## Hors périmètre

Rendre l'enregistrement refusé réappliquable sans reprise complète (mise de côté durable) : `sync_parked.reason` a une contrainte `CHECK` fermée, donc une migration ; non décidé, à rouvrir si le cas se produit. Le contenu de l'opération n'est jamais écrit dans le journal.

## Preuves

- **Rouge** : `ed3f01ae` (tests seuls) : `tests/unit/sync/applyFaultyRecord.test.ts`, deux tests rouges (reste du lot appliqué + avertissement + journal sans contenu ; synchro qui continue et avertissement après redémarrage), un garde-fou vert (sans refus : aucun avertissement). Échec constaté : `expected [] to deeply equal [ 'Après', 'Avant', 'Doublon' ]` : rien n'arrive, pas même « Avant ».
- **Vert** : `applyOpsIsolated` (`src/sync/apply.ts`), points de sauvegarde `savepoint` / `rollbackToSavepoint` / `releaseSavepoint` ajoutés à `SyncRepository` (noms fixes du code, jamais une donnée reçue), `META.applyRejected`, avertissement et acquittement dans `engine.ts`. Test supplémentaire (ajouté au vert) : un verrou (`busy`) est relancé tel quel, sans `rollback` ni mémorisation. 4 tests verts.
- **Module** : `tests/unit/sync`, `src/sync`, `src/db`, `src/i18n`, `src/features/sync` : **261 fichiers, 2 490 tests verts**. Lint des fichiers modifiés vert ; typage (`tsc --noEmit`) vert.
- **Bundle** (build `--manifest`, `measureStart.ts`) : **338 486 normalisés** (338 429 bruts, écart +57), marge 19 914, **+463 octets** face à `main` 338 023 (trois méthodes de point de sauvegarde, `applyOpsIsolated`, texte) ; plafond 358 400 inchangé, aucun module nouveau dans le départ. La garde `start-modules.json` est jugée par la CI.

## Passes

- **Product-owner** : critères relus contre la demande d'Ali (« un enregistrement fautif qui bloque toute la synchro ») et contre la règle « aucun échec silencieux » (critère 4).
- **Agent du module** : voir Preuves.
- **QA** : chemin normal inchangé (module entier vert) ; les quatre cas du bloc TRI-24 couvrent reste du lot appliqué, synchro qui continue, avertissement après redémarrage, absence de faux positif, et erreur de verrou relancée sans mémorisation. Non couvert : l'erreur de contrainte réelle du plugin Tauri SQL (le faux Wasm la classe par le même texte « constraint failed » ; un message sans ce texte, par exemple un `RAISE` de déclencheur, serait classé `unknown` et resterait bloquant, ce qui est le comportement sûr) ; les trois chemins `snapshot.ts` et `maintenance.ts` passent par la même fonction, sans test d'échec dédié.
- **Revue de code (à froid)** : diff relu sans le souvenir de l'écriture. (1) Chemin normal : deux instructions de plus par lot (`SAVEPOINT`, `RELEASE`). (2) Le `ROLLBACK TO` défait aussi les `park` et `writeClocks` du lot, refaits un par un au rejeu : l'état est celui d'un lot appliqué opération par opération. (3) `outcomes` garde un élément par opération, dans l'ordre : `maintenance.ts` l'indexe par position. (4) Une opération qui dépend d'une opération refusée est mise de côté (`missing-parent`) par la règle ordinaire. (5) Instantané : des lignes refusées sont signalées comme les autres (avertissement + reprise complète) ; le curseur d'un instantané n'existe pas, la ligne reste dans le fichier tant qu'il est conservé. (6) Aucun contenu dans le journal ni dans `applyRejected` (noms de tables du catalogue seulement, 16 au plus). Approuvée, sous réserve de la CI complète.
