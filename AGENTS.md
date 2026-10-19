# AGENTS.md — consignes pour Codex sur CircleTasks

Lis d'abord `CLAUDE.md` (stack, commandes, règles d'architecture) puis `docs/reprise-codex.md` (état exact au 2026-10-19, ordre de travail). Le PRD est `docs/PRD.md` ; ne le modifie jamais. Les maquettes `docs/maquettes/` sont la référence visuelle.

## Règles permanentes

- Ne désactive, ne saute et ne retarde jamais un test instable. Cherche la cause, corrige-la, note cause et correctif dans `docs/journal.md`. Aucun délai ajouté, aucun timeout allongé, aucune relance automatique.
- Ne relâche jamais un seuil de taille ni de couverture pour faire passer un test. Le plafond du bundle de départ (`tests/bundle/startBundle.test.ts`, 358 400 octets gzip) et le seuil de couverture de `src/domain` (80 %) ne bougent pas.
- Aucune défaillance silencieuse. Toute erreur durable est visible dans l'app (ligne d'état dans Réglages, écran Détails, bandeau A-09), persistante après redémarrage, effacée seulement au succès. Un journal technique seul ne suffit jamais.
- Vingt minutes maximum sur une tâche de documentation. Au-delà, arrête-toi, sauve le travail en cours sur une branche et dis à Ali ce qui bloque.
- Si un remplacement exact dans un fichier échoue deux fois de suite, ne réessaie pas : relis la section une fois et réécris-la entière d'un bloc.
- Si une estimation dérape de plus de 50 %, arrête-toi à un point de commit et préviens Ali avant de continuer.
- Mesure le bundle de départ (`npm run test:bundle`) avant tout push, même pour un texte déplacé.
- N'écris aucun fichier hors du dépôt (`C:\Dev\circletasks-kit` et ses worktrees). Fichiers temporaires dans le worktree, jamais commités.
- Interface en français, heures en 24 h, textes dans `src/i18n`, jamais en dur.

## Tri des défauts

- Un défaut qui perd des données, ou qui affiche un état faux sans le dire, passe avant la 1.0 d'office : ouvre la story à l'étape courante, ajoute le constat à `docs/audit-1.0.md`, informe Ali en une phrase disant ce que lui voit.
- Un défaut visible, qu'Ali peut signaler lui-même, passe après la 1.0 : ligne au backlog.
- N'interroge Ali que si tu hésites entre les deux.

## Workflow git

- Une branche par story, ID de la story dans chaque message de commit (ex. `T-TECH-01: ...`).
- Une PR par branche (`gh pr create --base main`). La protection classique de `main` impose la PR et le statut « suite verte » : aucun push direct sur `main`, même pour la documentation.
- Fusion seulement quand `gh pr checks` montre « suite verte » vert et que la passe de revue est approuvée dans la fiche de story : `gh pr merge <n> --merge`. L'approbation GitHub n'est pas requise : GitHub interdit à l'auteur d'approuver sa propre PR, et Codex assure lui-même la revue en passe distincte (décision d'Ali du 2026-10-19). Protection de `main` : zéro approbation exigée, PR et contrôles CI obligatoires conservés, dont « suite verte » avec branche à jour. Jamais `--auto`, jamais `--force`.
- En local, lance seulement les tests du module en cours ; la suite complète tourne dans GitHub Actions à chaque push (`.github/workflows/tests.yml`).
- Pour un test ciblé, couper la couverture (`--coverage.enabled=false`) : le seuil de 80 % de `src/domain` s'applique à la suite complète. La validation d'une story exige la suite complète avec couverture active.
- Aucun bloquant n'est clos sans un test qui échoue avant le correctif et passe après ; note les deux identifiants (commit ou run) dans la fiche de la story.
- Aucune story n'est « fait » sans tests verts, lint, typecheck et relecture approuvée.
- Une seule compilation iPhone (`build-ios.yml`, lancement manuel) par lot terminé, pas une par essai.
- Vérifie qu'aucun secret n'est suivi par git avant chaque push.

## Interdit

- Ne demande jamais à Ali de lancer un installeur à la main sur le PC. La seule voie est la bannière de mise à jour dans l'app (plugin updater). Le désinstalleur NSIS a déjà effacé ses données une fois.
- Ne touche pas aux données utilisateur réelles (`%APPDATA%\fr.circletasks.planner`, dossier iCloud `CircleTasks`).
- N'ajoute aucune fonction de la liste « Hors périmètre » du PRD (section 1).

## Bundle de départ et écrans à la demande

- Le plafond du bundle de départ ne bouge pas.
- Tout écran, fenêtre, bandeau ou catalogue de textes qui ne sert pas au premier affichage d'« Aujourd'hui » est en chargement à la demande dès sa création : `import()` dynamique au moment où l'état apparaît, catalogue i18n chargé avec lui, assertion « hors du départ » dans `startBundle.test.ts`. Jamais après coup quand le plafond saute.
- Un module nouveau dans le départ est refusé par la garde `tests/bundle/start-modules.json` (après la fusion de BUNDLE-01, PR #61) ; la liste ne s'étend que par un commit qui le justifie (ID de story et raison).
- Piège connu : un bloc à la demande qui importe un module du départ sort ce module du bloc principal et coûte des kilo-octets de compression. Donne aux écrans à la demande leur propre hôte et un module de vue séparé.

## Passes de travail (décision d’Ali du 2026-10-19)

Codex assure lui-même product-owner → agent du module → qa-test → code-reviewer en passes séparées, dans cet ordre, et consigne chaque résultat. La revue relit le diff à froid et s’appuie sur les tests, sans se fier au souvenir de l’écriture. Une story non vérifiée ne porte jamais le statut « fait ». I-06 reste « code fusionné, en attente de vérification appareil » jusqu’au succès de A1 à A10.

Exception explicite à la compilation iPhone unique par lot : l’essai SideStore N → N+1 utilise l’IPA déjà installée comme N ; une seule nouvelle compilation fournit N+1.
