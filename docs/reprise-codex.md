# Reprise — état courant du dépôt

Fichier court, pour tout agent (Codex, Claude Code ou autre) : l'état vivant et les décisions applicables, rien d'autre. Chaque jalon remplace la section « État au … » au lieu d'empiler un nouveau « point prioritaire ». L'historique du 19 au 27 octobre 2026, tel qu'il a été écrit au fil des reprises, est archivé dans `docs/reprise-historique-2026-10.md` ; en cas de désaccord entre les deux fichiers, celui-ci l'emporte. Règles de travail : `AGENTS.md`. Stack et architecture : `CLAUDE.md`.

## État au 2026-10-27, soir (Claude Code, écrit avant compaction à la demande d'Ali)

### Fusionné aujourd'hui dans `main`, dans l'ordre

| PR | Story | Contenu | Main après fusion | Bundle normalisé (marge) |
| --- | --- | --- | --- | --- |
| #88 | UI-FIX-03 | Rapport du mois : défauts 11, 12 (Rapport), 14 | e9ba7e26 | 334 039 (24 361) |
| #84 | DESIGN | Onze maquettes de refonte `docs/maquettes-refonte/` | 962893b1 | 334 039 (24 361) |
| #89 | PASSATION-02 | AGENTS.md et CLAUDE.md pour tout agent, reprise réduite, historique archivé, audits Codex commités | df9cbc5e | 334 039 (24 361) |
| #90 | N-FIX-03 | Remplacement vérifiable des notifications iOS : numéro neuf pour tout élément changé, ancien annulé après pose vérifiée, rappels conservés affichés | d6238ecb | 334 135 (24 265) |
| #91 | N-FIX-04 | Avertissement de plage silencieuse sur les trois formulaires et ligne « Rappels décalés » des routines | 522b9446 | 335 216 (23 184) |

Chaque fusion a attendu 48 contrôles verts et une revue consignée dans la fiche ; `main` remesuré après chacune. Versions en service : PC et iPhone **1.0.2** (26 octobre, source f473e113, schéma 19). N-FIX-03 et N-FIX-04 ne sont pas encore dans une version publiée : prochain lot iPhone à compiler quand Ali le décide (une compilation par lot).

### Reste à faire, dans l'ordre validé par Ali

