# TRI-22 — Une transaction perdue ne laisse plus la garde de synchro posée (audit 1.0, important « transaction-lost laisse sync_guard »)

Module : M16 transverse (pilote SQL) avec M15 · Palier : avant la 1.0 (arbitrage d'Ali du 2026-10-30, deuxième des cinq) · Agent : data-model + sync-icloud · Ouverte le 2026-10-30 par Claude Code. Tri : `docs/audits/2026-10-30-tri-importants.md`, ligne TRI-22.

Statut : **code, tests, lint, typage, bundle et revue verts en local ; CI complète à attendre avant fusion.** Estimation : 5 h (audit : 6 à 8 h pour trois volets) ; réel : environ 3 h.

## Origine

Le plugin SQL de Tauri peut remplacer la connexion en pleine transaction (ping en échec côté sqlx). Les instructions suivantes sont alors validées une à une, et `COMMIT` / `ROLLBACK` répondent « no transaction is active ». Le pilote rendait déjà l'échec visible (`transaction-lost`, 0.2.2). Restait la conséquence d'Ali : une transaction **gardée** (`guarded`, `sync_guard`) qui échoue après la pose de la garde la laisse en base. Tant qu'elle y est, les déclencheurs de capture sont coupés : **les écritures locales n'entrent plus dans `sync_outbox` et ne partent jamais vers l'autre appareil**, sans signe, jusqu'au redémarrage (`assertGuardEmpty` ne tourne qu'au démarrage, `bootstrap.ts`).

## Critères

1. Quand une transaction se termine par un `COMMIT` perdu, ou par une erreur dont le `ROLLBACK` répond « no transaction is active », le pilote retire la garde (`DELETE FROM sync_guard`) **avant de rendre la file** : aucune écriture d'un autre appelant ne passe sous une garde orpheline.
2. L'erreur d'origine (ou `transaction-lost`) reste rendue telle quelle ; l'échec du retrait ne la masque pas.
3. Une transaction annulée normalement n'émet aucune instruction sur `sync_guard`.
4. Le correctif est dans le pilote parce qu'il couvre toutes les transactions (`guarded`, migrations sous garde, réintégration des champs inconnus), pas seulement `guarded`.

## Périmètre : ce qui est traité et ce qui ne l'est pas

Traité : le volet (b) de l'audit, celui d'Ali. Non traités, volontairement : (a) migration à moitié appliquée rejouée : l'écran d'échec d'ouverture de la base est déjà visible et nommé, aucune écriture silencieuse ; (c) lot de synchro à moitié appliqué sans curseur : rejoué à l'identique au cycle suivant (opérations idempotentes). Le bandeau « pilote dégradé, rechargement conseillé » de l'audit n'est pas ajouté : l'échec de la transaction est déjà rendu à l'appelant, donc visible comme une erreur de cycle.

## Preuves

- **Rouge** : `98fe7d5c` (tests seuls) : `src/db/serializedDriver.test.ts`, bloc « TRI-22 », deux tests rouges (erreur du travail puis ROLLBACK sans transaction ; COMMIT perdu : `DELETE FROM sync_guard` jamais envoyé), deux garde-fous verts (échec du retrait ne masque pas l'erreur ; annulation normale sans instruction sur la garde).
- **Vert** : `src/db/serializedDriver.ts` : le `ROLLBACK` est lu (réussi ou « no transaction is active »), `lost` est posé par le `COMMIT` perdu, puis `DELETE FROM sync_guard` best-effort avant de relancer l'erreur. L'ancien oracle exact du test `transaction-lost` est complété de cette dernière instruction (la séquence reste exacte).
- **Module** : `src/db` : 50 fichiers, 274 tests verts. Module synchro (`tests/unit/sync` et `src/sync`) : **1 612 verts sur 1 613** ; le seul échec est `forgetScope.test.ts` « seul tauriSync.ts invoque une commande sync_* », un dépassement des 5 s par défaut : ce test lit tous les fichiers de `src/` (environ 1 s à vide) et tournait avec deux workers sur une machine sous pression mémoire. Relancé seul : 4 sur 4 verts en 2,4 s. Aucun délai modifié ; aucun lien avec le pilote SQL ; la CI tranche. Typage (`tsc --noEmit`) vert. Lint des deux fichiers vert.
- **Bundle** (build `--manifest`, `measureStart.ts`) : **338 023 normalisés**, marge 20 377, **+0** face à `main` après TRI-03 (338 023) ; plafond 358 400 inchangé, aucun module nouveau.

## Passes

- **Product-owner** : critères 1 à 4 relus contre la demande d'Ali (« des écritures locales qui ne partent jamais »).
- **Agent du module** : voir Preuves.
- **QA** : le pilote est commun à toute l'app : `src/db` entier (274 tests) et le module synchro (1 612 sur 1 613, voir plus haut) sont verts. Les quatre cas du bloc TRI-22 couvrent erreur du travail, COMMIT perdu, échec du retrait et annulation normale. Non couvert, par construction : la connexion réellement remplacée par sqlx (aucun faux ne la reproduit) ; la preuve est la séquence d'instructions envoyée au pilote.
- **Revue de code (à froid)** : diff de `serializedDriver.ts` relu seul : `lost` n'est posé que par le COMMIT « no transaction is active » ; le ROLLBACK est toujours émis comme avant, son échec est lu au lieu d'être avalé ; le retrait est best-effort (table absente avant la migration 0015, connexion morte : l'erreur d'origine est rendue dans tous les cas) ; il part dans le créneau de la file, donc avant tout autre appelant. Risque examiné : un retrait qui supprimerait une garde légitime : les transactions ne s'imbriquent pas et la file est série, donc la seule garde présente est celle de la transaction perdue. Approuvée, sous réserve de la CI complète.
