# Backlog CircleTasks

121 user stories, triées par ordre de construction (PRD section 9). Critères d'acceptation : docs/PRD.md section 4.

Statuts : à faire · en cours · en revue · fait. Le product-owner tient ce fichier à jour.

## Ordre 0 — Préparation

| ID | Tâche | Responsable | Statut |
| --- | --- | --- | --- |
| PREP-01 | Prérequis et comptes (PRD section 2) | Ali | fait (secrets GitHub créés le 2026-10-04 : TAURI_SIGNING_PRIVATE_KEY, _PASSWORD, RELEASES_TOKEN ; environnement « releases ») |
| PREP-02 | Initialiser le dépôt, installer CLAUDE.md, .claude/agents et docs/ | Ali + architect | fait |
| PREP-03 | Archiver le PRD v3 et le scaffold Expo dans docs/archive/, comparer les 45 anciennes stories (v3 + Expo manquants) | product-owner | fait (v3 + Expo indisponibles) |
| PREP-04 | Installer les polices Fraunces et DM Sans en local et la bibliothèque lucide-react | ui-design-system | fait |

## Ordre 1 — Socle

| ID | Module | User story | Agent | Statut |
| --- | --- | --- | --- | --- |
| T-01 | M1 | Je crée une tâche avec un titre seul | tasks-planning | fait |
| T-02 | M1 | J'affecte une date et une heure optionnelle | tasks-planning | fait |
| T-03 | M1 | J'ajoute une note et une icône | tasks-planning | fait |
| T-04 | M1 | Je marque une tâche terminée | tasks-planning | fait |
| T-05 | M1 | Je reporte une tâche | tasks-planning | fait |
| T-06 | M1 | Les tâches non faites passent au lendemain | tasks-planning | fait |
| T-07 | M1 | Je consulte les tâches terminées | tasks-planning | fait |
| T-08 | M1 | Je supprime une tâche | tasks-planning | fait |
| T-09 | M1 | Je rends une tâche récurrente | tasks-planning | fait |
| T-10 | M1 | Je modifie ou arrête une récurrence | tasks-planning | fait |
| T-11 | M1 | Mes heures restent justes quand je change de pays | tasks-planning | fait |
| T-12 | M1 | Je duplique une tâche | tasks-planning | fait |
| T-13 | M1 | J'annule ma dernière action | tasks-planning | fait |
| T-14 | M1 | Je choisis une date adaptée à mon appareil | tasks-planning | fait |
| A-01 | M2 | J'ouvre l'app sur la liste du jour | tasks-planning | fait |
| A-02 | M2 | Je réordonne ma liste | tasks-planning | fait |
| A-03 | M2 | Je masque les routines de la liste du jour | tasks-planning | fait |
| A-04 | M2 | J'accède à Aujourd'hui en un geste | tasks-planning | fait |
| A-05 | M2 | Je passe en mode édition | tasks-planning | fait |
| A-06 | M2 | Je replie la liste en vue compacte | tasks-planning | fait |
| A-08 | M2 | J'ouvre la fiche détail d'une tâche | tasks-planning | fait |
| A-09 | M2 | Je vois toujours l'état de l'app | tasks-planning | fait (critère 9 soldé avec les bandeaux de Y-10 et Y-11) |
| S-01 | M3 | Je vois ma semaine en 7 colonnes (PC) ou 7 sections (iPhone) | tasks-planning | fait |
| S-02 | M3 | Je déplace une tâche d'un jour à l'autre | tasks-planning | fait |
| S-03 | M3 | Je navigue entre semaines | tasks-planning | fait |
| S-04 | M3 | Je crée une tâche directement dans un jour | tasks-planning | fait |
| S-05 | M3 | Je vois les événements calendrier dans la semaine | tasks-planning | fait |
| S-06 | M3 | Je planifie depuis « Un jour » en glissant | tasks-planning | fait |
| R-01 | M4 | Je crée une routine avec icône et fréquence | routines | fait |
| R-02 | M4 | J'associe une heure optionnelle | routines | fait |
| R-03 | M4 | Je valide une routine du jour | routines | fait |
| R-04 | M4 | Je suis ma série | routines | fait |
| R-05 | M4 | Je mets une routine en pause ou l'archive | routines | fait |
| R-06 | M4 | Je consulte le rapport de routine | routines | fait |
| R-07 | M4 | Je planifie une routine tous les N jours ou toutes les N semaines | routines | fait |
| N-02 | M5 | Je choisis une avance (0, 5, 15, 30, 60 min, 1 jour) | notifications | fait |
| N-04 | M5 | Je règle un récapitulatif matin et soir | notifications | fait |
| ES-01 | M13 | J'ai deux espaces Pro et Perso | spaces-goals | fait |
| ES-02 | M13 | Chaque élément appartient à un espace | spaces-goals | fait |
| ES-03 | M13 | Je filtre Pro / Perso / Tout | spaces-goals | fait |
| ES-04 | M13 | Je crée des projets dans un espace | spaces-goals | fait |
| ES-05 | M13 | Je déplace un élément d'un espace ou projet à l'autre | spaces-goals | fait |
| ES-06 | M13 | Je rattache un agenda externe à un espace | spaces-goals | fait |
| ES-07 | M13 | Je définis des plages silencieuses par espace | spaces-goals | fait |
| ES-08 | M13 | Je vois statistiques et Focus par espace et projet | spaces-goals | fait |
| D-01 | M16 | L'app PC reste active en zone de notification | desktop-tauri | fait |
| D-02 | M16 | L'app PC démarre avec Windows | desktop-tauri | fait |
| D-03 | M16 | Je mets à jour l'app PC | desktop-tauri | fait (0.1.0 → 0.1.1 vérifiée par Ali le 2026-10-05) |
| OB-01 | M17 | Je fixe un objectif pour la semaine | spaces-goals | fait |
| OB-02 | M17 | J'épingle l'objectif en haut de ma liste | spaces-goals | fait |
| OB-03 | M17 | Je rattache une tâche à un objectif | spaces-goals | fait |
| OB-04 | M17 | Je vois l'avancement de l'objectif | spaces-goals | fait |
| OB-05 | M17 | Je reconduis un objectif non atteint | spaces-goals | fait |
| OB-06 | M17 | Je consulte mes objectifs passés | spaces-goals | fait |
| SD-01 | M18 | J'ajoute une tâche sans date dans « Un jour » | spaces-goals | fait |
| SD-02 | M18 | Je planifie une tâche « Un jour » en un geste | spaces-goals | fait |
| SD-03 | M18 | Je renvoie une tâche datée vers « Un jour » | spaces-goals | fait |
| SD-04 | M18 | J'organise la liste « Un jour » | spaces-goals | fait |

