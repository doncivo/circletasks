# Reprise par Codex — état exact au 2026-10-19

Écrit à la passation de Claude Code vers Codex (décision d'Ali du 2026-10-19). Règles de travail : `AGENTS.md`. Plan de la 1.0 : `docs/backlog.md` section « Palier 1.0 », audit `docs/audit-1.0.md`, décisions `docs/decisions.md`.

## Mise à jour de reprise du 2026-10-19 — quatre PR fusionnées

La décision d'Ali remplace l'ordre initial ci-dessous : **#62 → #60 → #61 → #63**. Les quatre sont fusionnées après QA, revue consignée et CI complète verte avec couverture : #62 (`c76bc718`), #60 (`1838dbe5`), #61 (`772d0f29`), #63 (`66bf7786`, tête `2bfca264`). Le bundle a été vérifié sur `main` après #62 et #60 (27/27), puis #61 (47/47, **340 810 octets normalisés**, marge **17 590**), puis #63 (**51/51, 340 260 octets normalisés**, brut 340 188, marge **18 140**). R1 est corrigé ; CI finale de #63 : runs **39262885779 et 39262896766**, tous les contrôles verts. Le défaut de réactivité apparu en CI a aussi été corrigé avant fusion (`d947b186`) ; les deux jobs de performance sont verts sur le correctif. Les preuves rouges historiques restent dans les fiches.

Protection classique de `main` : le nombre d'approbations GitHub était déjà zéro ; le PATCH à zéro l'a confirmé. PR, branche à jour et statut obligatoire « suite verte » conservés. La revue distincte reste obligatoire et son approbation est consignée dans la fiche de story : GitHub interdit l'auto-approbation. Règle inscrite dans `AGENTS.md`.

Nettoyage autorisé : inventaire présenté avant suppression, puis **66 worktrees fusionnés et propres supprimés**, avec recontrôle de propreté et d'ascendance juste avant chaque suppression ; aucune branche supprimée. Tous les autres worktrees conservés. `.bt.sh` est un ancien lanceur local de mesure de bundle ; `.bt/` contient son cache Node (189 fichiers, 2 880 908 octets). Ils restent conservés en attendant la décision d'Ali.

Les sections suivantes décrivent le point de départ historique ; leurs PR ouvertes et leur ordre initial ne décrivent plus l'état courant. I-06 reste « code fusionné, en attente de vérification appareil » jusqu'au succès de A1 à A10.

## 1. Point de départ historique

| Élément | Valeur |
| --- | --- |
| `main` | `5bd03d46` (PR #59 SEC-01), CI « suite verte » verte (run 39138955865) |
| Version en service | 0.3.3 PC et iPhone (tags `v0.3.3`, `ios-v0.3.3`) ; `package.json` 0.3.3 |
| Dépôt local | `C:\Dev\circletasks-kit`, sur la branche `passation-codex` (cette documentation, PR à fusionner) ; ~70 worktrees de branches déjà fusionnées sous `.claude/worktrees/` (voir section 7) |
| Appareils | PC `7d0b4a0a-…`, iPhone `ef50b6f7-…` ; ancien PC `56d4eec1-…` oublié le 2026-10-17 (ses sauvegardes du 16 octobre portent encore `is_self = 56d4…`) |
| Journaux | export iPhone dans `C:\Users\SPECTRE\iCloudDrive\CircleTasks\circletasks-logs-*.txt` ; données PC dans `%APPDATA%\fr.circletasks.planner\` (ne jamais y toucher) |

**Le backlog est en retard sur le code.** Lignes encore fausses dans `docs/backlog.md` : REL-TECH-01 « en cours » (fusionnée, PR #31), Y-10-FIX-01 « à faire » (fusionnée, PR #34), T-14-FIX-01 et T-14-FIX-02 « en revue » (fusionnées, PR #32 et #51), I-06 « en revue » (fusionnée, PR #23 ; vérifications A1 à A10 sur l'iPhone encore dues), Y-TECH-05, Y-FIX-04, Y-FIX-02, Y-IOS-05, SEC-01, UI-FIX-01 « fait sur la branche » (toutes fusionnées, voir section 2). Première tâche de documentation : réconcilier les statuts avec les PR et les preuves. Exception I-06 : code fusionné, en attente de vérification appareil ; clôture seulement après A1 à A10 passées (décision d’Ali du 2026-10-19). Un audit Codex du 2026-10-19 (lecture seule, non vérifié) a aussi relevé que A-07, N-03, K-05 à K-07, I-03 ont du code et des tests malgré un statut « à faire » : vérifier fiche par fiche avant de les reprendre.

## 2. Fusionné dans `main` (palier 1.0 et correctifs de séance)

| Bloquant | Story | PR | Date |
| --- | --- | --- | --- |
| B13 | Y-TECH-03 banc des faux iCloud hostiles | #44, clôture #45 | 2026-10-17 |
| B14 | Y-TECH-04 règle de report option B, identité conservée, choix éclairé de la sauvegarde | #48 | 2026-10-17 |
| B15 | REL-TECH-02 installeur sans piège (crochet NSIS) | #41, clôture #42 | 2026-10-17 |
| B4 | Y-FIX-04 plus de perte silencieuse au report d'époque | #49 | 2026-10-18 |
| (ajout 2) | Y-TECH-05 compte rendu visible du report d'époque | #52 | 2026-10-18 |
| B17 | T-14-FIX-02 roue des jours WebKit | #51 | 2026-10-18 |
| B2 | Y-FIX-02 impasse de première publication | #56 | 2026-10-18 |
| B6 | Y-IOS-05 appel iCloud muet | #54 | 2026-10-18 |
| B7 | SEC-01 plugin SQL fermé | #59 | 2026-10-18 |
| B11 | UI-FIX-01 thème sombre lisible | #57 | 2026-10-18 |
| B12 | PRD-01 exigence de taille de texte retirée du PRD | (docs, #43) | 2026-10-17 |
| — | REL-TECH-01 smoke du vrai binaire Windows | #31 (+ `b8a251a5` mesure des pixels en Node) | 2026-10-15 |
| — | Y-10-FIX-01, Y-IOS-02-FIX-02, T-14-FIX-01, I-06 | #34, #36/#39/#40, #32, #23 | 2026-10-09 → 10-17 |
| — | Fiches des étapes 4 à 6, décisions du 18 octobre, inventaire du bundle | #53, #58, #50 | 2026-10-18 |
| — | Test instable critère 11 (pilote SQLite Wasm), test instable restore_ios | #55, #47 | 2026-10-17/18 |

## 3. En CI ou en relecture (PR ouvertes)

| PR | Branche | Story | État au 2026-10-19 | Reste à faire avant fusion |
| --- | --- | --- | --- | --- |
| #60 | `y-fix-05-segment-tronque` | Y-FIX-05 (B18, segment tronqué jamais clos) | CI verte deux fois (runs 39139398906 et 39139403003), mergeable ; **aucune relecture** ; fiche `docs/stories/Y-FIX-05.md` « en attente de qa-test, revue et CI » | Passe qa-test puis code-reviewer, corrections, fiche « fait » (preuves rouge 89d5ef7d / vert 528bb5f2), audit B18 « corrigé », puis `gh pr merge 60 --merge` |
| #62 | `y-fix-03-lecture-en-echec` | Y-FIX-03 (B3, lecture en échec muette) | Fiche « fait sur la branche » (rouge a1964dee, vert d1baaf85) ; **poussée pour la première fois le 2026-10-19**, CI lancée | Attendre « suite verte », relecture code-reviewer, mesure du bundle, fusion. Touche `src/sync/engine.ts` : à fusionner avant d'ouvrir Y-IOS-02-FIX-01 et Y-IOS-07 |
| #63 | `t-tech-01-recurrences-synchro` | T-TECH-01 (B8, doublons de récurrences, report avant synchro) | 18 commits : développement, revue sur branche corrigée (B1, B2, I1 à I4, M1 à M6 ; M5 et M6 commités à la passation, tests du module verts) ; **poussée pour la première fois le 2026-10-19**, CI lancée ; ligne « Statut » de la fiche vide | Attendre « suite verte », `npm run test:bundle`, compléter la fiche (statut, preuves rouge/vert : 27a038d9, 49c6e943, c78a47d1, 9e11825e rouges ; c3d00efb, 5cf68143, d825bae6 verts), fusion. **À fusionner avant #61** |
| #61 | `bundle-01-paliers` | BUNDLE-01 (paliers 1 et 2, garde par liste blanche, mesure sans bruit de hachage) | 16 commits ; marge mesurée 17 674 octets ; docs commitées à la passation ; **poussée pour la première fois le 2026-10-19**, CI lancée ; pas de relecture | Attendre « suite verte », relecture code-reviewer, **rebase sur `main` après #63** (fichiers communs `src/App.tsx`, `src/features/app/lazyScreens.tsx`), fusion, puis ajouter la règle de la garde dans `CLAUDE.md` (déjà dans la branche) |

Ordre de fusion recommandé : #60, #62, #63, puis #61 rebasée. Après chaque fusion, relire `npm run test:bundle` sur `main`.

## 4. Reste à coder, dans l'ordre

Chaque story : branche propre, fiche lue en entier, test rouge avant, vert après, identifiants dans la fiche, estimation suivie (arrêt à +50 %).

1. **Y-IOS-02-FIX-01** (B5 réduit, étape 3) — `docs/stories/Y-IOS-02-FIX-01.md`. Échec de suppression de l'époque orpheline et `delete-own-failed` mémorisés dans `sync_meta`, visibles dans Détails et en bandeau A-09, « Réessayer maintenant » ; plus les défauts 2 et 3 du banc (instantanés qui reviennent après une suppression acceptée non propagée ; substitut persistant réarmé à chaque cycle). Scénario 4 du banc sur `y-tech-03-scenarios-rouges` (`c41d5d66`, `tests/unit/sync/hostile/scenario4DurableDelete.test.ts`). Dépend de : Y-IOS-02-FIX-02 (fait), #62 fusionnée (même `engine.ts`). Une session Codex lancée le 2026-10-19 sur cette story a été arrêtée pendant l'analyse : rien n'a été écrit.
2. **Y-IOS-07** (B16, étape 3) — `docs/stories/Y-IOS-07.md`. Segment de tête évincé par iOS : sur `cloud-pending` à l'ajout, ouvrir le segment `max + 1` (une rotation par cycle, échec visible). **Avant le code** : réponse écrite à la section « Raison technique de faire l'inverse ? » ; s'il existe une raison, arrêt et alerte à Ali. Scénario 6 sur `y-tech-03-scenarios-rouges` (`scenario6EvictedHeadSegment.test.ts`). Touche `publisher.ts` et `src-tauri/src/sync/store.rs`. Avenant ADR 0011 au prochain § libre (§33 est pris par Y-FIX-05 : vérifier).
3. **N-TECH-02** (B9, étape 6) — `docs/stories/N-TECH-02.md`, 24 critères. Puis **N-FIX-02** (B10) — `docs/stories/N-FIX-02.md`, 27 critères. Même dossier `src/features/reminders` et même budget de départ : jamais en parallèle, N-TECH-02 d'abord. Levier de bundle à mesurer avant : `replanNotifications` par `import()`.
4. **Points restants du palier** (fiches à écrire, `docs/backlog.md` lignes N-IOS-CHK-01, CI-SEC-01, C-FIX-01, Y-IOS-06) : CI-SEC-01 clé de signature hors du build front (3 h) ; C-FIX-01 clavier de la checklist iPhone et Y-IOS-06 gardes du sélecteur iOS (5 h ensemble) ; N-IOS-CHK-01 est un essai d'Ali (`%` sur l'appareil), pas du code.
5. **N-IOS-FIX-01** (séance 0.3.2) — branche `n-ios-apercus` (`df8ab316`, un commit du 2026-10-16, fiche `docs/stories/N-IOS-FIX-01.md` sur la branche) : texte de remplacement des aperçus masqués iOS. À rebaser sur `main`, CI, relecture, PR.
6. **Compilation iPhone du lot** (`build-ios.yml`, une seule), puis **essais d'Ali** (`docs/essais-iphone.md`) et test de mise à jour SideStore avec deux IPA successives N puis N+1 (I-06, vérifications A1 à A10 ; N+1 publiée seulement quand N est installée).
7. **Livraison** : REL-01 (12 parcours clés PC et iPhone), REL-02 (audits sécurité, performance, accessibilité), REL-03 (tag `v1.0.0` et `ios-v1.0.0`, guides `docs/install-pc.md` et `docs/install-iphone.md`, `CHANGELOG.md`).

Stories de l'ordre 5 encore « à faire » au backlog, hors palier 1.0 (à trier après la 1.0 sauf décision d'Ali) : A-07, N-03, K-05, K-06, K-07, K-TECH-01, Q-05, I-02, I-03, I-05, CAP-IOS-01, N-TECH-01 (critère 12 remplacé par N-TECH-02).

Dépendances entre dossiers : `src/sync` (Y-IOS-02-FIX-01, Y-IOS-07, #62) en séquence, jamais en parallèle ; `src/features/reminders` (N-TECH-02, N-FIX-02) en séquence ; `src/App.tsx` et `lazyScreens.tsx` (#63, #61) en séquence ; `src/db` et `src/domain` jamais à deux lots en parallèle.

## 5. Décisions d'Ali déjà prises, à ne pas rouvrir

Sources : `docs/decisions.md` (lignes datées), fiches citées.

- **Report d'époque : option B** (ADR 0011 §24 point 6, « survit tout ce que l'ouvreur n'avait pas lu, sauf ses propres écritures et celles d'un appareil oublié »), confirmée le 2026-10-17 ; question ouverte 13 fermée ; règle d'identité : une restauration ne change jamais l'identité de l'appareil ; compte rendu visible obligatoire (Y-TECH-05, livré).
- **B16 (Y-IOS-07) : rotation de segment, jamais de téléchargement avant l'ajout.** « L'écriture ne lit jamais iCloud » ; sur `cloud-pending`, ouvrir `max + 1`, une rotation par cycle, échec visible. Décision du 2026-10-17. Seule ouverture : une raison technique écrite dans la fiche, soumise à Ali avant le code.
- **B9 (N-TECH-02)** : fenêtre de 7 jours validée telle quelle, préfixe chronologique sans réserve par nature, pas de ligne « Plafond atteint » ; « Planifiés jusqu'au… » est calculé sur le **dernier rappel réellement posé**, pas sur la fenêtre visée (2026-10-18).
- **B10 (N-FIX-02)** : l'heure mise en avant est **l'heure d'échéance de l'élément** (`HH:MM · Pro/Perso`), jamais l'heure de sonnerie ; si le rappel a été décalé par la plage silencieuse, la mention du décalage vient **après** ; plus de parenthèse « (prévu HH:MM) » (2026-10-18).
- **B11 (UI-FIX-01)** : exemption de contraste 2,6:1 acceptée ; désactivé et éteint doivent rester distinguables l'un de l'autre ; Ali juge sur une capture des trois états côte à côte (clair et sombre), pas sur un ratio ; balayage complet des écrans sombres après la 1.0 (2026-10-18). Livré PR #57.
- **B12** : exigence `-apple-system-body` retirée du PRD, à revoir après la 1.0 (2026-10-17).
- **Bundle de départ : paliers 1 et 2 plus la garde par liste blanche, livrés quoi qu'il arrive**, bruit de hachage CSS traité dans le même lot (2026-10-18) ; paliers 3 (migrations) et 4 (synchro hors du départ) non retenus ; plafond jamais relevé ; tout nouvel écran à la demande dès sa création (règle dans `CLAUDE.md`). Branche : PR #61.
- **B18 (Y-FIX-05)** : avant la 1.0 (état faux muet des deux côtés) ; tolérance du lecteur seule, format publié inchangé, pas de `closed` à 0 enregistrement (2026-10-18). PR #60.
- **B15** : crochet NSIS `NSIS_HOOK_PREUNINSTALL`, pas de modèle NSIS personnalisé (2026-10-17). Livré.
- **Tri des défauts** (règle permanente du 2026-10-18) : voir `AGENTS.md`.
- **Y-FIX-02** : option (a), intention résolue seulement si la publication est permise (2026-10-18). Livré.
- **Méthode** : CI complète dans GitHub Actions, tests du module seuls en local ; un bloquant n'est clos qu'avec un test rouge avant et vert après ; alerte à +50 % d'estimation ; une compilation iPhone par lot ; Ali fait toutes les vérifications manuelles à la fin, ne jamais l'attendre pour continuer (hors besoin physique de l'iPhone).

## 6. Branches en vol et ce qui en a été fait le 2026-10-19

| Branche | État | Action faite | À faire |
| --- | --- | --- | --- |
| `y-fix-05-segment-tronque` | PR #60, CI verte | aucune | relecture puis fusion |
| `y-fix-03-lecture-en-echec` | PR #62 ouverte aujourd'hui | poussée, index du worktree réparé (`read-tree`) | CI, relecture, fusion |
| `t-tech-01-recurrences-synchro` | PR #63 ouverte aujourd'hui | M5 et M6 commités (`195dc3b3`), poussée | CI, bundle, fiche, fusion avant #61 |
| `bundle-01-paliers` | PR #61 ouverte aujourd'hui | docs commitées (`7b778c62`), poussée | CI, relecture, rebase après #63, fusion |
| `n-ios-apercus` | 1 commit `df8ab316` (N-IOS-FIX-01), jamais en PR | aucune | rebase, PR (section 4 point 5) |
| `y-tech-03-scenarios-rouges` | 1 commit `c41d5d66`, référence | gardée | ne pas fusionner : y reprendre les scénarios 4 (Y-IOS-02-FIX-01) et 6 (Y-IOS-07) ; supprimer après |
| `backup-y-fix-05-pre-rewrite` | sauvegarde avant réécriture des signatures (`ca3930b4`) | gardée | supprimer après la fusion de #60 |
| `fix-speech-timer-tests` | WIP du 2026-10-09 non relu (tests Rust du minuteur de dictée), retrouvé non commité dans un worktree | commité `cd9db3cf` et poussé tel quel | évaluer contre `main` 0.3.3 (aucune trace de ce défaut au journal depuis) ou supprimer |
| `fix-restore-ios-flaky` (PR #27) | remplacée par PR #47 | PR fermée avec commentaire, branche supprimée (`b2da5e59`) | rien |
| `wip-y-fix-04-2026-10-18` | sauvegarde de Y-FIX-04 avant la PR #49 fusionnée | supprimée (`fa57288c`) | rien |
| `wip-ordre4-amorce` | brouillon du 2026-10-05, tout dans `main` | supprimée (`0a92eeaa`) | rien |
| `rel-tech-02-rebased` | doublon de REL-TECH-02 fusionnée (#41) | supprimée (`13d1ac1e`) | rien |
| `y-ios-02-fix-01` | worktree créé le 2026-10-19 pour Codex, vide | worktree et branche supprimés | recréer au moment de la story |
| `passation-codex` | cette documentation | PR à fusionner | fusionner, puis supprimer |

Branches locales anciennes sans commit hors `main` (a-09-bandeaux, controle-ordre-*, dette-avant-ordre-3, fix-e2e-fusion-*, etc.) : à supprimer librement (`git branch --merged origin/main`).

## 7. Worktrees et restes à nettoyer

- Environ 70 worktrees sous `.claude/worktrees/` pour des branches déjà fusionnées, la plupart avec `node_modules`. Nettoyage sûr : `git worktree list`, puis `git worktree remove --force <chemin>` pour chaque branche fusionnée, puis `git worktree prune`. Garder ceux de #60 à #63 tant que les PR sont ouvertes.
- `.claude/worktrees/agent-acd50317fb4008648` (branche `qa-association`) contient une vieille variante non suivie de `src/features/sync/pairingDefects.test.tsx` (157 lignes) ; `main` a la version à jour (159 lignes) : à jeter avec le worktree.
- `.claude/worktrees/t-tech-01` contient `.bt/` et `.bt.sh` (script temporaire d'un agent, non suivis) : à jeter.
- Aucun stash en attente.

## 8. Signalements non vérifiés (audit Codex en lecture seule du 2026-10-19)

À vérifier avant d'agir ; aucun n'est au backlog :

- `src/domain/types.ts` : les marques imbriquées de `Brand` donneraient des types `never` (contrôle de compilation `SpaceId` ≠ `TaskId` à ajouter).
- `build-windows.yml` et `build-ios.yml` ne vérifient pas eux-mêmes que « suite verte » a réussi sur le commit livré.
- `src/features/stats/useMonthReport.ts` : le rapport mensuel ne se rafraîchit pas sur les changements de routines et d'objectifs.
- `src/platform/files/browser.ts` : annulation du sélecteur d'import iPhone dépendante de l'événement `cancel` (WKWebView).
- `statsRepository.ts` : tri paginé sur `COALESCE(date, …)` sans index d'expression.
- CI : pas de `cargo clippy` ni de `npm audit` ; projet e2e `iphone` en Chromium (WebKit seulement sur titres et roue tactile).
- `docs/dettes.md` mélange dettes ouvertes et points résolus.

Règle de tri de `AGENTS.md` : perte de données ou état faux muet → avant la 1.0, story ouverte, Ali informé ; sinon après.
