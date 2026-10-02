# Backlog CircleTasks

121 user stories, triées par ordre de construction (PRD section 9). Critères d'acceptation : docs/PRD.md section 4.

Statuts : à faire · en cours · en revue · fait. Le product-owner tient ce fichier à jour.

## Ordre 0 — Préparation

| ID | Tâche | Responsable | Statut |
| --- | --- | --- | --- |
| PREP-01 | Prérequis et comptes (PRD section 2) | Ali | à faire |
| PREP-02 | Initialiser le dépôt, installer CLAUDE.md, .claude/agents et docs/ | Ali + architect | fait |
| PREP-03 | Archiver le PRD v3 et le scaffold Expo dans docs/archive/, comparer les 45 anciennes stories (v3 + Expo manquants) | product-owner | en revue (attend v3 + Expo) |
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
| T-11 | M1 | Mes heures restent justes quand je change de pays | tasks-planning | à faire |
| T-12 | M1 | Je duplique une tâche | tasks-planning | à faire |
| T-13 | M1 | J'annule ma dernière action | tasks-planning | à faire |
| T-14 | M1 | Je choisis une date adaptée à mon appareil | tasks-planning | à faire |
| A-01 | M2 | J'ouvre l'app sur la liste du jour | tasks-planning | à faire |
| A-02 | M2 | Je réordonne ma liste | tasks-planning | à faire |
| A-03 | M2 | Je masque les routines de la liste du jour | tasks-planning | à faire |
| A-04 | M2 | J'accède à Aujourd'hui en un geste | tasks-planning | à faire |
| A-05 | M2 | Je passe en mode édition | tasks-planning | à faire |
| A-06 | M2 | Je replie la liste en vue compacte | tasks-planning | à faire |
| A-08 | M2 | J'ouvre la fiche détail d'une tâche | tasks-planning | à faire |
| A-09 | M2 | Je vois toujours l'état de l'app | tasks-planning | à faire |
| S-01 | M3 | Je vois ma semaine en 7 colonnes (PC) ou 7 sections (iPhone) | tasks-planning | à faire |
| S-02 | M3 | Je déplace une tâche d'un jour à l'autre | tasks-planning | à faire |
| S-03 | M3 | Je navigue entre semaines | tasks-planning | à faire |
| S-04 | M3 | Je crée une tâche directement dans un jour | tasks-planning | à faire |
| S-05 | M3 | Je vois les événements calendrier dans la semaine | tasks-planning | à faire |
| S-06 | M3 | Je planifie depuis « Un jour » en glissant | tasks-planning | à faire |
| R-01 | M4 | Je crée une routine avec icône et fréquence | routines | à faire |
| R-02 | M4 | J'associe une heure optionnelle | routines | à faire |
| R-03 | M4 | Je valide une routine du jour | routines | à faire |
| R-04 | M4 | Je suis ma série | routines | à faire |
| R-05 | M4 | Je mets une routine en pause ou l'archive | routines | à faire |
| R-06 | M4 | Je consulte le rapport de routine | routines | à faire |
| R-07 | M4 | Je planifie une routine tous les N jours ou toutes les N semaines | routines | à faire |
| N-02 | M5 | Je choisis une avance (0, 5, 15, 30, 60 min, 1 jour) | notifications | à faire |
| N-04 | M5 | Je règle un récapitulatif matin et soir | notifications | à faire |
| ES-01 | M13 | J'ai deux espaces Pro et Perso | spaces-goals | à faire |
| ES-02 | M13 | Chaque élément appartient à un espace | spaces-goals | à faire |
| ES-03 | M13 | Je filtre Pro / Perso / Tout | spaces-goals | à faire |
| ES-04 | M13 | Je crée des projets dans un espace | spaces-goals | à faire |
| ES-05 | M13 | Je déplace un élément d'un espace ou projet à l'autre | spaces-goals | à faire |
| ES-06 | M13 | Je rattache un agenda externe à un espace | spaces-goals | à faire |
| ES-07 | M13 | Je définis des plages silencieuses par espace | spaces-goals | à faire |
| ES-08 | M13 | Je vois statistiques et Focus par espace et projet | spaces-goals | à faire |
| D-01 | M16 | L'app PC reste active en zone de notification | desktop-tauri | à faire |
| D-02 | M16 | L'app PC démarre avec Windows | desktop-tauri | à faire |
| D-03 | M16 | Je mets à jour l'app PC | desktop-tauri | à faire |
| OB-01 | M17 | Je fixe un objectif pour la semaine | spaces-goals | à faire |
| OB-02 | M17 | J'épingle l'objectif en haut de ma liste | spaces-goals | à faire |
| OB-03 | M17 | Je rattache une tâche à un objectif | spaces-goals | à faire |
| OB-04 | M17 | Je vois l'avancement de l'objectif | spaces-goals | à faire |
| OB-05 | M17 | Je reconduis un objectif non atteint | spaces-goals | à faire |
| OB-06 | M17 | Je consulte mes objectifs passés | spaces-goals | à faire |
| SD-01 | M18 | J'ajoute une tâche sans date dans « Un jour » | spaces-goals | à faire |
| SD-02 | M18 | Je planifie une tâche « Un jour » en un geste | spaces-goals | à faire |
| SD-03 | M18 | Je renvoie une tâche datée vers « Un jour » | spaces-goals | à faire |
| SD-04 | M18 | J'organise la liste « Un jour » | spaces-goals | à faire |

## Ordre 1 bis — Vérification iPhone

| ID | Tâche | Responsable | Statut |
| --- | --- | --- | --- |
| POC-01 | Workflow build-ios.yml, IPA non signée, installation par SideStore, affichage de la liste du jour | ci-release + ios-mobile | à faire |

