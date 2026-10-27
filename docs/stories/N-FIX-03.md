# N-FIX-03 — Remplacement en place d'une notification : vérification aveugle, plan affiché sans preuve

Module : M5 Rappels · Palier : avant la 1.0 d'office (état faux affiché sans le dire, règle de tri d'AGENTS.md) · Agent : notifications · Ouverte le 2026-10-27 par Claude Code, Ali informé le même jour.

Statut : **code corrigé sur la branche `n-fix-03-remplacement-verifie`, tests du module verts, lint et typage verts ; CI complète, fusion et vérification sur l'iPhone encore requises**. Estimation : 3 h actives ; alerte à 4 h 30.

## Origine

Défaut signalé par Ali le 27 octobre 2026 en 1.0.2 : deux routines modifiées, aucune notification reçue sur l'iPhone ni l'Apple Watch. La cause exacte de ce qu'Ali observe n'est pas établie (faits de l'appareil attendus : ligne de Réglages › Rappels, lieu et nature des modifications, journaux exportés). Le diagnostic sur le code a trouvé un défaut certain, indépendant de ces faits : le seul chemin par lequel une routine modifiée est replanifiée ne pouvait pas être vérifié.

## Constat (code de `main` e9ba7e26)

1. `src/db/repositories/sql/reminderRepository.ts`, `replaceForTarget` : une avance conservée **met à jour la ligne existante** (`UPDATE … fire_at`). L'identifiant du rappel ne change pas.
2. `src/domain/notificationId.ts` : l'identifiant stable d'une occurrence est `routine:<rappel>:<jour>` ; il ne change donc pas non plus, ni le numéro iOS dérivé (`assignPlanIds`, registre préféré).
3. `src/platform/notifications/tauriNotifications.ts`, `replace` : l'élément est « changé » (instant ou empreinte différents) et renvoyé par `show` **avec le même numéro** ; la vérification ne contrôle que la présence du numéro dans `get_pending`.
4. ADR 0012, constats 3 et 8 : `get_pending` ne rend ni échéance ni `extra` ; `show` résout dès l'appel à `UNUserNotificationCenter.add`, avant son résultat, dont l'erreur asynchrone est ignorée.
5. Conséquence : si iOS n'applique pas le remplacement, l'ancienne demande satisfait la vérification, `replace` rend un succès, le registre enregistre le **nouvel** instant et Réglages › Rappels affiche « Planifiés jusqu'au … » pour un plan que l'iPhone ne porte pas. Aucun bandeau, aucune ligne d'échec : état faux muet.

## Ce qu'Ali voit

Rien d'anormal : la couverture s'affiche, aucune erreur. La notification sonne à l'ancienne heure si elle est encore à venir, ou ne sonne pas si l'ancienne demande a déjà été livrée ou retirée côté iOS pendant le remplacement.

## Règle (décision d'Ali du 2026-10-27, confirmée après la passe product-owner)

**Nouveau numéro iOS pour tout élément changé ; ancien annulé seulement après la pose réussie et vérifiée du nouveau.**

Raison, dans les mots d'Ali : si l'annulation précède la pose et que la pose échoue, « je me retrouve sans rappel sans le savoir ». Dans l'ordre inverse, le pire cas est un doublon ou un rappel à l'ancienne heure, visible, donc corrigeable. On préfère toujours le défaut visible au silence.

Deux exigences d'Ali :
1. Le test rouge couvre le **cas d'échec**, pas seulement le cas nominal : la pose du nouveau échoue, l'ancien doit survivre. C'est ce cas qui justifie l'ordre.
2. Si la pose du nouveau échoue et que l'ancien est conservé, **l'app le dit** : un rappel qui sonne à la mauvaise heure sans explication serait un état faux de plus.

Compromis imposé par le plafond iOS de 64 notifications en attente, consigné dans l'ADR 0012 (avenant N4) : le plan est presque toujours plein ; quand aucune place n'est libre, l'adaptateur déplace la notification en attente la plus **lointaine** pour poser la plus proche, puis libère les anciens des remplaçants confirmés par une relecture intermédiaire de `get_pending`. Un seul déplacement à la fois pour une modification ordinaire (jusqu'à huit éléments changés), huit par lot quand tout le plan change. En cas de coupure, le manque est lointain et réparé au passage suivant. Registre perdu : numéros en attente inconnus, annulés d'abord, plan reposé une fois sous des numéros libres.

