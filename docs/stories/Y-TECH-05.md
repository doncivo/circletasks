# Y-TECH-05 — Compte rendu visible du report d'époque

Module : M15 Synchronisation (écran : Réglages > Synchronisation > Détails) · Ordre de construction : palier 1.0, **étape 2, après Y-TECH-04** (placement proposé, à confirmer par Ali) · Agents : **sync-icloud** (constitution et persistance du compte rendu, banc) + **settings-personalization** (écran, bandeau, textes) · Relecture : code-reviewer · Estimation : **14 à 18 h** (sous-tâches 14 à 16 h, plus 2 h de réserve de relecture et de reprise de QA) · Statut : **à faire, à confirmer par Ali (placement avant la 1.0)**
Story technique, sans équivalent au PRD (écart à noter dans docs/decisions.md : ligne du 2026-10-17). Ajout 2 de la séance B14 du 2026-10-17.
Dépend de : **Y-TECH-04** (règle B validée par Ali). Touche `src/sync/epochSwitch.ts` : **même fichier que Y-FIX-04** (B4), donc jamais en parallèle avec lui ; ordre entre les deux à confirmer (voir « Placement »). Touche `src/db/migrations` (une migration), `src/db/repositories`, `src/features/sync` (écran et bandeau), `src/i18n`. Ne touche pas le format publié, les tables synchronisées ni Rust.

## Décision d'Ali du 2026-10-17 (ajout 2), mot pour mot

« 2. Après un report d'époque, l'app doit me présenter un compte rendu visible, pas seulement un journal : combien d'écritures reportées, par quel appareil, et surtout la liste nommée de ce qui a été rétabli alors que je l'avais supprimé. C'est le risque résiduel assumé de l'option B : il n'est acceptable que si je le vois. Le report d'époque est l'opération la plus dangereuse de l'app et c'est aujourd'hui la plus silencieuse. Chiffre-le et dis-moi si ça tient avant la 1.0 ou si ça doit attendre. »

## Placement : recommandation du product-owner