## Ordre 2 — Organisation

| ID | Module | User story | Agent | Statut |
| --- | --- | --- | --- | --- |
| C-01 | M6 | Je crée une checklist nommée | checklists-events | à faire |
| C-02 | M6 | Je coche des items | checklists-events | à faire |
| C-03 | M6 | J'associe une checklist à un jour | checklists-events | à faire |
| C-04 | M6 | Je réutilise une checklist modèle | checklists-events | à faire |
| C-05 | M6 | J'efface d'un coup les items cochés | checklists-events | à faire |
| E-01 | M7 | Je crée un événement daté, avec ou sans heure | checklists-events | à faire |
| E-02 | M7 | Je crée un anniversaire ou une date importante | checklists-events | à faire |
| E-03 | M7 | J'affiche les jours fériés | checklists-events | à faire |
| E-04 | M7 | Je vois un compte à rebours | checklists-events | à faire |
| K-01 | M8 | Je connecte Google Calendar | calendar-integration | à faire |
| K-02 | M8 | Je connecte Apple Calendar | calendar-integration | à faire |
| K-03 | M8 | Mes événements externes se mettent à jour | calendar-integration | à faire |
| K-04 | M8 | Je crée une tâche depuis un événement externe | calendar-integration | à faire |
| RC-01 | M14 | Je cherche n'importe quel élément | spaces-goals | à faire |
| RC-02 | M14 | Je filtre les résultats | spaces-goals | à faire |
| RC-03 | M14 | J'ouvre un résultat | spaces-goals | à faire |
| RC-04 | M14 | Je retrouve mes recherches récentes | spaces-goals | à faire |

## Ordre 3 — Fonctions avancées

| ID | Module | User story | Agent | Statut |
| --- | --- | --- | --- | --- |
| Q-01 | M9 | J'ajoute une tâche depuis n'importe où sur PC | quick-capture | à faire |
| Q-02 | M9 | Je saisis en langage naturel | quick-capture | à faire |
| Q-03 | M9 | Je dicte une tâche | quick-capture | à faire |
| Q-04 | M9 | Je photographie une liste manuscrite | quick-capture | à faire |
| Q-06 | M9 | Je choisis espace et projet en tapant | quick-capture | à faire |
| F-01 | M10 | Je lance une session sur une tâche | focus-time | à faire |
| F-02 | M10 | Je fais une pause | focus-time | à faire |
| F-03 | M10 | Je vois mon temps de concentration | focus-time | à faire |
| F-04 | M10 | La fin de session me notifie | focus-time | à faire |
| H-01 | M11 | Je vois ce que j'ai accompli ce mois-ci | stats-history | à faire |
| H-02 | M11 | Je vois mon taux de complétion | stats-history | à faire |
| H-03 | M11 | J'exporte mon historique | stats-history | à faire |
| P-01 | M12 | Je réordonne et masque les onglets | settings-personalization | à faire |
| P-02 | M12 | Je choisis clair, sombre ou système | settings-personalization | à faire |
| P-03 | M12 | Je règle le premier jour de semaine, la langue et le format d'heure | settings-personalization | à faire |
| P-04 | M12 | Je sauvegarde et restaure mes données | settings-personalization | à faire |
| P-05 | M12 | Je suis guidé au premier lancement | settings-personalization | à faire |
| P-06 | M12 | Un écran vide m'indique quoi faire | settings-personalization | à faire |
| P-07 | M12 | J'importe mes tâches existantes | settings-personalization | à faire |
| P-08 | M12 | Je consulte les raccourcis clavier | settings-personalization | à faire |
| D-04 | M16 | J'utilise les raccourcis clavier | desktop-tauri | à faire |

## Ordre 4 — Synchro

| ID | Module | User story | Agent | Statut |
| --- | --- | --- | --- | --- |
| Y-01 | M15 | Je choisis le dossier de synchro | sync-icloud | à faire |
| Y-02 | M15 | Mes données se synchronisent seules | sync-icloud | à faire |
| Y-03 | M15 | Je lance une synchro manuelle | sync-icloud | à faire |
| Y-04 | M15 | Je consulte les conflits | sync-icloud | à faire |
| Y-05 | M15 | Je travaille hors ligne | sync-icloud | à faire |
| Y-06 | M15 | Je raccorde un nouvel appareil | sync-icloud | à faire |
| Y-07 | M15 | Mes deux appareils n'ont pas la même version | sync-icloud | à faire |
| Y-08 | M15 | Mes données dans iCloud sont chiffrées | sync-icloud | à faire |
| Y-09 | M15 | Un élément supprimé ne réapparaît jamais | sync-icloud | à faire |

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
| I-01 | M16 | J'installe l'app sur l'iPhone | ios-mobile | à faire |
| I-02 | M16 | Je suis prévenu avant l'expiration hebdomadaire | ios-mobile | à faire |
| I-03 | M16 | Je protège l'app par Face ID | ios-mobile | à faire |
| I-04 | M16 | Je consulte et exporte les logs | ios-mobile | à faire |
| I-05 | M16 | Les autorisations sont demandées au bon moment | ios-mobile | à faire |
| I-06 | M16 | Je mets à jour l'app iPhone depuis SideStore | ios-mobile | à faire |

## Livraison unique

| ID | Contrôle | Responsable | Statut |
| --- | --- | --- | --- |
| REL-01 | Les 12 parcours clés (PRD section 8) verts sur PC et iPhone | qa-test | à faire |
| REL-02 | Audits sécurité, performance, accessibilité conformes | security-privacy, performance, accessibility-i18n | à faire |
| REL-03 | Version 1.0.0 taguée, installeur PC et IPA publiés, guide d'installation à jour | ci-release + docs-writer | à faire |
