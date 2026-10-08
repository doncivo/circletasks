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

## Avenant lot N1 (2026-10-08) — adaptateur iOS, replanification, actions, fuseau, avertissement PC

- Statut : accepté (contrat ; implémentation par l'agent notifications, avec ios-mobile pour Rust, capability et CI)
- Stories : N-01, N-03, N-05, N-06, N-07, compléments ordre 5 de F-04 et N-04
- Sources relues le 2026-10-08 : crate `tauri-plugin-notification` **2.5.1** (`ios/Sources/*.swift`, `src/{lib,mobile,commands,models}.rs`, `src/init-iife.js`, `build.rs`, `permissions/`), `tauri` 2.12.1 (`mobile/ios-api/.../Plugin.swift`), `src/platform/{notifications,focus,sync}`, `src/features/{reminders,app}`, `src/sync/deviceStatus.ts`, `src-tauri/{Cargo.toml,src/lib.rs,capabilities,tests/desktop/config.rs}`, `scripts/ios/plist-contract.json`, ADR 0007 (avenants), ADR 0011 (§1.4, §10.2), `docs/dettes.md` (lot Y2)

### N1.0 Constats complémentaires (suite des constats 1 à 6)

7. **Date du déclencheur lue comme heure murale locale.** Swift analyse `schedule.at.date` avec `DateFormatter` au format `yyyy-MM-dd'T'HH:mm:ss.SSS'Z'` : le `Z` est **littéral** et le fuseau est celui de l'appareil. Une chaîne `Date.toISOString()` (UTC) ferait sonner décalé du décalage UTC (2 h trop tôt à Paris en été). Tout autre format (sans millisecondes, avec `+02:00`) est refusé (`invalidDate`).
8. `show` résout dès l'appel à `UNUserNotificationCenter.add`, avant son résultat (confirme le constat 5) ; une date passée lève `pastScheduledTime` de façon synchrone (rejet de l'appel).
9. **Dépliage forcé élargi.** `toActiveNotification` lit `notificationsMap[id]!` dans `willPresent` (notification arrivée app au premier plan), dans `didReceive` (**simple appui** comme action) et dans `getActive`. La table est en mémoire, remplie par `show` et `batch` **du processus courant** seulement. Une notification planifiée par un processus précédent et non renvoyée arrête donc l'app si elle arrive app ouverte, si on l'ouvre ou si on agit dessus ; `get_active` l'arrête dès qu'une notification livrée vient d'un processus précédent.
10. **Événements perdus à froid.** `Plugin.trigger` (tauri 2.12.1) n'envoie qu'aux écouteurs déjà inscrits : une action qui lance l'app est émise avant l'inscription de l'écouteur JS et se perd sans trace.
11. Le plugin est le **délégué unique** de `UNUserNotificationCenter` (`NotificationManager`) : un second plugin qui veut recevoir les réponses doit prendre la place du délégué, il ne peut pas cohabiter.
12. Sans champ `sound`, `content.sound` reste nul : **notification muette**. Les fonctions JS du paquet (`requestPermission`, `isPermissionGranted`, `sendNotification`) passent par le `window.Notification` du script d'initialisation ; le paquet npm n'apporte rien d'utile.
13. MSRV 1.90 (comme tauri 2.12, déjà exigée), licence MIT OR Apache-2.0, aucune clé Info.plist ni droit (entitlement) pour des notifications locales. `notify-rust` n'est tiré que pour les cibles bureau **du plugin** : avec le plugin déclaré pour iOS seulement, rien n'est compilé sur Windows (les entrées apparaissent dans `Cargo.lock`, résolu pour toutes les cibles, sans effet sur le binaire PC).

### N1.1 Plugin, dépendances et frontière PC (le PC n'envoie aucune notification de rappel)

