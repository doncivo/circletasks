# AGENTS.md — règles de travail sur CircleTasks, pour tout agent

Ces règles valent pour tout agent qui travaille sur ce dépôt : Codex, Claude Code ou un autre. Elles ont été écrites pour Codex le 2026-10-19 et étendues à tout agent par décision d'Ali du 2026-10-27.

Lis d'abord `CLAUDE.md` (stack, commandes, architecture, bundle de départ : il ne se répète pas ici), puis `docs/reprise-codex.md` (état courant, court, mis à jour à chaque jalon ; l'historique est dans `docs/reprise-historique-2026-10.md`). Le PRD est `docs/PRD.md` ; ne le modifie jamais.

## Référence visuelle

- `docs/maquettes-refonte/` (PR #84, 24 octobre 2026, dessinées d'après les écrans réels de la 1.0.0) est la référence pour les écrans qu'elle couvre : Aujourd'hui iPhone clair et sombre, Semaine, Nouvelle tâche, Détail d'une tâche, Synchronisation, Routines, Checklists, Événements, Aujourd'hui PC, Réglages PC. Ses huit règles transversales (README du dossier) s'appliquent à ces écrans.
- `docs/maquettes/` (34 écrans de septembre) reste la référence pour tous les autres écrans.
- Quand une fiche cite un commit de maquette comme référence, elle cite un commit fusionné dans `main`.

## Règles permanentes

- Après chaque compaction du contexte, relis `AGENTS.md`, `CLAUDE.md` et `docs/reprise-codex.md` avant de reprendre ; distingue les décisions déjà tranchées des états historiques.
- Ne désactive, ne saute et ne retarde jamais un test instable. Cherche la cause, corrige-la, note cause et correctif dans `docs/journal.md`. Aucun délai ajouté, aucun timeout allongé, aucune relance automatique.
- Ne relâche jamais un seuil de taille ni de couverture pour faire passer un test. Le plafond du bundle de départ (`tests/bundle/startBundle.test.ts`, **358 400 octets gzip**, toujours écrit en octets) et le seuil de couverture de `src/domain` (80 %) ne bougent pas.
- Aucune défaillance silencieuse. Toute erreur durable est visible dans l'app (ligne d'état dans Réglages, écran Détails, bandeau A-09), persistante après redémarrage, effacée seulement au succès. Un journal technique seul ne suffit jamais.
- Vingt minutes maximum sur une tâche de documentation. Au-delà, arrête-toi, sauve le travail en cours sur une branche et dis à Ali ce qui bloque.
- Si un remplacement exact dans un fichier échoue deux fois de suite, ne réessaie pas : relis la section une fois et réécris-la entière d'un bloc.
- Si une estimation dérape de plus de 50 %, arrête-toi à un point de commit et préviens Ali avant de continuer.
- Mesure le bundle de départ (`npm run test:bundle`) avant tout push, même pour un texte déplacé.
- Interface en français, heures en 24 h, textes dans `src/i18n`, jamais en dur.

## Périmètre d'écriture et de lecture (décision d'Ali du 2026-10-27)

- Interdiction d'écrire, de modifier ou de supprimer quoi que ce soit hors de `C:\Dev\circletasks-kit` et de ses worktrees. Fichiers temporaires dans le worktree, sous `.codex-tmp/` (ignoré par git), jamais commités.
- Interdiction absolue de toucher aux données réelles d'Ali, en lecture comme en écriture, y compris pour un diagnostic : `%APPDATA%\fr.circletasks.planner` et le dossier iCloud `CircleTasks`. Si une information s'y trouve, demande à Ali de l'extraire lui-même.
- Lire un fichier qu'Ali désigne explicitement, par exemple un export de journal iPhone déposé dans iCloud Drive, est permis. Toute autre lecture hors dépôt se demande d'abord.

## Tri des défauts

- Un défaut qui perd des données, ou qui affiche un état faux sans le dire, passe avant la 1.0 d'office : ouvre la story à l'étape courante, ajoute le constat à `docs/audit-1.0.md`, informe Ali en une phrase disant ce que lui voit.
- Un défaut visible, qu'Ali peut signaler lui-même, passe après la 1.0 : ligne au backlog.
- N'interroge Ali que si tu hésites entre les deux.

## Workflow git

