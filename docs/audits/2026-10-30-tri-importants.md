# Tri des défauts « importants » de l'audit 1.0 — 30 octobre 2026

Source : `docs/audit-1.0.md` section 4 et rapports détaillés `docs/audits/2026-10-16/`. Base : `main` 515baaae. Tri demandé par Ali le 2026-10-30. Aucune correction dans ce document.

## Comment lire

**Le chiffre « 81 » de l'audit ne se retrouve pas ligne à ligne.** Les rapports détaillés contiennent 99 lignes « Important » et la section 4 les regroupe par domaine (7 + 1 + 6 + 7 + 3 + 7 + 18 + 13 + 14 + 2 + 21 = 99, pas 81). Le tri ci-dessous repart des rapports, fusionne les doublons évidents (taille de texte iOS ×3, cibles tactiles ×2, bundle ×3, backlog ×2, fuseau CI ×2, interrupteurs en sombre ×3) et compte **88 défauts distincts**, numérotés TRI-01 à TRI-88. Je n'ai pas pu reconstituer la façon dont l'audit arrive à 81 ; aucun défaut n'a été retiré sans raison écrite, et les quelques lignes de la section 4 que les rapports ne détaillent pas (écrans d'échec par plateforme, complément du 2026-10-17) relèvent de la restauration interrompue déjà traitée (A9, trou assumé).

Paquets :

- **A** — objectivement faux ou cassé, rien à arbitrer. Corrigé sans demander, en lots de cinq à dix par PR, règles habituelles (test rouge avant, vert après, passes distinctes, CI « suite verte »).
- **B** — confort, goût, ou mesure préalable nécessaire. Rien n'est fait avant un signalement d'Ali.
- **C** — pas corrigé, avec la raison.
- **D** — **sortis du tri : perte de données ou état faux muet** (règle d'Ali du 2026-10-19). Ce sont des bloquants d'office avant la 1.0, avec story ouverte et Ali informé ; ils ne sont pas dans le paquet A.
- **F** — déjà corrigés depuis l'audit (preuve citée).
- **X** — attend Ali (essai sur l'appareil ou décision), aucun code avant.

Heures : estimation de l'audit, au milieu de la fourchette ; elle date du 16 octobre et n'a pas été recalculée. « Revérifier » = le constat date d'avant les huit refontes ; le premier geste est un test rouge, et s'il ne peut pas être rouge le défaut est clos « déjà corrigé » avec la preuve.

## Totaux

| Paquet | Défauts | Coût (audit, non recalculé) |
|---|---|---|
| A — à corriger sans demander | 35 | 75,5 h, soit 4 à 5 lots de 7 à 9 |
| B — à corriger si ça te gêne | 13 | 51 h, à engager au cas par cas |
| C — à ne pas corriger | 16 | 0 h (l'audit en chiffrait environ 105 h) |
| D — bloquants sortis du tri, à valider | 13 | 54 h |
| F — déjà corrigés | 8 | déjà payés |
| X — attendent Ali | 3 | 12 h après ta réponse |
| **Total** | **88** | |

## Synchro

| ID | Constat | Paquet | h | Raison / état actuel |
|---|---|---|---|---|
| TRI-01 | Fichier verrouillé un instant classé « corrupt » collant (`store.rs:601`) : bandeau « illisibles » à tort, iPhone exclu, plus d'instantané ni de purge | D | 3 | état faux ; l'entretien est sauté sans le dire |
| TRI-02 | Horloge en avance : impasse d'un mois après correction de la date (`hlc.ts:84`) | D | 6 | les écritures gagnent tous les conflits sans action possible ; la décision ADR §4.4 est aussi à prendre |
| TRI-03 | `writeState` refusé en silence à l'étape 6 (`engine.ts:926`) | D | 2 | « À jour » alors que rien n'est annoncé |
| TRI-04 | `missing-parent` sans avertissement, abandon au plafond de 10 000 | D | 2 | opération perdue sans signe visible |
| TRI-05 | Changement d'époque figé sur un instantané supprimé (`epochSwitch.ts:323-350`) | D | 3 | « En attente d'iCloud » pour toujours, même famille que B18 |
| TRI-06 | `cap-dropped` / `publish-too-large` / `apply-abandoned` : journal seul, une note de plus de 256 Kio n'est jamais publiée | D | 4 | perte silencieuse |
| TRI-07 | Aucun acquittement d'un conflit sans restauration (demande d'Ali du 2026-10-17) | A | 2,5 | action « Garder cette valeur » qui pose `resolved_at` ; revérifier après UI-REFONTE-04 (« Rétablir » existe, pas « Garder ») |

## Sécurité

| ID | Constat | Paquet | h | Raison / état actuel |
|---|---|---|---|---|
| TRI-08 | Clé de signature exposée au build du front ; pas de `npm audit` en CI | F | 3 | CI-SEC-01 (#69) ; `npm audit` zéro avis consigné par REL-02 (#79) |

## iOS

| ID | Constat | Paquet | h | Raison / état actuel |
|---|---|---|---|---|
| TRI-09 | Deux sélecteurs de documents, gardes absentes | F | 3 | Y-IOS-06 (#71) |
| TRI-10 | `"error"` passager converti en `unsafe-folder` permanent | A | 2 | minuteur arrêté et « choisissez un autre dossier » pour un incident passager ; testable côté TS et Rust |
| TRI-11 | Clavier absent à la création d'une checklist | F | 2 | C-FIX-01 (#70) |
| TRI-12 | Fuite des accès de sécurité au dossier (plus de 288 par jour) | A | 1 | correctif Swift : preuve rouge non exécutable en local, contrôle statique et vérification sur ton IPA |
| TRI-13 | `delete`/`upsert`/`setCompleted` de rappel Apple sans `externalRef` | D | 2 | la suppression « réussit » sans supprimer : état faux muet |
| TRI-14 | Taille de texte iOS (`-apple-system-body`) non suivie | C | — | décision d'Ali du 2026-10-17 : exigence retirée du PRD (PRD-01), à revoir après la 1.0 |

## Notifications

| ID | Constat | Paquet | h | Raison / état actuel |
|---|---|---|---|---|
| TRI-15 | Titre et corps passés comme clés de localisation (`%` déformés) | X | 3 | essai N-IOS-CHK-01 à faire par Ali sur l'appareil ; aucun code avant son résultat |
| TRI-16 | Fuseau : déclencheur à durée absolue, 09:00 Paris sonne à 03:00 après un vol jusqu'à l'ouverture | B | 6 | cas rare, limite déjà affichée (`zoneLimit`) ; à valider sur appareil |
| TRI-17 | N-07 trop permissif : compare à la dernière synchro, aveugle aux rappels supprimés ou déplacés | D | 6 | l'avertissement dit « tout va sonner » à tort |
| TRI-18 | `get_pending` ne compare que l'identifiant ; « Autorisé » ignore aperçus, écran verrouillé, Concentration | D | 8 | le remplacement non vérifié est traité par N-FIX-03 (#90) ; le reste (réglages réels) est la classe du bug d'Ali, état faux muet |
| TRI-19 | Fin de Focus tronquée à la minute, faux échec « n'a pas pu être planifiée » | A | 1,5 | fin à 14:25:37 déclenchée à 14:25:00, ou date passée si moins d'une minute |
| TRI-20 | Priorité sous 64 purement chronologique, récapitulatifs qui prennent la moitié des places | B | 3 | réglage de comportement, à trancher à l'usage |
| TRI-21 | `delegateAtLaunch` possiblement faux en permanence | C | — | on ne corrige pas sans constat : à lire dans la séance N-03 A2 ; si le bandeau apparaît, le défaut est visible et signalable |

## Données

| ID | Constat | Paquet | h | Raison / état actuel |
|---|---|---|---|---|
| TRI-22 | `transaction-lost` laisse `sync_guard` : écritures locales hors `sync_outbox` jusqu'au redémarrage, migration à moitié appliquée | D | 7 | écritures qui ne partent jamais, sans signe |
| TRI-23 | Lot de 500 opérations en une transaction : `transaction-wait-timeout` sur iPhone | B | 5 | « à confirmer » : mesure sur l'appareil d'abord |
| TRI-24 | Un enregistrement fautif bloque toute la synchro (INSERT simple, unicité) | D | 3,5 | synchro arrêtée, curseur figé |

## Métier

| ID | Constat | Paquet | h | Raison / état actuel |
|---|---|---|---|---|
| TRI-25 | `firstWeekday` / `timeFormat` reçus non appliqués avant redémarrage | A | 3 | contraire à P-03 critères 8 et 9 ; revérifier après UI-REFONTE-09 |
| TRI-26 | Taux 7/30/90 jours des routines « X fois par semaine » faux hors semaine ISO | A | 5 | 25 % au lieu de 100 % ; règle retenue : quota proratisé sur la fenêtre, écrite dans R-06 |
| TRI-27 | Série cassée par une pause partielle | A | 1,5 | contraire à R-04 critère 5 ; les deux calculs se contredisent |
| TRI-28 | Avertissement PC N-07 lit `fire_at` figé | D | 4,5 | PC compte 0 quand l'iPhone sonne, et inversement |
| TRI-29 | Statistiques H-01/H-02 structurellement proches de 100 % (report nocturne) | X | 7 | décision n°4 d'Ali : conserver la date d'origine (migration) ou documenter la limite |
| TRI-30 | Tests DST en UTC, fuseau non épinglé en CI, oracles tautologiques (fusionné avec le constat QA « fuseau non épinglé ») | A | 3 | matrice `TZ` Europe/Paris, Pacific/Auckland, America/Los_Angeles ; tests du 25 octobre et du 29 mars |
| TRI-31 | Seuil de couverture du domaine à 80 % au lieu de 90 % | C | — | `AGENTS.md` : le seuil de 80 % ne bouge pas ; à rouvrir par Ali seulement |

## Écrans 393 pt

| ID | Constat | Paquet | h | Raison / état actuel |
|---|---|---|---|---|
| TRI-32 | Encoche cumulée avec le haut fixe (47 pt de décalage) | A | 1,5 | calculé sur le CSS ; revérifier (`AppShell.css` utilise maintenant `--ct-safe-area-top`) |
| TRI-33 | Carte de routine qui déborde à 289 pt | A | 1,5 | revérifier : UI-REFONTE-05 a refait la carte |
| TRI-34 | Roues d'événement rognées | A | 1,5 | revérifier : `EventDateWheels.css` a changé depuis |
| TRI-35 | Liste d'Aujourd'hui écrasée en défilement imbriqué | B | 4 | « à confirmer en capture » ; UI-REFONTE-02 a refait l'écran |
| TRI-36 | Aucune gestion du clavier sur les feuilles et pieds collants | B | 6 | « à confirmer sur appareil » ; `visualViewport` déjà utilisé par `TaskViewportSheet` et `WeekDayAdd` |
| TRI-37 | Champs à 15 pt : zoom iOS au focus | A | 1,5 | revérifier sur `TextField`, `RecurrencePicker`, `ScanDialog` |
| TRI-38 | Lignes de Réglages à 38 pt | A | 0,5 | encore présent (`SettingsScreen.css:48`) |
| TRI-39 | Puces Aujourd'hui/Demain/Un jour à 28 pt | A | 0,5 | revérifier |
| TRI-40 | Zones tactiles de 32 à 40 pt (une quinzaine d'écrans), fusionné avec le constat d'accessibilité « cibles < 44 pt » | A | 4 | règle globale `pointer: coarse` et test qui mesure les cibles |
| TRI-41 | Icône/emoji (~20 pt), titre de ligne (~25 pt), grille du mois (36 pt) | A | 1 | zone de 44 par pseudo-élément |
| TRI-42 | Textes de 11 à 12 pt | B | 3 | plancher de 13 pt : choix de lisibilité, à voir à l'usage |
| TRI-43 | Interrupteurs illisibles en sombre (fusionné avec le constat d'accessibilité) | F | 2 | UI-FIX-01 (#57) |
| TRI-44 | Icônes, anneau de sélection et bordures de champ sous 3:1 (fusionné avec le constat d'accessibilité) | A | 2,5 | revérifier : le test de contraste d'UI-FIX-01 couvre les paires de texte, pas forcément ces trois |
| TRI-45 | `icon-red` utilisé comme texte d'erreur dans Oublier l'appareil | A | 0,25 | jeton `--ct-color-danger` |
| TRI-46 | Polices de l'écran d'association non embarquées (`'DM Sans'` ≠ `'DM Sans Variable'`) | A | 0,75 | encore présent (`IosPairingScreen.css:18,53`) |
| TRI-47 | Focus terminé : boutons du bas rognés | B | 2 | « à confirmer » par capture |
| TRI-48 | Dialogues sans hauteur maximale | A | 1 | revérifier : `max-height: 100%` présent sur deux dialogues, `overflow` à contrôler |

## Accessibilité et textes

| ID | Constat | Paquet | h | Raison / état actuel |
|---|---|---|---|---|
| TRI-49 | Hauteurs fixes et 60 polices en px à 200 % | C | — | conséquence directe de la taille de texte iOS, exigence retirée (TRI-14) |
| TRI-50 | Toast peu annoncé, 5 s non suspendues pour VoiceOver | B | 3 | à signaler si tu utilises VoiceOver |
| TRI-51 | Focus perdu au retour de huit sous-écrans de Réglages | B | 3 | clavier et lecteur d'écran seulement |
| TRI-52 | `disabled` sans `aria-busy` sur les actions longues | B | 3 | idem |
| TRI-53 | Codes bruts affichés (« code state-mismatch », « Code : bad-name »), contraire à l'ADR 0003 | A | 4 | contredit une règle écrite ; phrase par famille, code dans « Détail technique » |
| TRI-54 | Jargon « instantané / époque / schéma » | B | 2 | vocabulaire ; UI-REFONTE-04 a déjà repris la carte de synchro |
| TRI-55 | Textes en dur dans Rust (page OAuth, boîtes natives, titres de fenêtre) | A | 4 | contraire à la règle « textes dans `src/i18n`, jamais en dur » |
| TRI-56 | Roue des minutes : `10:03` réécrit en `10:05` dès qu'on touche l'heure ; jours bornés ; pas de `spoken` | D | 3 | une heure saisie est changée sans le dire ; gravité faible. La décision n°5 (pas de 5 ou de 1) reste à toi |
| TRI-57 | `behavior: 'smooth'` explicite ignore `prefers-reduced-motion` | A | 1 | utilitaire `scrollBehavior()` existant |
| TRI-58 | Pas de lien d'évitement, trois boutons tabulables par ligne de tâche, rail sans tabindex itinérant | B | 3 | PC au clavier seulement |

## Tests et CI

| ID | Constat | Paquet | h | Raison / état actuel |
|---|---|---|---|---|
| TRI-59 | WebKit ne joue que 2 specs sur 120 | C | — | 10 h et une CI WebKit déjà lente (CI-WEBKIT-01) ; à rouvrir si un défaut WebKit passe |
| TRI-60 | e2e sur serveur de développement, jamais sur le build de production | C | — | 8 h ; aucun défaut de production de ce type observé ; les budgets et le smoke jouent déjà sur le build |
| TRI-61 | Base de test `sqlite-wasm` 3.53 contre SQLite ~3.46 en production | C | — | 8 h ; à rouvrir à la prochaine migration |
| TRI-62 | Aucun smoke iPhone | C | — | pas de Mac, aucune commande iOS locale (`CLAUDE.md`) ; le smoke simulateur est « hors palier » |
| TRI-63 | Publication sur tag sans vérifier « suite verte » du commit | A | 3 | un tag sur un commit rouge publie |
| TRI-64 | Ni plancher de tests ni plafond de `skip` | A | 3 | test de `test-counts.mjs` et `ci/floors.json` |
| TRI-65 | Seuils de couverture (global, sync, repositories) | C | — | même règle que TRI-31 |
| TRI-66 | Parcours 1 sans étape langue/notifications ni rechargement, avec l'horloge réelle | A | 3 | `page.clock.install` |
| TRI-67 | Parcours 2 PRD absent | F | 8 | J02 intégré par REL-01 (#78) |
| TRI-68 | `matchMedia` et CSS absents de jsdom | C | — | 4 h ; les e2e portent la visibilité |
| TRI-69 | Largeurs 393/390 jamais testées, pc à 1440 au lieu de 1280 | A | 2 | ajouter les largeurs aux projets e2e |
| TRI-70 | 26 `waitForTimeout` et ~60 `setTimeout` de « preuve par absence » | A | 6 | contraire à la règle « aucun délai ajouté » ; repères d'état et horloge simulée |
| TRI-71 | `memory.ts` seul faux pour tout ; conformité Rust sur 3 cas | C | — | 8 h ; Y-TECH-03 a déjà étendu la conformité |
| TRI-72 | Checklist ordre 5 sans texte verrouillé, fichiers évincés, clavier, roue, safe areas | F | 1 | remplacée par `docs/essais-iphone.md` (36 lignes) |
| TRI-73 | Budgets de performance sans IPC, démarrage à froid iPhone jamais mesuré | C | — | 4 h ; mesure physique, ligne du guide d'essais plutôt que du code |

## Code, ADR, architecture

| ID | Constat | Paquet | h | Raison / état actuel |
|---|---|---|---|---|
| TRI-74 | Bundle de départ à 349,9/350 Ko et `INEFFECTIVE_DYNAMIC_IMPORT` (fusionnés) | F | 8 | BUNDLE-01 (#61), marge de 20 383 octets sur `main` |
| TRI-75 | Lecture stricte de l'état : toute extension du format impose `sm` 2 | X | 2 | décision n°8 d'Ali : objet `ext` ignoré ou `sm` 2 obligatoire, avant tout changement du format |
| TRI-76 | Règles de protocole en trois exemplaires, 9 constantes sur 37 comparées | A | 3 | test croisé complet des constantes Rust/TS |
| TRI-77 | ADR 0011 contradictoire (nombre de commandes, §9.1 / §24.6, maîtrise Rust/TS) et consolidation des ADR | C | — | « consolidation des ADR » reportée après la 1.0 par Ali (audit, section 5) ; §9.1 déjà récrite par Y-TECH-04 |
| TRI-78 | Backlog et dettes faux (stories livrées « à faire ») | F | 2 | réconcilié le 2026-10-19 |
| TRI-79 | Commandes de sauvegarde absentes de tout ADR | A | 1 | avenant ADR 0009 |
| TRI-80 | Marqueur de restauration écrit avant l'échange ; `local:true` restaure une sauvegarde pré-migration sans marqueur | C | — | **reclassé après la 1.0 par Ali le 2026-10-30** : rien n'est perdu (`restore_backup_file` copie d'abord la base en place en sauvegarde « avant restauration »), le comportement est délibéré depuis la revue I-06 (test `i06_update_restore_is_a_local_rollback_without_any_sync_marker`), et une garde toucherait le chemin de récupération qu'A9 n'a pas vérifié sur appareil : on ne restreint pas ce qu'on ne sait pas tester |
| TRI-81 | ADR 0002 périmé, plugin SQL copié sans procédure, pont JS `^2.5.0` | A | 2 | avenant et test de cohérence des versions |
| TRI-82 | Règle métier Rappels Apple dans une feature, avec `localeCompare` | A | 4 | contraire à « règles métier dans `src/domain` » |
| TRI-83 | `import('@tauri-apps/api/window')` dans une feature | A | 1 | port dans `src/platform` et règle ESLint |
| TRI-84 | `Brand<Id>` qui se réduit à `never` | B | 8 | invisible à l'usage, coût élevé : à ouvrir seulement après un mélange d'identifiants constaté |
| TRI-85 | Taille d'installeur non mesurée depuis 0.1.0 | A | 1 | tableau de l'ADR 0006 et mesure en CI (REL-03 a mesuré 1.0.x) |
| TRI-86 | Licences incomplètes | A | 1,5 | obligation légale avant la 1.0 |
| TRI-87 | Somme des têtes non surveillée côté moteur | C | — | risque faible (~2^21 sur dix ans) |
| TRI-88 | `engine.ts` de 860 lignes à découper | C | — | « reporté après la 1.0 » dans l'audit ; geler le fichier |

## Suites du 2026-10-30 (arbitrage d'Ali)

Avant la 1.0 : TRI-03 (fait, #117), TRI-22 (fait, #120), TRI-24 (PR #121), TRI-13 (PR #123). Échec rendu visible seulement : TRI-06 et TRI-04. Après la 1.0 : TRI-02, TRI-17, TRI-28, TRI-56, TRI-01, TRI-05, TRI-18 (réserve : ligne 37 de la séance), TRI-80 (voir sa ligne). Le paquet A attend la fin des bloquants.