| Point | Décision |
| --- | --- |
| Version | `tauri-plugin-notification = "=2.5.1"` dans `[target.'cfg(target_os = "ios")'.dependencies]` seulement. Version **épinglée** : les constats 7 à 12 dépendent du code Swift ; toute montée exige une relecture des sources et un avenant. |
| npm | **Aucune** dépendance : l'adaptateur appelle `invoke` et `addPluginListener` de `@tauri-apps/api/core` (déjà présent). |
| Enregistrement | `lib.rs` : `#[cfg(target_os = "ios")] let builder = builder.plugin(tauri_plugin_notification::init());` avant `.run`. Aucune ligne sous `cfg(desktop)`. |
| Capability | Nouveau `src-tauri/capabilities/notifications-ios.json` : `windows: ["main"]`, `platforms: ["iOS"]`, permissions **exactement** `notification:allow-is-permission-granted`, `notification:allow-request-permission`, `notification:allow-show`, `notification:allow-cancel`, `notification:allow-get-pending`, `notification:allow-register-action-types`, `notification:allow-register-listener`, `notification:allow-remove-listener`. Aucune `core:` en plus. **Jamais** : `allow-notify` (chemin `window.Notification`/`sendNotification` qui perd les erreurs), `allow-batch`, `allow-get-active` (constat 9 : arrêt), `allow-remove-active`, `allow-check-permissions`, `allow-permission-state`, canaux, `default`. |
| Preuve PC | (1) crate absente de la compilation Windows (`cfg`) ; (2) enregistrement sous le même `cfg` (ne compilerait pas autrement) ; (3) capability `platforms: ["iOS"]` : tauri-build ne traite pas une capability hors de la cible (précédent : `desktop.json` accorde `updater:` sur Windows seulement et le build iOS passe) ; (4) sans plugin enregistré, ni script d'initialisation ni commande `plugin:notification|…` n'existent sur le PC ; (5) résolveur TS : implémentation vide hors (`tauri`, `ios`) ; (6) tests de N1.9. |

### N1.2 Adaptateur réel (`src/platform/notifications`)

**Fichiers.** `tauriNotifications.ts` : **seul fichier** de `src` qui nomme `plugin:notification|` ; il exporte `createTauriNotificationScheduler(deps)` et le pont bas niveau `createIosNotificationBridge()` (`show`, `cancel(ids)`, `pending()`, `permission()`, `requestPermission()`, `registerActionTypes()`, `onAction()`), réutilisé par `src/platform/focus/tauriFocusEnd.ts`. `notificationClock.ts` : port `NotificationClock { nowMs(): number; zone(): string | null }` (défaut `Date.now`, `detectTimeZone`). `notificationLedger.ts` : port `NotificationLedger { load(): Promise<LedgerRead>; save(ledger): Promise<void> }` (implémentation par la feature, voir plus bas). Résolveur : `openNotificationScheduler('tauri', 'ios', deps)` charge `tauriNotifications.ts` par import dynamique ; partout ailleurs l'implémentation vide.

**Contrat (`types.ts`), ajouts.**

```ts
export type NotificationKind = 'task' | 'routine' | 'event' | 'recap' | 'snooze';
export type NotificationCategory = 'task' | 'routine' | 'event';          // actions proposées (N-03)
export interface NotificationRequest { /* champs existants */ readonly category?: NotificationCategory }
export type NotificationFailure = /* existants */ | 'ledger-failed';      // registre non enregistré après un envoi réussi
export interface NotificationScheduler { /* existants */ reservedCount(): Promise<number> } // en attente dans [1 ; 65 535]
```

Implémentation vide : `reservedCount()` = 0 ; faux : la valeur de `setOutsidePlan`.

**Conversion `fireAt` → instant.** Fonction pure du domaine `src/domain/notificationInstant.ts` : `fireAtInstant(fireAt: LocalDateTime, zone: string): number` (ms UTC). Fuseau **passé en argument** (IANA, calcul par `Intl` avec fuseau explicite, donc indépendant de `TZ`). Heure inexistante : décalée d'une heure vers l'avant (décalage d'avant la transition) ; heure répétée : **la première** occurrence (ne pas réutiliser `localToUtcMs`, qui rend « l'une des deux »). Puis `pluginDate(instantMs, zone)` (adaptateur) rend l'**heure murale de cet instant dans ce fuseau** au format `YYYY-MM-DDTHH:mm:00.000Z` (constat 7 : le `Z` n'est pas UTC ; jamais `toISOString`). Une heure inexistante n'est donc jamais envoyée.

**Comparaison par instant.** Un élément est `kept` si, pour son identifiant stable, le registre porte le même identifiant numérique, le **même instant** (calculé avec le fuseau courant), la même empreinte (FNV-1a de `title`, `body`, `kind`, `category`) et si l'identifiant numérique figure dans `get_pending`. Un changement de fuseau change l'instant : replanifié (N-06). Identifiant numérique : celui du registre s'il est libre, sinon `notificationNumericIds` (collisions, §3.2).

