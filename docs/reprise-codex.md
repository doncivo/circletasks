# Reprise — état courant du dépôt

Fichier court, pour tout agent (Codex, Claude Code ou autre) : l'état vivant et les décisions applicables, rien d'autre. Chaque jalon remplace la section « État au … » au lieu d'empiler un nouveau « point prioritaire ». L'historique du 19 au 27 octobre 2026, tel qu'il a été écrit au fil des reprises, est archivé dans `docs/reprise-historique-2026-10.md` ; en cas de désaccord entre les deux fichiers, celui-ci l'emporte. Règles de travail : `AGENTS.md`. Stack et architecture : `CLAUDE.md`.

## État au 2026-10-27, fin de soirée (Claude Code, écrit avant redémarrage à la demande d'Ali)

### Fusionné aujourd'hui dans `main`, dans l'ordre

| PR | Story | Contenu | Main après fusion | Bundle normalisé (marge) |
| --- | --- | --- | --- | --- |
| #88 | UI-FIX-03 | Rapport du mois : défauts 11, 12 (Rapport), 14 | e9ba7e26 | 334 039 (24 361) |
| #84 | DESIGN | Onze maquettes de refonte `docs/maquettes-refonte/` | 962893b1 | 334 039 (24 361) |
| #89 | PASSATION-02 | AGENTS.md et CLAUDE.md pour tout agent, reprise réduite, historique archivé, audits Codex commités | df9cbc5e | 334 039 (24 361) |
| #90 | N-FIX-03 | Remplacement vérifiable des notifications iOS | d6238ecb | 334 135 (24 265) |
| #91 | N-FIX-04 | Avertissement de plage silencieuse sur les trois formulaires, ligne « Rappels décalés » des routines | 522b9446 | 335 216 (23 184) |
| #92 | ETAT-27-10 | Point d'état du soir | 07dd392e | 335 216 (23 184) |
| #93 | UI-FIX-04 | Défaut 12 : retour iPhone à gauche sur treize écrans, flèche `ArrowLeft` | **f6569eed** | **non mesuré** : la mesure a été arrêtée par manque de mémoire du PC ; attendu 335 256 (23 144), valeur de la branche. À refaire : `VITE_CT_E2E_HOOKS= npm run build -- --outDir <dossier> --emptyOutDir --manifest` puis `node tests/bundle/measureStart.ts <dossier>` sur `main`. |

Chaque fusion a attendu 48 contrôles verts et une revue consignée dans la fiche. Versions en service : PC et iPhone **1.0.2** (26 octobre, f473e113, schéma 19). N-FIX-03, N-FIX-04 et UI-FIX-04 ne sont pas encore dans une version publiée : prochain lot iPhone quand Ali le décide (une compilation par lot).

### En vol

- **PR #94, UI-FIX-05** (défaut 15, un seul moyen d'ajouter un objectif) : branche `ui-fix-05-objectif-ajout`, tête b3796723, à jour de `main` f6569eed, **CI en cours** au moment de ce point (la surveillance locale a été arrêtée par manque de mémoire ; lire `gh pr checks 94`). Preuve rouge 88d4c1b2, correctif f1cf8e52 : 123 tests Objectif, e2e OB-01 à OB-06 (52 verts, 2 ignorés), lint, typage, bundle 62/62 (335 256, marge 23 144), revue approuvée dans la fiche. À fusionner au vert (`gh pr merge 94 --merge`), puis mesurer `main`.
- **UI-FIX-06** (défaut 13, Concentration) : branche `ui-fix-06-concentration`, tête 29400612, poussée, **empilée sur UI-FIX-05**, pas encore en PR. Preuve rouge 722e6771, correctif 29400612 : 175 tests Focus, e2e F-01 à F-04 (44 verts, 4 ignorés), lint, typage, bundle 62/62 (335 397, marge 23 003, +141 : trois textes du pied dans `fr.focus.ts`, catalogue du départ), revue approuvée dans la fiche. Après la fusion de #94 : `git merge origin/main` dans la branche, push, `gh pr create`, CI, fusion, mesure de `main`.
- Si le job `e2e iphone-webkit` d'un run est annulé à 20 min 17 s pendant « Dépendances système de WebKit » (trois fois aujourd'hui, miroir Ubuntu lent, avant tout test) : `gh run rerun <run> --failed` suffit ; aucun délai ni test à modifier. Story CI proposée à Ali (cache des dépendances WebKit ou délai propre à cette étape), non ouverte sans son accord.

### Reste à faire, dans l'ordre validé par Ali

