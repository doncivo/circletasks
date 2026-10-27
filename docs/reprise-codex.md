# Reprise — état courant du dépôt

Fichier court, pour tout agent (Codex, Claude Code ou autre) : l'état vivant et les décisions applicables, rien d'autre. Chaque jalon remplace la section « État au … » au lieu d'empiler un nouveau « point prioritaire ». L'historique du 19 au 27 octobre 2026, tel qu'il a été écrit au fil des reprises, est archivé dans `docs/reprise-historique-2026-10.md` ; en cas de désaccord entre les deux fichiers, celui-ci l'emporte. Règles de travail : `AGENTS.md`. Stack et architecture : `CLAUDE.md`.

## État au 2026-10-27 (reprise par Claude Code)

- `main` : `e9ba7e26`, PR #88 (UI-FIX-03) fusionnée le 27 octobre après 48 contrôles verts. Bundle de départ mesuré sur ce `main` : 62 gardes vertes, **334 039 octets normalisés, 333 970 bruts, marge 24 361**, plafond 358 400 inchangé.
- Versions en service : PC et iPhone **1.0.2** (publiées le 26 octobre depuis `f473e113`, schéma 19). Mise à jour PC par la bannière seulement ; iPhone par SideStore sans désinstallation.
- Recette native : la 1.0.1 (paquet A, dix contrôles) est acceptée par Ali le 26 octobre. Le rendu natif de la refonte 1.0.2 (Nouvelle tâche, Détail) reste à vérifier : quatre contrôles dans `docs/essais-iphone.md`. Les lignes du backlog encore « en attente de vérification appareil » (I-06 A1 à A10, N-IOS-CHK-01, critère 18 de B5, clavier C-FIX-01, UIKit Y-IOS-06, N-FIX-02, N-IOS-FIX-01, A-07, N-03, K-05 à K-07, I-03) et REL-01 à REL-03 attendent qu'Ali dise ce que sa recette du 26 octobre a couvert.
- Défauts de la liste d'Ali du 27 octobre : 11, 12 (Rapport) et 14 corrigés par #88 (rouge e01b756e, vert ef10846f) ; 12 (Objectif), 13 (Concentration) et 15 (Objectif, un seul moyen d'ajouter) non commencés.
- Refonte des écrans : Nouvelle tâche et Détail livrés (UI-REFONTE-01, #86, **sans preuve rouge préalable**, story non « fait », voir sa fiche). Les huit autres écrans ne sont pas commencés : Aujourd'hui iPhone clair et sombre, Semaine, Synchronisation, Routines, Checklists, Événements, Aujourd'hui PC, Réglages PC. Une story par écran, test rouge avant le code, référence `docs/maquettes-refonte/` (PR #84, fusionnée le 27 octobre).
- Défaut signalé par Ali le 27 octobre (1.0.2) : deux routines modifiées, aucune notification reçue sur l'iPhone ni l'Apple Watch. Diagnostic sur le code fait : la replanification a lieu, la plage silencieuse décale sans supprimer, mais le remplacement sous le même numéro iOS n'était pas vérifiable (état faux muet). Story **N-FIX-03** ouverte et corrigée sur `n-fix-03-remplacement-verifie` (PR #90) selon la règle d'Ali : nouveau numéro, annulation après pose vérifiée, rappels conservés affichés. La cause de l'observation d'Ali attend ses journaux iPhone et la ligne de Réglages › Rappels.

## Ordre de travail convenu

1. N-FIX-03 : fusion de #90 après CI verte, mesure de main, puis lecture des journaux iPhone d'Ali pour établir la cause de son observation.
2. Défauts 12 (Objectif) et 15, puis 13 ; une story par écran.
3. Les huit refontes, dans l'ordre ci-dessus, un build iPhone par lot terminé.
4. Attendent Ali : les quatre contrôles natifs 1.0.2 ; la portée exacte de la recette du 26 octobre ; la validation de l'inventaire des worktrees avant toute suppression supplémentaire.

## Branches et worktrees vivants

- `passation-claude` (worktree `.claude/worktrees/n-ios-apercus`) : cette documentation et les corrections d'AGENTS.md / CLAUDE.md du 27 octobre.
- `pause-refonte-20261027` : trace du point de pause de Codex du 27 octobre, poussée ; son commit documentaire est repris dans `passation-claude`.
- `design-maquettes-refonte` (PR #84) : les onze maquettes, à jour de `main` par fusion (le commit bd3a80bf cité par UI-REFONTE-01 est conservé intact).
- `.claude/worktrees/codex-main-validation` : checkout détaché de `main` pour mesurer le bundle après chaque fusion.
- Branches à ne jamais fusionner : `i-06-a9-build-afterapply` (1226f203) et `i-06-a9-build-interruption` (2560945a), IPA de laboratoire A9.
- Branches mortes recensées le 27 octobre, suppression autorisée par Ali : `rel-02-audit`, `backup-y-fix-05-pre-rewrite`, `fix-speech-timer-tests`, `y-tech-03-scenarios-rouges`, `rel-03-publication-1-0`. Seize worktrees de branches fusionnées supprimés le 27 octobre ; le dossier `y-ios-07` résiste (chemin trop long sous Windows), à supprimer à la main.

## Décisions applicables (à ne pas rouvrir)

- **A9, 21 octobre 2026** : risque accepté pour l'usage mono-utilisateur ; redevient bloquant si l'app sort de l'usage personnel d'Ali. Trou assumé, ni story reportée ni essai réussi. Avant toute mise à jour changeant le schéma : vérification d'une sauvegarde iCloud récente (S1 à S4 du guide), jamais présentée comme une restauration éprouvée. A6b : vérification future en usage après la 1.0, non bloquante.
- **Référence visuelle, 27 octobre 2026** : `docs/maquettes-refonte/` pour les écrans qu'elle couvre, `docs/maquettes/` ailleurs (texte dans `AGENTS.md` et `CLAUDE.md`).
- **Preuve rouge, 27 octobre 2026** : test rouge avant, vert après, pour toute story sans exception, refontes comprises.
- **Périmètre, 27 octobre 2026** : écriture et suppression hors dépôt interdites ; données réelles (`%APPDATA%\fr.circletasks.planner`, dossier iCloud `CircleTasks`) intouchables ; lecture d'un fichier qu'Ali désigne permise.
- **Passes de travail, 19 octobre 2026, étendues le 27** : product-owner → agent du module → qa-test → code-reviewer, par tout agent, consignées dans la fiche.
- Les décisions antérieures (option B du report d'époque, rotation de segment B16, fenêtre de 7 jours B9, corps des notifications B10, exemption de contraste B11, bundle paliers 1 et 2 et garde par liste blanche, tolérance du lecteur B18, crochet NSIS B15, tri des défauts, méthode CI) restent celles de `docs/decisions.md` et de la section 5 de l'archive.

## Repères utiles

- Appareils : PC `7d0b4a0a-…`, iPhone `ef50b6f7-…` ; ancien PC `56d4eec1-…` oublié le 2026-10-17.
- Journaux : export iPhone dans iCloud Drive (`circletasks-logs-*.txt`), à lire seulement quand Ali désigne le fichier ; données PC dans `%APPDATA%\fr.circletasks.planner`, jamais touchées.
- Guide des essais iPhone : `docs/essais-iphone.md`. Audit 1.0 : `docs/audit-1.0.md`. Backlog : `docs/backlog.md`. Signalements non vérifiés de l'audit Codex du 19 octobre : section 8 de l'archive.
