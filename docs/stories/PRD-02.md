# PRD-02 — Mise à jour du PRD après les huit refontes : les écarts, groupés en lots, avec leur effet à l'usage

Module : M16 (transverse) · Palier : refontes après la 1.0.2 · Agent : product-owner, arbitrage par Ali · Ouverte le 2026-10-28 par Claude Code à la demande d'Ali (« présente-les-moi groupés, avec pour chacun ce que ça change pour moi à l'usage, je trancherai par lot »).

Statut : **ouverte, arbitrage par lot attendu.** Le PRD n'est pas modifié tant qu'Ali n'a pas tranché ; chaque lot accepté donne lieu à une retouche des stories citées (formulation des critères), jamais à une fonction nouvelle ni à une sortie du périmètre.

Sources : le tableau « Écarts avec le PRD et les maquettes, assumés » de chaque fiche `UI-REFONTE-02` à `UI-REFONTE-09`. Les écarts purement internes (classes CSS, aides e2e) ne sont pas repris ici. Ce qui n'a pas changé n'est pas listé : les réglages, les données, les raccourcis clavier, l'enregistrement, les libellés accessibles.

## Lot A — Les commandes qui ont changé de place (Aujourd'hui, iPhone et PC)

| Story | Le PRD disait | L'app fait | Ce que ça change à l'usage |
| --- | --- | --- | --- |
| A-05 | interrupteur « − » (mode édition) en bas à gauche | iPhone : « Mode édition » dans le menu « Plus d’options » (en haut à droite) ; PC : bouton nommé « Édition » dans la barre fixe | iPhone : un toucher de plus pour entrer en édition ; PC : la commande est lisible sans survol |
| A-06 | icône « deux flèches » (vue compacte) à droite de la date | iPhone : « Vue compacte » dans le même menu, et retirée des écrans Routines et Checklists ; PC : bouton nommé « Compacte » | iPhone : un toucher de plus, et Routines / Checklists ne se replient plus ; PC : lisible |
| OB-01, SD-01 | icône cible (Objectif) et icône horloge (Un jour) en haut d'Aujourd'hui | iPhone : les deux dans le menu « Plus d’options » (Un jour garde son compte) ; PC : boutons nommés « Objectif », « Un jour » | iPhone : un toucher de plus pour ouvrir Objectif ou Un jour ; le compte de « Un jour » reste visible dans le menu |
| A-01 | badge « AUJOURD'HUI » sur le jour courant | plus de badge ; la ligne « maintenant » (heure courante, trait traversant) dit le jour courant sur les deux plateformes | on sait qu'on est sur aujourd'hui parce que l'heure courante est tracée ; un autre jour n'a pas de ligne « maintenant » |
| Maquette PC (T-01) | bouton flottant « + » | PC : bouton nommé « Ajouter » dans la barre, même geste (focus du champ en ligne) ; iPhone : bouton flottant inchangé | rien à l'usage : même geste, bouton déplacé et nommé |

**Si tu refuses le lot** : les commandes reviennent dans l'en-tête iPhone (quatre icônes) et le badge revient ; les maquettes `Jour.html` et `PC-Jour.html` ne sont plus la référence sur ce point.

## Lot B — Les libellés qui s'écrivent en mots

