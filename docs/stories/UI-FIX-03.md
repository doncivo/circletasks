# UI-FIX-03 — Rapport du mois : états vides et retour

Statut : en pause à la demande d'Ali le 27 octobre 2026. Correctif ef10846f poussé en PR #88, vérifié localement et relu ; CI 40490948417 / 40490975874 en cours au relevé de pause, fusion encore requise. Demande du 27 octobre 2026, défauts 11, 12 (Rapport) et 14. Estimation : 1 h 30 à 2 h actives ; alerte à 3 h.

## Passe product-owner

Remplacer les tirets des tuiles vides par des phrases, sans confondre absence de données et exclusion par un filtre de projet. Si une routine existe mais n'a aucune occurrence comptable, le dire. Conserver les ratios, nommer le graphique « Taux d'achèvement par semaine ». Retour iPhone à gauche, flèche de navigation ; parcours de retour et PC conservés. Texte dans les catalogues, aucun changement de schéma ni de calcul métier. Même information dans les exports.

La suite autorisée est Objectif de la semaine (12/15), Concentration (13), puis les huit refontes : Aujourd'hui iPhone, Semaine, Synchronisation, Routines, Checklists, Événements, Aujourd'hui PC, Réglages PC. Une story par écran. La pause précédente est levée par Ali ; aucun nouveau résultat natif 1.0.2 n'est présumé.

## Preuves et revue

Rouge e01b756e : quatre échecs DOM (phrases absentes et anglicisme) et un échec navigateur (retour à droite). Vert du correctif : 59 tests ciblés sans couverture, dont export multiligne ; 13 parcours iPhone initiaux puis cinq complémentaires verts (filtres espace/projet, tableau accessible, chargement du graphique et retour). Une exclusion PC préexistante dans H-01 conservée, aucun essai instable sauté. Lint sans avertissement après retrait des assertions non nulles du test, typage strict inclus dans le bundle ; 62/62 gardes vertes avant push. CI complète avec couverture et mesure main restent obligatoires. Plafond 358 400 octets et couverture 80 % inchangés ; référence main a33c2dbf, 333 973 octets, marge 24 427.

## Passe agent du module

Bundle de production après correction : 334 025 octets normalisés, 333 960 bruts, marge 24 375 ; +52 octets face à main. Aucune extension de la liste des modules du départ.

Les catalogues fr/en portent les textes. reportEmptyText distingue absence, routine sans occurrence et exclusion par projet ; mêmes phrases à l'écran et à l'export, chiffres nuls conservés quand ils ont un sens. L'export utilise un petit corps multiligne pour éviter une phrase tronquée. Retour mobile aligné au début de son en-tête, icône ArrowLeft, routes inchangées.

## Passe QA et revue distincte

Les tests historiques ont été adaptés aux nouveaux libellés sans modifier leurs assertions de comptes, navigation ou filtrage. L'oracle initial de géométrie exigeait un bord droit inférieur à 100 px, ce qui ignorait la marge de l'en-tête ; l'oracle final vérifie l'alignement exact au bord gauche de cet en-tête et la présence dans la moitié gauche. Le contrôle de l'export est borné aux tuiles, pour ne pas mélanger les étiquettes du graphique avec leurs phrases. Aucun délai, timeout, retry, seuil ou garde de taille modifié.

Relecture distincte du diff et du nouveau module après QA : approuvée. Zéro reste un pourcentage valide ; un filtre de projet ne produit pas une affirmation d'absence ; les commandes de retour conservent leur destination. La nouveauté reste dans les modules à la demande du rapport. Aucun stockage utilisateur ni schéma touché. Rendu physique à vérifier avec le prochain lot, aucun résultat inventé.
