# N-TECH-02 — Routines : fenêtre de 7 jours d'occurrences planifiées et plafond équitable des 64 notifications

Module : M5 Rappels · Ordre de construction : palier 1.0, **étape 6 (B9)**, avant N-FIX-02 (même dossier `src/features/reminders`, jamais en parallèle) · Agent : **notifications** · Relecture : code-reviewer (après qa-test) · Estimation : **5 h** (audit B9), **alerte à Ali si le travail dépasse 7,5 h (+50 %)** · Statut : fiche écrite, à développer
Story technique, sans équivalent au PRD (le PRD lignes 581 et 728 parle déjà d'une « fenêtre glissante recalculée à chaque ouverture » : cette story la rend vraie pour les routines, aucun écart avec le PRD). Elle **remplace le critère 12 de N-TECH-01** (« un seul élément par avance : la prochaine occurrence »), décision 1 d'Ali du 2026-10-17 : « B9 : oui, je confirme la fenêtre de 7 jours » (docs/decisions.md, ligne du 2026-10-17 ; docs/audit-1.0.md, ligne B9).
Dépend de : N-TECH-01, N-01, N-03 (livrés). Touche `src/domain/notificationPlan.ts` et ses tests, `src/features/reminders/notificationRunner.ts` (levier de bundle), les tests de `src/features/reminders`. Ne touche ni `src/db`, ni Swift, ni Rust.

## Contexte

Constat (lignes vérifiées sur `main` c01e961b, worktree `fiches-etape-6`) :
- `src/domain/notificationPlan.ts` lignes **264 à 284** : pour un rappel de routine, la boucle sur `routineEligibleDates(routine)` s'arrête au premier jour dont l'échéance effective est à venir (`break` ligne **283**, commentaire ligne 267 « Une seule occurrence par avance »). Une routine quotidienne n'a donc **qu'une** notification en attente. Si Ali ignore le rappel sans ouvrir l'app, plus rien ne sonne le lendemain ni le surlendemain, alors que Réglages > Rappels dit « Tous les rappels sont planifiés » (`reminders.coverageComplete`, `src/i18n/fr.notifications.ts` via `src/i18n/fr.ts:392`).
- Les chemins cités par la consigne `src/features/notifications/notificationPlan.ts` et `notificationTexts.ts` n'existent pas : le planificateur est dans `src/domain/notificationPlan.ts`, les textes dans `src/features/reminders/notificationTexts.ts` (68 lignes ; les lignes 187-221 de l'audit B10 ne correspondent plus à ce fichier, voir N-FIX-02).
- Plafond iOS de 64, réparti **aujourd'hui** ainsi : `planNotifications` produit une seule liste de candidats (tâches, routines, événements, répétitions « +15 min », récapitulatifs), la trie par échéance effective (puis rappel avant récapitulatif, puis identifiant, unités de code) et garde les `limit` premiers (lignes 335-337). `limit` = 64 moins les notifications réservées en attente (fin de session Focus, alerte d'expiration de signature) calculé par `replanNotifications.ts:132`. Aucune réserve par nature. Les récapitulatifs apportent jusqu'à 801 candidats sur 400 jours ; les événements toutes leurs occurrences dans l'horizon ; les tâches datées sans horizon.
- Couverture (lignes 338-343) : `complete` si tous les candidats tiennent, sinon `until` = échéance du dernier élément gardé. Avec une seule occurrence par routine, `complete` est **faux** dès qu'une routine existe : la routine continue après le dernier élément planifié.
- Textes de couverture déjà en place et affichés par `RemindersStatusSection.tsx:112-121` via `formatCoverage` (`src/features/reminders/coverageText.ts`) : « Planifiés jusqu'au {date} à {heure} » (`reminders.coverageUntil`), « Tous les rappels sont planifiés », « Aucun rappel à planifier ». **Aucun texte nouveau n'est nécessaire** : il suffit que l'état `until` soit rendu quand c'est vrai.