- Une branche par story, ID de la story dans chaque message de commit (ex. `T-TECH-01: ...`). Les commits de documentation transverse portent aussi un identifiant (`PASSATION-02: ...`, `AGENTS: ...`).
- Une PR par branche (`gh pr create --base main`). La protection de `main` impose la PR et le statut « suite verte » avec branche à jour : aucun push direct sur `main`, même pour la documentation. Les deux pushs directs d'Ali du 24 octobre 2026 (réparation de marqueurs de conflit dans ce fichier) étaient une exception assumée par lui ; la règle ne change pas.
- Fusion seulement quand `gh pr checks` montre « suite verte » vert et que la passe de revue est approuvée dans la fiche de story : `gh pr merge <n> --merge`. L'approbation GitHub n'est pas requise : GitHub interdit à l'auteur d'approuver sa propre PR, et l'agent assure lui-même la revue en passe distincte (décision d'Ali du 2026-10-19). Jamais `--auto`, jamais `--force`. Pour mettre à jour une branche publiée, fusionne `main` dedans ; ne réécris pas son historique, surtout quand une fiche cite un de ses commits.
- En local, lance seulement les tests du module en cours ; la suite complète tourne dans GitHub Actions à chaque push (`.github/workflows/tests.yml`, seul workflow de tests ; `build-windows.yml` et `build-ios.yml` compilent).
- **Sur le PC d'Ali, seuls les tests légers tournent : unitaires et DOM (Vitest). Les e2e Playwright (`pc`, `iphone`, `iphone-webkit`) tournent dans la CI, jamais en local** (décision d'Ali du 2026-10-28). Le poste n'a pas la mémoire pour, et un résultat obtenu en manquant de mémoire n'est pas un résultat : le passage de fond du 2026-10-28 a été tué par manque de mémoire et ses 135 échecs étaient tous des plantages de navigateur. Quand la branche est prête (typage, lint, garde du bundle, suites Vitest du module), pousse et laisse la CI trancher ; un run de plus coûte moins qu'un résultat sans valeur. Si un e2e local est indispensable pour un diagnostic, préviens Ali avant de le lancer : il ferme ce qu'il faut. N'utilise jamais la variable `CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP` : elle masque le problème au lieu de le résoudre.
- Pour un test ciblé, coupe la couverture (`--coverage.enabled=false`) : le seuil de 80 % de `src/domain` s'applique à la suite complète. La validation d'une story exige la suite complète avec couverture active.
- **Test rouge avant, vert après, pour toute story sans exception**, correctif ou refonte : un commit qui n'ajoute que les tests et échoue, puis un commit de code qui les fait passer ; les deux identifiants (commit ou run) vont dans la fiche. Des tests écrits dans le même commit que le code ne valent pas preuve rouge (constat UI-REFONTE-01, décision d'Ali du 2026-10-27).
- Aucune story n'est « fait » sans tests verts, lint, typecheck et relecture approuvée. Une vérification native encore ouverte s'écrit dans le statut ; elle n'empêche pas « code fusionné », elle empêche « fait ».
- Vérifie qu'aucun secret n'est suivi par git avant chaque push.

## Compilation iPhone

- Une seule compilation iPhone (`build-ios.yml`, lancement manuel ou tag `ios-v*`) par lot terminé, pas une par essai, et jamais pour un changement de documentation.
- Exception explicite : l'essai de mise à jour SideStore N → N+1 utilise l'IPA déjà installée comme N ; une seule nouvelle compilation fournit N+1.

## Interdit

- Ne demande jamais à Ali de lancer un installeur à la main sur le PC. La seule voie est la bannière de mise à jour dans l'app (plugin updater). Le désinstalleur NSIS a déjà effacé ses données une fois.
- N'ajoute aucune fonction de la liste « Hors périmètre » du PRD (section 1).

## Bundle de départ et écrans à la demande

Règle complète dans `CLAUDE.md`. Rappels : le plafond ne bouge pas ; tout écran, fenêtre, bandeau ou catalogue de textes hors du premier affichage d'« Aujourd'hui » est à la demande dès sa création ; la garde `tests/bundle/start-modules.json` refuse tout module nouveau dans le départ et ne s'étend que par un commit qui le justifie. Piège connu : un bloc à la demande qui importe un module du départ sort ce module du bloc principal et coûte des kilo-octets de compression ; donne aux écrans à la demande leur propre hôte et un module de vue séparé.

## Passes de travail (décision d'Ali du 2026-10-19, étendue à tout agent le 2026-10-27)

L'agent assure lui-même product-owner → agent du module → qa-test → code-reviewer en passes séparées, dans cet ordre, et consigne chaque résultat dans la fiche de story. La revue relit le diff à froid et s'appuie sur les tests, sans se fier au souvenir de l'écriture. Une story non vérifiée ne porte jamais le statut « fait ». I-06 reste « code fusionné, en attente de vérification appareil » jusqu'au succès de A1 à A10.

## A9 — décision d'Ali du 21 octobre 2026

A9 n'est plus bloquant avant un changement de schéma ni pour la 1.0 en usage personnel. Il redevient bloquant si et seulement si l'app sort de l'usage personnel d'Ali ; sa vérification est alors obligatoire avant toute distribution à des tiers ou utilisation multi-utilisateur. Ce statut est un trou assumé, pas une story reportée ni un essai réussi.
Avant toute mise à jour changeant le schéma, le guide exige la vérification d'une sauvegarde iCloud récente (S1 à S4 de `docs/essais-iphone.md`). Ne jamais présenter cette vérification comme une restauration éprouvée.
