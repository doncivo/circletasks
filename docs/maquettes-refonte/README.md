# Maquettes de refonte — 24 octobre 2026

Onze maquettes HTML autonomes, dessinées à partir des **écrans réels de la 1.0.0**
(captures iPhone et PC du 24 octobre), et non des maquettes d'origine de septembre.

Ouvrir `index.html` dans un navigateur pour les parcourir.
Les écrans iPhone font 440 × 956, les écrans PC 1440 × 900.

Le système visuel ne change pas : Fraunces pour les titres, DM Sans pour le texte,
encre `#2E2150`, couleurs d'onglets et couleurs d'espaces inchangées.
Seules la hiérarchie, la mise en page et les formulations changent.

---

## iPhone

| Fichier | Écran | Ce que la maquette corrige |
|---|---|---|
| `Jour.html` | Aujourd'hui | Colonne d'heures et ligne « maintenant » traversant l'écran. Ce qui est passé recule, ce qui est dû passe en gros. Suppression du badge « AUJOURD'HUI », des icônes décoratives par tâche, des deux cartes encadrées, du bascule édition. Onze zones d'interface ramenées à six. |
| `Jour-Sombre.html` | Aujourd'hui, sombre | Même écran sur la palette sombre validée. |
| `Semaine-v2.html` | Semaine | Heures alignées en colonne. Aujourd'hui marqué par le trait d'encre et non par un fond gris. Jours en minuscules, week-end allégé. Ligne de synthèse : restantes, faites, en retard. |
| `Ajout-v2.html` | Nouvelle tâche | **Dessiné clavier ouvert**, son seul état réel. Titre seul en grand, trois décisions visibles (date, heure, espace), bouton « Ajouter la tâche » toujours au-dessus du clavier. Icône, répétition, rappel et projet passent derrière « Plus d'options ». Une seule commande par décision. |
| `Detail-v2.html` | Détail d'une tâche | **Échéance et rappel séparés** : « Prévue jeudi 19:30 » puis « Rappel vendredi 08:00 · Décalé : aucun rappel Pro après 19:00 ». Une seule commande pour terminer. Reporter / Un jour / Dupliquer remontent, le Focus redescend. Zone de sécurité iOS respectée. |
| `Synchro-v4.html` | Synchronisation | État en une phrase vraie ; le vert n'apparaît que si tout est effectivement parti. Trois appareils, un seul gabarit, noms lisibles, statut aligné en colonne. Les conflits nomment ce qui a changé (« Date de *Test Pc* ») au lieu d'exposer le champ interne. « Repartir de zéro » isolé dans un bloc qui annonce son coût. |
| `Routines-v2.html` | Routines | Les sept pastilles reflètent enfin le programme : pointillé = non prévu, contour = prévu, plein = fait. « 0/0 » devient « 3 sur 5 cette semaine ». La phrase d'aide sort de la zone de contenu. |
| `Checklists-v2.html` | Checklists | Le nom n'apparaît qu'une fois : le sélecteur est le titre. Un seul moyen d'ajouter. « Supprimer les 2 éléments cochés » porte le compte et le rouge ; « Tout décocher », réversible, ne les porte pas. |
| `Evenements-v2.html` | Événements | Les événements personnels gardent toute l'encre, les jours fériés reculent en gris. Les badges colorés disparaissent — le pays s'écrit en toutes lettres, ce qui libère le vert. |

## PC Windows

| Fichier | Écran | Ce que la maquette corrige |
|---|---|---|
| `PC-Jour.html` | Aujourd'hui | Colonne du jour bornée à 660 px. Seconde colonne — demain, la semaine, les raccourcis — au lieu des trois quarts de fenêtre vides. Icônes de barre nommées. Bouton flottant retiré. Barre supérieure fixe. |
| `PC-Reglages.html` | Réglages | Sommaire à gauche, colonne de réglages bornée à 660 px : la valeur reste près de son étiquette au lieu de partir à 1800 px. « Thème · semaine · heure » redevient trois lignes. Le raccourci en conflit s'explique en une phrase au lieu d'être barré à côté d'un interrupteur allumé. |

---

## Règles transversales que ces maquettes appliquent

1. **Chaque écran est dessiné dans l'état où il est utilisé** — clavier ouvert, liste vide, synchro en panne. Un écran qui n'est juste qu'à vide n'est pas fini.
2. **Une décision, une commande.** Deux façons de faire la même chose à l'écran : l'une des deux est du bruit.
3. **Aucun réglage qui ne peut rien faire.** Pas d'interrupteur « Rattacher à mon objectif » quand il n'y a pas d'objectif.
4. **Aucune valeur interne affichée** : pas de « · date », « · reportée », « 00:00 », « 0/0 », « PC 56d4 ».
5. **Le vert ne signifie qu'une chose** : c'est effectivement parti. Jamais une attente, jamais un pays.
6. **L'action destructrice descend, s'annonce et n'est jamais la seule action visible.**
7. **Sur grand écran, on borne et on navigue** ; on n'étire pas la mise en page du téléphone.
8. **La zone de sécurité iOS est respectée partout**, y compris clavier ouvert.