1. #91 fusionnée (522b9446, bundle 335 216, marge 23 184) ; PR #92 (ce point d'état) en CI, à fusionner au vert.
2. **Défaut 12** : fait sur `ui-fix-04-retours` (UI-FIX-04, treize écrans), PR à ouvrir après la fusion de #91 et du point d'état.
3. **Défaut 15, Objectif** : un seul moyen d'ajouter quand le champ de saisie est déjà présent ; piste notée par Codex : masquer le bouton d'ajout tant qu'un brouillon est ouvert, conserver l'ajout après création ; préserver saisie, focus et persistance.
4. **Défaut 13, Concentration** : titre français sans capitales à la place de « Focus Time » ; Pause domine visuellement « Terminer la tâche » ; le total du jour ne reste plus à zéro pendant la première minute active.
5. **Les huit refontes**, une story par écran, dans cet ordre : Aujourd'hui iPhone clair et sombre, Semaine, Synchronisation, Routines, Checklists, Événements, Aujourd'hui PC, Réglages PC. Référence `docs/maquettes-refonte/` (sur `main` depuis #84) ; règles transversales du README du dossier ; les lignes « Rappels décalés » (N-FIX-04) et les avertissements de formulaire restent dans les refontes Routines et Événements. Nouvelle tâche et Détail sont déjà livrés (UI-REFONTE-01, #86) mais **sans preuve rouge préalable** : la story n'est pas « fait ».
6. Après ce travail : une compilation iPhone du lot, les contrôles natifs du guide, puis REL-01 à REL-03.

Pour chaque story : branche propre, fiche, commit de tests rouges avant le code, identifiants rouge et vert dans la fiche, passes product-owner → module → QA → revue consignées, bundle mesuré avant push et sur `main` après fusion, CI complète verte avant fusion.

### Décisions prises par Ali aujourd'hui (27 octobre 2026)

- **AGENTS.md vaut pour tout agent**, Claude Code compris ; CLAUDE.md y renvoie au lieu de répéter. Périmètre : écriture et suppression hors dépôt interdites ; données réelles (`%APPDATA%\fr.circletasks.planner`, dossier iCloud `CircleTasks`) intouchables ; lire un fichier qu'Ali désigne est permis. Plafond du bundle écrit en octets partout (358 400). Les deux pushs directs d'Ali sur `main` du 24 octobre étaient une exception assumée ; la règle ne change pas.
- **Référence visuelle** : `docs/maquettes-refonte/` pour les écrans qu'elle couvre, `docs/maquettes/` ailleurs.
- **Test rouge avant, vert après, pour toute story sans exception**, refontes comprises ; des tests écrits dans le même commit que le code ne valent pas preuve.
- **N-FIX-03** : nouveau numéro iOS pour tout élément changé ; ancien annulé seulement après la pose vérifiée du nouveau ; si la pose échoue et que l'ancien est conservé, l'app le dit. Raison : « on préfère toujours le défaut visible au silence ». Compromis sous le plafond de 64 : la notification la plus lointaine est déplacée pour faire place (ADR 0012, avenant N4).
- **Enquête du défaut 1.0.2 close** : routines Pro à 20:00, plage Pro 19:00–08:00 et week-end, rappels décalés au prochain matin de semaine à 08:00 comme prévu. Le défaut réel est le silence de l'app au moment du choix : **N-FIX-04**, bloquante par la règle de tri.
- **N-FIX-04** : avertissement immédiat sur les trois formulaires, création et modification, formulation unique « Rappel décalé au lundi 08:00 — aucun rappel Pro après 19:00 » ; **trois états** sur la ligne Routines (tous décalés, partiellement décalés en nommant ce qui est touché, rien), jamais silencieux par défaut ; **une phrase, une cause** : la plage qui explique ce décalage-là (journée entière avant horaire, plage du jour avant celle de la veille) ; « aucun rappel Pro le week-end » pour la journée entière.
- **Ordre** : N-FIX-04 d'abord, puis 12, 15, 13, puis les huit refontes.
- **Ménage** : seize worktrees de branches fusionnées supprimés, cinq branches mortes supprimées (rel-02-audit, backup-y-fix-05-pre-rewrite, fix-speech-timer-tests, y-tech-03-scenarios-rouges, rel-03-publication-1-0) ; `i-06-a9-build-afterapply` et `i-06-a9-build-interruption` conservées, à ne jamais fusionner.

### Ce qui attend Ali

- Supprimer lui-même le fichier parasite `iCloudDrive\CircleTasks\devices\7d0b4a0a-…\state 2.ctx` (copie de conflit iCloud du 24 octobre 11:20, ignorée par Rust à chaque cycle, sans effet sur les données) ; aucun agent ne touche à ce dossier.
- Supprimer à la main le dossier du worktree `.claude/worktrees/y-ios-07` (chemin trop long pour `git worktree remove` sous Windows).
- Dire ce que sa recette native du 26 octobre a couvert : les lignes du backlog encore « en attente de vérification appareil » (I-06 A1 à A10, N-IOS-CHK-01, critère 18 de B5, clavier C-FIX-01, UIKit Y-IOS-06, N-FIX-02, N-IOS-FIX-01, A-07, N-03, K-05 à K-07, I-03) et REL-01 à REL-03 restent ouvertes tant qu'il ne l'a pas dit.
- Les quatre contrôles natifs de la refonte 1.0.2 (`docs/essais-iphone.md`), puis, au prochain lot, l'observation de N-FIX-03 et N-FIX-04 sur l'iPhone.
- Valider l'inventaire des worktrees restants avant toute suppression supplémentaire (`docs/audits/2026-10-19-inventaire-worktrees.md`).

### Incidents du jour, consignés

- CI de #90 : un run annulé par le délai de 20 minutes du job `e2e iphone-webkit` pendant `playwright install-deps webkit` (miroir Ubuntu lent), avant tout test ; relance des jobs annulés suffisante. Aucun délai ni test modifié.
- Bundle de #91 : +1 081 octets normalisés avec un ensemble de modules du départ identique à `main` (82 octets bruts dans le bloc partagé, le reste par renommage des identifiants minifiés) ; un premier essai dans `routineStore.ts`, module du départ, a été retiré.

## Branches et worktrees vivants

- `n-fix-04-plage-silencieuse` (PR #91) et `etat-2026-10-27` (ce point d'état, à fusionner après #91), worktree `.claude/worktrees/codex-main-validation`.
- `.claude/worktrees/main-mesure` : checkout détaché de `main` pour mesurer le bundle après chaque fusion (dépendances copiées).
- `.claude/worktrees/n-ios-apercus` : branche `passation-claude` fusionnée (#89), à réutiliser pour la prochaine story.
- `pause-refonte-20261027` : trace du point de pause de Codex, poussée, reprise par #89 ; peut être supprimée.
- Checkout racine `C:\Dev\circletasks-kit` : branche `design-maquettes-refonte` (fusionnée par #84), fichiers temporaires `.codex-tmp/` ignorés.
- Branches à ne jamais fusionner : `i-06-a9-build-afterapply` (1226f203) et `i-06-a9-build-interruption` (2560945a), IPA de laboratoire A9.

## Décisions applicables (à ne pas rouvrir)

- **A9, 21 octobre 2026** : risque accepté pour l'usage mono-utilisateur ; redevient bloquant si l'app sort de l'usage personnel d'Ali. Trou assumé, ni story reportée ni essai réussi. Avant toute mise à jour changeant le schéma : vérification d'une sauvegarde iCloud récente (S1 à S4 du guide), jamais présentée comme une restauration éprouvée. A6b : vérification future en usage après la 1.0, non bloquante.
- Les décisions du 27 octobre ci-dessus (périmètre, référence visuelle, preuve rouge, N-FIX-03, N-FIX-04, ordre).
- **Passes de travail, 19 octobre 2026, étendues le 27** : product-owner → agent du module → qa-test → code-reviewer, par tout agent, consignées dans la fiche.
- Les décisions antérieures (option B du report d'époque, rotation de segment B16, fenêtre de 7 jours B9, corps des notifications B10, exemption de contraste B11, bundle paliers 1 et 2 et garde par liste blanche, tolérance du lecteur B18, crochet NSIS B15, tri des défauts, méthode CI) restent celles de `docs/decisions.md` et de la section 5 de l'archive.

## Repères utiles

- Appareils : PC `7d0b4a0a-…`, iPhone `ef50b6f7-…` ; ancien PC `56d4eec1-…` oublié le 2026-10-17.
- Journaux : export iPhone dans iCloud Drive (`circletasks-logs-*.txt`), à lire seulement quand Ali désigne le fichier (dernier lu : `circletasks-logs-20261027-1605.txt`) ; données PC dans `%APPDATA%\fr.circletasks.planner`, jamais touchées.
- Guide des essais iPhone : `docs/essais-iphone.md`. Audit 1.0 : `docs/audit-1.0.md`. Backlog : `docs/backlog.md`. Signalements non vérifiés de l'audit Codex du 19 octobre : section 8 de l'archive.
- Mesure du bundle hors test : `VITE_CT_E2E_HOOKS= npm run build -- --outDir <dossier> --emptyOutDir --manifest` puis `node tests/bundle/measureStart.ts <dossier>` ; les cartes de source des blocs de départ permettent de comparer les modules du départ entre deux builds.