**Envoi.** Dans l'ordre : `get_pending` lu (vérité) ; `reservedCount` déduit ; validation `validateRequests(requests, réservés)` ; état du système (`unavailable`, puis `permission-denied`) ; `cancel` avec la liste explicite des identifiants à retirer (absents du plan, ou présents dans `get_pending` dans la plage du plan sans figurer au nouveau plan : registre perdu) ; puis `show` élément par élément **par ordre chronologique** (une coupure laisse les plus proches planifiés), charge `{ id, title, body, schedule: { at: { date: pluginDate, repeating: false, allowWhileIdle: false } }, sound: 'default', actionTypeId?, extra: { sid, at } }` (`extra` : chaînes seulement ; `actionTypeId` = `ct.task`, `ct.routine` ou `ct.event` selon `category`, absent pour récapitulatif et fin de Focus). Instant ≤ maintenant + 5 s : non transmis, sans erreur, absent de `pending()`.

**Réaffirmation par processus (constat 9).** L'adaptateur garde en mémoire les identifiants envoyés par le processus courant ; au premier `replace` d'un processus, chaque élément `kept` encore absent de cet ensemble est **renvoyé** par `show` (même identifiant : iOS remplace) et **compté `kept`** (N-05 critère 1 inchangé). Cela remplit `notificationsMap` ; la fenêtre entre le lancement et la fin du premier passage, et l'appui sur une notification déjà livrée par un processus précédent, restent exposés (N1.4).

**Vérification.** `get_pending` relu après l'envoi ; un identifiant attendu absent (hors instants ≤ relecture + 2 s, qui ont pu sonner) → `verify-failed` ; un rejet de `show` ou de `cancel` → `schedule-failed` après avoir tenté les autres ; échec de `get_pending` → `verify-failed` ; échec d'`invoke` signalant un plugin absent ou une permission refusée par la capability → `unavailable`. `partial` décrit l'état réel relu.

**Registre local, non synchronisé.** Réglage **local** `notifications.ledger` (`SETTINGS_DEFINITIONS`, `scope: 'local'`, donc jamais dans les journaux), écrit par `SettingsRepository` via le port. Format :

```ts
interface NotificationLedgerV1 {
  readonly v: 1;
  readonly zone: string | null;                     // fuseau des instants enregistrés
  readonly entries: readonly { n: number; sid: string; at: number; h: string; kind: NotificationKind }[]; // plage du plan ; aucun titre
  readonly focusEnd: { readonly sessionId: string; readonly at: number } | null;                       // identifiant 1
}
```

Analyse stricte par une fonction du domaine (`parseNotificationLedger`). **Illisible** (JSON invalide, version inconnue, champ faux) : journal `ledger-unreadable` (code seulement), lu comme vide, tout le plan est replanifié une fois (`get_pending` fait foi, aucun doublon : mêmes identifiants), et **information visible** dans Réglages > Rappels « Registre des rappels reconstruit à {heure} », effacée au passage suivant qui lit un registre valide. Écrit après la vérification, même en échec partiel (contenu = ce que `get_pending` confirme). Écriture impossible après un envoi réussi : `NotificationSchedulerError('ledger-failed', [], rapport)` (bandeau, N1.8) ; au passage suivant, les mêmes identifiants remplacent sans doublon.

### N1.3 Cas d'usage `replanNotifications`

**Fichiers.** `src/features/reminders/replanNotifications.ts` (un passage), `notificationRunner.ts` (sérialisation), `notificationStatus.ts` (store Zustand + réglage persistant), `notificationTexts.ts` (textes), `notificationActions.ts` (N-03). `AppContainer` reçoit `notifications: NotificationScheduler` et `notificationActions: NotificationActionSource | null`.

**Déclencheurs.** `ReplanTrigger = 'open' | 'resume' | 'sync' | 'hide' | 'edit' | 'action' | 'zone' | 'permission'`.