Pourquoi les tests ne l'attrapaient pas : le test `src/domain/notificationPlan.test.ts` lignes **213-227** (« 12 : une routine quotidienne à 07:00, avance 30 min : un seul élément, la prochaine occurrence », `expect(result.items).toHaveLength(1)`) **encode l'ancienne règle** comme une exigence ; aucun test ne simule « app fermée deux jours » (aucun test n'avance l'horloge sans rouvrir l'app).

## Décisions retenues

1. **Fenêtre glissante de 7 × 24 h** : pour chaque ligne de rappel de routine, toutes les occurrences dont l'**échéance effective** (après plages silencieuses) est dans `]now ; now + 7 jours]` à la minute, borne haute incluse (`addDays(today, 7)` à l'heure et la minute de `now`). Constante exportée `NOTIFICATION_ROUTINE_WINDOW_DAYS = 7`. Heure locale flottante : aucun fuseau, aucun `Date.now`.
2. **Repli** : si une ligne n'a aucune occurrence dans la fenêtre (toutes les 2 semaines, pause qui se termine plus tard, quota atteint), elle garde **sa première occurrence à venir** (règle de N-TECH-01 critère 13 conservée : « la première occurrence hors pause est planifiée, aucune si la pause n'a pas de fin »). Ce repli ne prolonge pas la couverture.
3. **Plafond : préfixe chronologique unique, aucune réserve par nature.** Les candidats sont triés comme aujourd'hui ; les `limit` premiers sont gardés ; les **plus lointains sont sacrifiés**. C'est équitable par construction : toutes les natures et toutes les routines sont couvertes jusqu'à la même minute `T`, aucune routine n'est privilégiée ni affamée, et une routine plus fréquente n'obtient pas plus de jours qu'une autre (elle obtient plus d'éléments, jusqu'au même instant). Aucun quota par nature : il rendrait « Planifiés jusqu'au {date} » faux (un élément avant la date manquerait). Recommandation soumise à Ali (question 1).
4. **Couverture honnête** : `until` = la plus petite de deux bornes. (a) **Coupe du plafond** : le dernier élément gardé dont l'échéance est **strictement antérieure à la minute du premier candidat sacrifié** (à égalité de minute, les éléments gardés de cette minute sont envoyés mais ne comptent pas dans la couverture) ; s'il n'y en a aucun, la minute de `now` (cas `limit` = 0 existant). (b) **Fin de fenêtre** : `now + 7 jours` dès qu'au moins une ligne de routine a une occurrence au-delà de la fenêtre. `complete` seulement si aucune des deux bornes ne joue ; `empty` sans aucun candidat. Le type `PlanCoverage` ne change pas (aucune migration de l'état persistant `notifications.status`).
5. **Texte de Réglages** : on réutilise les trois textes existants, sans chaîne nouvelle (bundle). « Tous les rappels sont planifiés » ne s'affiche plus qu'aux plans sans routine tronquée ni coupe ; sinon « Planifiés jusqu'au {date} à {heure} ». Question 3 à Ali pour une ligne « Plafond de 64 notifications atteint ».
6. **Répétitions « +15 min » (N-03)** : inchangées (candidats ordinaires du préfixe ; `deadSnoozeIds` inchangé).
7. **Identifiants stables** : `routine:{reminderId}:{dateOccurrence}` inchangé ; l'occurrence qui était seule hier garde son identifiant, donc `replace` ne reprogramme que les nouvelles (idempotence de N-TECH-01 critères 2 et 3).

## Bundle de départ (plafond inamovible)

- Mesure de référence : **358 357 / 358 400 octets gzip** (`tests/bundle/startBundle.test.ts`, qui somme les seuls fichiers `.js` du graphe statique de `index.html`), marge **43 octets**. L'audit du départ (docs/audits/2026-10-18-bundle-depart.md, section 5) estime cette story à **+300 à +800 octets**.
- Fichiers dans le départ : par imports statiques `src/App.tsx:17` → `features/app/startup.ts:11` → `features/reminders/notificationRunner.ts:2` → `replanNotifications.ts` → `src/domain/notificationPlan.ts` et `notificationTexts.ts`. **Ils sont dans le départ** (à confirmer par la mesure du premier commit). `coverageText.ts` est atteint par `reminders/index.ts:7`. `src/i18n/fr.notifications.ts` est dans `fr.ts` (départ).
- **Exigence : net <= 0 octet** sur chaque commit, mesuré (`npm run test:bundle`) après **chaque** commit (pas seulement ceux qui touchent le démarrage), valeur notée dans la fiche.
- **Levier proposé (étape 0 de la story, à mesurer avant tout code)** : `notificationRunner.ts` charge `replanNotifications` par `import()` (chargement à la demande) au lieu d'un import statique : le planificateur, les textes et les récapitulatifs sortent du départ (l'iPhone seulement les utilise ; le PC répond `pc` avant toute lecture). Pièges connus (mémoire du projet, Y-TECH-05) : un bloc à la demande qui importe un module du départ le sort du bloc principal et peut coûter des kilooctets de compression ; mesurer le départ avant/après ce seul changement. L'échec de chargement du bloc doit être **visible** (critère 21), jamais muet.
- Si, levier appliqué, le net reste > 0, ou si le levier fait grossir le départ : **arrêt et remontée à Ali** (paliers BUNDLE-01 de docs/audits/2026-10-18-bundle-depart.md, décision d'Ali ; leviers connus : réarmement d'orpheline paresseux `src/sync/orphanEpoch.ts`, `pairingStatus` hors du démarrage, fenêtre de restauration paresseuse). Aucun plafond relevé, aucun test de bundle assoupli.

