# N-TECH-01 — Planificateur de notifications et interface `NotificationScheduler`

Module : M5 Rappels · Ordre de construction : 5 (lot N0, phase 0) · Agent : **notifications** · Statut : à faire
Story technique, sans équivalent au PRD (écart noté dans docs/decisions.md, 2026-10-07). Précède N-01, N-03, N-05, N-06, N-07, I-02 et l'envoi réel de F-04 et de N-04.
Dépend de : R-02, R-05, N-02, N-04, ES-07, E-01 (données déjà livrées). Aucun Swift, aucune compilation iOS : tout est testable sous Windows.

## Contexte

- Dettes de docs/dettes.md, « Ordre 5 (iPhone) » : interface de planification absente de `src/platform` ; planifier sur `effectiveFireAt` ; routines en pause ou archivées ignorées ; rappels d'événements recalculés par occurrence ; plan limité aux rappels à venir.
- Décisions du 2026-10-07 : plugin officiel `tauri-plugin-notification` (N-01, pas ici) ; les 64 prochaines notifications par ordre chronologique, récapitulatifs compris ; seule la prochaine occurrence d'une routine ; « planifiés jusqu'au {date} ».
- Règles métier dans `src/domain` seulement ; accès base par `src/db/repositories` seulement. **Cette story ne touche pas à `src/db`** : le planificateur reçoit ses données en arguments ; la lecture en base est de N-01.

## Contrat de sortie du planificateur (à fixer par l'ADR 0012, voir « Avant le code »)

`planNotifications(entrée) → { items, coverage, total }` : fonction pure. Entrée : `now` (heure locale flottante), `limit` (64 par défaut), tâches, routines avec pauses et validations, événements, lignes `reminder`, espaces (plages silencieuses), réglages des récapitulatifs. Sortie : éléments structurés (aucun texte), triés.

## Critères testables

### Interface plateforme

1. **Étant donné** `src/platform/notifications`, **alors** le contrat `NotificationScheduler` offre : `availability()` (`available` ou `unavailable`), `permission()` (`granted`, `denied`, `undetermined`), `requestPermission()`, `replace(requests)` (remplacement complet du plan), `cancelAll()` et `pending()`. Une requête porte : `id` stable, `fireAt` en heure locale flottante, `title`, `body`, `kind`. La conversion vers un instant précis relève de l'adaptateur réel (N-01), pas du contrat.
2. **Étant donné** le faux de test, **quand** `replace` reçoit deux fois la même liste, **alors** le second rapport est `{ scheduled: 0, cancelled: 0, kept: n }` (idempotent).
3. **Quand** `replace` reçoit une liste où un `id` change d'échéance ou de texte, **alors** il est replanifié ; un `id` absent est annulé ; `pending()` rend exactement la dernière liste, triée par échéance.
4. **Quand** `replace` reçoit un `id` en double ou plus de 64 requêtes, **alors** il refuse avec une erreur typée (`duplicate-id`, `over-limit`), sans rien modifier : le planificateur plafonne, jamais l'adaptateur en silence.
5. **Étant donné** le PC (Windows), le navigateur de développement et Playwright, **alors** le résolveur de `src/platform` rend l'implémentation vide : `availability()` = `unavailable`, `replace` et `cancelAll` sans effet, `pending()` vide. Un test de cohérence (modèle de `capture/consistency.test.ts`) prouve qu'aucun chemin ne peut y obtenir un envoi réel : le PC n'émet aucune notification de rappel.
6. **Étant donné** `FocusEndScheduler` (F-04), **alors** il est inchangé et ses tests restent verts ; sa notification compte dans les 64 en attente, d'où le paramètre `limit` du planificateur (test avec `limit` = 63).

### Planificateur : rappels de tâches

7. **Étant donné** une tâche datée à 09:00 avec trois rappels (0, 15 et 1440 min), **alors** le plan contient trois éléments aux échéances 09:00, 08:45 et la veille 09:00, d'identifiant stable dérivé de la ligne `reminder` ; l'échéance est recalculée depuis la date et l'heure actuelles de la tâche, jamais lue dans `reminder.fire_at` (test avec un `fire_at` périmé).
8. **Alors** sont exclus : tâche terminée, supprimée, « Un jour » ou sans date ou sans heure ; rappel supprimé ; échéance effective ≤ `now`. Aucun rappel passé n'est émis au rattrapage.
9. **Étant donné** deux lignes de la même cible, de la même avance et de la même occurrence, **alors** un seul élément est gardé.

### Plages silencieuses

10. **Étant donné** l'espace Pro avec ses plages par défaut et une tâche Pro du mardi à 20:00 sans avance, **alors** l'élément est à 08:00 le mercredi (`effectiveFireAt`) et garde l'échéance d'origine en information ; une tâche Perso n'est pas décalée. Des plages enchaînées comptent pour une seule (ES-07 critère 6). Le tri et le plafond utilisent l'échéance **effective**.
11. **Alors** les plages ne s'appliquent ni aux récapitulatifs ni à la fin de session Focus (N-04 critère 8, en-tête de `quietHours.ts`).

### Routines