**Avant la 1.0, à l'étape 2, juste après Y-TECH-04.** Raison : Ali conditionne l'acceptation de l'option B à ce compte rendu (« il n'est acceptable que si je le vois »). Sans cette story, l'option B validée le 2026-10-17 expose un rétablissement silencieux d'éléments supprimés, ce que la règle du projet « aucun échec silencieux » (blocage ou effet durable visible dans l'app, pas seulement dans les logs) interdit. Attendre après la 1.0 reviendrait à publier une règle acceptée sous condition sans remplir la condition.

Coût : 14 à 18 h, qui s'ajoutent au palier (voir `docs/backlog.md`, « Palier retenu »). Si Ali refuse ce coût avant la 1.0, l'alternative est de revenir à l'option A (qui perd « Test Pc » dans le cas réel du 2026-10-17) : ce n'est pas la recommandation.

Ordre avec Y-FIX-04 : les deux touchent `epochSwitch.ts`. Y-FIX-04 (enfant non lu d'un parent remplacé, gardé en `sync_parked` ou rattaché à « Sans projet ») produit des lignes que le compte rendu doit aussi nommer (catégorie « rattachées » ou « mises de côté », critère 9). Deux ordres sont possibles : Y-FIX-04 d'abord (Ali : « Enchaîne ensuite sur B4 »), puis Y-TECH-05 qui reprend sa catégorie ; ou Y-TECH-05 d'abord, puis Y-FIX-04 qui ajoute sa catégorie. **À confirmer par Ali ; recommandation : Y-FIX-04 puis Y-TECH-05** (une seule fois dans `epochSwitch.ts`, compte rendu complet dès sa livraison). Dans les deux cas, les deux stories sont avant la fin de l'étape 2.

## Contexte

- Le report d'époque (`src/sync/epochSwitch.ts`) se fait en quatre étapes : (a) `materialize` parque en `sync_parked` (motif `epoch-carry`) les champs à reporter, (b) remplace la base (restauration « Appliquer partout », époques concurrentes) ou fusionne (réinitialisation Y-11), (c) `reapply` réapplique par la règle de hlc, page par page, (d) republie. Journal actuel : `epoch-carry { target, rows }` et `epoch-carry-late` : aucun nom, aucun auteur, aucune date, rien dans l'interface.
- Règle B (ADR 0011 §24 point 6, validée le 2026-10-17 par Y-TECH-04) : survit tout ce que l'ouvreur `O` n'avait pas lu, sauf ses propres écritures et celles d'un appareil oublié. Risque résiduel : une valeur écartée par la restauration peut revenir si `O` ne l'avait reçue que par la republication d'un autre appareil. Le report **rétablit, il n'efface jamais** : c'est ce rétablissement qu'Ali veut voir.
- Tables existantes utiles : `sync_tombstone` (traces des suppressions purgées), `sync_parked`, `sync_field_clock`, `conflict_log` (avec `resolved_at`, écran `src/features/sync/ConflictList.tsx` : modèle d'acquittement), horloges de champ. Migrations jusqu'à **0018** ; la 0019 est **réservée à B8 (T-TECH-01, étape 4)**.
- **Numéro de migration, à trancher par l'agent au moment du code et à écrire dans cette fiche** : la table du compte rendu est la **0020** si T-TECH-01 a déjà pris la 0019 ; sinon **0019**, et alors la fiche T-TECH-01 et le backlog sont mis à jour pour que T-TECH-01 prenne la suivante. Aucun trou de numérotation n'est laissé : la 0020 sans 0019 ferait exécuter la 0019 de T-TECH-01 après la 0020 sur les bases déjà migrées. Comme Y-TECH-05 (étape 2) précède T-TECH-01 (étape 4), le cas attendu est **0019 ici, T-TECH-01 renumérotée en 0020** ; le product-owner met T-TECH-01 à jour au moment de l'attribution.
- Bundle de départ saturé : 358 045 octets gzip sur 358 400 (marge 355 octets, `tests/bundle/startBundle.test.ts`). L'écran est chargé à la demande ; le **bandeau** vit dans le shell et doit rester à quelques dizaines d'octets (ou être lui-même chargé à la demande après un indicateur minimal).
- Écart avec le PRD, à soumettre à Ali (non décidé) : Y-09 « Un élément supprimé ne réapparaît jamais » (ligne 305). Proposition : voir `docs/stories/Y-TECH-04.md`, section Contexte.

## Décisions retenues

- **Définitions (testables)**, pour une ligne `(table, id)` reportée au passage à l'époque `E` ouverte par `O`, sur l'appareil `B` qui reporte :
  - **rétablie** : dans la base juste après l'étape (b) (remplacement), la ligne était **supprimée** (`deleted_at` non nul, ou trace dans `sync_tombstone`) ; après l'étape (c) elle est **vivante** parce qu'un champ reporté l'a emporté par la règle de hlc ;
  - **recréée** : la ligne était **absente** de la base remplacée et l'entrée `'+'` du report la rend vivante ;
  - **reportée** (compteur seulement) : tout champ, toute ligne et toute trace purgée dont le report a été appliqué, qu'il change ou non la valeur visible.
  - Une suppression de `O` annulée par la restauration (la ligne est vivante dans la sauvegarde) n'est **pas** « rétablie par le report » : la ligne est vivante avant et après (c). Elle n'est pas listée (c'est le sens de la restauration, confirmé par Ali).
- **Un compte rendu par appareil et par report**, établi par l'appareil qui reporte (`B`), pas par l'ouvreur. « Par quel appareil » se lit deux fois : l'appareil qui a fait le report (`B`, nommé par `deviceName`, « Cet appareil » pour soi) et, pour chaque compteur, l'**auteur** `X` des écritures reportées.
- **Mode `replace` seulement pour le bandeau** (restauration « Appliquer partout », époques concurrentes). En **fusion** (réinitialisation Y-11, orpheline abandonnée), rien n'est remplacé donc rien n'est « rétabli » : le compte rendu est enregistré (compteurs, visible dans Détails) mais sans bandeau. À confirmer par Ali.
- **Titres en clair seulement en local** : le libellé nommé de chaque ligne (titre de la tâche, nom du projet) est stocké dans une table **non synchronisée**, jamais publié dans iCloud, jamais écrit dans le journal technique exporté (le journal garde ses compteurs et identifiants).
- **Bornée** : les **500 premières** lignes nommées sont conservées, le reste est compté (`overflow`). Les 20 derniers comptes rendus sont gardés ; un compte rendu **non acquitté n'est jamais élagué**.
- **Aucun échec silencieux** : si le compte rendu ne peut pas être écrit, le report **n'est pas bloqué ni perdu** (le report des données passe avant), mais l'échec est visible (avertissement dans Détails et bandeau) en plus du journal.
- Pas d'action « supprimer à nouveau » dans cette story : le compte rendu informe, la suppression se fait par l'interface habituelle (une action de masse serait une fonction nouvelle, à décider par Ali).

## Critères testables

### Constitution du compte rendu pendant le report (4 à 5 h)

1. **Étant donné** un appareil `B` qui reporte au passage à l'époque `E`, **quand** l'étape (c) `reapply` traite ses pages, **alors** elle accumule, par auteur `X`, le **nombre de champs** et le **nombre de lignes distinctes** reportés (suppressions et restaurations comprises, ce sont des champs `deleted_at`), plus le nombre de traces purgées reportées, plus les écritures tardives (`epoch-carry-late`) comptées à part. Les compteurs sont exacts sur un jeu de données connu (assertion sur les nombres, pas sur « au moins »).
2. **Étant donné** une ligne vivante après (c) et supprimée dans la base remplacée juste après (b), **quand** le compte rendu est établi, **alors** elle figure dans la liste **« rétablies »** avec : la table, l'identifiant, le **libellé** (titre ou nom), l'**auteur** de l'écriture qui l'a rétablie, la **date de la suppression écartée** (date physique du hlc de `deleted_at`, ou date de la trace) et l'**auteur de cette suppression**.
3. **Étant donné** une ligne absente de la base remplacée et rendue vivante par une entrée `'+'`, **quand** le compte rendu est établi, **alors** elle figure dans la liste **« recréées »** avec les mêmes champs, sauf la suppression (absente). Une ligne déjà vivante avant et après (c) ne figure dans aucune des deux listes.
4. **Étant donné** une suppression de `O` écrite après la sauvegarde restaurée (écriture annulée par la restauration, jamais reportée), **quand** le compte rendu est établi, **alors** cette ligne n'est **pas** dans « rétablies » (assertion explicite), conformément à la définition.
5. **Étant donné** une table sans colonne de libellé évidente, **quand** une de ses lignes est nommée, **alors** un libellé de repli est utilisé (« (sans titre) » et identifiant abrégé) ; une table de correspondance unique dans `src/domain` associe chaque table publiée à sa colonne de libellé et à son nom en français ; un test échoue si une table publiée n'y figure pas.
6. **Étant donné** un arrêt brutal pendant (c) puis une reprise, **quand** le report se termine, **alors** les compteurs et les listes sont ceux d'une exécution sans arrêt (aucune ligne comptée deux fois ni oubliée) : le compte rendu est écrit **dans la même transaction que le retrait des entrées `epoch-carry` de la page**, et la reprise reconstruit, sans doublon, à partir de ce qui est déjà enregistré.
7. **Étant donné** un report en mode fusion (réinitialisation Y-11), **quand** il se termine, **alors** le compte rendu existe avec ses compteurs, ses listes « rétablies » et « recréées » sont vides par construction (rien n'est remplacé) et son attribut « bandeau » vaut faux.
8. **Étant donné** un report qui ne reporte aucune écriture, **quand** il se termine, **alors** aucun bandeau n'est levé ; le compte rendu (zéro écriture) est enregistré et lisible dans Détails (« Aucune écriture à reporter »), conformément au « visible, pas seulement un journal ».
9. **Étant donné** que Y-FIX-04 aura livré ses lignes rattachées à « Sans projet » ou gardées en `sync_parked`, **quand** le compte rendu est établi, **alors** elles figurent dans une troisième liste nommée (« rattachées » / « mises de côté ») avec leur cause. **Si Y-FIX-04 n'est pas encore fusionnée au moment du code, ce critère est reporté à Y-FIX-04 et la fiche le note** (pas de liste vide factice).

### Persistance bornée (2 h)

10. **Étant donné** la migration (numéro 0019 ou 0020, tranché et écrit dans la fiche), **quand** elle s'applique sur une base existante et sur une base neuve, **alors** la table `epoch_carry_report` existe avec au minimum : identifiant, époque cible, cause (restauration, époques concurrentes, réinitialisation), appareil qui a reporté, appareil ouvreur, mode (`replace` / `merge`), compteurs par auteur, listes nommées (« rétablies », « recréées », éventuellement « rattachées »), nombre de lignes au-delà de la borne, `created_at`, `acknowledged_at` (nul tant que non acquitté). Test de migration (modèle des migrations existantes) : schéma exact, migration idempotente, aucune donnée existante modifiée.
11. **Étant donné** plus de 500 lignes à nommer, **quand** le compte rendu est enregistré, **alors** les **500 premières** (ordre déterministe : date de suppression écartée décroissante, puis table, puis identifiant) sont nommées, le **reste est compté** dans le champ de débordement, et l'écran affiche « et N autres » avec ce nombre. Test à 501 et à 5 000 lignes.
12. **Étant donné** la table `epoch_carry_report`, **quand** on liste les tables publiées dans iCloud, **alors** elle n'y figure **pas** et aucun libellé n'apparaît dans le journal technique exporté (test d'hygiène par recherche des libellés dans le journal d'un scénario). Elle est incluse dans les sauvegardes locales de la base comme tout le reste.
13. **Étant donné** plus de 20 comptes rendus, **quand** un nouveau est enregistré, **alors** les plus anciens **acquittés** sont supprimés ; un compte rendu non acquitté n'est jamais supprimé, même au-delà de 20.
14. **Étant donné** un échec d'écriture du compte rendu (disque plein, simulé), **quand** le report se poursuit, **alors** les données sont reportées normalement (comparaison des bases avec un report sans panne) et un avertissement visible « Le compte rendu du changement d'époque n'a pas pu être enregistré : {cause} » est levé (Détails et bandeau) en plus du journal. Jamais d'échec silencieux.
15. **Étant donné** que l'accès à la base ne passe que par les dépôts, **quand** le compte rendu est lu ou écrit, **alors** tout passe par `src/db/repositories` ; les règles de classement (rétablie, recréée) sont dans `src/domain`.

### Écran et bandeau (4 à 5 h)

16. **Étant donné** un compte rendu non acquitté avec bandeau (mode `replace`, au moins une écriture reportée), **quand** l'application s'ouvre, **alors** un **bandeau durable** s'affiche (dans le mécanisme des avertissements de synchro, `src/domain/syncBanners.ts` et `SYNC_WARNINGS`) avec le nombre d'éléments rétablis et un accès au détail ; il reste affiché **à chaque ouverture** jusqu'à l'acquittement « J'ai vu » (`acknowledged_at`), après un redémarrage comme après plusieurs jours. L'état « À jour » n'est pas affiché seul tant que le bandeau est levé si des éléments ont été rétablis (règle « À jour interdit sans preuve »).
17. **Étant donné** Réglages > Synchronisation > Détails, **quand** Ali ouvre le compte rendu, **alors** l'écran (chargé à la demande) montre : (a) la date et l'heure de l'époque (24 h), la cause et l'appareil ouvreur nommé ; (b) l'appareil qui a reporté ; (c) le nombre d'écritures reportées **par auteur** (nom lisible de chaque appareil, « Cet appareil » pour soi, « (oublié) » pour une identité oubliée) ; (d) la liste nommée **« Rétablis alors que vous les aviez supprimés »**, chaque ligne avec le type en français (Tâche, Projet…), le libellé, qui l'a rétabli, « supprimé le {date} à {heure} par {appareil} » ; (e) la liste « Recréés » ; (f) « et N autres » si la borne est dépassée.
18. **Étant donné** le bouton « J'ai vu », **quand** Ali l'appuie, **alors** `acknowledged_at` est enregistré, le bandeau disparaît immédiatement, le compte rendu reste lisible dans Détails (historique des 20 derniers), et le même compte rendu ne ressort jamais en bandeau. Le bouton n'agit que sur le compte rendu affiché (jamais d'acquittement global implicite).
19. **Étant donné** un compte rendu sans élément rétabli (listes vides), **quand** on l'affiche, **alors** la phrase « Aucun élément supprimé n'a été rétabli » apparaît en tête (le contraire d'un écran vide muet) et le bandeau n'a pas été levé.
20. **Étant donné** l'écran sur 393 pt de large, **quand** la liste dépasse l'écran, **alors** elle défile, les libellés longs passent à la ligne sans troncature du nom d'appareil, les cibles tactiles font au moins 44 pt, la structure est une liste annoncée par les lecteurs d'écran avec le nombre d'éléments, et l'ordre de focus est : résumé, listes, « J'ai vu ». Composants, couleurs et polices de la feuille de réglages existante (maquettes comme référence visuelle).
21. **Étant donné** les textes, **quand** on cherche une chaîne en dur, **alors** aucune : tout est dans `src/i18n` (français, heures en 24 h). Aucun pluriel automatique n'est présumé : les formulations utilisent des libellés de la forme « Éléments rétablis : 3 » pour éviter les accords.
22. **Étant donné** un compte rendu à 500 lignes nommées, **quand** l'écran s'ouvre, **alors** il s'affiche sans bloquer l'interface (liste virtualisée ou paginée par pages de 50, sans délai artificiel) ; test de rendu sur 500 lignes.

### Banc à deux appareils (3 h)

23. **Scénario : restauration « Appliquer partout » avec un troisième auteur.** **Étant donné** trois appareils sur le banc existant : `A` (ouvreur, restaure une sauvegarde), `B` (reporte) et `C` (troisième auteur non oublié, jamais lu par `A` au-delà de `covers[C]`), une horloge déterministe et ces données : (i) la tâche « Test Pc » créée par `C`, non lue par `A`, détenue par `B` ; (ii) l'élément « À jeter » supprimé par `A` à un instant connu, puis restauré par `C` (champ `deleted_at` effacé, hlc supérieur) sans que `A` l'ait lu ; (iii) la tâche « Annulée par la restauration » supprimée par `A` après la sauvegarde ; (iv) 3 champs modifiés par `C` sur une ligne vivante, 2 champs modifiés par `B`, **quand** `A` restaure et que `B` reporte, **alors** le compte rendu de `B` contient **exactement** : auteur `C` : le nombre exact de champs et de lignes du jeu ; auteur `B` : le nombre exact ; « rétablies » = [« À jeter », supprimé par `A` à l'instant connu, rétabli par `C`] ; « recréées » = [« Test Pc », auteur `C`] ; la tâche (iii) **absente** des deux listes ; débordement 0. L'assertion porte sur le contenu complet (égalité de structure), pas sur une inclusion.
24. **Étant donné** le même scénario, **quand** `C` reporte à son tour (ou `A` après coup), **alors** son propre compte rendu est établi sans doublon d'élément dans la base (convergence idempotente de l'ADR 0011 §24 point 6) et les deux comptes rendus se contredisent sur aucun libellé commun.
25. **Étant donné** le même scénario avec **épreuve de détection**, **quand** la constitution du compte rendu est neutralisée (étape de classement retournant des listes vides, injection dans ce fichier de test seulement), **alors** le scénario 23 est **rouge** (preuve que le banc voit un compte rendu faux), puis vert une fois l'injection retirée.
26. **Étant donné** le scénario de l'interface (test Testing Library sur l'écran, puis e2e `pc` et `iphone` 393 pt), **quand** le compte rendu du scénario 23 est affiché, **alors** le bandeau est levé, l'écran de détail montre « À jeter » dans « Rétablis alors que vous les aviez supprimés », « J'ai vu » fait disparaître le bandeau et il ne revient pas après redémarrage simulé.

### Non-régression, bundle, documentation (1 h plus 2 h de réserve)

27. **Alors** : tests du module en local (`CT_TEST_WORKERS=1 npx vitest run src/sync src/features/sync src/db tests/unit/sync tests/sim --coverage.enabled=false` et le test de migration) verts ; lint et typage verts ; aucun `skip`, aucun délai, aucun retry ; aucune attente d'un test allongée ; suite complète verte en CI sur la branche (« suite verte »). Les tests existants de l'ordre de report (`epochCarryGuard.test.ts`, scénarios `epoch-carry`) passent **sans modification de leurs attentes**.
28. **Alors** le **bundle de départ** est mesuré avant et après (`tests/bundle/startBundle.test.ts`, 358 045 octets gzip, seuil 358 400) : l'écran de détail est un bloc à la demande, le bandeau ne dépasse pas la marge (355 octets) ; si elle est dépassée, les leviers connus de la mémoire du projet sont appliqués dans la même story et la mesure est notée dans la fiche. Aucun octet de l'écran ne passe dans le départ.
29. **Alors** : ADR 0011 (avenant : numéro libre au moment de l'écriture ; compte rendu du report, définitions rétablie / recréée, table, bornes), `docs/decisions.md`, `docs/journal.md`, `docs/backlog.md`, `docs/audit-1.0.md` à jour ; **numéro de migration retenu écrit dans cette fiche** et fiche T-TECH-01 mise à jour si elle est renumérotée ; écart au PRD (Y-09) signalé à Ali, non appliqué.

## Limites assumées

- Le compte rendu dit ce qui a été rétabli **sur l'appareil qui le produit** ; chaque appareil qui reporte établit le sien.
- « Supprimé par l'utilisateur » est établi par l'état de la base remplacée et la trace de suppression (auteur et date du hlc), pas par l'intention : une suppression faite par un autre appareil de l'utilisateur est présentée avec son auteur.
- Le compte rendu n'empêche pas le rétablissement : il le rend visible. Aucun mécanisme de « refus » du report n'est ajouté (fonction nouvelle, à décider par Ali).
- Une ligne dont le libellé est purgé ou illisible est nommée par repli (critère 5).

## Hors de cette story

- Une action « supprimer à nouveau » ou « annuler le rétablissement » en un geste.
- Le correctif B4 (Y-FIX-04), hors la catégorie du critère 9.
- Toute modification du PRD ou du format publié.
- Toute fonction de la liste « Hors périmètre » du PRD (section 1).

## Ordre des sous-tâches

1. Définitions et classement dans `src/domain` (rétablie, recréée, table de correspondance table / libellé / nom français), tests (critères 1 à 5, 7, 8).
2. Migration, dépôt, bornes, élagage, échec d'écriture visible (critères 10 à 15), puis écriture du compte rendu dans la transaction de page de (c) et reprise sans doublon (critère 6).
3. Écran de détail à la demande, bandeau, acquittement, textes `src/i18n` (critères 16 à 22).
4. Banc à trois appareils, épreuve de détection, e2e (critères 23 à 26) ; critère 9 si Y-FIX-04 est fusionnée.
5. Bundle, non-régression locale du module, documentation (critères 27 à 29) ; qa-test, puis code-reviewer.

Découpage de l'estimation : constitution 4 à 5 h, persistance 2 h, écran et bandeau 4 à 5 h, banc 3 h, bundle 1 h (= 14 à 16 h) ; réserve de relecture et de reprise de QA 2 h (= 14 à 18 h au plus).

## Vérifications

- Local : seulement les tests du module (commande du critère 27) ; suite complète en CI.
- Preuves de détection : critère 25 (compte rendu neutralisé, banc rouge) ; critère 12 (aucun libellé dans le journal exporté).
- Règle d'Ali : arrêt et alerte avant de continuer si l'estimation dérape de plus de 50 % (au-delà de 27 h).
- Aucun fichier écrit hors du dépôt ; aucun secret ; aucun libellé d'utilisateur hors de la base locale.
- Clôture refusée si un critère manque : le product-owner vérifie les 29 critères (le 9 compte s'il est applicable) avant « fait ».
