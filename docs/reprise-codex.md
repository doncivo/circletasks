# Reprise — état courant du dépôt

Fichier court, pour tout agent (Codex, Claude Code ou autre) : l'état vivant et les décisions applicables, rien d'autre. Chaque jalon remplace la section « État au … » au lieu d'empiler un nouveau « point prioritaire ». L'historique du 19 au 27 octobre 2026, tel qu'il a été écrit au fil des reprises, est archivé dans `docs/reprise-historique-2026-10.md` ; en cas de désaccord entre les deux fichiers, celui-ci l'emporte. Règles de travail : `AGENTS.md`. Stack et architecture : `CLAUDE.md`.

## État au 2026-10-29, midi (Claude Code)

### Fusionné dans `main`

- Les huit refontes (#99 à #107), #100 (AGENTS : tests unitaires et DOM en local, e2e en CI), #108 (clôture), #109 (séance unique) ; puis les trois correctifs décidés par Ali : **#110 Q-05-FIX-01** (c3a09d1c), **#112 UI-FIX-07** (3943f4b7), **#113 UI-FIX-08** (8ed535ac). Bundle de `main` : **338 017** normalisés, marge 20 383 (relevé dans la CI : le relevé local a été arrêté par le système, mémoire critique, et non relancé sans demande). Garde du bundle à borne asymétrique 100 / 300 (décision d'Ali).
- **IPA N+1 prête** : compilation iPhone unique du lot, run 40798967224 sur `main` e2c2f45a (après #111), verte, publication non lancée ; artefact `CircleTasks-ipa` : CircleTasks.ipa, 7 383 697 octets, SHA-256 `86a18af5fdbe5e238bbc4c78f0a27b2ef61f403eefdcdd074d9ec7a71e8c364d`. Elle remplace l'IPA du run 40750480780 (périmée). **Signal de la séance d'Ali envoyé le 2026-10-29.**

### Décisions d'Ali (28 au soir)

- Q-05-FIX-01 maintenant ; PRD-02 : oui aux six lots, sauf OB-03 conservé (marque d'objectif dans la Semaine : UI-FIX-07) et « Masquer les fériés » mémorisé (UI-FIX-08) ; borne du critère 4 de BUNDLE-01 : 100 octets quand la mesure est plus petite que le build réel, 300 dans l'autre sens. Les trois correctifs et les alignements partent dans l'IPA N+1.
- Procédure : je ne m'arrête que pour une décision tranchée à rouvrir, un défaut qui perd des données ou affiche un état faux, une estimation qui dérape de plus de 50 %, ou un besoin physique de l'iPhone.

### En vol

| Élément | État |
| --- | --- |
| #111 PRD-02 (PRD aligné, point d'état, journal, fiches, guide de séance, backlog) | **fusionnée** (e2c2f45a) |
| Y-05-OBS | une tâche longue isolée de 1 476 ms (Y-05, @perf) sur #110, non reproduite à la relance, cause non établie ; journal du 2026-10-29 et backlog ; si l'échec revient : défaut du publieur, Ali prévenu avant tout e2e local |

### Reste à faire, dans l'ordre

1. Séance d'Ali sur l'IPA N+1 (36 lignes de `docs/essais-iphone.md`) ; recueillir ses résultats ; chaque écart devient une story de correction avec sa preuve rouge (puis, si du code change, une nouvelle IPA : une seule, à la fin).
2. REL-01, REL-02, REL-03 : publication de la 1.0 par tag `ios-v*`, source SideStore, mise à jour N → N+1 (A3, A7, A10 de I-06) ; rapport final : livré, ouvert et pourquoi, liste de ce qu'Ali fait avec l'IPA publiée.

### Règles en vigueur

- Tests unitaires et DOM en local seulement ; e2e Playwright en CI ; prévenir Ali avant tout e2e local ; jamais `CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP` (`AGENTS.md`). Un travail lourd arrêté par le système pour manque de mémoire n'est pas relancé sans demande.
- Une PR doit être à jour de `main` pour fusionner : mettre la branche à jour par l'API (`gh api -X PUT repos/doncivo/circletasks/pulls/N/update-branch`) après chaque fusion voisine ; ordre de fusion : code d'abord, documentation en dernier.
- Un seul build iPhone par lot terminé, jamais pour de la documentation. Test rouge avant le code pour tout défaut de l'app ; mesure du bundle après chaque fusion ; plafond 358 400 octets.

## État au 2026-10-27, nuit (Claude Code, reprise après le redémarrage du PC)

### Fusionné le 27 octobre dans `main`, dans l'ordre

| PR | Story | Contenu | Main après fusion | Bundle normalisé (marge) |
| --- | --- | --- | --- | --- |
| #88 | UI-FIX-03 | Rapport du mois : défauts 11, 12 (Rapport), 14 | e9ba7e26 | 334 039 (24 361) |
| #84 | DESIGN | Onze maquettes de refonte `docs/maquettes-refonte/` | 962893b1 | 334 039 (24 361) |
| #89 | PASSATION-02 | AGENTS.md et CLAUDE.md pour tout agent, reprise réduite, historique archivé, audits Codex commités | df9cbc5e | 334 039 (24 361) |
| #90 | N-FIX-03 | Remplacement vérifiable des notifications iOS | d6238ecb | 334 135 (24 265) |
| #91 | N-FIX-04 | Avertissement de plage silencieuse sur les trois formulaires, ligne « Rappels décalés » des routines | 522b9446 | 335 216 (23 184) |
| #92 | ETAT-27-10 | Point d'état du soir | 07dd392e | 335 216 (23 184) |
| #93 | UI-FIX-04 | Défaut 12 : retour iPhone à gauche sur treize écrans, flèche `ArrowLeft` | f6569eed | 335 256 (23 144), mesuré après le redémarrage |
| #94 | UI-FIX-05 | Défaut 15 : un seul moyen d'ajouter un objectif | 89a1f9c6 | 335 256 (23 144) |
| #95 | UI-FIX-06 | Défaut 13 : « Concentration », Pause dominante, total du jour vivant | **64e6a400** | **335 397 (23 003)** |

Chaque fusion a attendu 48 contrôles verts et une revue consignée dans la fiche. #94 et #95 ont chacune eu un job `e2e iphone-webkit` annulé à 20 min 17 s (miroir Ubuntu lent) relancé par `gh run rerun --failed`. Versions en service : PC et iPhone **1.0.2** (26 octobre, f473e113, schéma 19). N-FIX-03, N-FIX-04 et UI-FIX-04 à 06 ne sont pas encore dans une version publiée : prochain lot iPhone quand Ali le décide (une compilation par lot).

### En vol

- **CI-WEBKIT-01** (cache des paquets système de WebKit, délai propre à l'étape ; décision d'Ali du 27 octobre au soir : pas de test rouge, preuve par mesure du temps avant et après) : branche `ci-webkit-01-cache`, tête fad12ce9, poussée, **pas encore en PR**. Fiche `docs/stories/CI-WEBKIT-01.md` avec la mesure « avant » (16 runs à 26–67 s, un à 305 s, cinq annulés entre 596 et 1197 s). Premier run 40560815702 : miroir lent, 117 Mo en 4 min 46 s, installation finie à 305 s, délai de 5 min dépassé et cache non sauvegardé (`actions/cache` ne sauvegarde qu'en fin de job réussi). Correctif fad12ce9 : `actions/cache/restore` et `actions/cache/save` séparés, sauvegarde en `always()`, délai porté à 8 min. Run du correctif 40565118802 en cours. Reste : consigner ce run (cache froid) et le suivant (cache chaud) dans la fiche, passe de revue, PR, CI verte, fusion, puis premier run de `main` (cache froid côté `main`) et le suivant. Arbre `src/` identique à `main`, pas de mesure de bundle nouvelle.
- Ce point d'état : branche `etat-2026-10-27-soir`, à fusionner par PR (un point d'état qui ne vit que sur une branche finit par se perdre, consigne d'Ali).

### Reste à faire, dans l'ordre validé par Ali

1. Finir CI-WEBKIT-01 (ci-dessus).
2. **Les huit refontes**, une story par écran, dans cet ordre : Aujourd'hui iPhone clair et sombre, Semaine, Synchronisation, Routines, Checklists, Événements, Aujourd'hui PC, Réglages PC. Référence `docs/maquettes-refonte/` (sur `main`) et les huit règles transversales de son README. Les lignes « Rappels décalés » (N-FIX-04), le retour à gauche (UI-FIX-04), le bouton unique d'ajout d'objectif (UI-FIX-05), l'écran Concentration (UI-FIX-06) et les avertissements de formulaire sont conservés par les refontes. Nouvelle tâche et Détail sont déjà livrés (UI-REFONTE-01, #86) **sans preuve rouge préalable** : story non « fait ». Carte de l'écran Aujourd'hui iPhone (fichiers, blocs, tests, e2e, catalogue, bundle) relevée le 27 au soir, à refaire dans la fiche de la première refonte.
3. Ensuite : une compilation iPhone du lot, les contrôles natifs du guide (dont N-FIX-03, N-FIX-04, UI-FIX-04 à 06), puis REL-01 à REL-03.

Pour chaque story : branche propre, fiche, **commit de tests rouges avant le code**, identifiants rouge et vert dans la fiche, passes product-owner → module → QA → revue consignées, bundle mesuré avant push et sur `main` après fusion, CI complète verte avant fusion. En local, seulement les tests unitaires et DOM du module ; **les e2e Playwright tournent dans la CI, jamais sur le PC** (règle d’Ali du 2026-10-28, `AGENTS.md`) ; **une seule tâche lourde à la fois** (consigne d'Ali du 27 au soir : le PC a manqué de mémoire avec deux builds et une surveillance en parallèle).

### Décisions prises par Ali le 27 octobre 2026

- **AGENTS.md vaut pour tout agent**, Claude Code compris ; CLAUDE.md y renvoie. Périmètre : écriture et suppression hors dépôt interdites ; données réelles (`%APPDATA%\fr.circletasks.planner`, dossier iCloud `CircleTasks`) intouchables ; lire un fichier qu'Ali désigne est permis. Plafond du bundle écrit en octets partout (358 400). Les deux pushs directs d'Ali sur `main` du 24 octobre : exception assumée, règle inchangée.
- **Référence visuelle** : `docs/maquettes-refonte/` pour les écrans qu'elle couvre, `docs/maquettes/` ailleurs.
- **Test rouge avant, vert après, pour toute story sans exception**, refontes comprises ; des tests écrits dans le même commit que le code ne valent pas preuve. **Exception explicite du soir : CI-WEBKIT-01**, story d'outillage CI sans test rouge, preuve par mesure du temps de l'étape avant et après, plus un délai propre à cette étape (le délai borne une installation de paquets, pas un test ; aucune relance automatique).
- **Règle de remplacement vérifié (N-FIX-03)** : nouveau numéro iOS pour tout élément de notification changé ; l'ancien numéro n'est annulé qu'après la pose **vérifiée** du nouveau par `get_pending` ; si la pose échoue et que l'ancien est conservé, l'app le dit (« {n} rappel conservé à l'ancienne heure »). Raison d'Ali : « si l'annulation précède la pose et que la pose échoue, je me retrouve sans rappel sans le savoir ; dans l'ordre inverse, le pire cas est un doublon ou un rappel à l'ancienne heure, visible, donc corrigeable. On préfère toujours le défaut visible au silence. » Sous le plafond de 64, la notification la plus lointaine est déplacée pour faire place (ADR 0012, avenant N4).
- **Enquête du défaut 1.0.2 close** : routines Pro à 20:00, plage Pro 19:00–08:00 et week-end, rappels décalés au prochain matin de semaine à 08:00 comme prévu. Le défaut réel était le silence de l'app au moment du choix : N-FIX-04.
- **N-FIX-04, les trois états de la ligne Routines** (jamais silencieux par défaut) : tous les rappels décalés → « Rappels décalés à 08:00 » ; partiellement décalés → une ligne qui nomme ce qui est touché, « Rappels du week-end décalés au lundi 08:00 » ; aucun décalage → rien. Raison d'Ali : « une routine Pro à 10:00 tous les jours sonne bien en semaine, mais ses occurrences du week-end partent au lundi 08:00 sans que rien ne le dise ; je le découvrirai un samedi. »
- **N-FIX-04, une phrase, une cause** : l'avertissement de formulaire nomme la plage qui explique ce décalage-là, pas les deux : la journée entière l'emporte sur la plage horaire (un samedi 20:00 dit « le week-end »), la plage du jour (« après 19:00 ») l'emporte sur celle commencée la veille (« avant 08:00 ») ; formulation « Rappel décalé au lundi 08:00 — aucun rappel Pro après 19:00 », et « aucun rappel Pro le week-end » pour la journée entière ; sur les trois formulaires (tâche, routine, événement), création et modification.
- **Ordre** : N-FIX-04 d'abord, puis 12, 15, 13 (faits), puis le cache WebKit, puis les huit refontes.
- **Ménage** : seize worktrees de branches fusionnées supprimés ; cinq branches mortes supprimées ; `i-06-a9-build-afterapply` et `i-06-a9-build-interruption` conservées, à ne jamais fusionner.

### Ce qui attend Ali

- Supprimer lui-même `iCloudDrive\CircleTasks\devices\7d0b4a0a-…\state 2.ctx` (copie de conflit iCloud du 24 octobre 11:20, ignorée par Rust à chaque cycle, sans effet sur les données) ; aucun agent ne touche à ce dossier.
- Supprimer à la main le dossier du worktree `.claude/worktrees/y-ios-07` (chemin trop long pour `git worktree remove` sous Windows).
- Dire ce que sa recette native du 26 octobre a couvert : les lignes du backlog encore « en attente de vérification appareil » (I-06 A1 à A10, N-IOS-CHK-01, critère 18 de B5, clavier C-FIX-01, UIKit Y-IOS-06, N-FIX-02, N-IOS-FIX-01, A-07, N-03, K-05 à K-07, I-03) et REL-01 à REL-03 restent ouvertes tant qu'il ne l'a pas dit.
- Les quatre contrôles natifs de la refonte 1.0.2 (`docs/essais-iphone.md`), puis, au prochain lot, l'observation de N-FIX-03, N-FIX-04 et UI-FIX-04 à 06 sur l'iPhone.
- Valider l'inventaire des worktrees restants avant toute suppression supplémentaire (`docs/audits/2026-10-19-inventaire-worktrees.md`).
- Mémoire du PC : une seule tâche lourde à la fois (consigne appliquée depuis la reprise), ou lancer Claude Code avec `CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP=1`.

## Branches et worktrees vivants

- `ci-webkit-01-cache` (CI-WEBKIT-01, pas encore en PR) : poussée ; worktree `.claude/worktrees/ci-webkit-01` (sans `node_modules`, inutiles pour cette story). `etat-2026-10-27-soir` : ce point d'état, worktree `.claude/worktrees/n-ios-apercus`.
- `.claude/worktrees/codex-main-validation` : sur `ui-fix-06-concentration` (fusionnée), dépendances installées, à réutiliser pour la première refonte. `.claude/worktrees/main-mesure` : checkout détaché de `main` 64e6a400 pour mesurer le bundle (dépendances copiées).
- Checkout racine `C:\Dev\circletasks-kit` : branche `design-maquettes-refonte` (fusionnée par #84), fichiers temporaires `.codex-tmp/` ignorés.
- Branches fusionnées, supprimables : `n-fix-04-plage-silencieuse`, `etat-2026-10-27`, `ui-fix-04-retours`, `ui-fix-05-objectif-ajout`, `ui-fix-06-concentration`, `passation-claude`, `pause-refonte-20261027`, `n-fix-03-remplacement-verifie`.
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
