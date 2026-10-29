# Backlog CircleTasks

## Reprise du 27 octobre 2026 (Claude Code)

Pause levée par Ali. UI-FIX-03 (défauts 11, 12 Rapport, 14) fusionnée par #88 dans `e9ba7e26`, bundle main 62/62, 334 039 normalisés, marge 24 361. Restent : 12 (Objectif), 15, 13, puis les huit refontes, une story par écran, test rouge avant le code. Référence visuelle : `docs/maquettes-refonte/` (PR #84) pour les écrans couverts. UI-REFONTE-01 n'est pas « fait » (preuve rouge préalable absente, rendu natif ouvert). Nouveau défaut 1.0.2 signalé par Ali : routines modifiées sans notification, diagnostic en cours. État courant : `docs/reprise-codex.md`.

## Pause du 27 octobre 2026

Travail suspendu à la demande d'Ali. UI-FIX-03 (11/12 Rapport/14) : correctif et preuves poussés en PR #88, ef10846f, QA/revue locales vertes ; CI en cours au dernier relevé, aucune fusion ni livraison présumée. Objectif (12/15), Concentration (13) et les huit refontes suivantes restent non commencés. Périmètre exact et ordre sauvegardés en tête de docs/reprise-codex.md ; reprise seulement sur demande explicite.

## 27 octobre — défauts 11 à 15 puis refonte complète

UI-FIX-03 (Rapport, 11/12/14) en QA : phrases vides, retour iPhone à gauche, taux d'achèvement. Preuve rouge e01b756e, vert/revue/CI/fusion à vérifier. Suivent Objectif (12/15) et Concentration (13), puis une story par écran dans l'ordre autorisé : Aujourd'hui iPhone, Semaine, Synchronisation, Routines, Checklists, Événements, Aujourd'hui PC, Réglages PC. La pause des huit écrans est levée par Ali ; aucune de ces corrections n'est encore livrée.

## Refonte 1.0.2 — publication vérifiée

UI-REFONTE-01 intégré par #86 ; PC et iPhone **1.0.2** publiés depuis **f473e113**, même code, schéma 19 inchangé. CI complète : runs **40297597829 / 40297604155** verts, revue approuvée. Bundle main après fusion **62/62, 333 973 normalisés, marge 24 427**, soit 5 225 octets économisés face à 1.0.1 ; plafond et couverture inchangés.

Builds réels **40300455346 (iPhone) / 40300455500 (PC)** verts. IPA **7363893 octets**, SHA-256 **89fda9b6cde29106e442e6553742debfbef323dc6000f9e5afac601e938e3675**, concordants avec l'asset et source SideStore ; version/build 1.0.2, fr.circletasks.planner, iOS minimum 18.0, contrat cinq plugins contrôlés. EXE **6406556 octets**, SHA-256 **aa231a03b9c5cb13e944ed7fec0ece26ac7dd0b99d01ff5bee239ed2e84a18d7**, signature Ed25519 et endpoint updater 1.0.2 vérifiés sans exécution. PC uniquement par bannière ; iPhone par SideStore sans désinstallation.

**Rendu natif de la refonte encore ouvert** : quatre contrôles seulement dans docs/essais-iphone.md. Les essais 1.0.1 sont acceptés par Ali, sans les réattribuer à 1.0.2. A9 reste le trou assumé ; A6b reste une vérification future en usage après la 1.0. Suivi documentaire sur rel-03-refonte-1-0-2 ; aucune recompilation pour ces textes.

## 26 octobre 2026 — recette 1.0.1 reçue, refonte autorisée

Ali confirme dans la conversation la réussite des dix contrôles du paquet A et des autres essais natifs du guide. Attestation utilisateur, sans inventer de captures ni d'heures individuelles. Le paquet A et la recette du candidat 1.0.1 sont acceptés ; A9 reste le trou assumé, A6b reste une vérification future en usage après la 1.0. Les preuves automatiques et les artefacts déjà vérifiés restent ceux de #83 / #85.

Nouvelle demande : refonte de Nouvelle tâche et Détail, story UI-REFONTE-01, branche du même nom dans n-ios-apercus. Références Ajout-v2 / Detail-v2 de la PR #84, autres écrans exclus. Candidat 1.0.2 sans migration, schéma 19. Nouveau rendu non encore validé sur appareil ; ne pas lui attribuer la recette de 1.0.1. Estimation 6 à 8 h actives, alerte 12 h. Tests ciblés, revue, CI, bundle et publication à terminer avant remise.

## Paquet A — publication vérifiée du 24 octobre 2026

PC et iPhone **1.0.1** publiés depuis **b8ddc85f**, tags v1.0.1 / ios-v1.0.1 ; runs **40090523636 / 40090523848** verts. IPA : 7 356 612 octets, SHA-256 d1ba316c179036369a656ef718591ed3f8e2ba4dc5c332710d2bd80988244e97, asset/artefact/source SideStore concordants, Info.plist et contrat cinq plugins valides. Signature PC Ed25519 et endpoint updater 1.0.1 vérifiés sans exécuter l'EXE. Mise à jour PC exclusivement par bannière, puis iPhone SideStore sans désinstallation. Guide : docs/essais-iphone.md.

Bundle main après #83 : **58/58, 339 198 normalisés, 339 190 bruts, marge 19 202 octets**, plafond et liste de modules inchangés ; +722 octets pour le paquet. CI applicative 48/48, lint, typage et revue approuvée. **Vérification native du paquet et clôture REL-01 à REL-03 encore ouvertes** ; ne pas écrire « fait ». A9 reste le trou assumé décidé par Ali, A6b « vérifié en usage après la 1.0 » est futur, pas exécuté. Suivi documentaire sur rel-03-paquet-a-1-0-1 ; aucune recompilation pour ces textes.

## UI-FIX-02 — Paquet A demandé le 24 octobre 2026

En cours : dix défauts constatés sur l'iPhone 1.0.0, dans l'ordre de la fiche `docs/stories/UI-FIX-02.md`. Pas de refonte Nouvelle tâche/Détail avant les maquettes. Aucune correction encore validée sur appareil.

Code fusionné par #83 dans b8ddc85f, 48 CI verts sur 80970c6c, revue/lint/typage consignés. Version de lot 1.0.1 sans changement de schéma ; publication et vérification sur iPhone encore dues. La fiche et le guide donnent les dix vérifications ciblées ; aucun statut « fait » sur l'appareil avant les preuves nécessaires.

## Décision applicable — 21 octobre 2026

A9 — récupération après migration interrompue, non vérifiée sur appareil réel. Décision d'Ali du 21 octobre 2026 : risque accepté pour l'usage mono-utilisateur. À reprendre obligatoirement si l'app devient multi-utilisateur ou distribuée à des tiers.

A9 n'est plus bloquant avant un changement de schéma ni pour la 1.0 en usage personnel. Il redevient bloquant si et seulement si l'app sort de l'usage personnel d'Ali ; sa vérification est alors obligatoire avant toute distribution à des tiers ou utilisation multi-utilisateur. Ce statut est un trou assumé, pas une story reportée ni un essai réussi.