Hors périmètre : lire l'échéance chez iOS (le plugin ne la rend pas), toute modification du plugin officiel épinglé, la cause de l'observation d'Ali tant que les faits de l'appareil manquent.

## Preuves

- **Rouge** (commits `ab31267c` puis `57d19234` sur la branche, avant tout correctif) : `tauriNotifications.test.ts` : « la pose du nouveau est rejetée par iOS : l'ancien survit, jamais annulé, échec visible avec le nombre de rappels conservés » ; « la pose du nouveau “réussit” mais iOS ne garde rien (constat 8) : verify-failed, l'ancien survit, registre sans le nouvel instant » ; « cas nominal : nouveau numéro, pose avant annulation » ; l'ancien test « même identifiant numérique » adapté à la règle avec trace. `RemindersStatus.dom.test.tsx` : « pose du nouveau échouée, ancien conservé : Réglages dit combien de rappels sonneront encore à l'ancienne heure ». Résultat : **5 rouges / 48 verts** sur les deux fichiers, assertion en échec : `replace` rendait `{ scheduled: 1, cancelled: 0, kept: 0 }` et le registre portait l'instant 08:30.
- **Vert** (commit du correctif, identifiant dans le journal) : `src/platform/notifications`, `src/features/reminders`, `src/domain/notificationStatus` : **349 tests / 24 fichiers verts**, couverture coupée ; lint sans avertissement ; typage strict vert ; garde du bundle de départ 62/62, **334 135 octets normalisés, marge 24 265** (+96 face à main 334 039 : analyse du champ `stale` dans l'état persistant, module du départ). Tests adaptés avec trace « ancienne règle » : registre perdu, registre illisible, registre non écrit, fuseau changé (`tauriNotifications.test.ts`), critères 4 et N-06 1 (`notificationLifecycle.test.ts`), deux tests de récapitulatif (`recapNotifications.test.ts`) : leurs assertions de non-doublon, de nombre en attente et d'heure murale sont conservées ; seuls les numéros réutilisés et le compte `cancelled: 0` changent.
- CI complète avec couverture : requise avant fusion ; identifiants des runs à consigner.

## Passes

- **Product-owner** : règle, raison et exigences ci-dessus ; périmètre borné à l'adaptateur iOS, aux types de rapport, à l'état persistant et à une ligne de Réglages ; aucun changement du planificateur, du schéma ni du protocole de synchro.
- **Agent du module** : `tauriNotifications.ts` (`assignPlanIds` avec numéros bloqués ; `replace` réécrit : pose avant annulation, relecture intermédiaire, déplacement du plus lointain sous le plafond, `stale`), `types.ts` et `domain/notificationStatus.ts` (`stale` facultatif, analysé), `RemindersStatusSection.tsx` et catalogues fr/en (`planFailedStale`, `planFailedStalePlural`).
- **QA** : tests ciblés ci-dessus ; les e2e N-01/N-05 utilisent le faux planificateur et ne changent pas ; suite complète en CI.
- **Code-reviewer** (relecture à froid du diff final) : approuvée. Points vérifiés : aucun numéro en attente n'est redonné à un élément changé (`blocked`) ; les anciens ne sont annulés qu'après confirmation par `get_pending` (relecture intermédiaire ou finale), sauf le déplacement explicite du plus lointain quand le plan est plein, journalisé et borné ; un remplaçant refusé ou absent laisse son ancien en place et le compte dans `stale`, repris par l'état persistant et Réglages ; le registre ne contient que ce que `get_pending` confirme, anciens conservés compris ; `cancelAll`, la plage réservée et la protection de la notification sur le point de sonner sont inchangés. Réserve : le rendu natif (iOS remplace-t-il vraiment sous le même numéro, combien de temps dure une relecture de `get_pending` à 64) reste à observer sur l'appareil au prochain lot.