| Story | Le PRD disait | L'app fait | Ce que ça change à l'usage |
| --- | --- | --- | --- |
| R-01 | compteur « 2/7 » sur la carte de routine | iPhone : « 2 sur 7 cette semaine » dans la ligne d'informations ; PC : « 2/7 » | on lit une phrase, plus une fraction ; même nombre |
| C-02 | progression « 3/5 » | iPhone : « 2 sur 3 » ; PC : « 3 / 6 » | idem |
| C-05 | bouton « Effacer les cochés » | iPhone : « Supprimer les 2 éléments cochés » (compte, rouge, inactif à zéro) ; la confirmation et le PC gardent « Effacer » | on sait combien d'éléments partent avant d'appuyer ; le bouton est éteint quand il n'y a rien à supprimer |
| E-03 | étiquettes « Férié FR » / « Férié TN » dans la liste des événements | iPhone : plus d'étiquette, sous-ligne « Jour férié en France » ; PC : « Jour férié en France » aussi ; les bandeaux d'Aujourd'hui et de la Semaine gardent « Férié FR » | le pays s'écrit en toutes lettres dans la liste ; les fériés reculent en gris, le vert est rendu aux événements propres |
| T-11 | « Europe/Paris (automatique) » | PC : valeur « Europe/Paris » avec la mention « Suit celui de Windows » sous l'étiquette ; iPhone inchangé | même information, dite autrement |
| P-01 | « Onglets · 5 visibles » | PC : « Onglets visibles · 5 sur 5 » (Réglages, toujours affiché, ne compte pas) ; iPhone inchangé | on voit le total ; Réglages n'y figure pas parce qu'il ne se masque pas |
| P-02, P-03 | une ligne « Thème · semaine · heure : Système · lundi · 24 h » | PC : trois lignes (« Thème : Système », « Début de semaine : Lundi », « Format de l’heure : 24 h »), toutes vers le même écran ; iPhone inchangé | chaque valeur près de son étiquette ; trois endroits où cliquer au lieu d'un |
| D-04, P-08 | ligne « Raccourcis clavier · Afficher » ; combinaison prise : « Indisponible : … » barrée à côté de l'interrupteur | « Tous les raccourcis · Ctrl / » (ligne cliquable) ; combinaison prise : phrase « Ctrl+Alt+Espace est utilisé par une autre application. Choisissez-en un autre. » sous l'étiquette, touche en ambre | on comprend pourquoi la capture rapide ne marche pas et quoi faire ; plus de barré |
| Y-04 | journal des conflits : « élément, champ, valeur gardée, valeur écartée » ; bouton « Restaurer » | « Heure prévue de « Envoyer la facture » », valeur appliquée, valeur écartée ; « Rétablir », message « Valeur rétablie » | le conflit nomme ce qui a changé au lieu du nom interne du champ ; un verbe au lieu d'un autre |
| Y-11 (fiche) | « RÉINITIALISATION » | « Repartir de zéro », isolé dans un bloc qui annonce son coût ; dialogues inchangés | le bouton dit ce qu'il fait ; rien ne change à ce qu'il fait |
| Maquettes (R-01, E-01) | « Éditer » / « Calendrier » | « Modifier » (un seul verbe dans l'app) ; « Vue calendrier » (le titre de la feuille reste « Calendrier ») | vocabulaire unifié |

**Si tu refuses le lot** : retour des fractions et des étiquettes ; le reste des écrans ne bouge pas.

## Lot C — Les icônes et marques décoratives retirées des listes iPhone

| Story | Le PRD disait | L'app fait | Ce que ça change à l'usage |
| --- | --- | --- | --- |
| T-03 | icône décorative à droite de la ligne (Aujourd'hui, Semaine) | plus d'icône dans l'agenda d'Aujourd'hui (iPhone et PC) ni dans la ligne iPhone de la Semaine ; elle reste dans la fiche Détail, le formulaire et l'onglet Routines | l'icône choisie pour une tâche ne se voit plus dans les listes du jour et de la semaine, seulement en ouvrant la tâche |
| OB-02 | objectif « en tête d'Aujourd'hui, encadré » | une ligne « Objectif · titre · 2/5 » sans cadre, un toucher ouvre Objectif ; l'épinglage garde son interrupteur | même place, même geste, sans cadre |
| OB-03 critère 3 | marque « objectif » sur la ligne iPhone de la Semaine | plus de marque dans la Semaine iPhone ; la fiche Détail et la carte PC la gardent | on ne voit plus dans la Semaine iPhone qu'une tâche est rattachée à l'objectif |
| R-01 | icône de la routine sur la carte iPhone | plus d'icône sur la carte ; elle reste dans le formulaire et le rapport | la liste des routines est en texte seul |

**Si tu refuses le lot** : les icônes reviennent dans les lignes, au prix de la ligne plus chargée des maquettes de septembre. C'est le lot où un refus partiel a le plus de sens (par exemple garder la marque d'objectif dans la Semaine, OB-03).

## Lot D — La Semaine sur iPhone : ajout et repères

| Story | Le PRD disait | L'app fait | Ce que ça change à l'usage |
| --- | --- | --- | --- |
| S-04 | champ d'ajout rapide en bas de chaque jour | iPhone : un seul champ en bas, « Ajouter à jeudi 24 », qui vise le **jour sélectionné** (aujourd'hui par défaut ; un toucher sur l'en-tête d'un jour le sélectionne) ; PC : un champ par colonne, inchangé | pour ajouter à un autre jour, on touche d'abord son en-tête ; un seul champ au lieu de sept |
| S-01 | jour courant « mis en évidence » | trait d'encre et jour en gras, pas de fond gris | même repère, autre forme |
| S-03 | retour « Cette semaine » | la pastille n'apparaît que hors de la semaine courante | rien à l'usage : elle est là quand elle sert |