Cette décision remplace les exigences A9 antérieures conservées ci-dessous pour historique. Aucun banc isolé ni séance A9 à lancer. Les preuves automatiques existantes sont conservées, sans les assimiler à un essai d'appareil. A6b reste « vérifié en usage après la 1.0 » : vérification future, non faite et non bloquante. Les autres essais natifs restent ouverts ; REL-01 à REL-03 ne sont pas clos sans leurs résultats.


121 user stories (plus les stories techniques et correctifs, dont la section « Palier 1.0 »), triées par ordre de construction (PRD section 9). Critères d'acceptation : docs/PRD.md section 4.

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
| N-04 | M5 | Je règle un récapitulatif matin et soir | notifications | fait (envoi réel sur l'iPhone ajouté le 2026-10-08, phase 1 de l'ordre 5) |
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
| K-01 | M8 | Je connecte Google Calendar | calendar-integration | fait (2026-10-08 : connexion réelle validée par Ali sur PC, agendas, Événements, Semaine, filtre Pro/Perso/Tout, fériés FR et TN ; iPhone avec le plugin web-auth au lot des calendriers) |
| K-02 | M8 | Je connecte Apple Calendar | calendar-integration | fait (2026-10-08 : connexion réelle validée par Ali sur PC, 4 agendas iCloud, Événements, Semaine, filtre Pro/Perso/Tout) |
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
| F-04 | M10 | La fin de session me notifie | focus-time | fait (envoi réel sur l'iPhone ajouté le 2026-10-08, phase 1 de l'ordre 5) |
| H-01 | M11 | Je vois ce que j'ai accompli ce mois-ci | stats-history | fait |
| H-02 | M11 | Je vois mon taux de complétion | stats-history | fait |
| H-03 | M11 | J'exporte mon historique | stats-history | fait |
| P-01 | M12 | Je réordonne et masque les onglets | settings-personalization | fait |
| P-02 | M12 | Je choisis clair, sombre ou système | settings-personalization | fait |
| P-03 | M12 | Je règle le premier jour de semaine, la langue et le format d'heure | settings-personalization | fait |
| P-04 | M12 | Je sauvegarde et restaure mes données | settings-personalization | fait (PC ; iPhone par P-04-iOS) |
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
| A-07 | M2 | J'agis d'un geste sur iPhone | tasks-planning | code fusionné, en attente de vérification appareil (PR #9 ; ne pas redévelopper ; vérifier la fiche et la checklist de l’ordre 5) |
| N-01 | M5 | Je reçois un rappel à l'heure d'une tâche | notifications | fait (2026-10-08, phase 1 de l'ordre 5, PR #1 ; vérification sur l'iPhone au point de contrôle et en fin d'ordre) |
| N-03 | M5 | Je termine ou reporte depuis la notification | notifications | code fusionné, en attente de vérification appareil (PR #3 ; ne pas redévelopper ; vérifier la fiche et la checklist de l’ordre 5) |
| N-05 | M5 | Les rappels survivent au redémarrage | notifications | fait (2026-10-08, phase 1 de l'ordre 5, PR #1 ; vérification sur l'iPhone au point de contrôle et en fin d'ordre) |
| N-06 | M5 | Mes rappels suivent mon changement de fuseau | notifications | fait (2026-10-08, phase 1 de l'ordre 5, PR #1 ; vérification sur l'iPhone au point de contrôle et en fin d'ordre) |
| N-07 | M5 | Un rappel créé sur le PC sonne sur l'iPhone | notifications | fait (2026-10-08, phase 1 de l'ordre 5, PR #1 ; vérification sur l'iPhone au point de contrôle et en fin d'ordre) |
| K-05 | M8 | Je vois mes Rappels Apple dans CircleTasks | calendar-integration | code fusionné, en attente de vérification appareil (PR #8 ; ne pas redévelopper ; vérifier la fiche et la checklist de l’ordre 5) |
| K-06 | M8 | Je coche un rappel dans CircleTasks ou dans Rappels | calendar-integration | code fusionné, en attente de vérification appareil (PR #8 ; ne pas redévelopper ; vérifier la fiche et la checklist de l’ordre 5) |
| K-07 | M8 | Je retrouve mes Rappels Apple sur le PC | calendar-integration | code fusionné, en attente de vérification appareil (PR #8 ; ne pas redévelopper ; vérifier la fiche et la checklist de l’ordre 5) |
| K-TECH-01 | M8 | Story technique : connexion Google sur iPhone, plugin `web-auth` (ASWebAuthenticationSession), lecture `CT_GOOGLE_IOS_CLIENT_ID`, solde de K-01 côté iPhone (ADR 0008 §5 et §9) | calendar-integration + ios-mobile | code fusionné, en attente de vérification appareil (PR #8 ; ne pas redévelopper ; vérifier la fiche et la checklist de l’ordre 5) |
| Q-05 | M9 | Je capture vite depuis l'iPhone | quick-capture | code fusionné, en attente de vérification appareil (PR #19 ; ne pas redévelopper ; vérifier la fiche et la checklist de l’ordre 5) |
| I-01 | M16 | J'installe l'app sur l'iPhone | ios-mobile | fait (2026-10-07, lot I0 ; build de contrôle après revue à relancer quand la facturation GitHub sera réglée ; installation réelle par Ali en fin d’ordre) |
| I-02 | M16 | Je suis prévenu avant l'expiration hebdomadaire | ios-mobile | code fusionné, en attente de vérification appareil (PR #19 ; ne pas redévelopper ; vérifier la fiche et la checklist de l’ordre 5) |
| I-03 | M16 | Je protège l'app par Face ID | ios-mobile | code fusionné, en attente de vérification appareil (PR #7 ; ne pas redévelopper ; vérifier la fiche et la checklist de l’ordre 5) |
| I-04 | M16 | Je consulte et exporte les logs | ios-mobile + settings-personalization | fait (branche lot-f-ios ; critères d'appareil dans la checklist de l'ordre 5) |
| I-05 | M16 | Les autorisations sont demandées au bon moment | ios-mobile + quick-capture | code fusionné, en attente de vérification appareil (PR #12 ; ne pas redévelopper ; vérifier la fiche et la checklist de l’ordre 5) |
| I-06 | M16 | Je mets à jour l'app iPhone depuis SideStore | ios-mobile + ci-release | code fusionné, en attente de vérification appareil (PR #23 ; clôture seulement après A1 à A10 passées) |
| P-04-iOS | M12 | Sauvegarde et restauration sur iPhone (P-04 critère 11, ADR 0010 règles 1 à 6, avenant ADR 0009) | settings-personalization + ios-mobile | fait (branche lot-f-ios ; critères d'appareil dans la checklist de l'ordre 5) |
| FILES-IOS-01 | M12 | Story technique : plugin Fichiers (`FileService.save` sur iPhone par le sélecteur « Enregistrer dans Fichiers », décision d'Ali du 2026-10-08), P-07 « Télécharger un modèle » et rapport des rejets sur iPhone, bouton « Exporter » de H-03 sur iPhone | settings-personalization + ios-mobile | fait (branche lot-f-ios ; critères d'appareil dans la checklist de l'ordre 5) |
| N-TECH-01 | M5 | Story technique : interface `NotificationScheduler` dans src/platform/notifications (faux, noop PC) et planificateur pur dans src/domain (échéance effective, routines actives, prochaine occurrence, plafond iOS de 64) | notifications | fait (2026-10-07, lot N0, ADR 0012) ; critère 12 (une occurrence par avance) remplacé par la fenêtre de 7 jours de N-TECH-02 (décision d'Ali du 2026-10-17) |
| Y-IOS-01 | M15 | Story technique : plugin folder-bookmark (signet, hydratation, lecture à partir d'un octet), `BookmarkFs`, cycle de synchro au passage en arrière-plan | sync-icloud + ios-mobile | fait (2026-10-08, phase 1 de l'ordre 5, PR #1 ; vérification sur l'iPhone au point de contrôle et en fin d'ordre) |
| Y-IOS-02 | M15 | Story technique : Trousseau iOS relu, scan du QR lancé par Rust, confirmations natives iOS, décalage horaire local iOS, échec de réintégration visible | sync-icloud + ios-mobile | fait (2026-10-08, phase 1 de l'ordre 5, PR #1 ; vérification sur l'iPhone au point de contrôle et en fin d'ordre) |
| T-14-FIX-01 | M1/M2 | Correctif de T-14 (et N-02) : la roue des heures de la feuille d'ajout iPhone se règle au doigt jusqu'à 12 et au-delà (plus de recalage de `scrollTop` pendant le geste ni pour un choix issu du défilement), tests par le chemin du doigt en Chromium et WebKit | tasks-planning + ios-mobile | fait (PR #32 fusionnée ; réconcilié le 2026-10-19 avec GitHub et la passation) |
| T-14-FIX-02 | M1/M2 | Correctif de T-14 : la roue des jours de la feuille d'ajout iPhone ne s'ouvre plus 40 jours avant aujourd'hui en WebKit (scroll de scroll-snap avant le calage initial pris pour un geste) | tasks-planning + ios-mobile | fait (PR #51 fusionnée ; réconcilié le 2026-10-19 avec GitHub et la passation) |
| Y-10-FIX-01 | M15 | Correctif de Y-10 : oubli en échec à l'étape `declare`, bouton « Annuler la demande » à côté de « Réessayer » (efface le mémo d'échec et l'intention non publiée, aucune boîte native, aucune écriture iCloud ; jamais de relance sans appui explicite) | sync-icloud + ios-mobile | fait (PR #34 fusionnée ; réconcilié le 2026-10-19 avec GitHub et la passation) |
| Y-IOS-02-FIX-01 | M15 | Correctif de Y-IOS-02 : échec de suppression de l'époque orpheline affiché avec sa cause (avertissement dans Détails et en bandeau, chemin du dossier à vérifier, « Réessayer maintenant ») ; devient « B5 réduit » de l'audit 1.0 : périmètre étendu à `delete-own-failed` (échec durable de suppression de son propre fichier, visible) en plus de `orphan-epoch-delete-failed`, avec son test rouge puis vert dans le banc Y-TECH-03 ; **étendu le 2026-10-17 aux défauts 2 et 3 révélés par le banc** (décision d'Ali, pas de story nouvelle) : (2) instantanés qui reviennent après une suppression acceptée puis non propagée (le moteur les resupprime à chaque instantané, le dossier grossit sans fin, aucun code `*-failed`, « À jour ») : fichier revenu après suppression = échec durable visible ; (3) substitut persistant qui fait réarmer puis journaliser `orphan-epoch-already-gone` à chaque cycle sans rien de visible | sync-icloud + ios-mobile | Complément code vérifié et fusionné #72 (1eac03fd), 48 CI verts, revue approuvée, rouges 016dbd04 / 9dba2a9e ; bundle main 338 458, marge 19 942. Suspects non prouvés reportés dans l’inventaire ; critère physique 18 ouvert. |
| Y-IOS-02-FIX-02 | M15 | Correctif de Y-IOS-02 : publication bloquée par un instantané orphelin resté dans iCloud (`canPublish` ne compte plus un instantané seul d'une époque non courante jamais annoncée, réarmement `orphan-epoch-relisted` puis suppression, cause réelle dans `publish-deferred`) ; lève le « `canPublish` inchangé » de Y-IOS-02-FIX-01 ; fiche `docs/stories/Y-IOS-02-FIX-02.md` | sync-icloud + ios-mobile | fait (vérifié sur l'iPhone 0.3.3 par Ali le 2026-10-17, checklist de l'ordre 5) ; PR #36, livrée en 0.3.3 |
| N-IOS-FIX-01 | M5 | Correctif des rappels iPhone : texte de remplacement propre (`hiddenPreviewsBodyPlaceholder`) quand iOS masque les aperçus sur l'écran verrouillé, plus ligne d'aide dans Réglages > Rappels sur le réglage iOS « Afficher les aperçus » ; fiche écrite par l'agent notifications (`docs/stories/N-IOS-FIX-01.md`) | notifications | Code fusionné #74, 48 CI verts et revue ; Swift compilé dans le lot 1.0.0 (39605174348), IPA publiée. Aperçus sur appareil encore à vérifier. |
| CAP-IOS-01 | M9 | Story technique : plugins Vision (OCR, Q-04) et Speech (Q-03) sur iPhone derrière les contrats existants, avec I-05 caméra et micro | quick-capture + ios-mobile | code fusionné, en attente de vérification appareil (PR #12 ; ne pas redévelopper ; vérifier la fiche et la checklist de l’ordre 5) |

Ordre de construction de l'ordre 5 (fixé le 2026-10-07 ; au plus 2 lots en parallèle, un seul lot à la fois sur src/db et src/domain ; chaque lot à plugin Swift est accepté seulement si `build-ios.yml` lancé sur sa branche est vert) :
- Phase 0, en parallèle : lot I0 (I-01, puis chaîne CI par branche et contrat des permissions Info.plist) et lot N0 (N-TECH-01).
- Phase 1, en parallèle : lot N1 (N-01, N-05, N-06, N-07, N-03, envoi réel de F-04 et de N-04) et lot Y-IOS (Y-IOS-01, puis Y-IOS-02).
- Phase 2, en parallèle : lot K (K-TECH-01, K-05, K-06, K-07 ; seul lot sur src/db et src/domain) et lot M (A-07, Q-05, I-03, I-02). Fiches prêtes le 2026-10-08. Détail :
  - Avant tout code : architecte, avenant ADR 0008 §9 (web-auth) et §10 (Rappels Apple) pour le lot K ; ADR 0013 (haptique, biométrie, expiration de signature) pour le lot M.
  - Étape « M0 » : les pièces de `src/domain` du lot M (politique de verrou, calcul de l'alerte d'expiration, clés de réglage locales) sont écrites et fusionnées **avant** que le lot K ne touche `src/domain` ; ensuite le lot M ne touche ni `src/domain` ni `src/db`.
  - Lot K : K-TECH-01 (sans base ni domaine, peut démarrer pendant la rédaction de l'avenant §10), puis K-05, K-06, K-07. Lot M : M0, I-03, A-07, I-02, Q-05. Fusion : lot M d'abord (plus court), lot K rebasé ensuite (fichiers partagés : `Cargo.toml`, `lib.rs`, capabilities iOS, `Info.ios.plist`, `plist-contract.json`, `build-ios.yml`, `container.ts`). Le plugin `notification-actions` de N-03 (décision d'Ali du 2026-10-08, développé en parallèle) touche les mêmes fichiers : le fusionner avant la phase 2 ou le rebaser avec elle.
- Phase 3, en parallèle : lot F (ADR 0009 avenant, P-04-iOS, plugin Fichiers, P-07 iPhone, I-04) et lot C (CAP-IOS-01, I-05). Fiches prêtes le 2026-10-08. Détail :
  - Avant tout code : architecte, avenant ADR 0009 (plugin Fichiers et P-04 sur iPhone) et ADR 0014 (journal technique persistant) pour le lot F ; ADR 0015 (plugins Vision et Speech, autorisations de capture) pour le lot C.
  - Lot F : FILES-IOS-01, puis I-04, puis P-04-iOS (le plus risqué en dernier). Lot C : CAP-IOS-01 (Vision, puis Speech avec les critères d'I-05 sur le micro), puis I-05 (test transversal, contrat Info.plist complet).
  - Dossiers : aucun des deux lots ne touche `src/db` ni `src/domain` (le lot K, en revue, les occupe) ; si une fiche l'exige, arrêt et question au product-owner. Dossiers disjoints, sauf les fichiers partagés `Cargo.toml`, `Cargo.lock`, `build.rs`, `src/lib.rs`, `tests/desktop/config.rs`, `build-ios.yml`, `container.ts`, `src/i18n` (index) : fusion du lot K d'abord, puis lot C, puis lot F rebasé.
- Phase 4 : I-06 (mise à jour N vers N+1 par SideStore), IPA candidate, vérifications d'Ali sur l'iPhone, puis REL-01 à REL-03. Fiche prête le 2026-10-09 (`docs/stories/I-06.md`). Détail :
  - Avant tout code : architecte, avenant ADR 0007 (version lue par l'app, `CFBundleVersion` monotone, notes issues de `CHANGELOG.md`, absence de retour arrière) et lignes d'avenant 0011, 0012, 0002.
  - Sous-tâches : version commune PC et iPhone (solde de la dette Y-07), erreur typée « base plus récente » et écran d'échec avec restauration, premier lancement d'une nouvelle version (réglage local), source SideStore à deux versions avec notes, guide, e2e `iphone`, revue. Aucun autre lot en parallèle. Prérequis : P-04-iOS et I-04 fusionnés (restauration avant mise à jour, export du journal).

## Palier 1.0 (plan d'Ali du 2026-10-17, audit `docs/audit-1.0.md`)

Palier « raisonnable » plus les faux iCloud hostiles de B13 : 82 à 90 h au chiffrage du 2026-10-17 du matin, **porté à 104 à 117 h net après la séance B14 du 2026-10-17** (voir « Palier retenu » ci-dessous). Ordre imposé par Ali : étape 1 Y-TECH-03 ; étape 2 Y-TECH-04 (option B validée par Ali le 2026-10-17, règle d'identité, choix éclairé de la sauvegarde), puis Y-TECH-05 (compte rendu visible du report, **placée avant la 1.0 par Ali le 2026-10-18**), puis Y-FIX-04 (ordre de Y-TECH-05 et de Y-FIX-04 à confirmer : même fichier `epochSwitch.ts`, jamais en parallèle ; recommandation : Y-FIX-04 d'abord) ; étape 3 Y-FIX-02, Y-FIX-03, Y-IOS-02-FIX-01 (B5 réduit, plus les défauts 2 et 3 du banc, ligne dans « Ordre 5 »), Y-IOS-05, **Y-IOS-07** (B16, segment de tête évincé, ajouté le 2026-10-17 sur décision d'Ali) ; étape 4 T-TECH-01 ; étape 5 SEC-01 ; étape 6 N-TECH-02, N-FIX-02, UI-FIX-01 ; étape 7 PRD-01 ; puis les quatre points restants (N-IOS-CHK-01, CI-SEC-01, C-FIX-01, Y-IOS-06), placés après l'étape 7 sauf contrainte technique signalée à Ali. Règles d'Ali : aucun bloquant n'est clos sans un test qui échoue avant le correctif et passe après ; arrêt et alerte si une estimation dérape de plus de 50 % ; défauts du banc de même famille remontés à Ali avant de continuer. Les fiches sont écrites story par story avant leur développement.

**Palier retenu, total recalculé le 2026-10-17 (séance B14).** Le chiffrage du matin (82 à 90 h) comptait déjà B14 à 3 à 4 h (séance de validation). La séance a ajouté deux livrables : Y-TECH-04 (11 à 13 h, dont la partie A de 3 à 4 h qui **est** l'ancien B14) et Y-TECH-05 (14 à 18 h, compte rendu visible du report). Présentation retenue, sans double compte :

| Poste | Bas | Haut |
| --- | --- | --- |
| Palier du matin | 82 h | 90 h |
| moins l'ancien B14 (séance de validation), absorbé par Y-TECH-04 partie A | -3 h | -4 h |
| plus Y-TECH-04 (A 3 à 4 h, B 2 à 3 h, C 6 h) | +11 h | +13 h |
| plus Y-TECH-05 (compte rendu visible) | +14 h | +18 h |
| **Total net du palier** | **104 h** | **117 h** |

En additionnant sans retirer l'ancien B14, on obtiendrait 107 à 121 h : c'est un double compte des 3 à 4 h de la partie A. **Réserve à confirmer** : le chiffre de 82 à 90 h n'a pas été recalculé à l'ajout de Y-IOS-07 (B16, 4 à 6 h, ajouté le 2026-10-17 après le chiffrage ; l'audit l'ajoute à part, « +4 à 6 h »). S'il ne le comptait pas, le total est de **108 à 123 h**. Y-TECH-05 (14 à 18 h) est la part que le placement « avant la 1.0 » ajoute ; si Ali la fait attendre après la 1.0, le total revient à 90 à 99 h (net, avec Y-TECH-04), et l'option B est alors livrée sans son compte rendu, contre la condition posée par Ali.

| ID | Module | User story | Agent | Statut |
| --- | --- | --- | --- | --- |
| Y-TECH-03 | M15 | Banc des faux iCloud hostiles (audit B13 / Q3) : plan de pannes partagé `FaultPlan` (fixture JSON) pour `memory.ts`, `syncCloudSim`, `MemFs` et `fake_bookmark.rs`, conformité `syncfs-conformance.json` étendue et rejouée sur les quatre, scénario de l'instantané orphelin du 8 octobre, rapport des défauts révélés ; fiche `docs/stories/Y-TECH-03.md` (palier 1.0, étape 1, 16 h) | sync-icloud + qa-test | fait (PR #44 fusionnée le 2026-10-17, suite verte 48/48, relecture approuvée ; scénarios rouges 2 à 6 conservés sur la branche `y-tech-03-scenarios-rouges`) |
| Y-TECH-04 | M15 / M16 | Report d'époque validé, identité conservée, sauvegarde choisie en connaissance de cause (audit B14, séance d'Ali du 2026-10-17, fiche `docs/stories/Y-TECH-04.md`). **A** règle de report : option B (ADR 0011 §24.6) validée, §9.1 (a) récrite, question ouverte 13 fermée « tranchée le 2026-10-17, option B », tableau des cas devenu la référence, tests alignés (3 à 4 h). **B** règle d'identité : une restauration (« Appliquer partout » comme « Garder les données synchronisées ») conserve l'identité de l'appareil (`sync_state.is_self`), test rouge avant et vert après avec la copie `backup16` (2 à 3 h). **C** écran de restauration : pour chaque sauvegarde l'appareil (nom lisible, « Cet appareil », « (oublié) », « Appareil inconnu »), la date et l'heure réelles, l'époque (« autre époque » si différente) ; `backup.rs` lit `sync_state` et `sync_meta` en lecture seule (6 h). Palier 1.0, étape 2, **11 à 13 h** (remplace les 3 à 4 h de la séance B14) | sync-icloud + settings-personalization + desktop-tauri | fait (PR #48 fusionnée le 2026-10-17, suite verte 48/48, relecture approuvée en trois passes) |
| Y-TECH-05 | M15 | Compte rendu visible du report d'époque (ajout 2 d'Ali du 2026-10-17, contrepartie de l'option B) : par auteur, nombre de champs et de lignes reportés ; liste nommée des éléments rétablis alors qu'ils avaient été supprimés (table, libellé, auteur, date de la suppression écartée) et des éléments recréés ; table `epoch_carry_report` bornée (500 lignes nommées, le reste compté) ; écran à la demande dans Réglages > Synchronisation > Détails, bandeau durable jusqu'à « J'ai vu » ; banc à trois appareils ; fiche `docs/stories/Y-TECH-05.md` (palier 1.0, étape 2 après Y-TECH-04, **14 à 18 h**) | sync-icloud + settings-personalization | fait (PR #52 fusionnée ; réconcilié le 2026-10-19 avec GitHub et la passation) |
| Y-FIX-04 | M15 | Correctif B4 : plus de perte silencieuse au report d'époque (enfant non lu d'un parent remplacé par la restauration « Appliquer partout » : rattaché à « Sans projet » du même espace pour un lien facultatif, gardé en `sync_parked` `missing-parent` pour un lien obligatoire, journal `epoch-carry-reattached` / `epoch-carry-held`, notice locale et avertissements visibles, jamais effacé sans journal ; extension de la décision (c) du 2026-10-05 ; test rouge du scénario exact avant le correctif, vert après ; interface livrée à Y-TECH-05) ; fiche `docs/stories/Y-FIX-04.md` (palier 1.0, étape 2, 4 h, alerte à 6 h) | sync-icloud | fait (PR #49 fusionnée ; réconcilié le 2026-10-19 avec GitHub et la passation) |
| Y-FIX-02 | M15 | Correctif B2 : plus d'impasse de première publication (segment écrit, état non écrit : tête locale comme borne, intention résolue seulement si la publication est permise (option a)) ; scénario d'arrêt brutal du banc rouge puis vert (scénario 2 repris tel quel de `y-tech-03-scenarios-rouges`, `crashPoints` P1 à P4, ADR 0011 §30 réservé ; bundle de départ 358 357 / 358 400, net <= 0 exigé, mesure après chaque commit) ; fiche `docs/stories/Y-FIX-02.md` (palier 1.0, étape 3, 5 h, alerte à 7 h 30) | sync-icloud (+ desktop-tauri si `store.rs` change) | fait (PR #56 fusionnée ; réconcilié le 2026-10-19 avec GitHub et la passation) |
| Y-FIX-03 | M15 | Correctif B3 : une lecture de journal en échec n'est plus muette (avertissement par appareil, `lastSyncAt` gelé, `io` dans `errorStreak`) ; scénario du banc rouge puis vert (palier 1.0, étape 3, 3 h) | sync-icloud | fait : PR #62 fusionnée, QA et revue approuvées, CI complète verte 39250092435 / 39250101460 (2026-10-19) |
| Y-IOS-05 | M15 | Correctif B6 : un appel iCloud qui ne répond pas ne fige plus la synchro (`call_with_deadline` sur le transport, `cloud-pending`, annulation de la coordination, `"error"` traité comme `cloud`) ; test du transport muet dans le banc, rouge puis vert (palier 1.0, étape 3, 7 h). Identifiant Y-IOS-03 évité : cité comme hypothèse rejetée dans decisions.md (2026-10-08). Fiche : docs/stories/Y-IOS-05.md (21 critères, parallèle possible avec Y-FIX-02, aucun fichier commun) | sync-icloud + ios-mobile + desktop-tauri | fait (PR #54 fusionnée ; réconcilié le 2026-10-19 avec GitHub et la passation) |
| Y-IOS-07 | M15 | Correctif B16 (défaut nouveau n° 1 du banc Y-TECH-03, bloquant) : segment de tête évincé par iOS (« Optimiser le stockage ») ; sur `cloud-pending` à l'ajout, le moteur ouvre le segment `max + 1` (une rotation par cycle, `expectRecords: 0`, `closed` enregistré), l'écriture ne lit jamais iCloud (pas de téléchargement avant l'ajout, décision d'Ali du 2026-10-17), échec de rotation visible dans Détails ; scénario 6 du banc repris de `y-tech-03-scenarios-rouges` (c41d5d66), rouge puis vert ; réponse écrite à « Raison technique de faire l'inverse ? » avant le code ; fiche `docs/stories/Y-IOS-07.md` (palier 1.0, étape 3, 4 à 6 h) | sync-icloud + desktop-tauri | fait, code fusionné et vérifié le 2026-10-20, PR #66 ; 48 contrôles CI verts ; observation appareil dans le lot IPA |
| Y-FIX-05 | M15 | Correctif B18 (révélé par Y-FIX-02 le 2026-10-18, confirmé par la revue) : un segment tronqué que Rust n'a jamais enregistré, suivi d'un segment plus grand, bloquait le lecteur en `cloud-pending` pour toujours (le PC affichait « En attente d'iCloud » sans fin et ne recevait plus rien de l'iPhone, pendant que l'iPhone affichait « À jour »). Règle retenue : tolérance du lecteur (`read_journal`, `store.rs`), sans changement de format (une entrée `closed` à 0 enregistrement est refusée par le schéma, ADR 0011 §21) ; extension du critère 5 de Y-FIX-02 côté PC rouge puis verte ; fiche `docs/stories/Y-FIX-05.md` (palier 1.0, étape 3, 3 à 4 h, alerte à 6 h) | sync-icloud + desktop-tauri | fait : PR #60 fusionnée, QA et revue approuvées, CI complète verte 39253744800 / 39253748866 ; preuves dans la fiche (2026-10-19) |
| T-TECH-01 | M1/M2 | Correctif B8 : plus de doublons de tâches récurrentes ni de report avant la première synchro (attendre le premier cycle ou échec visible avant `rollover.start()`, identifiants d'occurrence déterministes UUID v5, jamais reporter une tâche `done`, passage JavaScript de nettoyage après chaque cycle réussi (0020 réservée vide, schéma 19 inchangé ; suivi R1 persistant), test à deux appareils) (palier 1.0, étape 4, 12 à 16 h, alerte à 24 h) ; fiche `docs/stories/T-TECH-01.md` (22 critères) | tasks-planning + data-model | fait : PR #63 fusionnée, R1 corrigé ; QA et revue approuvées ; CI complète avec couverture 39262885779 / 39262896766 verte (2026-10-19) |
| SEC-01 | M16 | Correctif B7 : plugin SQL fermé (seul `sqlite:circletasks.db` accepté, `ATTACH` et `VACUUM INTO` refusés, tests de refus) (palier 1.0, étape 5, 5 h, alerte à 7,5 h) ; fiche `docs/stories/SEC-01.md` (17 critères) | desktop-tauri + security-privacy | fait (PR #59 fusionnée ; réconcilié le 2026-10-19 avec GitHub et la passation) |
| N-TECH-02 | M5 | Routines : fenêtre de sept jours, préfixe chronologique sans réserve par nature et couverture à deux bornes (B9 ; remplace le critère 12 de N-TECH-01 ; fiche `docs/stories/N-TECH-02.md`) | notifications | fait, code vérifié et fusionné #67 (e64e0148), 48 CI verts, revue approuvée ; bundle main 338 481, marge 19 919 |
| N-FIX-02 | M5 | Correctif B10 : corps de notification avec heure et espace (`HH:MM · Pro/Perso`, « (prévu 19:30) », « Reporté · 14:00 », date d'événement), constructeur unique testé sur le texte final, tableau de 16 cas exacts rouge avant ; fiche `docs/stories/N-FIX-02.md`, 27 critères (palier 1.0, étape 6, après N-TECH-02, 3 h, alerte à 4,5 h) | notifications | **Fait, code vérifié et fusionné #68** (f06bdee5), 48 CI verts avec couverture, revue approuvée ; bundle main 338 443, marge 19 957 ; essai physique du lot IPA encore requis |
| N-FIX-03 | M5 | Remplacement vérifiable d'une notification iOS (défaut 1.0.2 signalé par Ali le 2026-10-27 : routines modifiées sans notification) : un élément changé reçoit un numéro iOS neuf, l'ancien n'est annulé qu'après la pose vérifiée ; pose échouée et ancien conservé = compte `stale` affiché dans Réglages ; déplacement du plus lointain quand les 64 places sont prises ; fiche `docs/stories/N-FIX-03.md`, ADR 0012 avenant N4 (avant la 1.0 d'office : état faux muet, 3 h, alerte 4 h 30) | notifications | code corrigé sur `n-fix-03-remplacement-verifie`, rouges ab31267c / 57d19234, 349 tests du module verts, lint, typage, bundle 62/62, revue approuvée ; CI complète, fusion et observation iPhone requises |
| N-FIX-04 | M5 + M13 | Rappel dans la plage silencieuse : avertissement immédiat sur les trois formulaires (tâche, routine, événement), création et modification, formulation de N-FIX-02 « Rappel décalé au lundi 08:00 — aucun rappel Pro après 19:00 » ; ligne « Rappels décalés » sur l'écran Routines quand tous les rappels sont décalés ; fiche `docs/stories/N-FIX-04.md` (avant la 1.0 d'office : état faux muet, demande d'Ali du 2026-10-27, 7 à 9 h, alerte 12 h) | notifications + ui-design-system | code sur `n-fix-04-plage-silencieuse`, rouge ce96c7a8, 795 tests du module verts, e2e pc et iphone verts, lint, typage, revue approuvée ; CI complète, fusion et observation iPhone requises |
| UI-FIX-04 | transverse | Défaut 12 de la liste d'Ali du 2026-10-27 : retour iPhone à gauche partout, flèche `ArrowLeft`, douze écrans alignés sur le Rapport (UI-FIX-03) ; fiche `docs/stories/UI-FIX-04.md` (1 h 30) | ui-design-system | fait (PR #93 fusionnée le 2026-10-27, 48 contrôles verts, revue approuvée, rouge 967a786c ; bundle main 335 256, marge 23 144 ; observation iPhone au prochain lot) |
| UI-FIX-05 | M17 | Défaut 15 de la liste d'Ali du 2026-10-27 : un seul moyen d'ajouter un objectif, le bouton disparaît tant qu'un brouillon est affiché et revient après création ; fiche `docs/stories/UI-FIX-05.md` (1 h) | spaces-goals | fait (PR #94 fusionnée le 2026-10-27, 48 contrôles verts, revue approuvée, rouge 88d4c1b2 ; bundle main 335 256, marge 23 144 ; observation iPhone au prochain lot) |
| UI-FIX-06 | M10 | Défaut 13 de la liste d'Ali du 2026-10-27 : en-tête « Concentration », Pause dominante pendant la session, total du jour qui compte la session active dès la première seconde ; fiche `docs/stories/UI-FIX-06.md` (2 h) | focus-time | fait (PR #95 fusionnée le 2026-10-27, 48 contrôles verts, revue approuvée, rouge 722e6771 ; bundle main 335 397, marge 23 003 ; observation iPhone au prochain lot) |
| CI-WEBKIT-01 | M16 | Cache des paquets système `.deb` de WebKit dans le job `e2e iphone-webkit` (187 paquets, 117 Mo retéléchargés à chaque run ; trois annulations à 20 min le 2026-10-27 sur miroir Ubuntu lent) et délai propre à l'étape d'installation (5 min) ; pas de test rouge, preuve par mesure du temps de l'étape avant et après (décision d'Ali du 2026-10-27) ; fiche `docs/stories/CI-WEBKIT-01.md` | ci-release | mesure faite (cache chaud 23 s contre 26–67 s nominal et 305–321 s à miroir lent ; `.deb` sauvegardés même en échec, délai 8 min sur l'étape), revue approuvée ; PR et fusion requises |
| Q-05-FIX-01 | M9 | Régression du critère 9 de Q-05 par UI-REFONTE-01 : l'Entrée dans le titre de « Nouvelle tâche » est ignorée sans retour tant que le bloc à la demande des options n'a pas livré le libellé du bouton (bouton `disabled`, soumission implicite bloquée) ; symptôme en CI : `Q-05.spec.ts:16` instable (run 40565118802, 1 échec sur 15), cause au journal du 2026-10-27. Correctif : Entrée sur titre valide → `submit()` direct, bouton indépendant du bloc à la demande ; test rouge « Entrée avant le bloc » puis vert | quick-capture | fait (fusionnée #110, `main` c3a09d1c, bundle 337 956 ; avancée par Ali le 2026-10-28 ; rouge 0b43a922, vert 9f4d2ab6 ; contrôle sur l'iPhone : ligne 13 de la séance unique) |
| UI-FIX-07 | M3 / M17 | Alignement PRD-02 (lot C, réserve d'Ali) : la marque d'objectif revient sur la ligne iPhone de la Semaine (OB-03 critère 3) ; fiche `docs/stories/UI-FIX-07.md` | tasks-planning | fait (fusionnée #112, `main` 3943f4b7 ; rouge 73e1443a, vert a85f3c53) |
| UI-FIX-08 | M7 / M12 | Alignement PRD-02 (lot F, réserve d'Ali) : « Masquer les fériés » mémorisé par appareil (`events.hideHolidays`, local) ; fiche `docs/stories/UI-FIX-08.md` | checklists-events | fait (fusionnée #113, `main` 8ed535ac, bundle 338 017 ; rouge 26afcf76, vert 023cee38) |
| Y-05-OBS | M15 | Observation, run 40786557564 (2026-10-29) : une tâche longue isolée de 1 476 ms dans `J10-conflit-hors-ligne.spec.ts:188` (Y-05, @perf), non reproduite à la relance ; cause non établie. Instrumenter l'échec du test : consigner `entry.attribution` des tâches longues ; si l'échec revient, traiter comme défaut du publieur (appel non découpé), Ali prévenu avant tout e2e local | sync-icloud + qa-test | à planifier (aucun correctif aveugle ; voir journal du 2026-10-29) |
| UI-REFONTE-02 | M2 (+ M17, M7, M8) | Première refonte (ordre d'Ali du 2026-10-27) : Aujourd'hui sur iPhone, clair et sombre, selon `docs/maquettes-refonte/Jour.html` : agenda du jour sur la colonne des heures, ligne « maintenant », passé atténué, dû en gros, sans heure derrière un tiret, en-tête sans badge avec menu « Plus d’options » (Un jour, Objectif, Rapport, Vue compacte, Mode édition), objectif en une ligne, événements dans l'agenda ; PC inchangé ; fiche `docs/stories/UI-REFONTE-02.md` (écarts PRD A-05, A-06, OB-01, OB-02, SD-01 : PRD-02 à ouvrir par Ali) | tasks-planning + ui-design-system | fait (fusionnée #99 le 2026-10-28, `main` 9e97ee21, bundle 337 581 ; trois passages CI, 26 tests d'autres modules adaptés avec trace) |
| UI-REFONTE-03 | M3 | Deuxième refonte : Semaine sur iPhone (`Semaine-v2.html`) : heures en colonne, aujourd'hui marqué au trait, jours en minuscules, week-end allégé, synthèse « restantes, faites, en retard », jour cible de l'ajout ; PC inchangé ; fiche `docs/stories/UI-REFONTE-03.md` | tasks-planning + ui-design-system | fait (fusionnée #101, `main` c9507aa1, bundle 337 586) |
| UI-REFONTE-04 | M15 | Troisième refonte : Synchronisation (`Synchro-v4.html`) : état en une phrase vraie (carte), appareils en gabarit avec statut en colonne, conflits nommés par le champ lisible, « Rétablir », « Repartir de zéro » isolé et annoncé ; fiche `docs/stories/UI-REFONTE-04.md` | sync-icloud + ui-design-system | fait (fusionnée #102, `main` 9f010ec5, bundle 337 469) |
| UI-REFONTE-05 | M4 | Quatrième refonte : Routines sur iPhone (`Routines-v2.html`) : synthèse de la semaine, pastilles non prévu / prévu / fait, « 3 sur 5 cette semaine », fréquences en toutes lettres, rangée du bas « Rapport du mois » + « Routine » ; fiche `docs/stories/UI-REFONTE-05.md` | routines + ui-design-system | fait (fusionnée #103, `main` de6d486a, bundle 337 460) |
| UI-REFONTE-06 | M6 | Cinquième refonte : Checklists sur iPhone (`Checklists-v2.html`) : le sélecteur est le titre, un seul moyen d'ajouter, « 2 sur 3 », « Supprimer les 2 éléments cochés » ; fiche `docs/stories/UI-REFONTE-06.md` | checklists-events + ui-design-system | fait (fusionnée #104, `main` c5a8ac20, bundle 337 604) |
| UI-REFONTE-07 | M7 | Sixième refonte : Événements sur iPhone (`Evenements-v2.html`) : fériés en gris sans badge, pays en toutes lettres, pastille « Masquer les fériés », rangée du bas « Vue calendrier » + « Événement » ; fiche `docs/stories/UI-REFONTE-07.md` | checklists-events + ui-design-system | fait (fusionnée #105, `main` e9d094b4, bundle 337 464) |
| UI-REFONTE-08 | M2 | Septième refonte : Aujourd'hui sur PC (`PC-Jour.html`) : barre fixe nommée (Objectif, Rapport, Un jour, Ajouter, Édition, Compacte), colonne du jour bornée à 660 px avec l'agenda, seconde colonne « Demain / Cette semaine / Raccourcis » à la demande, plus de badge ni de bouton flottant ; fiche `docs/stories/UI-REFONTE-08.md` | tasks-planning + ui-design-system | fait (fusionnée #106, `main` e4fb9e9a, bundle 337 922 ; trois passages CI) |
| UI-REFONTE-09 | M12 | Huitième refonte : Réglages sur PC (`PC-Reglages.html`) : sommaire à gauche, colonne bornée à 660 px, titres en minuscules, « Général » en lignes séparées, Clavier expliqué ; iPhone inchangé ; fiche `docs/stories/UI-REFONTE-09.md` | settings-personalization + ui-design-system | fait (fusionnée #107, `main` a17c9ada, bundle 337 895 ; trois passages CI, critère 4 de BUNDLE-01 rendu asymétrique sur décision d'Ali) |
| BUNDLE-02 | transverse (M12) | Dette décidée par Ali le 2026-10-28 (UI-REFONTE-09) : modèle de normalisation de la mesure du bundle **sans bruit** (les pseudo-hachages de `bundleMeasure.ts` laissent un écart de compression qui croît avec le nombre de blocs à la demande : +143 octets pour 85 blocs), ce qui oblige à re-relever toutes les mesures consignées ; à faire **quand le plafond redeviendra serré**, pas avant | performance | dette, non planifiée |
| PRD-02 | M16 | Mise à jour du PRD après les huit refontes, fiche `docs/stories/PRD-02.md` (écarts groupés en six lots avec leur effet à l'usage, arbitrage par lot) : écarts assumés listés dans le tableau « Écarts » de chaque fiche UI-REFONTE-02 à 09 (A-01 badge, A-05 / A-06 bascules nommées ou menu, OB-01 / OB-02 ligne d'objectif, SD-01, Y-10 identifiant d'appareil, R-04 « 3 sur 5 cette semaine », C-02 / C-05, E-03 pays en toutes lettres, T-03 icône absente de l'agenda, T-11 fuseau PC, P-01 « 5 sur 5 », P-02 / P-03 trois lignes, D-04 / P-08 phrase du conflit) | product-owner (Ali) | ouverte le 2026-10-28, arbitrage par lot attendu d'Ali |
| UI-FIX-01 | M12 | Correctif B11 : thème sombre lisible (jeton `--ct-color-on-nav`, jetons d'interrupteur) et test de contraste sur toutes les paires CSS des deux thèmes (analyse statique des règles, relations de composants, inventaire des jetons), e2e sombre et captures sombres ; fiche `docs/stories/UI-FIX-01.md`, 21 critères (palier 1.0, étape 6, 4,5 h, alerte à 6,75 h) | ui-design-system + accessibility-i18n | fait (PR #57 fusionnée ; réconcilié le 2026-10-19 avec GitHub et la passation) |
| PRD-01 | M16 | B12 : exigence de taille de texte iOS (`-apple-system-body`) retirée du PRD, décision 2 d'Ali du 2026-10-17, à revoir après la 1.0 (palier 1.0, étape 7) | docs-writer | fait (2026-10-17, PRD lignes 657 et 1306) |
| N-IOS-CHK-01 | M5 | Séance iPhone : essai des `%` sur l'appareil (audit 1.0, section 5 point 5), à faire par Ali ; le périmètre exact est précisé dans la fiche avant la séance (palier 1.0, point restant, 1 h) | notifications + ios-mobile | Protocole préparé et relu : titre et corps natifs avec %, nom d’espace/restauration et aperçus explicités ; CI documentaire avant fusion. Essai iPhone encore non exécuté, aucun correctif aveugle. |
| CI-SEC-01 | M16 | Clé de signature hors du build front (audit 1.0, section 5 point 2 ; clé updater dans GitHub Secrets, jamais lue par le build du front) (palier 1.0, point restant, 3 h) | ci-release + security-privacy | Signature hors build #69 et complément TLS #73 fusionnés (9baff642) ; 48 CI verts avec audit/garde RSA, revue approuvée ; bundle main 338 443, marge 19 957. Signature réelle de livraison encore ouverte. |
| C-FIX-01 | M6 | Clavier de la checklist sur iPhone (audit 1.0, section 5 point 3) ; le périmètre exact est précisé dans la fiche (palier 1.0, point restant ; avec Y-IOS-06 : 5 h) | checklists-events + ios-mobile | Code vérifié et fusionné #70 (44441dbe), 48 CI verts, revue approuvée ; bundle main 338 443, marge 19 957 ; clavier physique encore ouvert |
| Y-IOS-06 | M15 | Gardes du sélecteur iOS (audit 1.0, section 5 point 3) ; le périmètre exact est précisé dans la fiche (palier 1.0, point restant ; avec C-FIX-01 : 5 h) | ios-mobile | Code vérifié et fusionné #71 (dc14badf), 371 Rust sync, lint, typage, revue et 48 CI verts ; bundle main 58/58, 338 413 normalisés, marge 19 987 ; UIKit physique encore ouvert. |
| BUNDLE-01 | transverse (M12) | Bundle de départ, décision d'Ali du 2026-10-18 : paliers 1 et 2 (`TaskDetail` réellement à la demande avec préchargement, puis six hôtes à la demande : Onboarding, Recherche, Focus, Aide des raccourcis, Jours fériés, Mise à jour ; un commit et une mesure par hôte), **garde par liste blanche des modules du départ** lue dans les cartes de source (`tests/bundle/start-modules.json`, livrée quoi qu'il arrive, y compris avec la marge revenue ; plafond 358 400 inchangé) et fin du bruit de hachage CSS (noms hachés normalisés dans la mesure, build livré inchangé) ; paliers 3 et 4 après la 1.0 ; fiche `docs/stories/BUNDLE-01.md`, 30 critères (palier 1.0, transverse, livrée avant la compilation iOS du lot, 9 à 13 h : paliers 5 à 7 h, garde 3 à 4 h, hachage 1 à 2 h, alerte à 19,5 h) | performance + ui-design-system | fait : PR #61 fusionnée, QA et revue approuvées, CI complète verte 39255869894 / 39255876068 (2026-10-19) |

## Livraison unique

| ID | Contrôle | Responsable | Statut |
| --- | --- | --- | --- |
| REL-TECH-01 | Test de fumée du binaire Windows : le vrai `circletasks.exe` démarre et affiche l'écran du jour (fiche `docs/stories/REL-TECH-01.md`, décision d'Ali du 2026-10-10) | ci-release + qa-test | fait (PR #31 fusionnée ; réconcilié le 2026-10-19 avec GitHub et la passation) |
| REL-TECH-02 | La désinstallation ne supprime jamais les données : crochet NSIS `NSIS_HOOK_PREUNINSTALL` (case « Supprimer les données » sans effet), garde-fou sur le script NSIS généré, smoke Windows étendu installation / réinstallation / désinstallation (fiche `docs/stories/REL-TECH-02.md`, audit B15, décision 9 d'Ali du 2026-10-17) | ci-release + qa-test | fait (PR #41 fusionnée le 2026-10-17, run 39034221587 vert) |
| REL-01 | Les 12 parcours clés (PRD section 8) verts sur PC et iPhone | qa-test | Automatisation intégrée #78, main c5fc22ee ; 48 CI verts, revue/lint/typage/couverture consignés, J02 inclus. Douze parcours reliés aux preuves ; seules les frontières natives du guide restent ouvertes. |
| REL-02 | Audits sécurité, performance, accessibilité conformes | security-privacy, performance, accessibility-i18n | Audit intégré #79 : npm zéro avis, Rust/perf/couverture verts, bundle main 338 476 ; IPA 1.0.0 et empreinte vérifiées. Signature réelle PC, SHA et endpoint updater vérifiés après run 39616432734 ; revue consignée. A9 : risque accepté ; frontières natives encore ouvertes ; aucune clôture déduite de l'automatisation #78. |
| REL-03 | Version 1.0.0 taguée, installeur PC et IPA publiés, guide d'installation à jour | ci-release + docs-writer | Candidats PC et iPhone 1.0.0 publiés et vérifiés, runs 39616432734 / 39605174348 verts ; signature, empreintes et manifestes contrôlés. PC par bannière uniquement. A9 : risque accepté ; recette physique ouverte ; livraison finale non close. |


## Historique annulé — I-06-A9 bloquant (2026-10-21)

Ali confirme A9 avant livraison, budget 6 h, avec priorité à l’arrêt réel après commit 19 avant afterApply. Deux builds de test non publiés sont préparés, sans publication : exception puis interruption ; aucune panne dans le candidat. Le premier conserve la vraie restauration Rust et suspend sa relance pour prouver la réouverture par 0.3.3 en 18 ; le second attend l’arrêt physique, puis reprend le vrai traitement au redémarrage. Guide : docs/essais-iphone-a9.md. Statut : préparation, aucun succès physique revendiqué. A6b reste "vérifié en usage après la 1.0" (futur, non fait, non bloquant).

Le rappel d’une erreur générique ne suffit pas : la réintégration actuelle intercepte ses erreurs. L’exception injectée est un cas de laboratoire ; la preuve prioritaire concerne un vrai processus arrêté avec commit SQLite acquis. Le retour normal en 19 après relance et le rollback de sauvegarde vers 18 sont deux sorties différentes, prouvées séparément.

## REL-03 : séance A9 prête, preuve physique attendue (2026-10-21)

#80 fusionnée dans main 2398e8e2 après 48 CI verts de d67692ae (39638601218 / 39638593312). Deux builds A9 réussis, artefacts téléchargés et vérifiés : afterapply 39637333456 et interruption 39637672577. Contrat des cinq plugins, version/build 1.0.0, identifiant fr.circletasks.planner et minimum 18.0 conformes.

Paquet A9-seance-4-IPA.zip : 29 328 763 octets ; SHA-256 e8b7d51a8d129a9b4e203ff047daca4bb51d403e155ef7c138cd8aa3db9d880a, identique au digest GitHub. Quatre IPA internes relues et hachées depuis le ZIP : chacune concorde avec son empreinte ; deux guides, mémo et SHA256SUMS inclus, huit entrées. Brouillon non publié a9-20261021-cff59f5c ; aucun ajout à la source SideStore publique (blob 5a8af39e2a3f10209bf965f131ca1483b95dcd39 inchangé).

Guide et paquet transmis à Ali ; créneau physique de 60 à 75 minutes. A9 reste **non exécuté sur appareil** et bloque la livraison. Après A9 restent les frontières natives du guide et le verdict final REL-01/REL-02/REL-03. A6b : « vérifié en usage après la 1.0 », futur, non fait, non bloquant. Aucun worktree supprimé.