1. Mesurer `main` f6569eed (voir tableau), fusionner #94 au vert et mesurer, puis PR, fusion et mesure de UI-FIX-06.
2. **Les huit refontes**, une story par écran, dans cet ordre : Aujourd'hui iPhone clair et sombre, Semaine, Synchronisation, Routines, Checklists, Événements, Aujourd'hui PC, Réglages PC. Référence `docs/maquettes-refonte/` (sur `main`) et les huit règles transversales de son README. Les lignes « Rappels décalés » (N-FIX-04), le retour à gauche (UI-FIX-04) et les avertissements de formulaire sont conservés par les refontes. Nouvelle tâche et Détail sont déjà livrés (UI-REFONTE-01, #86) **sans preuve rouge préalable** : story non « fait ».
3. Ensuite : une compilation iPhone du lot, les contrôles natifs du guide (dont N-FIX-03, N-FIX-04, UI-FIX-04 à 06), puis REL-01 à REL-03.

Pour chaque story : branche propre, fiche, **commit de tests rouges avant le code**, identifiants rouge et vert dans la fiche, passes product-owner → module → QA → revue consignées, bundle mesuré avant push et sur `main` après fusion, CI complète verte avant fusion. En local, seulement les tests du module ; une seule tâche lourde à la fois (le PC a manqué de mémoire ce soir avec deux builds et une surveillance en parallèle).

### Décisions prises par Ali aujourd'hui (27 octobre 2026)

- **AGENTS.md vaut pour tout agent**, Claude Code compris ; CLAUDE.md y renvoie. Périmètre : écriture et suppression hors dépôt interdites ; données réelles (`%APPDATA%\fr.circletasks.planner`, dossier iCloud `CircleTasks`) intouchables ; lire un fichier qu'Ali désigne est permis. Plafond du bundle écrit en octets partout (358 400). Les deux pushs directs d'Ali sur `main` du 24 octobre : exception assumée, règle inchangée.
- **Référence visuelle** : `docs/maquettes-refonte/` pour les écrans qu'elle couvre, `docs/maquettes/` ailleurs.
- **Test rouge avant, vert après, pour toute story sans exception**, refontes comprises ; des tests écrits dans le même commit que le code ne valent pas preuve.
- **Règle de remplacement vérifié (N-FIX-03)** : nouveau numéro iOS pour tout élément de notification changé ; l'ancien numéro n'est annulé qu'après la pose **vérifiée** du nouveau par `get_pending` ; si la pose échoue et que l'ancien est conservé, l'app le dit (« {n} rappel conservé à l'ancienne heure »). Raison d'Ali : « si l'annulation précède la pose et que la pose échoue, je me retrouve sans rappel sans le savoir ; dans l'ordre inverse, le pire cas est un doublon ou un rappel à l'ancienne heure, visible, donc corrigeable. On préfère toujours le défaut visible au silence. » Sous le plafond de 64, la notification la plus lointaine est déplacée pour faire place (ADR 0012, avenant N4).
- **Enquête du défaut 1.0.2 close** : routines Pro à 20:00, plage Pro 19:00–08:00 et week-end, rappels décalés au prochain matin de semaine à 08:00 comme prévu. Le défaut réel était le silence de l'app au moment du choix : N-FIX-04.
- **N-FIX-04, les trois états de la ligne Routines** (jamais silencieux par défaut) : tous les rappels décalés → « Rappels décalés à 08:00 » ; partiellement décalés → une ligne qui nomme ce qui est touché, « Rappels du week-end décalés au lundi 08:00 » ; aucun décalage → rien. Raison d'Ali : « une routine Pro à 10:00 tous les jours sonne bien en semaine, mais ses occurrences du week-end partent au lundi 08:00 sans que rien ne le dise ; je le découvrirai un samedi. »
- **N-FIX-04, une phrase, une cause** : l'avertissement de formulaire nomme la plage qui explique ce décalage-là, pas les deux : la journée entière l'emporte sur la plage horaire (un samedi 20:00 dit « le week-end »), la plage du jour (« après 19:00 ») l'emporte sur celle commencée la veille (« avant 08:00 ») ; formulation « Rappel décalé au lundi 08:00 — aucun rappel Pro après 19:00 », et « aucun rappel Pro le week-end » pour la journée entière ; sur les trois formulaires (tâche, routine, événement), création et modification.
- **Ordre** : N-FIX-04 d'abord, puis 12, 15, 13, puis les huit refontes.
- **Ménage** : seize worktrees de branches fusionnées supprimés ; cinq branches mortes supprimées ; `i-06-a9-build-afterapply` et `i-06-a9-build-interruption` conservées, à ne jamais fusionner.

### Ce qui attend Ali

