# N-FIX-03 — Remplacement en place d'une notification : vérification aveugle, plan affiché sans preuve

Module : M5 Rappels · Palier : avant la 1.0 d'office (état faux affiché sans le dire, règle de tri d'AGENTS.md) · Agent : notifications · Ouverte le 2026-10-27 par Claude Code, Ali informé le même jour.

Statut : **ouverte, preuve rouge écrite, aucun correctif**. Estimation : 3 h actives (adaptateur, test, fiche) ; alerte à 4 h 30.

## Origine

Défaut signalé par Ali le 27 octobre 2026 en 1.0.2 : deux routines modifiées, aucune notification reçue sur l'iPhone ni l'Apple Watch. La cause exacte de ce qu'Ali observe n'est pas établie (faits de l'appareil attendus : ligne de Réglages › Rappels, lieu et nature des modifications, journaux exportés). Le diagnostic sur le code a trouvé un défaut certain, indépendant de ces faits : le seul chemin par lequel une routine modifiée est replanifiée ne peut pas être vérifié.

## Constat (code de `main` e9ba7e26)

1. `src/db/repositories/sql/reminderRepository.ts`, `replaceForTarget` : une avance conservée **met à jour la ligne existante** (`UPDATE … fire_at`). L'identifiant du rappel ne change pas.
2. `src/domain/notificationId.ts` : l'identifiant stable d'une occurrence est `routine:<rappel>:<jour>` ; il ne change donc pas non plus, ni le numéro iOS dérivé (`assignPlanIds`, registre préféré).
3. `src/platform/notifications/tauriNotifications.ts`, `replace` : l'élément est « changé » (instant ou empreinte différents) et renvoyé par `show` **avec le même numéro** ; la vérification (étape 6) ne contrôle que la présence du numéro dans `get_pending`.
4. ADR 0012, constats 3 et 8 : `get_pending` ne rend ni échéance ni `extra` ; `show` résout dès l'appel à `UNUserNotificationCenter.add`, avant son résultat, dont l'erreur asynchrone est ignorée.
5. Conséquence : si iOS n'applique pas le remplacement, l'ancienne demande satisfait la vérification, `replace` rend un succès, le registre enregistre le **nouvel** instant et Réglages › Rappels affiche « Planifiés jusqu'au … » pour un plan que l'iPhone ne porte pas. Aucun bandeau, aucune ligne d'échec : état faux muet.

## Ce qu'Ali voit

Rien d'anormal : la couverture s'affiche, aucune erreur. La notification sonne à l'ancienne heure si elle est encore à venir, ou ne sonne pas si l'ancienne demande a déjà été livrée ou retirée côté iOS pendant le remplacement.

## Règle retenue (à confirmer par la passe product-owner)

Ne jamais réutiliser un numéro iOS pour un instant ou un texte changé : un élément « changé » reçoit un **nouveau** numéro, l'ancien est annulé dans le même passage (annulation après l'envoi réussi, pas avant, pour qu'une suspension de l'app laisse un doublon plutôt qu'un silence). La vérification par présence redevient alors une preuve : le nouveau numéro absent de `get_pending` est un `verify-failed` visible. Le registre ne décrit que ce qu'iOS confirme. Hors périmètre : lire l'échéance chez iOS (le plugin ne la rend pas), toute modification du plugin officiel épinglé.

## Preuves

- **Rouge** : `src/platform/notifications/tauriNotifications.test.ts`, test « N-FIX-03 : remplacement en place non appliqué par iOS … ». Le faux pont garde l'ancienne demande (`dropOnShow` sur le second envoi du même identifiant) ; aujourd'hui `replace` rend `{ scheduled: 1, cancelled: 0, kept: 0 }` et le registre porte l'instant 08:30. Commit de la preuve : voir le journal.
- **Vert** : à venir, avec les identifiants du commit et du run CI.

## Passes

- Product-owner : ce document (règle à confirmer, périmètre, estimation).
- Agent du module : à faire après l'accord d'Ali sur la règle, test rouge d'abord commité (fait).
- QA : tests ciblés `src/platform/notifications` et `src/features/reminders` sans couverture ; suite complète en CI.
- Code-reviewer : relecture à froid du diff, consignée ici.
