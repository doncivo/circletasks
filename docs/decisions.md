# Décisions CircleTasks

Ce fichier recense les décisions prises sans validation préalable d'Ali (consigne du 2026-10-02 : validation automatique). Il contient deux types de décisions :
- l'option recommandée par le product-owner sur une question que ni le PRD ni les maquettes ne tranchent ;
- les écarts entre le PRD et les maquettes, où la maquette fait référence.

docs/PRD.md n'est jamais modifié.

Les 32 décisions de l'ordre 1, tranchées par Ali le 2026-10-02, se trouvent dans docs/stories/_questions-ordre-1-a.md et _questions-ordre-1-b.md.

| Date | Story | Question ou écart | Option retenue | Raison |
| --- | --- | --- | --- | --- |
| 2026-10-02 | SD-03 | Écart PRD / maquettes : libellé de l'action « Plus tard » (PRD) ou « Un jour » (maquettes) | « Un jour » (maquettes) | Décision d'Ali : les maquettes font référence |
| 2026-10-02 | OB-06 | Écart PRD / maquettes : historique des objectifs dans Statistiques (PRD) ou dans l'écran Objectif (maquettes) | Écran Objectif (maquettes) | Décision d'Ali : les maquettes font référence |
| 2026-10-02 | A-06 | Écart PRD / maquettes : heures masquées (PRD) ou affichées (maquette) en vue compacte | Heures affichées (maquette) | Décision d'Ali : les maquettes font référence |
| 2026-10-02 | A-01 | Champ « Date » à saisie libre (T-14) à côté du champ d'ajout PC, absent de PC-Aujourdhui.html et PC-Date.html (la date s'y règle dans la fiche) | Conservé, intégré à droite du cadre gris pleine largeur du champ d'ajout | T-14 le livre, les e2e en dépendent ; visuellement un seul champ comme la maquette |
| 2026-10-02 | A-01 | Objectif épinglé, événement, routines, icônes Un jour / Objectif / Recherche, « Scan tâches » des maquettes Aujourd'hui | Absents tant que leurs modules n'existent pas (assemblage prêt, `todaySources`) | Aucun élément factice (règle du lot) |
| 2026-10-02 | A-01 | Ligne « Ctrl / raccourcis » de l'aide en bas de PC-Aujourdhui.html | Seule « Ctrl N nouvelle tâche » est affichée | P-08 (aide des raccourcis) n'existe pas |
| 2026-10-02 | A-05 | Poignée de déplacement sur une tâche terminée (Main-Edition.html) | Absente | Une tâche terminée ne se déplace pas (A-02 critère 7) : pas de commande inerte |
| 2026-10-02 | A-05 | « Déplacer » de la barre de sélection : espace puis projet | Espace seulement | Les projets arrivent avec ES-04 (Q12) |
| 2026-10-02 | A-08 | « Marquer comme terminée » dans le panneau PC (absent de PC-Aujourdhui.html, présent dans Detail.html) | Seulement sur la feuille iPhone ; sur PC, terminer reste la case de la ligne | Maquette PC ; le critère A-08 n° 6 ne l'exige que sur iPhone |
| 2026-10-02 | A-08 | « Dupliquer » absent de PC-Aujourdhui.html | Ajouté (pilule, même style que Reporter / Un jour) | Exigé par T-12 et A-08 |
| 2026-10-02 | A-08 | Interrupteur « Objectif de la semaine », bouton Focus, rappels éditables, « Créée … sur le PC » (maquettes) | Objectif en texte seul, Focus absent, rappels en puces non éditables, horodatage sans appareil | OB-03, M10, N-02 non livrés ; aucune donnée ne dit sur quel appareil la tâche a été créée |
| 2026-10-02 | A-08 | Titre de la fiche PC éditable : bouton dans le titre de niveau 2, aide liée par aria-describedby, F2 ou Entrée | Retenu | Accessibilité au clavier ; les e2e sont adaptés (sélecteurs exacts), pas l'accessibilité |
| 2026-10-02 | A-04 | Écran « bientôt » des onglets non construits (critère 6) | Écran vide neutre | « Interne au développement, retiré avant livraison » : rien à retirer |
| 2026-10-02 | A-01 | Badge AUJOURD'HUI de Main-Vide.html (jour non courant, 27 dim.) | Badge affiché sur le jour courant, absent des autres jours (flèches PC) | La capture visuelle fixe l'horloge sur ce dimanche : l'app est alors « aujourd'hui » |
| 2026-10-02 | S-01 | Routines, événement « Point client », anniversaire, objectif (OB), « checklist 0/8 » des maquettes Semaine | Absents tant que leurs modules n'existent pas (assemblage prêt : `todaySources`, `buildWeek`) ; les événements externes sont lus en base (S-05) | Aucun élément factice (règle du lot) |
| 2026-10-02 | S-01 | Tâches terminées « laissées à leur place » (critère 4) ou en bas (T-04) | Terminées en bas du jour, barrées, comme Aujourd'hui | Cohérence avec T-04 et A-01 ; même assemblage (`buildTodayList`) |
| 2026-10-02 | S-01 | Lignes iPhone de 26 px (Semaine.html) | Zone tactile de 44 px par ligne | PRD 5 : cibles tactiles ≥ 44 pt ; la grille défile |
| 2026-10-02 | S-01 | Fiche détail PC : panneau à droite (rétrécit la zone centrale) ou par-dessus la grille | Par-dessus la grille (AppShell `detailOverlay`) | Les sept colonnes gardent leur largeur ; proposition de la fiche |
| 2026-10-02 | S-02 | Tâche récurrente déplacée : « cette occurrence sans question » (fiche, critère 8) ou question de portée (consigne du lot, T-10) | Question « Cette occurrence / Toutes les suivantes » avant le déplacement (glisser, Alt+←/→, Ctrl+D) | Consigne du lot S ; « cette occurrence » reste le choix qui répond au critère 8 |
| 2026-10-02 | S-02 | Alternative clavier au glisser : Ctrl+D ou Reporter → Choisir une date (critère 9) | Ajout de Alt+← / Alt+→ (jour précédent / suivant de la semaine affichée) et Alt+↑ / Alt+↓ (ordre du jour) sur la carte sélectionnée | Vrai équivalent du glisser, déclaré au registre des raccourcis (P-08) ; Ctrl+D et la fiche restent disponibles |
| 2026-10-02 | S-02 | Message d'annulation « déplacée au jeu. 24 » (critère 3) | « déplacée au jeu. 24 sept. » (libellé existant `undo.moveDate`, jour court avec mois) | Même format de date que les messages de report (T-05) |
| 2026-10-02 | S-03 | « Cette semaine » active dans la capture de PC-Semaine.html / Semaine.html (semaine courante) | Pastille inactive (`aria-disabled`, atténuée) dans la semaine courante, active ailleurs | Critère 4 de la fiche ; la pastille garde le focus clavier |
| 2026-10-02 | S-03 | Ancre de la semaine : `week.anchorDate` dans un store (fiche) | Route de navigation `{ tab: 'week', weekStart }` (ADR 0004 §4) ; `null` = semaine courante, qui suit minuit | Source de vérité unique de la navigation ; la dernière semaine consultée est conservée par `lastRoutes`, perdue au redémarrage (critère 7) |
| 2026-10-02 | S-03 | Sens du glissement à l'affichage d'une autre semaine | Glissement bref de 180 ms dans le sens du geste (maquettes muettes) ; coupé par « Réduire les animations » | Retour visuel du changement ; critère 8 |
| 2026-10-02 | S-04 | « + Ajouter » dessiné seulement sur le dimanche vide dans Semaine.html (iPhone) | Affiché en bas de chaque jour, PC et iPhone ; chip de 32 px à zone tactile de 44 px, champ de 44 px à l'ouverture | Le PRD prime (fiche S-04, écart signalé) ; PRD 5 pour la zone tactile |
| 2026-10-02 | S-04 | Nom accessible du bouton « + Ajouter » (sept boutons identiques) | « Ajouter une tâche, jeu. 24 » ; texte visible « + Ajouter » | Distinguer les jours aux lecteurs d'écran |