12. **Étant donné** une routine active à 07:00 tous les jours avec avance 30 min, **alors** un seul élément par avance : la prochaine occurrence à venir (`routineReminderFireAt` ou `nextOccurrences`). Avec `now` à 07:00 passé, c'est le lendemain ; avec `now` avancé d'un jour, le plan suit (recalcul quotidien, fonction pure).
13. **Alors** sont ignorées : routine archivée ; routine sans heure (QB-07) ; occurrence couverte par une pause (la première occurrence hors pause est planifiée, aucune si la pause n'a pas de fin) ; occurrence du jour déjà validée (R-03), l'occurrence suivante la remplace.
14. **Étant donné** une routine tous les 2 jours ou toutes les 2 semaines (R-07), **alors** la prochaine occurrence suit la règle (test par règle).

### Événements (dette E-01)

15. **Étant donné** un anniversaire annuel du 12 mars avec les avances 10080, 1440 et 0, et `now` au 7 octobre 2026, **alors** trois éléments pour l'occurrence du 12 mars 2027 (09:00 pour une journée entière, E-01 D3), chacun d'identifiant dérivé de la ligne `reminder` et de la date d'occurrence.
16. **Étant donné** un événement hebdomadaire ou mensuel, **alors** chaque occurrence à venir produit ses propres éléments, jusqu'à la date de fin ; fin de mois bornée (31 janvier → 28 février, `clampedDay`) ; horizon d'au plus 400 jours ; l'échéance stockée de la ligne `reminder` (une seule, sur la prochaine occurrence) n'est pas utilisée.
17. **Alors** une occurrence passée dont l'avance tombe encore dans le futur est gardée (événement demain 08:00, avance 1 jour : échéance aujourd'hui 08:00 si `now` est avant) ; un événement non répété et passé ne donne rien.

### Récapitulatifs

18. **Étant donné** les réglages par défaut (matin 07:30, soir 21:00) et `now` à 10:00, **alors** le plan contient le récapitulatif du soir d'aujourd'hui, puis matin et soir des jours suivants ; celui du matin d'aujourd'hui est exclu (échéance passée) ; un récapitulatif désactivé n'apparaît jamais. Identifiants `recap:{matin|soir}:{date}`.
19. **Alors** le contenu structuré (nombre et lignes, `buildRecap`) est calculé pour aujourd'hui seulement ; pour un autre jour il est absent et N-01 affichera le texte générique qui invite à ouvrir l'app (N-07). Les récapitulatifs ne sont pas filtrés par espace.

### Plafond et couverture

20. **Étant donné** 100 éléments candidats, **alors** les 64 premiers par échéance effective sont gardés ; à égalité, ordre fixe (rappel avant récapitulatif, puis identifiant) ; `total` = 100, `coverage` = `jusqu'à` l'échéance du dernier élément gardé. Sous le plafond, `coverage` = `complet` ; sans aucun élément, `vide`.
21. **Alors** les clés i18n françaises et une fonction de mise en forme testée donnent « Planifiés jusqu'au {date} » (date et heure 24 h), « Tous les rappels sont planifiés » et « Aucun rappel à planifier ». L'écran Réglages > Rappels les affiche avec N-01.

### Pureté et déterminisme

22. **Alors** `planNotifications` : n'appelle ni `Date.now` ni `Math.random` ; n'importe ni `src/platform`, ni `src/db`, ni `src/i18n` ; ne modifie pas ses arguments ; rend le même résultat (égalité profonde) quel que soit l'ordre des tableaux d'entrée.
23. **Étant donné** un changement de fuseau de l'appareil, **alors** le plan est identique : le planificateur ne connaît pas le fuseau (N-06 ne fait que le relancer).
24. **Étant donné** 5 000 tâches dont peu ont un rappel, 200 événements répétés et 30 routines, **alors** le plan est calculé et rend au plus 64 éléments (test fonctionnel, sans assertion de durée).

## Hors de cette story

- Adaptateur réel (plugin Tauri, capability, `Info.plist`, demande d'autorisation, conversion en instant), lecture en base, textes des notifications, branchement à l'ouverture, à la reprise, à la synchro, au changement de fuseau et à l'arrière-plan : N-01, N-05, N-06, N-07.
- Actions « Fait » et « +15 min », file d'actions : N-03.
- Envoi réel de la fin de session Focus (F-04) et des récapitulatifs : lot N1.
- Écran Réglages > Rappels (affichage de la couverture, bandeau d'autorisation refusée) : N-01.

## Avant le code

Un ADR court **0012** de l'architecte est nécessaire avant le code (contrat de `NotificationScheduler`, forme de la sortie du planificateur). Il tranche : schéma des identifiants stables (tâche : ligne `reminder` ; routine et événement : ligne et date d'occurrence ; récapitulatif : nature et jour) ; sémantique de `replace` (différentiel, rapport, erreurs) ; planification des événements par occurrence sans ligne `reminder` par occurrence (confirme la décision E-01 du 2026-10-04) ; contenu des récapitulatifs hors du jour ; horizon de 400 jours ; place du plafond (planificateur seul).

## Fichiers et ADR à lire

- ADR : 0001 (couches), 0004 (contrats, rappels), 0005 (horodatage, heure flottante), 0007 (build iOS, plugins), 0011 §21 (état des lieux ordre 4, pour l'ordre des lots).
- Domaine : `src/domain/quietHours.ts`, `reminders.ts`, `routineReminder.ts`, `eventReminders.ts`, `eventOccurrences.ts`, `recurrenceNext.ts`, `routineSchedule.ts`, `recap.ts`, `model/reminder.ts`, `timeZone.ts`, `localDate.ts`.
- Plateforme : `src/platform/index.ts`, `runtime.ts`, `timeZone.ts`, `focus/types.ts` et `focus/endScheduler.ts` (modèle noop + faux), `capture/consistency.test.ts` (modèle du test de cohérence).
- Fiches : N-02, N-04, R-02, R-05, E-01, ES-07, F-04 ; docs/dettes.md « Ordre 5 (iPhone) » ; docs/decisions.md (2026-10-07, lignes « Ordre 5 »).