## Lot E — La Synchronisation : un seul vocabulaire d'état

| Story | Le PRD disait | L'app fait | Ce que ça change à l'usage |
| --- | --- | --- | --- |
| Maquette (Y-03) | bouton « Vérifier », état « Tout est parti vers iCloud », « Dernier envoi il y a 2 minutes » | la carte reprend la ligne d'état existante (« À jour · il y a 2 min », erreurs nommées) et le bouton « Synchroniser » | un seul libellé d'état partout (bandeau, Réglages, écran) ; le vert n'apparaît que si tout est parti |
| Maquette (Y-09) | appareils « Actif / Oublié » | les huit statuts existants restent, en pastilles de couleur (vert actif, gris oublié ou jamais vu, rouge pour le reste) | on garde « Horloge en avance », « Version plus récente : mettez à jour l'app », etc. |
| Y-10 | identifiant d'appareil visible | « Cet appareil » pour soi, nom + huit caractères d'identifiant pour les autres (exigence de l'audit Y-10 conservée) | rien ne change |

## Lot F — Réglages PC et Événements : structure

| Story | Le PRD / la maquette disait | L'app fait | Ce que ça change à l'usage |
| --- | --- | --- | --- |
| Maquette PC-Reglages | section « Sauvegardes » | « Sauvegardes et données » : sauvegarde, import CSV, données d'exemple, Corbeille | un seul endroit pour tout ce qui touche aux données ; la Corbeille y reste (T-08, point d'accès unique) |
| Reglages.html (septembre) | « Jours fériés » dans TÂCHES | PC : dans « Espaces et agendas » ; iPhone : dans TÂCHES, inchangé | on cherche les fériés avec les agendas sur PC |
| Maquette PC-Reglages | chevron sur « Fuseau horaire » | pas de chevron : lecture seule (T-11) | rien : il n'y a rien à ouvrir |
| Maquette Evenements-v2 | « Masquer les fériés » | pastille d'affichage mémorisée le temps de la session, pas un réglage ; les calendriers se règlent dans Réglages (E-03 critère 3) | à la prochaine ouverture, les fériés sont de nouveau affichés ; le réglage durable reste dans Réglages |
| Maquette Evenements-v2 / PC-Jour | compte à rebours « dans 40 j » | « J-40 » conservé (forme du PRD E-04, partagée partout) | rien ne change |

## Ce que j'attends d'Ali

Un oui, un non ou un « oui sauf … » par lot (A à F). Pour chaque lot accepté, la retouche du PRD (formulation des critères des stories citées) est faite dans une PR de documentation, avec le tableau ci-dessus comme source ; pour un lot refusé, une story de correction est ouverte par écran concerné. Rien n'est changé dans l'app tant que le lot n'est pas tranché.