- Supprimer lui-même `iCloudDrive\CircleTasks\devices\7d0b4a0a-…\state 2.ctx` (copie de conflit iCloud du 24 octobre 11:20, ignorée par Rust à chaque cycle, sans effet sur les données) ; aucun agent ne touche à ce dossier.
- Supprimer à la main le dossier du worktree `.claude/worktrees/y-ios-07` (chemin trop long pour `git worktree remove` sous Windows).
- Dire ce que sa recette native du 26 octobre a couvert : les lignes du backlog encore « en attente de vérification appareil » (I-06 A1 à A10, N-IOS-CHK-01, critère 18 de B5, clavier C-FIX-01, UIKit Y-IOS-06, N-FIX-02, N-IOS-FIX-01, A-07, N-03, K-05 à K-07, I-03) et REL-01 à REL-03 restent ouvertes tant qu'il ne l'a pas dit.
- Les quatre contrôles natifs de la refonte 1.0.2 (`docs/essais-iphone.md`), puis, au prochain lot, l'observation de N-FIX-03, N-FIX-04 et UI-FIX-04 à 06 sur l'iPhone.
- Décider de la story CI sur le job WebKit (voir « En vol »).
- Valider l'inventaire des worktrees restants avant toute suppression supplémentaire (`docs/audits/2026-10-19-inventaire-worktrees.md`).
- Mémoire du PC : deux tâches de fond ont été arrêtées par Claude Code ce soir faute de mémoire ; à la reprise, une seule tâche lourde à la fois, ou lancer Claude Code avec `CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP=1`.

## Branches et worktrees vivants

- `ui-fix-05-objectif-ajout` (PR #94) et `ui-fix-06-concentration` (empilée, pas encore en PR) : poussées. `etat-2026-10-27-soir` : ce point d'état.
- `.claude/worktrees/codex-main-validation` : sur `ui-fix-06-concentration`. `.claude/worktrees/n-ios-apercus` : sur `etat-2026-10-27-soir`. `.claude/worktrees/main-mesure` : checkout détaché de `main` pour mesurer le bundle (dépendances copiées).
- Checkout racine `C:\Dev\circletasks-kit` : branche `design-maquettes-refonte` (fusionnée par #84), fichiers temporaires `.codex-tmp/` ignorés.
- Branches fusionnées aujourd'hui, supprimables : `n-fix-04-plage-silencieuse`, `etat-2026-10-27`, `ui-fix-04-retours`, `passation-claude`, `pause-refonte-20261027`, `n-fix-03-remplacement-verifie`.
- Branches à ne jamais fusionner : `i-06-a9-build-afterapply` (1226f203) et `i-06-a9-build-interruption` (2560945a), IPA de laboratoire A9.

## Décisions applicables (à ne pas rouvrir)

- **A9, 21 octobre 2026** : risque accepté pour l'usage mono-utilisateur ; redevient bloquant si l'app sort de l'usage personnel d'Ali. Trou assumé, ni story reportée ni essai réussi. Avant toute mise à jour changeant le schéma : vérification d'une sauvegarde iCloud récente (S1 à S4 du guide), jamais présentée comme une restauration éprouvée. A6b : vérification future en usage après la 1.0, non bloquante.
- Les décisions du 27 octobre ci-dessus (périmètre, référence visuelle, preuve rouge, remplacement vérifié, trois états, une phrase une cause, ordre).
- **Passes de travail, 19 octobre 2026, étendues le 27** : product-owner → agent du module → qa-test → code-reviewer, par tout agent, consignées dans la fiche.
- Les décisions antérieures (option B du report d'époque, rotation de segment B16, fenêtre de 7 jours B9, corps des notifications B10, exemption de contraste B11, bundle paliers 1 et 2 et garde par liste blanche, tolérance du lecteur B18, crochet NSIS B15, tri des défauts, méthode CI) restent celles de `docs/decisions.md` et de la section 5 de l'archive.

## Repères utiles

- Appareils : PC `7d0b4a0a-…`, iPhone `ef50b6f7-…` ; ancien PC `56d4eec1-…` oublié le 2026-10-17.
- Journaux : export iPhone dans iCloud Drive (`circletasks-logs-*.txt`), à lire seulement quand Ali désigne le fichier (dernier lu : `circletasks-logs-20261027-1605.txt`) ; données PC dans `%APPDATA%\fr.circletasks.planner`, jamais touchées.
- Guide des essais iPhone : `docs/essais-iphone.md`. Audit 1.0 : `docs/audit-1.0.md`. Backlog : `docs/backlog.md`. Fiches du jour : `docs/stories/N-FIX-03.md`, `N-FIX-04.md`, `UI-FIX-04.md`, `UI-FIX-05.md`, `UI-FIX-06.md`. Signalements non vérifiés de l'audit Codex du 19 octobre : section 8 de l'archive.
- Mesure du bundle hors test : `VITE_CT_E2E_HOOKS= npm run build -- --outDir <dossier> --emptyOutDir --manifest` puis `node tests/bundle/measureStart.ts <dossier>` ; les cartes de source des blocs de départ permettent de comparer les modules du départ entre deux builds.