| Déclencheur | Branchement |
| --- | --- |
| `open` | `startup.ts`, après l'ouverture de la base et **après le premier rendu** (jamais attendu par le rendu, N-05 critère 1). |
| `resume` / `hide` | `visibilitychange` (visible / masqué), même écouteur que T-11. Au lot Y-IOS-01, la tâche d'arrière-plan iOS enveloppe d'abord `request('hide')` puis le cycle de synchro (le passage va au bout du `replace` avant toute autre tâche d'arrière-plan ; une coupure est reprise à l'ouverture suivante, sans état d'échec). |
| `sync` | `onRemoteChanges` sur `task`, `routine`, `routine_pause`, `routine_log`, `event`, `reminder`, `space`, `settings` (récapitulatifs). |
| `edit` | Après validation de la transaction, par les cas d'usage de création, modification, fin, suppression, restauration et annulation 5 s des tâches, routines (validation comprise), événements, rappels, plages silencieuses et récapitulatifs : `container.notificationsPlanChanged()` (aucune lecture de la base par un déclencheur). |
| `action` | Après application d'une action de notification (N1.4). |
| `zone` | `timeZoneWatcher.onChange` (point d'extension N-06 déjà prévu). |
| `permission` | Après `requestPermission()` sur geste. |

**Sérialisation et coalescence.** `NotificationRunner.request(trigger): Promise<ReplanOutcome>` : au plus **un passage en cours et un passage en attente**. Un déclencheur arrivé pendant un passage marque le passage en attente (relance unique à la fin) et sa promesse se résout à la fin de **ce** passage suivant. Les actions de la file (N1.4) sont appliquées **dans le même passage**, avant le plan. Aucune minuterie de regroupement.

**Un passage.** (1) appliquer la file d'actions ; (2) `availability()` : `unavailable` sur le PC → état « Les rappels sont envoyés par l'iPhone », **aucune lecture de données ni appel de planification** ; sur iPhone, `unavailable` est un échec (N1.8) ; (3) `permission()` enregistrée ; `denied` ou `undetermined` → état visible, **aucun `replace`** ; (4) lecture des données **par les repositories seulement** (méthode manquante : ajoutée au repository, jamais de SQL dans la feature) ; (5) `limit = 64 − await reservedCount()` ; (6) `planNotifications({ now: heure locale de NotificationClock, limit, …, snoozes })` ; (7) textes ; (8) `replace` ; (9) réussite : `lastSuccess` écrit, `planFailure` effacé ; échec : `planFailure` écrit. Toute exception inattendue est rattrapée et enregistrée `schedule-failed` (jamais avalée).

**Textes (`src/i18n`, fichiers `fr.notifications.ts` / `en.notifications.ts`, espace `notifications`).** Rappel de tâche, routine, événement : titre = titre de la cible ; corps `notifications.body.atTime` « À l'heure » (avance 0) ou `notifications.body.inAdvance` « Dans {advance} » (même mise en forme que `reminderChoiceLabel`) ; répétition : titre et corps de l'origine. Récapitulatif du jour : titre de `formatRecapTitle`, corps = 5 premières lignes puis `notifications.recap.more` « et {n} autres » ; autre jour : titre `notifications.recap.morningTitle` « Récapitulatif du matin » / `notifications.recap.eveningTitle` « Récapitulatif du soir », corps `notifications.recap.generic` « Ouvrez CircleTasks pour voir votre journée ». Fin de Focus : titre `notifications.focusEnd.title` « Session terminée · {duration} », corps = titre de la tâche. Actions : `notifications.action.done` « Fait », `notifications.action.snooze` « +15 min ». Le journal technique ne reçoit que codes et nombres.

**État persistant.** Réglage **local** `notifications.status`, lu au démarrage avant le premier passage (le bandeau survit au redémarrage) :

```ts
interface NotificationStatusV1 {
  readonly v: 1;
  readonly permission: NotificationPermission | null;
  readonly lastSuccess: { at: IsoDateTime; coverage: PlanCoverage; total: number; zone: string | null } | null;
  readonly planFailure: { at: IsoDateTime; reason: NotificationFailure | 'zone-unknown'; count: number; partial: ReplaceReport | null } | null;
  readonly focusEndFailure: { at: IsoDateTime; sessionId: string; reason: NotificationFailure } | null;
  readonly zoneChange: { at: IsoDateTime; from: string; to: string } | null;
  readonly ledgerRebuiltAt: IsoDateTime | null;
}
```

`planFailure` est **effacé par le premier `replace` réussi** (un plan vide réussi compte) ; `permission` est relue à chaque passage (rétablie dans Réglages iOS → bandeau retiré à la reprise). Valeur illisible : journal `status-unreadable`, affichée comme `planFailure` `schedule-failed` jusqu'au passage réussi suivant, qui la réécrit. Écriture impossible : l'état reste dans le store pour la session (visible), nouvel essai au passage suivant.

**Réalisation du déclencheur `edit` (revue du lot N1).** Il est posé par `observeWrites` (`src/db/repositories/observeWrites.ts`) dans `createAppContainer`, pas par chaque cas d'usage : toute écriture réussie des repositories surveillés (tâches, récurrences, routines, validations, événements, rappels, espaces, réglages `reminders.*` et `general.locale`) et toute transaction réussie, quelle qu'elle soit, déclenche `edit`. Les déclenchements sont coalescés par le coordinateur ; le coût d'un passage inutile sur l'iPhone (quelques lectures) est accepté, une replanification manquée ne l'est pas. Les réglages `notifications.*` ne déclenchent jamais (pas de boucle).

### N1.4 Actions de notification (N-03)

**Types d'action.** Enregistrés à chaque démarrage, avant le premier `show` : `ct.task` et `ct.routine` = `done` « Fait » + `snooze15` « +15 min » ; `ct.event` = `snooze15` seul ; récapitulatif et fin de Focus : aucune catégorie. Toutes avec `foreground: true`.

**Source des actions (port de plateforme).** `NotificationActionSource { start(onAction: (a: RawNotificationAction) => void): Promise<() => void> }` avec `RawNotificationAction = { numericId: number; actionId: 'done' | 'snooze15'; receivedAtMs: number; sid: string | null; deliveredAt: number | null }`. Chemin officiel : écouteur `actionPerformed` inscrit au démarrage de la plateforme ; `tap` et `dismiss` ignorés ; `sid` absent (le plugin ne rend pas `extra`) → résolu par le registre.

**File durable.** Réglage **local** `notifications.actionQueue` :

```ts
interface NotificationActionQueueV1 {
  readonly v: 1;
  readonly entries: readonly { key: string; sid: string | null; numericId: number; action: 'done' | 'snooze15'; receivedAt: IsoDateTime; tries: number; lastError: string | null }[]; // 100 au plus
  readonly applied: readonly { key: string; at: IsoDateTime }[];   // mémoire d'idempotence : 200 au plus, 30 jours
  readonly snoozes: readonly { id: string; originId: string; fireAt: LocalDateTime }[];   // répétitions vivantes
  readonly dropped: number;                                        // entrées écartées faute de place (visible)
}
```

Clé d'idempotence = `{identifiant stable}|{action}|{instant de la notification livrée}` (identifiant stable + action, plus l'occurrence : un « +15 min » sur une notification d'un autre jour du même rappel n'est pas confondu). Une action reçue est **d'abord écrite** dans la file (base ouverte ; avant l'ouverture, tampon mémoire écrit dès l'ouverture), puis appliquée par le passage suivant (`action`). Ordre : `receivedAt`, puis `key`. Application par les cas d'usage seulement : « Fait » tâche = cas d'usage de T-04 (toast « Annuler » 5 s si l'app est au premier plan) ; « Fait » routine = validation R-03 **pour la date d'occurrence** de l'identifiant ; « +15 min » = ajout dans `snoozes` de `snooze:{origine}` (origine d'une répétition de répétition = l'origine première) à `heure locale(receivedAt + 15 min)`, aucune écriture synchronisée. Cible déjà terminée, supprimée ou absente : succès sans effet. Entrée appliquée : retirée, clé ajoutée à `applied`. Échec ou cible introuvable (registre perdu, `sid` inconnu) : l'entrée reste (`tries` + 1, `lastError` = code), bandeau (N1.8), nouvel essai au passage suivant, « Ignorer » dans Réglages > Rappels. File pleine : l'entrée la plus ancienne est écartée et `dropped` incrémenté (visible jusqu'à « Ignorer »).

**« +15 min » dans le plan.** `NotificationPlanInput` reçoit `snoozes: readonly { id; originId; fireAt }[]` ; le planificateur (domaine) rend un `PlannedItem` `kind: 'snooze'` (`category` de l'origine) si `fireAt > now` **et** si la cible de l'origine est vivante (tâche à faire et non supprimée, routine ni archivée ni supprimée et occurrence non validée, événement non supprimé, rappel non supprimé) ; il est trié avec les rappels (rappel avant récapitulatif) et compté dans les 64 sans réserve. Les répétitions mortes ou passées sont purgées de la file par le passage.

**Action à froid : détection et repli.** Constats 9 et 10 : avec le seul plugin officiel, un **appui** ou une **action** sur une notification d'un processus précédent arrête probablement l'app, et une action qui lance l'app est perdue. Décision du 2026-10-07 maintenue (plugin maison sur constat) ; **prévision de l'architecte : échec**. Détection sur l'appareil (A2 de N-03, étendu ; à reporter par le product-owner dans la checklist) : planifier une tâche à +2 min, tuer l'app, puis (a) appui simple sur la notification, (b) « Fait », (c) « +15 min », (d) app relancée par l'icône et notification reçue app ouverte avant toute modification, (e) appui sur une notification déjà livrée avant la relance. **Échec** = l'app se ferme ou repart sans la tâche terminée / la répétition, ou n'applique pas l'action (aucun bandeau ne l'annonce : perte silencieuse). Un seul échec déclenche le repli pour tout le lot (N-01 compris).

**Repli : plugin Swift maison `notification-actions`** (ios-mobile ; contrat fixé ici, peut être préparé sur une branche sans fusion avant le constat). Crate `src-tauri/plugins/notification-actions` (`build.rs` : commandes `drain`, `ack`, `status` ; `ios/` Swift), dépendance et `.plugin(...)` sous `cfg(target_os = "ios")`, **enregistré après** le plugin officiel. Au chargement, il **devient le délégué** de `UNUserNotificationCenter` (réaffirmé à chaque `didBecomeActive`) : `willPresent` → bannière, liste et son, sans table ; `didReceive` → pour `done` et `snooze15`, ajoute une ligne JSON `{ n, a, t, sid, at }` (`sid` et `at` lus dans `userInfo["__EXTRA__"]`) à `Library/Application Support/ct-notification-actions/queue.jsonl` avec `fsync`, puis appelle le gestionnaire de fin. `drain() → { entries, unreadable }` (sans effacer), `ack({ count })` (retire les `count` premières lignes : fichier temporaire puis renommage), `status() → { delegate: boolean }`. Permissions ajoutées à `notifications-ios.json` : `notification-actions:allow-drain`, `allow-ack`, `allow-status`. JS : `NotificationActionSource` natif = `drain` au démarrage et à la reprise → écriture dans la file durable → `ack`. `status().delegate` faux ou lignes illisibles → bandeau. Aucune clé Info.plist. Si A1 de N-01 révèle aussi une notification muette (constat 12), le repli remplace également `show` (contenu avec `UNNotificationSound.default`), avec un nouvel avenant.

### N1.5 Fuseau (N-06)

**Choix : option 3.** Livré : replanification au premier déclencheur (`open`, `resume`, et `zone` par `timeZoneWatcher.onChange`) ; la comparaison par instant (N1.2) suffit à replanifier ; le fuseau du registre (`ledger.zone`) différent du fuseau courant pose `zoneChange` (« Fuseau modifié : rappels recalculés à {heure} » dans Réglages > Rappels), effacé au passage réussi suivant ; `ledger.zone` n'est mis à jour qu'après un `replace` réussi. Fuseau illisible (`zone()` nul) : instants calculés avec le décalage courant du moteur JS (`new Date(a, m, j, h, min)`), passage mené à bout, puis `planFailure` `zone-unknown` visible (« Fuseau de l'appareil illisible : rappels calculés avec le décalage actuel »).

**Limite visible app fermée.** Ligne fixe de Réglages > Rappels sur iPhone : « Après un changement de fuseau, ouvrez CircleTasks : les rappels sont recalculés à l'ouverture. » Entre le voyage et l'ouverture, une notification déjà planifiée sonne à l'ancien instant (constat 2).

**Dette conditionnelle (sans Swift).** Si A2 de N-06 montre un écart gênant pour Ali : passer les rappels au déclencheur calendaire **du plugin officiel**, `schedule: { interval: { interval: { year, month, day, hour, minute } } }` (`UNCalendarNotificationTrigger` en composantes locales, suit le fuseau sans réveil ; l'année rend la répétition unique) ; à vérifier sur l'appareil : retrait de la requête après échéance, heure répétée. Un plugin Swift n'est nécessaire que si ce déclencheur échoue.

### N1.6 Avertissement PC (N-07)

- **Valeur** : `SyncDeviceStatus.lastReadAt` **ne convient pas** (pour un autre appareil c'est `hlcIso(ack_hlc)`, l'heure de sa dernière **écriture** lue). Ajout d'un champ facultatif `publishedSyncAt?: IsoDateTime | null` = `hlcIso(sync_state.last_seen_hlc)` (`lastSyncHlc` du dernier `state.ctx` accepté), posé par `storedDeviceStatuses` pour les autres appareils seulement ; format publié inchangé, aucune migration.
- **Domaine** `src/domain/iphoneReminderWarning.ts` : `warnIphoneReminder({ nowMs, fireAtMs, devices }) → 'none' | 'stale' | 'no-iphone'` (pur). iPhones = `platform === 'ios'`, `self` faux, `seen !== false`. `no-iphone` sans iPhone (ou synchro non configurée). Rappel concerné si `0 < fireAtMs − nowMs < 2 h`. `stale` si aucun iPhone `active` n'a `publishedSyncAt` ≥ `nowMs − (2 h + STATE_REFRESH_MS)` : seuil 2 h 30 sur la valeur publiée (rafraîchie toutes les 30 min au plus), jamais une fausse alerte pour un iPhone synchronisé, au pire 30 min de retard. `forgotten`, `expired`, `corrupt`, `foreign`, `rollback`, `newer-major`, `clock-ahead` : non synchronisé. `fireAtMs` = `fireAtInstant(échéance effective, fuseau du PC)`.
- Le PC ne fait qu'**afficher** (bloc Rappel, détail, Réglages > Rappels) ; aucune planification, aucun appel au plugin, minuterie d'une minute arrêtée au démontage.

### N1.7 Fin de Focus (F-04) et récapitulatifs (N-04)

- `FocusEndScheduler` **inchangé**. Adaptateur iOS `src/platform/focus/tauriFocusEnd.ts` (résolveur `openFocusEndScheduler(runtime, os)` : réel pour (`tauri`, `ios`) seulement), par le pont de `tauriNotifications.ts` : identifiant **1**, `pluginDate(fireAt.getTime(), zone courante)` (constat 7 : même un `Date` doit être écrit en heure murale), pas de catégorie, `sound: 'default'`, `extra: { sid: 'focus:{sessionId}' }` ; `schedule` remplace l'identifiant 1, `cancel(sessionId)` ne le retire que si `ledger.focusEnd.sessionId` correspond ; vérification par `get_pending` ; rejet typé `NotificationSchedulerError`. Le cas d'usage Focus attrape le rejet et écrit `focusEndFailure` (`notifications.status`), effacé au `schedule` ou `cancel` réussi suivant ou à la clôture de la session ; la session continue.
- `replace` et `cancelAll` du plan ne touchent jamais [1 ; 65 535] ; `reservedCount()` compte l'identifiant 1 dans `limit`.
- Récapitulatifs : même adaptateur et même `replace` (`kind: 'recap'`, sans catégorie). Plages silencieuses non appliquées aux récapitulatifs ni à la fin de Focus (déjà dans le planificateur et hors plan).

### N1.8 Aucun échec silencieux

- `AppStatusBanner` n'accepte aujourd'hui que des types fermés : **extension** de `APP_STATUS_PRIORITY` par `remindersTrouble`, placé **après `syncTrouble`, avant `updateRequired`**, posé par `notificationStatus.ts` avec `message` composé, `more` (autres états des rappels) et « Voir » (Réglages > Rappels). Ordre interne : autorisation refusée, autorisation non décidée (bouton « Autoriser », appel de `requestPermission()` sur ce geste), `unavailable` sur iPhone, échec du plan (`planFailure`), fin de Focus, actions en échec ou écartées, `zone-unknown`.
- Réglages > Rappels affiche les mêmes états, plus la couverture (`coverageText` sur `lastSuccess`), `zoneChange`, `ledgerRebuiltAt` et la ligne de limite du fuseau. PC : « Les rappels sont envoyés par l'iPhone » et l'avertissement N-07, jamais de bandeau de planification.

### N1.9 Info.plist, tests et CI

- **Info.plist** : aucune clé, **aucune entrée** dans `scripts/ios/plist-contract.json` (notifications locales ; le repli `notification-actions` n'en ajoute pas non plus).
- **Unitaires (Vitest)** : `notificationInstant.test.ts` (Europe/Paris 2027-03-28 02:30 et 2026-10-25 02:30, America/New_York, Pacific/Auckland, deux valeurs de `TZ`) ; `tauriNotifications.test.ts` avec un faux `invoke` (format exact de `date`, jamais `toISOString`, `show` seul, `cancel` toujours avec liste, `get_pending` relu, codes d'erreur, réaffirmation par processus, registre perdu ou illisible, `ledger-failed`, identifiant 1 intact) ; `notificationRunner.test.ts` (rafale de 20, jamais deux `replace` simultanés) ; `replanNotifications.test.ts`, `notificationStatus.test.ts` (chaque code, redémarrage entre l'échec et la réussite), `notificationActions.test.ts`, `iphoneReminderWarning.test.ts` (bornes), `tauriFocusEnd.test.ts`. **Durcis** : `consistency.test.ts` (motif complété par `plugin:notification` ; seul `tauriNotifications.ts` le nomme ; `Cargo.toml` : `=2.5.1` sous `cfg(target_os = "ios")` ; `lib.rs` : `tauri_plugin_notification` seulement sous ce `cfg` ; capabilities : seule `notifications-ios.json` accorde `notification:`, liste exacte ; `allow-get-active` et `allow-notify` jamais) ; `noNotification.test.ts` : exception limitée au seul `tauriNotifications.ts`, jamais supprimé.
- **Rust** : `tests/desktop/config.rs`, test de la liste exacte des permissions de `notifications-ios.json` (`windows: ["main"]`, `platforms: ["iOS"]`) et absence de `notification:` partout ailleurs.
- **e2e Playwright** projet `iphone` : planificateur et source d'actions injectés en développement seulement (`__ctNotifications`, comme `__ctSync`) ; projet `desktop` : aucun appel. Fichiers `tests/e2e/N-01.spec.ts`, `N-03.spec.ts`, `N-05.spec.ts`, `N-07.spec.ts`, compléments `F-04.spec.ts`.
- **CI `build-ios.yml`** : nouvelle étape « Plugins iOS » : `cargo tree --target aarch64-apple-ios -i tauri-plugin-notification` réussit, `cargo tree --target x86_64-pc-windows-msvc -i tauri-plugin-notification` ne trouve rien (échec explicite sinon) ; contrat Info.plist inchangé ; lancé sur la branche du lot, vert avant fusion.

### N1.10 Rappel ressuscité (N-05)

Avec deux appareils (PC et iPhone, cas du PRD) le cas de `docs/dettes.md` (lot Y2) ne se produit pas. Avec trois appareils ou plus, la ligne `reminder` ressuscitée est **vivante** dans la base de l'appareil : le planificateur la planifie et elle **peut sonner** jusqu'à la lecture de la suppression. Limite visible : le rappel figure dans la ligne « Rappels » de la tâche et peut y être supprimé. Aucun changement au lot N1.

### Fichiers impactés

`src-tauri/Cargo.toml`, `Cargo.lock`, `src/lib.rs`, `capabilities/notifications-ios.json` (nouveau), `tests/desktop/config.rs` ; `src/domain/{notificationInstant,iphoneReminderWarning}.ts` (nouveaux), `notificationPlan.ts` (`snoozes`, `kind: 'snooze'`), `model/settings.ts` (`notifications.ledger`, `notifications.status`, `notifications.actionQueue`, locales), `appStatus.ts` (`remindersTrouble`) ; `src/platform/notifications/{types,fake,unavailable,index,validate,consistency.test}.ts`, `tauriNotifications.ts`, `notificationClock.ts`, `notificationLedger.ts` (nouveaux) ; `src/platform/focus/{index,tauriFocusEnd}.ts` ; `src/platform/sync/types.ts` (`publishedSyncAt`), `src/sync/deviceStatus.ts` ; `src/features/reminders/*` (cas d'usage, store, textes, Réglages > Rappels, avertissement N-07, `noNotification.test.ts`) ; `src/features/app/{container,startup,AppStatusBanner}.ts(x)` ; `src/features/focus/focusActions.ts` ; cas d'usage des tâches, routines, événements, rappels, espaces et récapitulatifs (déclencheur `edit`) ; `src/features/sync/startSync.ts` (`sync`) ; `src/i18n/{fr,en}.notifications.ts` ; `.github/workflows/build-ios.yml` ; `tests/e2e/*`. Repli éventuel : `src-tauri/plugins/notification-actions/`.

### Écarts avec les fiches (à reporter par le product-owner)

1. F-04 critère 11 : « un `Date`, pas de fuseau à convertir » est faux pour ce plugin (constat 7) : l'instant est réécrit en heure murale du fuseau courant.
2. N-01 « ADR requis » point 3 : `AppStatusBanner` n'accepte pas d'autre source ; étendu par `remindersTrouble`.
3. N-01 critère 11 : l'autorisation non décidée produit aussi un bandeau (avec « Autoriser »), pas seulement une invitation dans Réglages.
4. N-06 critère 3 : un fuseau illisible n'est pas un `invalid-request` (refus avant tout effet) mais l'état `zone-unknown`, passage mené avec le décalage courant.
5. N-05 « ADR requis » : la confirmation demandée est fausse avec trois appareils (N1.10).
6. N-07 : `lastReadAt` n'est pas la dernière synchro de l'iPhone ; champ `publishedSyncAt` ajouté ; seuil effectif de 2 h 30 sur la valeur publiée.
7. N-03 point 3 : le fichier d'actions du repli est lu par les commandes Swift `drain` / `ack`, pas par Rust ; le plugin de repli doit **remplacer le délégué** (constat 11) et couvre aussi l'appui simple de N-01 ; la checklist doit ajouter les cas (a), (d), (e) de N1.4.
8. Contrat N-TECH-01 complété : `kind: 'snooze'`, `category`, `reservedCount()`, raison `ledger-failed`.
9. Décision du 2026-10-07 (plugin maison sur constat) : la lecture du code prévoit l'échec (constats 9, 10, 12) ; à Ali de dire s'il valide le repli dès maintenant pour éviter un cycle CI et un passage sur l'appareil.
