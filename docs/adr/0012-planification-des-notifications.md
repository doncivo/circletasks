# ADR 0012 — Planification des notifications : planificateur pur et `NotificationScheduler`

- Statut : accepté (contrat ; implémentation par l'agent notifications, story N-TECH-01, puis N-01)
- Date : 2026-10-07
- Stories : N-TECH-01 (lot N0) ; prépare N-01, N-03, N-05, N-06, N-07, I-02 et l'envoi réel de F-04 et N-04 (lot N1)
- Complète : ADR 0001 (couches), 0004 (modèle `reminder`, avenants R-05 et E-01), 0005 (heure locale flottante), 0007 (build iOS sans Mac). Décisions du 2026-10-07 (« Ordre 5 ») dans `docs/decisions.md`

## Contexte

Les rappels sont des données depuis l'ordre 1 ; l'ordre 5 les envoie, **sur l'iPhone seulement**. iOS garde au plus 64 notifications locales en attente, et l'app n'est pas réveillée pour en replanifier : le plan doit être calculé d'avance, borné, et recalculé à l'ouverture, à la reprise, après une synchro et au passage en arrière-plan (N-01, N-05). Le moteur retenu est le plugin officiel `tauri-plugin-notification`. Pas de Mac : tout ce qui précède l'adaptateur réel doit être testable sous Windows.

**Constats sur `tauri-plugin-notification` 2.5.1** (crate et paquet npm, sources lues le 2026-10-07 ; MIT OR Apache-2.0) :

1. identifiant **entier 32 bits signé** (`id: i32` en Rust, `id?: number` en JS) ; sur iOS, l'identifiant de la requête est sa forme décimale (`"\(notification.id)"`) et il est relu par `Int(identifier) ?? -1` ;
2. `Schedule.at(date)` devient sur iOS un `UNTimeIntervalNotificationTrigger` : une **durée relative** calculée à l'envoi, et non une date du calendrier. Une date passée est refusée (`pastScheduledTime`) ; un changement de fuseau ou d'horloge ultérieur ne déplace pas la notification ;
3. `get_pending` ne rend sur iOS que `id`, `title`, `body` (ni échéance ni `extra`, malgré le type TypeScript) ;
4. `cancel` sans liste (`cancelAll()`) retire **toutes** les notifications en attente de l'app, fin de Focus comprise ;
5. `sendNotification` (JS) passe par `window.Notification` et **perd toute erreur** ; la commande mobile `show` rejette, mais l'erreur asynchrone de `UNUserNotificationCenter.add` est ignorée ;
6. le dictionnaire des notifications du gestionnaire iOS (`notificationsMap`) vit en mémoire ; `actionPerformed` le lit avec un dépliage forcé : une action sur une notification planifiée par un processus précédent risque l'arrêt de l'app (à vérifier sur l'appareil par N-03 ; sinon plugin Swift maison, décision du 2026-10-07).

## Décision

### 1. Couches et fichiers

| Brique | Couche | Rôle |
| --- | --- | --- |
| `src/domain/notificationPlan.ts` (+ tests) | domain | `planNotifications(entrée)` : fonction pure, sortie structurée sans texte. |
| `src/platform/notifications/types.ts` | platform | Contrat `NotificationScheduler`, `NotificationRequest`, `ReplaceReport`, `NotificationSchedulerError`, `NOTIFICATION_LIMIT = 64`. |
| `src/platform/notifications/unavailable.ts` | platform | Implémentation vide (PC, navigateur, Playwright, Vitest). |
| `src/platform/notifications/fake.ts` | platform | Faux testé : sémantique complète de `replace`, appels enregistrés, échecs injectables. |
| `src/platform/notifications/index.ts` | platform | `openNotificationScheduler(runtime, os)` : rend l'implémentation vide partout à N-TECH-01 ; N-01 ajoute la seule branche `tauri` + `ios`. Réexporté par `src/platform/index.ts`. |
| `src/platform/notifications/consistency.test.ts` | platform | Modèle de `capture/consistency.test.ts` : aucun chemin PC vers un envoi réel (section 7). |
| `src/i18n` (fr, en) + `src/features/reminders/coverageText.ts` | i18n, features | Clés de couverture et mise en forme testée (critère 21). |

`src/db` n'est pas touché ; `AppContainer` n'est pas modifié (champ `notifications` ajouté par N-01). Aucune dépendance npm ni cargo à N-TECH-01.

### 2. Contrat `NotificationScheduler` (`src/platform/notifications/types.ts`)

```ts
export const NOTIFICATION_LIMIT = 64;
export type NotificationKind = 'task' | 'routine' | 'event' | 'recap';
export interface NotificationRequest {
  readonly id: string;              // identifiant stable (section 3)
  readonly fireAt: LocalDateTime;   // heure locale flottante (échéance EFFECTIVE)
  readonly title: string;
  readonly body: string;
  readonly kind: NotificationKind;
}
export interface ReplaceReport { readonly scheduled: number; readonly cancelled: number; readonly kept: number }
export type NotificationFailure =
  | 'duplicate-id' | 'over-limit' | 'invalid-request'      // refus avant tout effet
  | 'unavailable' | 'permission-denied'                    // état du système
  | 'schedule-failed' | 'verify-failed';                   // échec pendant ou après l'envoi (adaptateur réel)
export class NotificationSchedulerError extends Error {
  readonly reason: NotificationFailure;
  readonly ids: readonly string[];        // identifiants en cause (doublons, refusés, manquants)
  readonly partial: ReplaceReport | null; // ce qui a été fait avant l'échec (schedule-failed, verify-failed)
}
export interface NotificationScheduler {
  availability(): Promise<'available' | 'unavailable'>;
  permission(): Promise<'granted' | 'denied' | 'undetermined'>;
  requestPermission(): Promise<'granted' | 'denied' | 'undetermined'>;
  replace(requests: readonly NotificationRequest[]): Promise<ReplaceReport>;
  cancelAll(): Promise<void>;
  pending(): Promise<readonly NotificationRequest[]>;
}
```

- Le contrat ne connaît **ni instant, ni fuseau** : la conversion de `fireAt` en instant est faite par l'adaptateur réel au moment de l'envoi (section 4).
- `cancelAll()` et `pending()` ne portent **que sur les notifications du plan** (section 3.2) : jamais sur la fin de Focus.
- L'implémentation vide : `availability()` = `unavailable`, `permission()` et `requestPermission()` = `denied` sans effet, `replace` rend `{ 0, 0, 0 }` sans rien faire, `cancelAll` sans effet, `pending()` = `[]`. Elle valide quand même la liste (mêmes refus typés), pour que le PC et l'iPhone se comportent pareil devant une liste fautive.
- `FocusEndScheduler` (F-04) reste **inchangé** (contrat séparé, échéance en instant `Date`). Au lot N1, son implémentation iOS utilise le même plugin avec l'identifiant réservé 1 (section 3.2).

### 3. Identifiants

#### 3.1 Identifiant stable (chaîne, produit par le domaine)

| Élément | Forme | Exemple |
| --- | --- | --- |
| Rappel de tâche | `task:{reminderId}` | `task:01J…` |
| Rappel de routine | `routine:{reminderId}:{dateOccurrence}` | `routine:01J…:2026-10-08` |
| Rappel d'événement | `event:{reminderId}:{dateOccurrence}` | `event:01J…:2027-03-12` |
| Récapitulatif | `recap:{morning\|evening}:{jour}` | `recap:evening:2026-10-07` |

- Une tâche récurrente n'a qu'une occurrence vivante, avec ses propres lignes `reminder` : la ligne suffit. Une routine et un événement n'ont **qu'une ligne par avance pour toutes leurs occurrences** : la date d'occurrence (premier jour, `EventOccurrence.date` ou jour prévu de la routine) distingue les notifications et sert à N-03 (« Fait » valide la routine **ce jour-là**).
- L'identifiant ne contient ni l'échéance ni le texte : changer l'heure d'une tâche garde l'identifiant et replanifie (critère 3).
- Récapitulatif : valeurs de `RecapKind` (`morning`, `evening`), pas les mots français de la fiche (écart 1).

#### 3.2 Identifiant numérique du plugin (adaptateur réel, N-01)

- Plage des notifications du plan : **[65 536 ; 2 147 483 647]**. Valeur = `65 536 + (FNV-1a 32 bits de l'identifiant stable en UTF-8) mod (2³¹ − 65 536)`. Positif (le plugin rend −1 quand il ne sait pas lire un identifiant), déterministe, sans état.
- Collision dans un même plan (probabilité ≈ 5·10⁻⁷ pour 64 éléments) : les identifiants stables sont parcourus dans l'ordre croissant (unités de code) et le suivant prend la valeur libre suivante dans la plage (bouclage). Jamais d'erreur durable pour une collision.
- **Plage réservée [1 ; 65 535]** hors plan : 1 = fin de session Focus (une seule session à la fois) ; le reste pour N-03 si la répétition « +15 min » reste hors du plan (recommandation : en faire une entrée du planificateur, gardée dans la file locale durable de N-03, pour qu'elle compte dans les 64 sans réserve).
- La correspondance numérique → stable est tenue par l'adaptateur dans un **registre local** (section 4) ; c'est elle que N-03 utilise pour retrouver la cible d'une action (le plugin ne rend pas `extra`).

### 4. Sémantique de `replace` (idempotent, par différence)

1. **Validation complète avant tout effet** : `fireAt` au format `LocalDateTime`, titre non vide, `kind` connu (`invalid-request`) ; identifiant répété (`duplicate-id`, avec les identifiants) ; `requests.length` + notifications en attente hors plan > 64 (`over-limit`). Un refus ne modifie rien. Le plafond est appliqué **par le planificateur** ; l'adaptateur ne tronque jamais en silence.
   **État du système** (adaptateur réel et faux, pas l'implémentation vide) : après la validation de la liste et avant tout effet, `replace` rejette `unavailable` si le moteur est indisponible, puis `permission-denied` si l'autorisation n'est pas `granted` (refusée ou non décidée). C'est l'**adaptateur** qui lève ; N-01 attrape l'erreur, la range dans le store et affiche le bandeau (section 7). L'implémentation vide ne rejette pas : elle rend `{ 0, 0, 0 }` (PC).
2. **Différence** avec le plan en place, par identifiant stable : absent du nouveau plan → annulé (`cancelled`) ; nouveau, ou même identifiant dont `fireAt`, `title`, `body` ou `kind` change → (re)planifié (`scheduled`, un remplacement compte une fois) ; identique → `kept`. Deux appels avec la même liste : `{ scheduled: 0, cancelled: 0, kept: n }`.
3. **Adaptateur réel** (N-01), en plus :
   - l'égalité compare aussi l'**instant** calculé (fuseau courant de l'appareil, `localToUtcMs`) : après un changement de fuseau, le planificateur rend le même plan (critère 23) mais l'adaptateur replanifie, puisque le déclencheur iOS est relatif (constat 2). Heure inexistante (passage à l'heure d'été) : décalée d'une heure vers l'avant ; heure répétée : la première ;
   - un élément dont l'instant est déjà passé à l'envoi n'est pas transmis (il serait refusé) ;
   - envoi élément par élément par la commande mobile `show` avec attente du résultat (jamais `sendNotification`), annulation par `cancel` avec la liste des identifiants numériques du plan (jamais `cancel` sans liste) ;
   - **vérification** : `get_pending` relu après l'envoi ; un identifiant attendu absent → `verify-failed` ; un rejet du plugin → `schedule-failed` après avoir tenté les autres ; `partial` décrit l'état réel ;
   - registre local (identifiant numérique, identifiant stable, instant, empreinte du texte, `kind`) : port `NotificationLedger { load(); save(entries) }` fourni par la feature (réglage **local**, non synchronisé, via `SettingsRepository`). La vérité reste `get_pending` : registre perdu ou illisible = tout est replanifié une fois, résultat juste.
4. `pending()` : la dernière liste acceptée, triée par `fireAt` puis identifiant ; pour l'adaptateur réel, restreinte aux identifiants encore présents dans `get_pending`.
5. `cancelAll()` : annule tous les identifiants de la plage du plan présents en attente ; vide le registre.

### 5. Planificateur `planNotifications` (`src/domain/notificationPlan.ts`)

```ts
export const NOTIFICATION_HORIZON_DAYS = 400;
export interface NotificationPlanInput {
  readonly now: LocalDateTime;
  readonly limit?: number;                          // défaut NOTIFICATION_LIMIT_DEFAULT = 64 ; entier 0 à 64
  readonly tasks: readonly Task[];                  // au moins : cibles des rappels vivants + tâches datées du jour de `now`
  readonly routines: readonly Routine[];
  readonly routinePauses: readonly RoutinePause[];
  readonly routineLogs: readonly RoutineLog[];
  readonly events: readonly CalendarEvent[];
  readonly reminders: readonly Reminder[];
  readonly spaces: readonly Pick<Space, 'id' | 'quietHours'>[];
  readonly recaps: RecapSettings;
}
interface PlannedReminderBase {
  readonly id: string; readonly reminderId: ReminderId; readonly offsetMin: ReminderOffsetMin;
  readonly spaceId: SpaceId; readonly occurrenceDate: LocalDate;
  readonly scheduledAt: LocalDateTime;  // échéance d'origine (information, critère 10)
  readonly fireAt: LocalDateTime;       // échéance effective (plages silencieuses)
}
export type PlannedItem =
  | (PlannedReminderBase & { readonly kind: 'task'; readonly targetId: TaskId })
  | (PlannedReminderBase & { readonly kind: 'routine'; readonly targetId: RoutineId })
  | (PlannedReminderBase & { readonly kind: 'event'; readonly targetId: EventId })
  | { readonly kind: 'recap'; readonly id: string; readonly recapKind: RecapKind; readonly day: LocalDate;
      readonly fireAt: LocalDateTime; readonly content: Recap | null };
export type PlanCoverage = { readonly state: 'complete' } | { readonly state: 'until'; readonly until: LocalDateTime } | { readonly state: 'empty' };
export interface NotificationPlan { readonly items: readonly PlannedItem[]; readonly coverage: PlanCoverage; readonly total: number }
export function planNotifications(input: NotificationPlanInput): NotificationPlan;
```

Règles (les critères de la fiche s'appliquent ; seules les décisions sont écrites ici) :

- **Échéance toujours recalculée** depuis la cible (date et heure actuelles de la tâche, occurrence de la routine ou de l'événement) ; `reminder.fire_at` et `reminder.delivered` ne sont **ni lus ni écrits** (aucune écriture synchronisée depuis le plan). Les avances stockées sont prises telles quelles, mais filtrées selon la cible comme le modèle (`isReminderOffset` pour tâche et routine, `isEventReminderOffset` pour événement) ; une avance non admise ne produit aucun élément.
- **Exclusion « passé » sur l'échéance effective** : un élément est candidat si `fireAt` effectif > `now` (minute). Un rappel Pro de 20:00 décalé au lendemain 08:00 reste donc candidat à 21:00 ; un rappel dont l'échéance effective est passée n'est jamais rattrapé.
- **Doublons** (même cible, même avance, même occurrence) : la ligne `reminder` d'identifiant le plus petit est gardée.
- **Plages silencieuses** : `effectiveFireAt` avec les plages de l'espace de la cible, pour tâches, routines et événements ; jamais pour les récapitulatifs (ni pour la fin de Focus, hors plan). Plusieurs rappels décalés à la même heure restent des éléments distincts (regroupement d'ES-07 : hors N-TECH-01).
- **Routines** : par avance, la première date d `≥` jour de `now`, d `≤` jour + 400, telle que la routine est active ce jour (`isActive` avec les pauses, donc booléen `paused` si aucune période n'existe), prévue (`isPlannedOn`), non validée ce jour, non masquée par le quota atteint (`x_per_week`, même règle que `routinesForDay`), et dont l'échéance effective est > `now`. Aucune si elle n'a pas d'heure, est archivée ou supprimée.
- **Événements** : **une notification par occurrence et par avance, sans ligne `reminder` par occurrence** (confirme la décision E-01 du 2026-10-04 et l'avenant E-01 de l'ADR 0004). Occurrences par `occurrenceStarts` dont la date de début est dans [jour de `now` ; jour + 400] ; heure `eventReminderTime` (09:00 en journée entière).
- **Horizon de 400 jours, borné sur l'échéance** : l'échéance effective d'un rappel de routine ou d'événement doit tomber au plus tard le jour de `now` + 400 (23:59). Les occurrences sont donc cherchées jusqu'à jour + 400 + la plus grande avance des rappels (en jours, arrondie au-dessus), puis filtrées sur l'échéance effective ; ainsi `complete` est exact (un événement à J+405 avec l'avance d'une semaine est planifié). Même borne pour les récapitulatifs (jour de `now` à jour + 400). Les tâches n'ont pas d'horizon (leurs lignes sont en nombre fini).
- **Récapitulatifs** : `recap:{kind}:{jour}` pour chaque jour de l'horizon et chaque récapitulatif activé, à l'heure du réglage, sans plage silencieuse ni filtre d'espace. `content` = `buildRecap(...)` **pour le jour de `now` seulement** ; `null` ensuite, et N-01 affiche alors le texte générique qui invite à ouvrir l'app (N-07). Le contenu du jour est donc figé à la dernière replanification ; les déclencheurs de N-01 (dont le passage en arrière-plan) le tiennent à jour.
- **Tri et plafond** : tri par `fireAt` effectif, puis rappel avant récapitulatif, puis identifiant (comparaison par unités de code, jamais `localeCompare`) ; les `limit` premiers sont gardés. `total` = nombre de candidats ; `coverage` = `empty` sans candidat, `complete` si `total ≤ limit`, sinon `until` = échéance effective du dernier élément gardé. N-01 passe `limit` = 64 − notifications réservées en attente (1 tant qu'une session Focus est planifiée, critère 6).
- **`limit` = 0 avec candidats** (63 réservés par d'autres notifications, ou plafond épuisé) : `items` vide, `total` = nombre de candidats, `coverage` = `{ state: 'until', until: now }` (rien n'est planifié, la couverture s'arrête à `now`) ; `empty` reste réservé à l'absence de candidat.
- **Pureté** : aucun `Date.now`, `new Date()` sans argument, `Math.random`, ni import de `src/platform`, `src/db`, `src/i18n` (règle ESLint de l'ADR 0001 et test de la fiche) ; arguments non modifiés ; résultat identique quel que soit l'ordre des tableaux (déduplication et tri par identifiants). **Indépendant du fuseau** : tout est en heure locale flottante, arithmétique sur dates civiles.
- **Totalité** : `planNotifications` ne lève pas ; une donnée incohérente (rappel orphelin, règle sans occurrence, plage invalide) ne produit simplement aucun élément.

### 6. Frontière avec N-01 et les stories suivantes

Hors N-TECH-01 : lecture en base (repositories, dont les tâches du jour et les cibles des rappels), adaptateur réel (`tauriNotifications.ts`, capability, entrée cargo iOS seulement, `Info.plist`), conversion en instant, registre, textes des notifications (src/i18n), demande d'autorisation (OB, Réglages), déclencheurs de replanification (ouverture, reprise, synchro, arrière-plan : N-01, N-05 ; fuseau : N-06), actions « Fait » / « +15 min » (N-03), envoi de la fin de Focus et des récapitulatifs (lot N1). Le test `src/features/reminders/noNotification.test.ts` (N-02 critère 9) reste vert à N-TECH-01 (aucun nom `scheduleNotification`, aucun import de plugin) ; N-01 le restreint à son seul fichier d'adaptateur iOS.

### 7. Aucun échec silencieux

- **PC** : `availability()` = `unavailable` ; Réglages > Rappels l'affiche (« les rappels sont envoyés par l'iPhone », N-01). Le test de cohérence prouve : le résolveur rend l'implémentation vide pour (`tauri`, `windows`), (`web`, tout système) ; aucun fichier de `src/platform` hors adaptateur iOS ne référence le plugin ; `src-tauri/Cargo.toml` ne déclare le plugin que sous `cfg(target_os = "ios")` (ou pas du tout) ; aucune capability d'une fenêtre Windows n'accorde `notification:`.
- **États visibles prévus pour N-01** (store de la feature rappels, lus par Réglages > Rappels et le bandeau A-09) : `permission-denied` → bandeau persistant avec renvoi aux réglages iOS ; `undetermined` → invitation à autoriser ; plafond atteint → « Planifiés jusqu'au {date} » (information, pas une erreur) ; échec de `replace` (`schedule-failed`, `verify-failed`, `over-limit`, `invalid-request`) → bandeau « Les rappels n'ont pas pu être planifiés », nouvel essai au déclencheur suivant, retiré au premier `replace` réussi. Journal : code d'échec et nombres seulement (ni titre ni texte de rappel).
- Le planificateur ne cache rien : `total` et `coverage` disent toujours ce qui n'est pas planifié.

## Conséquences

- Tout le calcul est testable sous Windows (Vitest) ; l'adaptateur iOS n'a plus qu'à convertir, envoyer et vérifier.
- Toute modification d'un rappel, d'une tâche, d'une routine ou d'un événement est prise en compte au prochain déclencheur sans écriture en base : la ligne `reminder` des événements et des routines ne porte plus d'échéance utile (`fire_at` gardé pour compatibilité et synchro).
- Avec les deux récapitulatifs activés (800 candidats sur l'horizon), `coverage` vaut presque toujours `until` (32 jours au plus sans autre rappel) : c'est l'information juste, puisque rien ne sonnera après cette date si l'app n'est pas rouverte.
- Les identifiants numériques 1 à 65 535 sont réservés hors plan ; toute nouvelle notification hors plan (N-03, lot N1) y prend sa place et réduit `limit` d'autant.
- Constat 6 : risque d'arrêt de l'app sur une action à froid ; à vérifier par N-03 sur l'appareil avant de s'appuyer sur `onAction`.

## Écarts avec la fiche N-TECH-01 (à reporter dans la fiche par le product-owner)

1. Critère 18 : identifiants `recap:{matin|soir}:{date}` → `recap:{morning|evening}:{date}` (valeurs de `RecapKind`).
2. Critère 20 : `coverage` = `complet` / `jusqu'à` / `vide` → `{ state: 'complete' | 'until' | 'empty' }` (identifiants de code sans accent ni apostrophe ; les textes restent ceux du critère 21).
3. Critère 16 : « événement hebdomadaire » n'existe pas (`EventRepeat` = `once` / `monthly` / `yearly`) ; les tests portent sur mensuel et annuel.
4. Critère 17 : « une occurrence passée dont l'avance tombe encore dans le futur » est impossible (avances ≥ 0) ; l'exemple donné (événement demain 08:00, avance d'un jour) est une occurrence à venir dont le rappel tombe aujourd'hui : c'est lui qui est testé.
5. Critère 10 / 8 : l'exclusion « échéance ≤ `now` » s'applique à l'échéance **effective** (un rappel décalé par une plage silencieuse en cours reste dû).
6. Critère 13 : routine « X fois par semaine » dont le quota est atteint : aucun rappel ces jours-là (non cité par la fiche ; cohérent avec `routinesForDay`).