## Critères testables

Toutes les valeurs ci-dessous sont en heure locale flottante, avec `now` = **2026-10-07T10:00** (mercredi, le `NOW` des tests existants) sauf mention contraire, récapitulatifs désactivés (`NO_RECAPS`), routines de l'espace Perso sauf mention. Chaque critère est **rouge avant** (sur `main` c01e961b) et vert après, sauf ceux notés « inchangé ».

### Fenêtre de 7 jours

1. **Étant donné** une routine quotidienne à 07:00, avance 30 min, `now` = 2026-10-07T07:00, **alors** le plan contient **7** éléments d'identifiants `routine:{r}:2026-10-08` à `routine:{r}:2026-10-14`, d'échéance `…T06:30` chacun ; `total` = 7 ; `coverage` = `{ state: 'until', until: '2026-10-14T07:00' }`. Rouge avant : 1 élément et `complete`.
2. **Étant donné** le même plan puis `now` = 2026-10-08T07:00, **alors** le second plan va de `…-09` à `…-15`, et sur le faux planificateur `replace(plan2)` après `replace(plan1)` rend `{ scheduled: 1, cancelled: 1, kept: 6 }` (identifiants stables).
3. **Étant donné** une routine à 07:00 avec les avances 0 et 30, `now` = 2026-10-07T06:00, **alors** 14 éléments, 7 par avance, occurrences du 2026-10-07 au 2026-10-13 pour chacune (l'occurrence du 14 tombe après `now + 7 jours`).
4. **Borne exacte** : routine à 10:00, avance 0, `now` = 2026-10-07T10:00 : occurrences du 10-08 au 10-14 (celle du 10-14 à 10:00 est incluse, celle du 10-07 à 10:00 exclue car <= `now`), soit 7 ; avec `now` = 2026-10-07T09:59 : du 10-07 au 10-13, soit 7 (l'occurrence du 10-14 à 10:00 dépasse 10-14T09:59).
5. **Plages silencieuses** : routine Pro à 20:00 (plages par défaut 19:00 → 08:00 et week-end entier), avance 0 : 7 éléments d'échéances effectives 2026-10-08T08:00, 10-09T08:00, **trois à 2026-10-12T08:00** (occurrences du vendredi 10-09, samedi 10-10, dimanche 10-11, identifiants distincts), 10-13T08:00, 10-14T08:00 ; la fenêtre porte sur l'échéance **effective**, `scheduledAt` garde l'échéance d'origine.
6. **Repli** : routine toutes les 2 semaines (lundi, début 2026-10-05) : 1 élément, `routine:{r}:2026-10-19` à 07:00 (test existant « 14 : toutes les 2 semaines » **inchangé**), `coverage` = `{ state: 'until', until: '2026-10-14T10:00' }` (le repli ne prolonge pas la couverture). Routine tous les 2 jours (début 2026-10-07, 07:00) : occurrences 10-09, 10-11, 10-13, sans repli.
7. **Pauses** : pause 2026-10-07 → 2026-10-09 : 5 éléments, du 10-10 au 10-14 à 07:00 ; pause sans fin : **aucun** élément et aucun repli (test existant inchangé), `coverage` = `empty` si rien d'autre ; pause du 2026-10-07 au 2026-10-20 : le repli donne 1 élément, `routine:{r}:2026-10-21` à 07:00 (première occurrence hors pause, hors fenêtre).
8. **Validations et quotas** : occurrence du jour validée (journal du 10-07), `now` = 2026-10-07T06:00 : 6 éléments du 10-08 au 10-13 ; « 2 fois par semaine » avec 2 validations les 10-05 et 10-06, `now` = 2026-10-07T06:00 : **2 éléments**, 2026-10-12T07:00 et 2026-10-13T07:00 ; avec une seule validation : 7 éléments du 10-07 au 10-13. Routines archivée, supprimée, sans heure, en pause sans période : aucun élément (inchangé).
9. **Autres natures inchangées** : tâches, événements (toutes occurrences de l'horizon de 400 jours), récapitulatifs (401 soirs, 400 matins sur 400 jours), répétitions « +15 min » : les tests existants passent **sans modification**.

### Plafond équitable et couverture

10. **Préfixe chronologique** : sur un scénario mêlant 12 tâches, 6 routines (avances 0 et 30), 4 événements répétés, 2 répétitions « +15 min » et les récapitulatifs par défaut, avec `limit` = 64, 63 et 10, **aucun élément gardé n'a une échéance effective postérieure à celle d'un candidat sacrifié** (propriété vérifiée en comparant `items` au tri complet de tous les candidats, `limit` illimité). Aucun quota par nature.
11. **Équité entre routines** : 12 routines quotidiennes à 07:00 (avance 0), récapitulatifs par défaut, `now` = 2026-10-07T10:00, `limit` = 64. Candidats : 84 occurrences de routines + 801 récapitulatifs = **`total` 885**. Gardés : le récapitulatif du soir du 10-07, 14 éléments par jour du 10-08 au 10-11 (12 routines et 2 récapitulatifs), puis 7 routines à 07:00 le 10-12 (ordre : identifiant, unités de code) = 64. **Chaque routine a ses occurrences du 10-08 au 10-11** (au moins 4, 7 d'entre elles en ont 5), `coverage` = `{ state: 'until', until: '2026-10-11T21:00' }` (le récapitulatif du soir, dernier gardé strictement avant la minute du premier sacrifié 10-12T07:00).
12. **Égalité de minute** : 60 rappels de tâche à 08:00 et 10 à 09:00 le même jour, `limit` = 64 : 60 + 4 gardés, `coverage` = `until` 08:00 (et non 09:00). 66 rappels à la même minute : 64 gardés, `coverage` = `until` la minute de `now`. Les tests existants du critère 20 de N-TECH-01 (100 minutes distinctes, `limit` 63, `limit` 0, plafond sur l'échéance effective) passent **sans modification**.
13. **Couverture par la fenêtre** : une routine quotidienne seule : `until` = `now + 7 jours`, jamais `complete`. Des tâches seules sous le plafond : `complete` (inchangé). Une routine en pause sans fin plus des tâches : `complete`. Une routine tronquée plus une tâche datée du 2026-10-20 : `until` = `2026-10-14T10:00` (la tâche est planifiée, la routine ne l'est pas au-delà).
14. **Réglages** : `RemindersStatus.dom.test.tsx` : avec une routine, la ligne de couverture affiche « Planifiés jusqu’au 14 oct. à 10:00 » et **jamais** « Tous les rappels sont planifiés » ; sans routine ni coupe, « Tous les rappels sont planifiés » (inchangé). `coverageText.test.ts`, `notificationStatus` (analyse de l'état persistant) et `parseCoverage` passent sans modification : le type de couverture est inchangé.

### Application fermée pendant deux jours (test rouge d'abord)

15. **Étant donné** une routine quotidienne à 07:00, avance 0, un plan calculé à `t0` = 2026-10-07T10:00, **et l'app jamais rouverte** : à `t2` = 2026-10-09T10:00 (horloge simulée, aucun délai réel), les notifications déjà sonnées sont celles des 10-08 et 10-09 à 07:00 et les notifications encore en attente sont **exactement** 2026-10-10T07:00 à 2026-10-14T07:00 (5). Rouge avant : en attente à `t2` = `[]` (seule l'occurrence du 10-08 existait). Ce test est écrit et vu rouge **avant** tout changement du planificateur.
16. **Au niveau du cas d'usage** : `replanNotifications(container, 'open')` avec le faux planificateur et l'horloge de notifications simulée à `t0`, puis horloge avancée à `t2` **sans nouveau passage** ; `scheduler.pending()` filtré sur `fireAt > t2` rend les 5 identifiants du critère 15 ; un passage `resume` à `t2` complète jusqu'à `t2 + 7 jours` : plan du 10-10 au 10-16 à 07:00, rapport `scheduled: 2` (10-15 et 10-16), `kept: 5` ; `cancelled` vaut 0 ou 2 selon que le faux planificateur garde ou non les deux notifications déjà sonnées (valeur écrite avec le test, d'après le comportement du faux).

### Remplacement de l'ancienne règle et non-régression

17. **Test qui encode l'ancienne règle** : `src/domain/notificationPlan.test.ts` lignes 213-227 (« 12 : … un seul élément, la prochaine occurrence ») est **remplacé** par les critères 1 et 2 ; sont adaptées, avec trace « ancienne attente → nouvelle attente » dans le tableau des preuves : lignes 229-234 (une par avance → 7 par avance, critère 3), 245-252 (pause bornée : 1 → 5 éléments), 265-273 (quota : 1 → 2 et 1 → 7), 281-285 (tous les 2 jours : 1 → 3) ; dans `src/domain/notificationPlan.qa.test.ts` les blocs « critères 12 et 13 » lignes 218-270 (pause, validation, quota, routine Pro décalée : `fires(...)` d'un seul élément → fenêtre), et tout test de `src/features/reminders` qui comptait une occurrence par routine (à trouver par recherche de `routine:` dans `*.test.ts` avant de coder). Les tests aux lignes 254-263 (`items[0]`), 275-279, 287-291 et 293-296 passent **sans modification**. Aucun test supprimé, désactivé, assoupli ni allongé ; le nombre d'assertions ne baisse pas.
18. **Pureté et déterminisme** (N-TECH-01 critères 22 à 24) : `planNotifications` n'appelle ni `Date.now` ni `Math.random`, n'importe ni `src/platform`, ni `src/db`, ni `src/i18n`, ne modifie pas ses arguments, rend le même résultat dans tous les ordres d'entrée (le test d'ordre existant est étendu à un scénario avec fenêtre, tableaux inversés) et identique quel que soit le fuseau de l'appareil ; 5 000 tâches, 200 événements répétés, 30 routines : au plus 64 éléments (test existant inchangé).
19. **Frontière** : le `limit` reçu (64 moins les réservées) reste respecté ; `replace` n'est jamais appelé avec plus de 64 requêtes (`over-limit` n'apparaît pas), y compris avec 30 routines à avances multiples.
20. **Règle PC** : le PC n'émet toujours aucune notification (`noNotification.test.ts` et `capture/consistency.test.ts` inchangés).
21. **Chargement du bloc à la demande** (si le levier de bundle est appliqué) : si l'`import()` de `replanNotifications` échoue (simulé), le passage se termine par `{ status: 'failed', reason: 'schedule-failed' }`, l'état persistant `notifications.status.planFailure` est écrit, le bandeau et Réglages > Rappels l'affichent, et le journal reçoit un code sans texte d'utilisateur. Rouge avant le levier : test écrit contre l'`import()` simulé avec un module qui rejette. Jamais d'échec silencieux.

### Bundle, documentation, vérifications

22. **Bundle** : mesure de départ au premier commit (attendu 358 357), puis après chaque commit ; **net <= 0** sur chaque commit et sur la branche ; sinon arrêt (voir « Bundle de départ »). Les valeurs avant/après et le gain éventuel du levier sont notés dans « Preuves ».
23. **Documentation** : ADR 0012 (avenant : section 5, « seule la prochaine occurrence d'une routine » remplacée par la fenêtre de 7 jours, couverture à deux bornes, égalité de minute) ; docs/decisions.md (ligne du 2026-10-07 « seule la prochaine occurrence d'une routine » marquée remplacée) ; `docs/stories/N-TECH-01.md` : critère 12 marqué « remplacé par N-TECH-02 », critères 13, 14 et 20 renvoyés vers les critères 6 à 8 et 12 de cette fiche ; docs/journal.md ; docs/backlog.md ; docs/audit-1.0.md (B9). Aucun écart avec le PRD (lignes 581 et 728 déjà conformes).
24. **Vérifications** : tests du module en local seulement (`CT_TEST_WORKERS=1 npx vitest run src/domain/notificationPlan src/features/reminders src/platform/notifications --coverage.enabled=false`), lint et typage verts ; suite complète en CI sur la branche (« suite verte ») ; aucun `skip`, aucun délai, aucun retry ; le journal technique ne reçoit aucun titre.

## Hors de cette story

- Fenêtre de plus de 7 jours, réglable, ou par routine ; quota réservé par nature ; planification en arrière-plan sans ouvrir l'app (hors périmètre iOS actuel).
- Corps des notifications (N-FIX-02), texte de remplacement des aperçus masqués (N-IOS-FIX-01).
- Rappel d'une routine déjà faite hors de l'app : seule la validation dans l'app replanifie (limite assumée : une routine « 2 fois par semaine » sonne chaque jour tant que le quota n'est pas atteint dans l'app).
- Toute fonction de la liste « Hors périmètre » du PRD (section 1).

## Plan par phases

1. **Étape 0, mesure (0,5 h)** : mesurer le départ de référence et, séparément, le levier `import()` de `replanNotifications` (une mesure, sans autre changement) ; si le levier ne rend pas au moins le coût attendu, remonter à Ali avant d'écrire du code.
2. **Tests rouges (1 h)** : critères 15 et 16 (application fermée), 1 à 4, 11, 12, 13 sur `main` ; noter l'assertion en échec ; commit « test seul ».
3. **Planificateur (1,5 h)** : fenêtre, repli, couverture à deux bornes, égalité de minute (`src/domain/notificationPlan.ts`) ; critères 5 à 10, 17 à 19 ; adapter les tests de l'ancienne règle un à un.
4. **Cas d'usage, Réglages et levier de bundle (1 h)** : critères 14, 16 et 21 ; levier `import()` mesuré à l'étape 1.
5. **Mesure, documentation, qa-test puis code-reviewer (0,5 h)** : critères 22 à 24.

Découpage : 0,5 + 1 + 1,5 + 1 + 0,5 + 0,5 de réserve de relecture = 5 h.

## Vérifications

- Local : seulement les tests du module (commande du critère 24) ; suite complète en CI.
- Preuve de détection : critères 15 et 16 rouges sur `main` avant le correctif (assertion `[]` contre 5 identifiants), verts après.
- Règle d'Ali : arrêt et alerte avant de continuer si l'estimation dérape de plus de 50 % (au-delà de 7,5 h) ; arrêt aussi si le net de bundle reste > 0.
- Aucun fichier écrit hors du dépôt ; aucun secret.
- Clôture refusée si un critère manque : le product-owner vérifie les 24 critères avant « fait ».

## Preuves (à remplir par l'agent)

| Élément | Valeur |
|---|---|
| Départ de référence (octets gzip, seuil 358 400) | |
| Levier `import()` de `replanNotifications` : départ avant / après | |
| Critères 15 et 16, rouge avant (commit, assertion) | |
| Critères 15 et 16, vert après (commit) | |
| Tableau « ancienne attente → nouvelle attente » (critère 17) | |
| Départ après chaque commit (net <= 0) | |
| Commandes locales et résultats | |

## Écarts

(aucun à ce jour)

## Questions à Ali (sans bloquer)

1. **Réserve par nature ?** Recommandation : **non**. Le préfixe chronologique couvre toutes les natures jusqu'à la même minute et garde « Planifiés jusqu'au… » vrai ; une réserve (par exemple 4 créneaux par nature) ferait manquer un élément avant la date affichée. Coût du défaut du préfixe : 70 rappels de tâches le même jour affament les routines du lendemain (cas irréaliste pour un utilisateur seul, couvert par un test qui le documente).
2. **Fenêtre glissante de 7 × 24 h ou jours civils ?** Recommandation : glissante (7 occurrences exactes pour une routine quotidienne à toute heure d'ouverture).
3. **Ligne dédiée « Plafond de 64 notifications atteint » dans Réglages ?** Recommandation : non pour l'instant, le texte « Planifiés jusqu'au… » dit déjà la conséquence et n'ajoute aucun octet au départ ; une ligne nouvelle coûterait environ 40 à 80 octets de départ (marge de 43) et exigerait un palier BUNDLE-01.
4. **Levier de bundle (chargement à la demande du planificateur)** : accepté sans question si la mesure le justifie (même dossier, aucun comportement visible) ; sinon c'est une décision de palier BUNDLE-01.