## Ordre 1 bis — Vérification iPhone

| ID | Tâche | Responsable | Statut |
| --- | --- | --- | --- |
| POC-01 | Workflow build-ios.yml, IPA non signée, installation par SideStore, affichage de la liste du jour | ci-release + ios-mobile | fait |

## Ordre 2 — Organisation

| ID | Module | User story | Agent | Statut |
| --- | --- | --- | --- | --- |
| C-01 | M6 | Je crée une checklist nommée | checklists-events | fait |
| C-02 | M6 | Je coche des items | checklists-events | fait |
| C-03 | M6 | J'associe une checklist à un jour | checklists-events | fait |
| C-04 | M6 | Je réutilise une checklist modèle | checklists-events | fait |
| C-05 | M6 | J'efface d'un coup les items cochés | checklists-events | fait |
| E-01 | M7 | Je crée un événement daté, avec ou sans heure | checklists-events | fait |
| E-02 | M7 | Je crée un anniversaire ou une date importante | checklists-events | fait |
| E-03 | M7 | J'affiche les jours fériés | checklists-events | fait |
| E-04 | M7 | Je vois un compte à rebours | checklists-events | fait |
| K-01 | M8 | Je connecte Google Calendar | calendar-integration | en cours (vérifié sur simulateur ; connexion réelle : ID client OAuth d'Ali) |
| K-02 | M8 | Je connecte Apple Calendar | calendar-integration | en cours (vérifié sur simulateur ; connexion réelle : mot de passe d'application iCloud d'Ali) |
| K-03 | M8 | Mes événements externes se mettent à jour | calendar-integration | fait |
| K-04 | M8 | Je crée une tâche depuis un événement externe | calendar-integration | fait |
| RC-01 | M14 | Je cherche n'importe quel élément | spaces-goals | fait |
| RC-02 | M14 | Je filtre les résultats | spaces-goals | fait |
| RC-03 | M14 | J'ouvre un résultat | spaces-goals | fait |
| RC-04 | M14 | Je retrouve mes recherches récentes | spaces-goals | fait |

## Ordre 3 — Fonctions avancées

| ID | Module | User story | Agent | Statut |
| --- | --- | --- | --- | --- |
| Q-01 | M9 | J'ajoute une tâche depuis n'importe où sur PC | quick-capture | fait |
| Q-02 | M9 | Je saisis en langage naturel | quick-capture | fait |
| Q-03 | M9 | Je dicte une tâche | quick-capture | fait |
| Q-04 | M9 | Je photographie une liste manuscrite | quick-capture | fait |
| Q-06 | M9 | Je choisis espace et projet en tapant | quick-capture | fait |
| F-01 | M10 | Je lance une session sur une tâche | focus-time | fait |
| F-02 | M10 | Je fais une pause | focus-time | fait |
| F-03 | M10 | Je vois mon temps de concentration | focus-time | fait |
| F-04 | M10 | La fin de session me notifie | focus-time | fait |
| H-01 | M11 | Je vois ce que j'ai accompli ce mois-ci | stats-history | fait |
| H-02 | M11 | Je vois mon taux de complétion | stats-history | fait |
| H-03 | M11 | J'exporte mon historique | stats-history | fait |
| P-01 | M12 | Je réordonne et masque les onglets | settings-personalization | fait |
| P-02 | M12 | Je choisis clair, sombre ou système | settings-personalization | fait |
| P-03 | M12 | Je règle le premier jour de semaine, la langue et le format d'heure | settings-personalization | fait |
| P-04 | M12 | Je sauvegarde et restaure mes données | settings-personalization | en cours (PC fait ; critère 11 iPhone à l’ordre 5, avec le plugin Fichiers) |
| P-05 | M12 | Je suis guidé au premier lancement | settings-personalization | fait |
| P-06 | M12 | Un écran vide m'indique quoi faire | settings-personalization | fait |
| P-07 | M12 | J'importe mes tâches existantes | settings-personalization | fait |
| P-08 | M12 | Je consulte les raccourcis clavier | settings-personalization | fait |
| D-04 | M16 | J'utilise les raccourcis clavier | desktop-tauri | fait |

## Ordre 4 — Synchro

| ID | Module | User story | Agent | Statut |
| --- | --- | --- | --- | --- |
| Y-01 | M15 | Je choisis le dossier de synchro | sync-icloud | fait (lot Y1, critère 16 branché au lot Y2 ; vérifications manuelles d'Ali dans la fiche) |
| Y-02 | M15 | Mes données se synchronisent seules | sync-icloud | fait (lot Y2 ; vérifications manuelles d'Ali dans la fiche) |
| Y-03 | M15 | Je lance une synchro manuelle | sync-icloud | fait (lot Y2 ; vérifications manuelles d'Ali dans la fiche) |
| Y-04 | M15 | Je consulte les conflits | sync-icloud | fait (lot Y3 ; conflit réel PC / iPhone à l'ordre 5) |
| Y-05 | M15 | Je travaille hors ligne | sync-icloud | fait (parcours 10 à deux pages, lot Y3) |
| Y-06 | M15 | Je raccorde un nouvel appareil | sync-icloud | fait (lot Y3 ; scan réel par l'iPhone à l'ordre 5) |
| Y-07 | M15 | Mes deux appareils n'ont pas la même version | sync-icloud | fait (lot Y3 ; vérification réelle à l'ordre 5) |
| Y-08 | M15 | Mes données dans iCloud sont chiffrées | sync-icloud | fait (parcours 11 vert, validation security-privacy du 2026-10-06) |
| Y-09 | M15 | Un élément supprimé ne réapparaît jamais | sync-icloud | fait (lot Y2 ; vérifications manuelles d'Ali dans la fiche) |
| Y-10 | M15 | J'oublie un appareil (audit ADR 0011 H7) | sync-icloud | fait (lot Y4 ; cas réel avec l'iPhone à l'ordre 5 ; texte du PRD M15 à ajouter par Ali) |
| Y-11 | M15 | Je réinitialise la synchronisation avec une nouvelle clé (audit ADR 0011 H8) | sync-icloud | fait (lot Y4 ; cas réel avec l'iPhone à l'ordre 5 ; texte du PRD M15 à ajouter par Ali) |
| Y-TECH-01 | M15 | Story technique avant l'ordre 5 : état réécrit seulement s'il change, positions après remplacement, anti-rejeu des lectures (dettes de Y-10 et Y-11) | sync-icloud | fait (2026-10-07) |
| Y-TECH-02 | M15 | Revue d'ensemble de fin d'ordre 4 : décisions ADR 0011 §21, échecs visibles, segment absent et trou impossible à combler, couches et code mort | sync-icloud | fait (2026-10-07) |

Ordre de construction de l'ordre 4 (ADR 0011 §13) : amorce (fait, 2092549) ; lot Y1 (Y-08 puis Y-01) en parallèle du lot Y2 (Y-02, Y-09, Y-05, Y-03), deux worktrees ; lot Y3 (Y-04, Y-07, Y-06, en parallèle) après la fusion de Y2 ; lot Y4 (Y-10, Y-11) ensuite. Écrans sans maquette relus par Ali en fin d'ordre 4.

## Ordre 5 — iPhone

| ID | Module | User story | Agent | Statut |
| --- | --- | --- | --- | --- |
| A-07 | M2 | J'agis d'un geste sur iPhone | tasks-planning | à faire |
| N-01 | M5 | Je reçois un rappel à l'heure d'une tâche | notifications | à faire |
| N-03 | M5 | Je termine ou reporte depuis la notification | notifications | à faire |
| N-05 | M5 | Les rappels survivent au redémarrage | notifications | à faire |
| N-06 | M5 | Mes rappels suivent mon changement de fuseau | notifications | à faire |
| N-07 | M5 | Un rappel créé sur le PC sonne sur l'iPhone | notifications | à faire |
| K-05 | M8 | Je vois mes Rappels Apple dans CircleTasks | calendar-integration | à faire |
| K-06 | M8 | Je coche un rappel dans CircleTasks ou dans Rappels | calendar-integration | à faire |
| K-07 | M8 | Je retrouve mes Rappels Apple sur le PC | calendar-integration | à faire |
| Q-05 | M9 | Je capture vite depuis l'iPhone | quick-capture | à faire |
| I-01 | M16 | J'installe l'app sur l'iPhone | ios-mobile | fait (2026-10-07, lot I0 ; build de contrôle après revue à relancer quand la facturation GitHub sera réglée ; installation réelle par Ali en fin d’ordre) |
| I-02 | M16 | Je suis prévenu avant l'expiration hebdomadaire | ios-mobile | à faire |
| I-03 | M16 | Je protège l'app par Face ID | ios-mobile | à faire |
| I-04 | M16 | Je consulte et exporte les logs | ios-mobile | à faire |
| I-05 | M16 | Les autorisations sont demandées au bon moment | ios-mobile | à faire |
| I-06 | M16 | Je mets à jour l'app iPhone depuis SideStore | ios-mobile | à faire |
| P-04-iOS | M12 | Sauvegarde et restauration sur iPhone (P-04 critère 11, ADR 0010 règles 1 à 6, avenant ADR 0009) | settings-personalization + ios-mobile | à faire |
| N-TECH-01 | M5 | Story technique : interface `NotificationScheduler` dans src/platform/notifications (faux, noop PC) et planificateur pur dans src/domain (échéance effective, routines actives, prochaine occurrence, plafond iOS de 64) | notifications | fait (2026-10-07, lot N0, ADR 0012) |
| Y-IOS-01 | M15 | Story technique : plugin folder-bookmark (signet, hydratation, lecture à partir d'un octet), `BookmarkFs`, cycle de synchro au passage en arrière-plan | sync-icloud + ios-mobile | à faire |
| Y-IOS-02 | M15 | Story technique : Trousseau iOS relu, scan du QR lancé par Rust, confirmations natives iOS, décalage horaire local iOS, échec de réintégration visible | sync-icloud + ios-mobile | à faire |
| CAP-IOS-01 | M9 | Story technique : plugins Vision (OCR, Q-04) et Speech (Q-03) sur iPhone derrière les contrats existants, avec I-05 caméra et micro | quick-capture + ios-mobile | à faire |

Ordre de construction de l'ordre 5 (fixé le 2026-10-07 ; au plus 2 lots en parallèle, un seul lot à la fois sur src/db et src/domain ; chaque lot à plugin Swift est accepté seulement si `build-ios.yml` lancé sur sa branche est vert) :
- Phase 0, en parallèle : lot I0 (I-01, puis chaîne CI par branche et contrat des permissions Info.plist) et lot N0 (N-TECH-01).
- Phase 1, en parallèle : lot N1 (N-01, N-05, N-06, N-07, N-03, envoi réel de F-04 et de N-04) et lot Y-IOS (Y-IOS-01, puis Y-IOS-02).
- Phase 2, en parallèle : lot K (K-05, K-06, K-07 ; seul lot sur src/db) et lot M (A-07, Q-05, I-03, I-02).
- Phase 3, en parallèle : lot F (ADR 0009 avenant, P-04-iOS, plugin Fichiers, P-07 iPhone, I-04) et lot C (CAP-IOS-01, I-05).
- Phase 4 : I-06 (mise à jour N vers N+1 par SideStore), IPA candidate, vérifications d'Ali sur l'iPhone, puis REL-01 à REL-03.

## Livraison unique

| ID | Contrôle | Responsable | Statut |
| --- | --- | --- | --- |
| REL-01 | Les 12 parcours clés (PRD section 8) verts sur PC et iPhone | qa-test | à faire |
| REL-02 | Audits sécurité, performance, accessibilité conformes | security-privacy, performance, accessibility-i18n | à faire |
| REL-03 | Version 1.0.0 taguée, installeur PC et IPA publiés, guide d'installation à jour | ci-release + docs-writer | à faire |
