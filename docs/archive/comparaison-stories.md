# Comparaison des stories : PRD v4 (Windows) → PRD actuel

Source : docs/archive/PRD_CircleTasks_v4_Windows.md, section 5 (28 stories, US-01 à US-45). Cible : docs/PRD.md, section 4 (M1 à M18).
Rédigé par le product-owner le 2026-10-01 (PREP-03). Le PRD v3 (45 stories) n'étant pas disponible, sa comparaison reste à faire.

Légende : **couverte** = même fonction (formulation ou détail différent) ; **partielle** = une partie de la fonction n'a pas de story ; **absente** = aucune story.

## Correspondance

| Story v4 | Priorité v4 | Intitulé v4 | Story(s) actuelle(s) | Couverture | Remarque |
| --- | --- | --- | --- | --- | --- |
| US-01 | M | Ajouter une tâche rapide | T-01, A-01 | couverte | Le champ qui reste actif après ajout (réglage v4 « Garder le focus ») n'est pas un critère actuel. |
| US-02 | M | Heure via syntaxe rapide (« 8:30 Sport ») | Q-02, T-02 | couverte | Q-02 est à l'ordre 3 ; la v4 l'avait au socle. |
| US-03 | M | Cocher / décocher | T-04, R-03, A-07 | couverte | Haptique dans A-07. Le son à la coche (v4) n'est pas prévu ; le PRD dit que le seul son du PC est celui de Focus Time. |
| US-04 | M | Naviguer entre les jours (›, →, bouton « Aujourd'hui ») | A-04, S-01, S-03 | partielle | Aller à Aujourd'hui (A-04) et naviguer entre semaines (S-03) existent ; la navigation jour par jour dans l'écran Aujourd'hui n'a pas de story. |
| US-05 | M | Rollover des todos non cochés | T-06 | couverte | Comportement différent : la v4 propose une bannière (déplacer / laisser / supprimer) ; T-06 fait un report automatique à 00:00 avec badge. |
| US-06 | S | Réorganiser manuellement | A-02, T-02 | couverte | Le tri automatique par heure de la v4 correspond à « heure affichée et triée » (T-02). |
| US-07 | S | Mode compact | A-06 | couverte | — |
| US-08 | C | Statistiques 7 et 30 jours | H-02, R-06 | couverte | — |
| US-10 | M | Créer une routine | R-01, R-02, A-01 | couverte | — |
| US-11 | M | Compteur hebdomadaire x/7 | R-03, R-04, R-07 | couverte | Compteur « 1/7 » décrit en section 5 (Routines). |
| US-12 | M | Modifier les jours actifs | R-01, R-07 | couverte | Modification via le bouton « Éditer » (section 5) ; la règle « complétions passées conservées » n'est pas écrite en critère. |
| US-13 | M | Rappel de routine (notification Windows) | R-02, N-01, N-05 | couverte | Contraire au PRD actuel sur la plateforme : les rappels sonnent sur l'iPhone uniquement, jamais sur le PC. |
| US-14 | S | Vue mensuelle (carte de chaleur) | R-06, H-01 | couverte | — |
| US-15 | C | Archiver une routine | R-05 | couverte | — |
| US-20 | M | Événement annuel | E-01, E-02 | couverte | — |
| US-21 | M | Compte à rebours | E-04 | couverte | La v4 le nomme « DayCircle » ; le PRD interdit toute référence à DayCircle (section 5, « À ne pas reproduire »). |
| US-22 | S | Zone de notification et démarrage avec Windows | D-01, D-02 | couverte | — |
| US-23 | C | Export ICS des événements et routines | — | absente | H-03 exporte en CSV, JSON, PDF ou image, mais pas en ICS. |
| US-30 | M | Plusieurs checklists | C-01 | couverte | — |
| US-31 | M | Cocher sans supprimer | C-02 | couverte | — |
| US-32 | M | Effacer les items cochés | C-05 | couverte | — |
| US-33 | S | Renommer / supprimer une liste | C-01 | partielle | Le crayon de modification apparaît en section 5 (Checklists), mais aucun critère ne couvre le renommage ni la suppression d'une liste avec confirmation. |
| US-40 | M | Export / import JSON | P-04, H-03, P-07 | couverte | — |
| US-41 | M | Thème sombre | P-02 | couverte | — |
| US-42 | M | Premier jour de la semaine | P-03 | couverte | L'avertissement de recalcul des compteurs (v4) n'est pas un critère actuel. |
| US-43 | S | Français / anglais | P-03 | couverte | Section 8 : français d'abord, anglais en option. |
| US-44 | S | Couleurs des onglets (Customize Tabs) | P-01 | partielle | P-01 réordonne et masque les onglets ; le choix de couleur n'existe pas, les couleurs sont fixées en section 5. |
| US-45 | M | Supprimer toutes mes données | — | absente | Aucune story ne couvre l'effacement complet (saisie de SUPPRIMER, export préalable proposé). |

Bilan : 28 stories v4 ; 23 couvertes, 3 partielles, 2 absentes.

## Stories absentes à arbitrer par Ali

Aucune story v4 ne relève de la liste « Hors périmètre » du PRD (section 1). Selon la règle de la section 1, toute fonction absente de M1 à M18 est hors périmètre par défaut : les points ci-dessous ne seront pas développés sans mise à jour du PRD.

1. **US-45 — Supprimer toutes mes données** (Must en v4). Absente. Si elle est retenue, il faut aussi décider de son effet sur la synchro (M15) et sur l'autre appareil.
2. **US-23 — Export ICS** (Could en v4). Absente. Elle pourrait s'ajouter à H-03.
3. **US-04 — Navigation jour par jour dans Aujourd'hui** (Must en v4). Partielle : la vue Semaine permet de voir les autres jours.
4. **US-44 — Choix des couleurs d'onglets** (Should en v4). Partielle : à arbitrer face aux couleurs validées en section 5.
5. **US-33 — Renommer ou supprimer une checklist** (Should en v4). Partielle : le crayon existe dans l'interface, mais il n'y a aucun critère. Il suffirait de compléter C-01.

Écart à signaler sans arbitrage nécessaire : US-13 (rappel envoyé par Windows) est contraire au PRD actuel, qui n'émet les rappels que sur l'iPhone. Elle est donc couverte par N-01 et N-05, sans notification sur le PC.

Le product-owner ne modifie pas docs/PRD.md : chaque point retenu doit faire l'objet d'une proposition de mise à jour validée par Ali.
