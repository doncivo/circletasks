# N-FIX-04 — Rappel dans la plage silencieuse : l'app le dit au moment du choix, et la routine le montre

Module : M5 Rappels, avec M13 Espaces (ES-07) · Palier : **avant la 1.0 d'office** (règle de tri d'AGENTS.md : état faux affiché sans le dire) · Agent : notifications + ui-design-system · Ouverte le 2026-10-27 par Claude Code à la demande d'Ali.

Statut : **ouverte, à chiffrer et à placer par Ali** (voir « Estimation et place »). Aucun code.

## Origine

Enquête du 27 octobre 2026 (journal iPhone du jour, routines Pro à 20:00 tous les jours, plage Pro 19:00–08:00 et week-end) : l'app fonctionne comme prévu, chaque rappel est décalé au prochain matin de semaine à 08:00 (`effectiveFireAt`, ES-07 critères 5 à 7). Le défaut est ailleurs : au moment où Ali a réglé un rappel à 20:00 pour une routine Pro, l'app l'a accepté en silence, en sachant qu'il ne sonnerait pas à cette heure. Dans les mots d'Ali : « j'ai réglé un rappel à 20:00 et elle l'a accepté en silence, sachant qu'il ne sonnerait pas à cette heure ». Ce que montre l'écran (une heure de rappel) n'est pas ce qui se passe (une autre heure, un autre jour) : état faux muet.

Ce qui existe déjà : le corps de la notification porte « · décalé » (N-FIX-02) ; la fiche Détail d'une tâche iPhone montre « Décalé par la plage silencieuse de {space} » (UI-REFONTE-01, `taskRefonteText.quiet`) ; le bloc Rappel du PC avertit quand l'iPhone n'est pas synchronisé (N-07, `IphoneReminderWarning`, qui calcule déjà l'échéance effective). Rien n'avertit au moment du choix, ni sur la liste des routines.

## Demande d'Ali (2026-10-27)

1. Au moment où l'utilisateur choisit une heure de rappel qui tombe dans la plage silencieuse de l'espace choisi, l'app le dit **tout de suite**, sur l'écran de création comme sur celui de modification, sur les **trois formulaires** : tâche, routine, événement.
2. Formulation unique, celle de N-FIX-02 : **« Rappel décalé au lundi 08:00 — aucun rappel Pro après 19:00 »** (jour et heure effectifs, nom de l'espace, borne de la plage qui couvre l'heure choisie).
3. Sur l'écran Routines, une routine dont **tous** les rappels sont systématiquement décalés le montre **dans sa ligne**, pas seulement à la création.

## Critères d'acceptation (à valider par la passe product-owner)

1. Domaine pur : `quietShift(fireAt, quietHours)` rend `null` si l'échéance n'est pas couverte, sinon `{ effective, range }` avec la plage qui commence le silence (pour « après 19:00 » ou « le week-end »). Même règle que `effectiveFireAt`, qui reste la source de l'échéance effective ; aucun changement de planification.
2. Texte dans `src/i18n` (fr source, en suit), chargé avec le bloc du formulaire, jamais dans le départ : « Rappel décalé au {day} {time} — aucun rappel {space} après {from} » ; variante pour une plage « toute la journée » : « … — aucun rappel {space} le week-end » ou « … le {jour} ». Jour formaté par `formatDayLabel`, heures en 24 h.
3. Formulaire **tâche** (Nouvelle tâche iPhone, feuille Modifier, champs PC) : dès qu'une date, une heure, un espace et au moins une avance sont choisis, chaque avance dont l'échéance effective diffère de l'échéance d'origine affiche la ligne sous les choix de rappel ; elle disparaît dès que le choix change et n'est plus couvert. Création et modification.
4. Formulaire **routine** : échéance de la prochaine occurrence prévue (`routineReminderFireAt`) pour chaque avance ; même ligne, même disparition ; création et modification. Changer l'espace recalcule.
5. Formulaire **événement** : même règle sur la prochaine occurrence et les avances d'événement (10080, 1440, 0).
6. Écran **Routines** : une routine avec heure et au moins un rappel dont **toutes** les avances sont décalées sur les sept prochaines occurrences prévues porte dans sa ligne d'information « Rappels décalés à {time} » (heure effective de la prochaine), et l'aide vocale le dit ; une routine partiellement décalée ne porte rien (règle « tous », demandée par Ali) ; sans heure ou sans rappel, rien.
7. Aucune ligne n'apparaît quand l'espace n'a aucune plage, quand l'heure est hors plage, ou quand les plages couvrent toute la semaine (l'échéance d'origine est rendue, ES-07 critère 7 ; dans ce cas la ligne dit « aucun rappel {space} : plages continues »).
8. Tests rouges avant le code : domaine (`quietShift`), un test DOM par formulaire (création et modification) et un pour la ligne Routines ; e2e iPhone sur le formulaire routine (le cas d'Ali) ; e2e PC sur le formulaire tâche. Lint, typage, bundle 62/62 sans entrée nouvelle dans la liste du départ.
9. Hors périmètre : modifier la planification ou les plages ; proposer de changer l'heure ou la plage (après la 1.0, ligne au backlog) ; la ligne « Décalé » de Détail (déjà livrée) reprend la formulation unique seulement si cela n'augmente pas le départ.

## Estimation et place

Estimation : **7 à 9 h actives**, alerte à 12 h. Détail : domaine et textes 1,5 h ; trois formulaires, création et modification, avec leurs tests DOM 3,5 à 4,5 h ; ligne Routines 1,5 h ; e2e, bundle, fiche et revue 1 h.

Place proposée : **avant les huit refontes, juste après l'ouverture**, parce que la règle de tri la met avant la 1.0 d'office et qu'elle touche trois formulaires que les refontes Routines et Événements vont redessiner : livrer la ligne d'abord, puis la refonte la garde (règle 4 des maquettes de refonte : aucune valeur interne, et une décision visible). Les défauts 12, 15 et 13 sont des défauts visibles ; ils passent après cette story si Ali le confirme.

## Preuves

- Rouge : à écrire avant le code, identifiants dans cette section.
- Vert : à consigner avec le commit et le run CI.

## Passes

- Product-owner : critères ci-dessus à confirmer par Ali (règle « tous les rappels » pour la ligne Routines, formulation exacte, place).
- Agent du module, QA, code-reviewer : après l'accord.
