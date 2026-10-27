# UI-REFONTE-02 — Aujourd'hui sur iPhone, clair et sombre : l'agenda du jour

Module : M2 Aujourd'hui (avec M17 pour la ligne d'objectif, M7 et M8 pour les événements) · Palier : refontes après la 1.0.2, première des huit dans l'ordre d'Ali du 2026-10-27 · Agent : tasks-planning avec ui-design-system · Ouverte le 2026-10-27 par Claude Code.

Statut : **ouverte, passe product-owner écrite ; aucun code.** Estimation : 10 à 14 h actives ; alerte à 15 h (Ali prévenu si l'estimation dérape de plus de 50 %).

Références : `docs/maquettes-refonte/Jour.html` (clair) et `Jour-Sombre.html` (sombre), PR #84 fusionnée dans `main` (962893b1), et les huit règles transversales du README du même dossier. Écran réel de départ : `src/features/today/` (carte relevée le 2026-10-27 au soir : `TodayScreen.tsx`, `TodayHeader.tsx`, `TodayParts.tsx`, `TodayListView.tsx`, `TodayRows.tsx`, `TodayCreate.tsx`, `TodayScreen.css`, domaine `src/domain/todayList.ts`).

## Passe product-owner

### Ce que la maquette change (et ce qu'elle ne change pas)

La maquette remplace la liste à cartes par **l'agenda du jour** : une colonne d'heures à gauche, une ligne « maintenant » qui traverse l'écran, ce qui est passé qui recule, ce qui est dû qui passe en gros, les tâches sans heure derrière un tiret. Onze zones d'interface ramenées à six : date, objectif en une ligne, filtres, agenda, ligne « maintenant », ajout. Disparaissent : le badge « AUJOURD'HUI », les icônes décoratives par tâche, les deux cartes encadrées (objectif, événement), la bascule du mode édition et le bouton « Vue compacte » **de l'écran** (les deux fonctions restent, voir critère 2). Le système visuel ne change pas (Fraunces, DM Sans, encre, couleurs d'espaces et d'onglets).

**Périmètre : la mise en page iPhone (`useLayout() === 'mobile'`) d'Aujourd'hui, dans les deux thèmes.** La mise en page PC ne change pas (c'est la septième refonte, `PC-Jour.html`). Aucune fonction retirée, aucun texte supprimé du catalogue sans remplacement, aucune écriture en base modifiée, aucune route nouvelle. Les comportements livrés par N-FIX-04 (avertissements de formulaire), UI-FIX-04 (retour à gauche), UI-FIX-05 (un seul bouton d'ajout d'objectif), UI-FIX-06, A-09 (squelette, bandeaux) et UI-REFONTE-01 (feuille « Nouvelle tâche », Détail) sont conservés tels quels.

### Écarts avec le PRD, à trancher par Ali (ligne PRD-02 proposée, le PRD n'est pas modifié par cette story)

Les maquettes validées par Ali le 24 octobre contredisent quatre formulations du PRD ; la story suit les maquettes et garde la fonction derrière une autre commande :

| PRD | Formulation actuelle | Maquette | Choix de la story |
| --- | --- | --- | --- |
| A-05 | « Interrupteur « − » en bas à gauche » | bascule édition supprimée de l'écran | « Mode édition » dans le menu « Plus d'options » de l'en-tête ; la barre de sélection, les poignées et les actions groupées ne changent pas |
| A-06 | « Icône à deux flèches à droite de la date » | bouton absent | « Vue compacte » dans le même menu ; choix mémorisé inchangé ; Routines et Checklists gardent leur icône (hors périmètre) |
| OB-02 | « objectif affiché en tête d'Aujourd'hui, encadré » | une ligne « Objectif · titre · 2/5 », sans cadre | ligne sans cadre, un toucher ouvre Objectif ; l'épinglage garde son interrupteur et son sens |
| OB-01, SD-01 | « icône cible » et « icône horloge en haut d'Aujourd'hui » | en-tête réduit à Rechercher et « Plus d'options » | « Objectif de la semaine » et « Un jour » (avec son compte) dans le menu « Plus d'options » ; Rechercher reste une icône |

Si Ali préfère garder ces quatre commandes visibles dans l'en-tête, seul le critère 2 change ; le reste de la story tient.

### Critères

1. **En-tête.** Mois et année en petit gris (« septembre 2026 »), jour en Fraunces sur une ligne (« mercredi 23 », ajusté par `useFitText` comme aujourd'hui), plus de badge « AUJOURD'HUI » (la clé `tasks.todayBadge` reste utilisée par le PC, inchangé). À droite : Rechercher (inchangé) et un bouton « Plus d'options ». Hors du jour courant (date naviguée), même en-tête ; la ligne « maintenant » n'apparaît que le jour courant (critère 5).
2. **Menu « Plus d'options »** (`ActionMenu` existant, hôte et catalogue **à la demande**, assertion « hors du départ ») : « Un jour » (avec le nombre de tâches, SD-01), « Objectif de la semaine », « Rapport du mois », « Vue compacte » (interrupteur, A-06), « Mode édition » (interrupteur, A-05). Chaque entrée ouvre exactement ce que l'icône ou la bascule ouvrait. Le retour de ces écrans reste à gauche (UI-FIX-04).
3. **Objectif en une ligne.** Pour chaque objectif épinglé visible sous le filtre courant : « Objectif » en gris, titre, progression « 2/5 » (ou « Atteint ») en chiffres tabulaires, séparée par un filet ; un toucher ouvre Objectif ; aucun cadre, aucune légende « Objectif de la semaine ». Sans objectif épinglé : aucune ligne (règle 3, aucun élément qui ne peut rien faire). Les propositions Reconduire / Clore (OB-05) gardent leur place au-dessus des lignes.
4. **Filtres.** Tout / Pro / Perso en pastilles (Tout pleine quand active ; Pro et Perso au trait, texte de la couleur de l'espace) ; le menu Projet existant est conservé à droite des pastilles.
5. **Agenda.** Les lignes du jour, routines, tâches et événements mêlés, sont triées par heure ; chaque ligne porte l'heure à gauche (colonne de 46 px, chiffres tabulaires) ; les éléments sans heure portent un tiret et viennent **après** les éléments à l'heure, dans l'ordre manuel (A-02 : le glisser-déposer agit sur cet ordre ; parmi les éléments à l'heure il ne change pas l'heure). Le jour courant, la ligne « maintenant » (heure en gras, point, trait traversant l'écran, `aria-label` « Il est 14 h 32 ») s'insère à l'heure courante et se déplace chaque minute :
   - **passé** : lignes dont l'heure est avant maintenant, texte et heure atténués ; une tâche ou routine faite est barrée et sa case pleine atténuée (« Rouvrir : … ») ;
   - **dû** : tâche à l'heure, non faite, dont l'heure est passée : placée juste **avant** la ligne « maintenant », titre en Fraunces 27 px, heure en gras, case 28 px, sous-ligne rouge « En retard de 32 min · Perso » (minutes, puis heures au-delà de 60 min, texte dans `src/i18n`) ; une routine en retard reste une ligne normale (pas de retard pour une routine) ;
   - **à venir** : lignes normales après la ligne « maintenant » ;
   - **sans heure** : après tout le reste, tiret dans la colonne ; faites : barrées en fin de groupe.
   Les éléments faits ne descendent plus en bloc en bas de liste : ils restent à leur heure. Hors du jour courant, pas de ligne « maintenant », rien n'est « passé » ni « dû » : lignes normales triées par heure, faites barrées à leur place.
6. **Lignes.** Tâche : case à cocher (terminer / rouvrir), titre 17 px, sous-ligne : espace en « Tout » (couleur de l'espace), rien sinon ; plus d'icône décorative à droite ; les gestes A-07, l'appui long, la fiche Détail (A-08), les boutons équivalents VoiceOver et le mode édition (poignée, rond de sélection) sont inchangés. Routine : case, titre, sous-ligne « Routine · tous les mardis et vendredis » (la phrase de fréquence existante), ligne « Rappels décalés » conservée quand elle s'affiche aujourd'hui. Événement (E-01 à E-04, K-0x) : rond au trait de la couleur des événements au lieu d'une case, titre, sous-ligne = nom du calendrier ou « Journée entière » ; compte à rebours « J-12 » conservé en sous-ligne pour les événements importants ; plus de bandeau coloré.
7. **Ajout.** En bas, au-dessus de la zone de sécurité : champ « Ajouter une tâche » (rond, même saisie rapide Q-01/Q-06 qu'aujourd'hui), bouton Scanner au trait, bouton « + » plein qui ouvre la feuille « Nouvelle tâche » (UI-REFONTE-01) ; `aria-label` « Ajouter » conservé (e2e et aides). La barre de sélection du mode édition se superpose à cette rangée comme aujourd'hui.
8. **Checklists du jour** (C-03) : section conservée sous l'agenda, sans cadre, même style de ligne (tiret dans la colonne, progression « 3/5 » en sous-ligne).
9. **État vide** (A-01, TodayEmpty) : texte d'aide existant, sans carte ; la ligne « maintenant » reste affichée le jour courant au-dessus de l'ajout.
10. **Sombre** (`Jour-Sombre.html`) : mêmes jetons `tokens.css` ; les gris du passé, le rouge du retard, le trait « maintenant » et le rond d'événement ont un jeton par thème ; toutes les paires texte/fond nouvelles passent le test de contraste de UI-FIX-01 (`contrastCss.test.ts`, paires déclarées dans `cssContrastKit.ts`).
11. **Zone de sécurité iOS** (règle 8) : en-tête sous `--ct-safe-area-top`, rangée d'ajout au-dessus de `--ct-safe-area-bottom`, clavier ouvert compris (visualViewport déjà géré par la feuille).
12. **Bundle de départ** : aucun module nouveau dans le départ ; le menu « Plus d'options » et son catalogue sont à la demande ; mesure avant push et sur `main` après fusion ; plafond 358 400 octets inchangé. Le retrait des cartes et des icônes doit faire **baisser** la mesure ou la laisser stable ; toute hausse est expliquée dans la fiche.
13. **PC** : aucune différence de rendu ni de test (`TodayList.test.tsx` l.33, e2e `pc`).

### Preuves attendues

- **Rouge d'abord** (commit de tests seuls, exécuté et rouge, identifiant dans la fiche) : `src/domain/todayAgenda.test.ts` (tri par heure, insertion de « maintenant », groupes passé / dû / à venir / sans heure, faits à leur place, retard en minutes puis heures, jour non courant) ; `src/features/today/TodayAgenda.test.tsx` (en-tête sans badge, menu « Plus d'options » et ses cinq entrées, ligne d'objectif, ligne « maintenant », styles passé / dû, rond d'événement, tiret, absence d'icône décorative, PC inchangé) ; e2e `tests/e2e/UI-REFONTE-02.spec.ts` sur `iphone` et `iphone-webkit` (agenda visible, création par le champ et par « + », Mode édition et Vue compacte par le menu, retour à gauche depuis Objectif et Un jour, thème sombre) ; paires de contraste ajoutées dans `cssContrastKit.ts`.
- **Vert ensuite** : suites `today`, `domain/todayList`, `goals/GoalsPinned` et `theme` ; adaptations tracées des tests historiques qui lisent le badge, les cartes ou la bascule (A-01, A-05, A-06, IOS-titres, `GoalsPinned`, `helpers/goals.ts`, `tests/visual/capture.spec.ts` maquette `Main.html` → `Jour.html`) ; lint ; typage ; bundle 62/62 ; CI complète.

### Hors périmètre de cette story

Semaine, Synchronisation, Routines, Checklists, Événements, Aujourd'hui PC, Réglages PC (stories suivantes) ; toute modification du PRD (PRD-02 à ouvrir par Ali) ; toute écriture en base ; le rendu natif sur l'iPhone (séance d'Ali au prochain lot).

## Passe agent du module

À écrire après la preuve rouge.

## Passe QA

À écrire.

## Passe code-reviewer

À écrire.
