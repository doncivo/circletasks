# TRI-03 — Un état refusé juste après un instantané n'est plus ignoré (audit 1.0, important « writeState refusé en silence »)

Module : M15 Synchronisation · Palier : avant la 1.0 (arbitrage d'Ali du 2026-10-30, priorité absolue des cinq) · Agent : sync-icloud · Ouverte le 2026-10-30 par Claude Code. Tri : `docs/audits/2026-10-30-tri-importants.md`, ligne TRI-03.

Statut : **code, tests, lint, typage, bundle et revue verts en local ; CI complète à attendre avant fusion.** Estimation : 3 h ; réel jusqu'ici : environ 1 h 30. Point de contrôle des sept défauts du lot : 12 h cumulées.

## Origine

L'audit du 2026-10-16 relevait que `writeState` rendait faux sur `state-mismatch` (hypothèse refusée par Rust, maître) sans que l'étape 6 du cycle en tienne compte : « À jour · à l'instant » alors que rien n'était annoncé. Y-IOS-02-FIX-02 a corrigé l'étape 6 (`publish-blocked`, ADR 0011 §24 point 10 (a)). Relecture du 2026-10-30 de tous les appelants de `writeState` dans `engine.ts` : la reprise d'une intention d'ajout (`resolveInflight`) utilise le retour ; l'étape 6 l'utilise ; **l'écriture de l'état juste après un instantané (étape 7) l'ignorait**. Dans ce cas : « snapshot-written » journalisé, aucun avertissement, `lastSyncAt` avancé.

## Critères

1. Un `writeState` refusé après l'écriture d'un instantané (`state-mismatch`, ou plus de 64 accusés) lève `publish-blocked` pendant ce cycle, avec la même cause nommée (`state-refused`) que l'étape 6.
2. Un état accepté après l'instantané ne lève rien (pas d'avertissement permanent).
3. Aucun autre appelant de `writeState` n'ignore son retour (relecture consignée ci-dessus).

## Preuves

- **Rouge** : `136fb2e2` (test seul) : `tests/unit/sync/writeStateAfterSnapshot.test.ts`, test « le refus est visible » ; échec constaté : `expected [] to include 'publish-blocked'`, alors que `write-state-failed` et `snapshot-written` sont journalisés.
- **Vert** : correctif d'une ligne dans `src/sync/engine.ts` (`if (!(await writeState(…))) await deferPublish(true)`) ; test vert, et son pendant « état accepté » vert avant comme après.
- **Module** : `tests/unit/sync` et `src/sync` : 143 fichiers, 1 613 tests verts en local. Lint des deux fichiers vert ; typage (`tsc --noEmit`) vert ; le test vérifie aussi la cause nommée (`publish-deferred`, `state-refused`).
- **Bundle** (build `--manifest`, `measureStart.ts`, commit du correctif) : **338 023 normalisés** (338 025 bruts), marge 20 377, **+6 octets** face à `main` 338 017 ; plafond 358 400 inchangé, aucun module nouveau.

## Hors périmètre

Les autres défauts du tri (TRI-22, 24, 80, 13, 06, 04) ont chacun leur fiche. Aucun changement de texte, de schéma ni de format publié.

## Passes

- **Product-owner** : critères 1 à 3 relus contre l'ADR 0011 §24 point 10 (a) ; le refus après instantané doit être aussi visible que celui de l'étape 6.
- **Agent du module** : voir Preuves.
- **QA** : la suite du module est verte ; le test vert n'est pas tautologique (même scénario, rouge sans le correctif). Cas non couvert : plus de 64 accusés après instantané, qui emprunte le même `return false` et la même branche.
- **Revue de code (à froid)** : diff relu sans le souvenir de l'écriture : une ligne dans `engine.ts`, `deferPublish` est dans la portée (déjà utilisé à l'étape 6), il ne peut s'appliquer qu'une fois par cycle (l'étape 7 n'écrit un instantané que si la publication est permise, donc après un étape 6 réussie). Le journal `snapshot-written` reste émis, l'instantané étant bien écrit. Approuvée, sous réserve de la CI complète.
