import type { AppleCreateSetting, AppleListsSetting, ApplePending } from '../appleReminders';
import type { FocusDuration } from '../focusSession';
import type { OnboardingStepId, SampleIds } from '../onboarding';
import type { DeviceId, IsoDateTime, LocalTime, SpaceFilter, SpaceId } from '../types';
import type { ReminderOffsetMin } from './reminder';
import type { TabsConfig } from '../tabs';
import type { TimeFormat } from '../timeFormat';
import type { FirstWeekday } from '../week';

/** P-02 : choix de thème. */
export type ThemeChoice = 'system' | 'light' | 'dark';

/**
 * Réglages typés (table `settings` : key TEXT unique, value JSON).
 *
 * - `shared` : préférence partagée entre appareils, synchronisée (PRD 6 : thème,
 *   espaces, premier jour…) ; la ligne porte updated_at, device_id et hlc ;
 * - `local` : propre à l'appareil, jamais envoyé dans les journaux de synchro.
 *
 * Ajouter un réglage : une entrée dans `SettingsValues` ET dans `SETTINGS_DEFINITIONS`
 * (le typage l'impose). Une clé absente en base vaut sa valeur par défaut ; une clé
 * inconnue lue en base (version plus récente) est conservée telle quelle (Y-07).
 */
export interface SettingsValues {
  /** T-06 : report automatique à 00:00 des tâches non faites. */
  'tasks.carryOverUndone': boolean;
  /** A-03 : masquer les routines dans la liste du jour. */
  'today.hideRoutines': boolean;
  /** A-06 / SD-04 : vue compacte mémorisée par écran. */
  'view.compact': { readonly today: boolean; readonly routines: boolean; readonly checklists: boolean; readonly someday: boolean };
  /** RC-04 : dix dernières recherches validées (la plus récente en premier) ; propre à l'appareil, jamais synchronisée ni partagée. */
  'search.recent': readonly string[];
  /** ES-03 : dernier filtre choisi (mémorisé par appareil). */
  'spaces.filter': SpaceFilter;
  /** ES-02 : espace des nouveaux éléments quand le filtre vaut « Tout ». */
  'spaces.defaultSpaceId': SpaceId | null;
  /** N-02 : avances proposées par défaut à la création (sous-ensemble de REMINDER_OFFSETS_MIN). */
  'reminders.defaultOffsets': readonly ReminderOffsetMin[];
  /** N-04 : récapitulatif du matin (liste du jour). */
  'reminders.morningRecap': { readonly enabled: boolean; readonly time: LocalTime };
  /** N-04 : récapitulatif du soir (non fait). */
  'reminders.eveningRecap': { readonly enabled: boolean; readonly time: LocalTime };
  /** P-03 / ADR 0003. */
  'general.locale': 'fr' | 'en';
  /** P-03 : premier jour de la semaine affichée (Semaine, mini-calendriers, carte de chaleur) ; partagé. Objectifs, rapport et R-07 restent au lundi. */
  'general.firstWeekday': FirstWeekday;
  /** P-03 : format d'affichage des heures (les valeurs stockées restent 'HH:mm', 24 h). */
  'general.timeFormat': TimeFormat;
  /** P-02 : thème de cet appareil (un PC et un iPhone peuvent différer). */
  'ui.theme': ThemeChoice;
  /** P-01 : onglets de cet appareil : ordre (identifiants) et onglets masqués. Identifiants inconnus ignorés, nouveaux onglets ajoutés à la fin. */
  'ui.tabs': TabsConfig;
  /** Ancien réglage partagé, remplacé par `ui.theme` (local, P-02 D1) ; non utilisé. */
  'general.theme': 'system' | 'light' | 'dark';
  /** E-03 : calendriers de jours fériés activés (France, Tunisie), tous deux par défaut ; partagé entre appareils. */
  'holidays.countries': { readonly FR: boolean; readonly TN: boolean };
  /** T-11 : dernier fuseau IANA détecté sur cet appareil (affiché dans Réglages). */
  'general.timeZone': string | null;
  /** P-05 : l'assistant de premier lancement est terminé ou passé (jamais rouvert tout seul) ; local. */
  'onboarding.completed': boolean;
  /** P-05 critère 10 : étape en cours de l'assistant, pour le rouvrir là après une interruption ; null hors assistant. */
  'onboarding.step': OnboardingStepId | null;
  /** P-05 critère 6 : éléments créés par « Ajouter des données d'exemple » (pour « Supprimer les données d'exemple »). */
  'sample.ids': SampleIds;
  /** D-01 : fermer la fenêtre réduit l'app en zone de notification (PC). */
  'desktop.closeToTray': boolean;
  /** D-02 : démarrage avec Windows, réduit. */
  'desktop.launchAtStartup': boolean;
  /** D-03 : dernière vérification de mise à jour (toutes les 24 h). Pas d'« ignorer cette version » (QB-16). */
  'desktop.updater': { readonly lastCheckAt: IsoDateTime | null };
  /** D-04 : capture rapide globale (PC), combinaison en notation du registre ; local à l'appareil. */
  'shortcut.quickCapture': { readonly enabled: boolean; readonly keys: string };
  /** F-01 critère 12 : dernière durée de session choisie (minutes ; null = « Libre »), propre à l'appareil. */
  'focus.lastDuration': FocusDuration;
  /** F-04 : son de fin de session (Réglages › TÂCHES), propre à l'appareil, activé par défaut. */
  'focus.endSound': boolean;
  /** F-01 critère 3 : position de la mini-fenêtre Focus du PC (pixels physiques), propre à l'appareil. */
  'focus.windowPosition': { readonly x: number; readonly y: number } | null;
  /** ADR 0005 : identifiant de cet appareil, créé au premier lancement. */
  'device.id': DeviceId | null;
  /**
   * N-01 (ADR 0012 avenant N1.2) : registre local des notifications planifiées sur cet iPhone (identifiants, instants, empreintes, aucun
   * titre). Valeur BRUTE : lue par `parseNotificationLedger` (une valeur illisible fait tout replanifier une fois) ; jamais synchronisée.
   */
  'notifications.ledger': unknown;
  /** N-01 (avenant N1.3) : état persistant des rappels (autorisation, dernière planification, échecs). Valeur BRUTE lue par `parseNotificationStatus` ; locale. */
  'notifications.status': unknown;
  /** N-03 (avenant N3.4) : file durable des actions « Fait » et « +15 min » reçues de la notification, répétitions vivantes. Valeur BRUTE lue par `parseActionQueue` ; locale, jamais synchronisée. */
  'notifications.actionQueue': unknown;
  /** K-05 (ADR 0008 §10.3) : listes Rappels choisies, avec leur espace et leur nom lisible sur le PC ; partagé. Valeur à relire par `parseAppleLists`. */
  'appleReminders.lists': AppleListsSetting;
  /** K-06 : création dans Rappels par espace (désactivée par défaut) ; partagé. Valeur à relire par `parseAppleCreate`. */
  'appleReminders.create': AppleCreateSetting;
  /** K-05 critère 14, K-07 : dernière lecture réussie de Rappels par l'iPhone (une écriture au plus tous les 15 min) ; partagé. */
  'appleReminders.lastPassAt': IsoDateTime | null;
  /** K-06 critère 8, K-07 critère 8 : écritures dues vers Rappels (nombre et heure), publié par l'iPhone ; partagé. */
  'appleReminders.pending': ApplePending | null;
  /** ADR 0008 §10.3 : échec persistant, plafonds, suppressions retenues, liens inconnus, messages ; LOCAL. Valeur BRUTE lue par `parseAppleStatus` ; jamais de titre. */
  'appleReminders.status': unknown;
  /**
   * I-03 (ADR 0013 §2.3) : verrouillage de l'app par Face ID ou code de l'iPhone. Valeur BRUTE lue par `parseAppLockSetting` (illisible :
   * verrouillé, échec fermé) ; locale, jamais synchronisée ni observée par la replanification.
   */
  'security.appLock': unknown;
  /** I-02 (ADR 0013 §3.3) : dernière date d'expiration lue, échec, alerte en attente. Valeur BRUTE lue par `parseSigningStatus` ; locale. */
  'notifications.signing': unknown;
}

export type SettingKey = keyof SettingsValues;
export type SettingScope = 'local' | 'shared';

export interface SettingDefinition<K extends SettingKey> {
  readonly scope: SettingScope;
  readonly defaultValue: SettingsValues[K];
}

export const SETTINGS_DEFINITIONS: { readonly [K in SettingKey]: SettingDefinition<K> } = {
  'tasks.carryOverUndone': { scope: 'shared', defaultValue: true },
  'today.hideRoutines': { scope: 'shared', defaultValue: false },
  'view.compact': { scope: 'local', defaultValue: { today: false, routines: false, checklists: false, someday: false } },
  'search.recent': { scope: 'local', defaultValue: [] },
  'spaces.filter': { scope: 'local', defaultValue: 'all' },
  'spaces.defaultSpaceId': { scope: 'shared', defaultValue: null },
  'reminders.defaultOffsets': { scope: 'shared', defaultValue: [0] },
  'reminders.morningRecap': { scope: 'shared', defaultValue: { enabled: true, time: '07:30' as LocalTime } },
  'reminders.eveningRecap': { scope: 'shared', defaultValue: { enabled: true, time: '21:00' as LocalTime } },
  'general.locale': { scope: 'shared', defaultValue: 'fr' },
  'general.firstWeekday': { scope: 'shared', defaultValue: 'monday' },
  'general.timeFormat': { scope: 'shared', defaultValue: '24h' },
  'ui.theme': { scope: 'local', defaultValue: 'system' },
  'ui.tabs': { scope: 'local', defaultValue: { order: [], hidden: [] } },
  'general.theme': { scope: 'shared', defaultValue: 'system' },
  'holidays.countries': { scope: 'shared', defaultValue: { FR: true, TN: true } },
  'general.timeZone': { scope: 'local', defaultValue: null },
  'onboarding.completed': { scope: 'local', defaultValue: false },
  'onboarding.step': { scope: 'local', defaultValue: null },
  'sample.ids': { scope: 'local', defaultValue: { tasks: [], routines: [], checklists: [] } },
  'desktop.closeToTray': { scope: 'local', defaultValue: true },
  'desktop.launchAtStartup': { scope: 'local', defaultValue: false },
  'desktop.updater': { scope: 'local', defaultValue: { lastCheckAt: null } },
  'shortcut.quickCapture': { scope: 'local', defaultValue: { enabled: true, keys: 'Ctrl+Alt+Space' } },
  'focus.lastDuration': { scope: 'local', defaultValue: 25 },
  'focus.endSound': { scope: 'local', defaultValue: true },
  'focus.windowPosition': { scope: 'local', defaultValue: null },
  'device.id': { scope: 'local', defaultValue: null },
  'notifications.ledger': { scope: 'local', defaultValue: null },
  'notifications.status': { scope: 'local', defaultValue: null },
  'notifications.actionQueue': { scope: 'local', defaultValue: null },
  'appleReminders.lists': { scope: 'shared', defaultValue: { lists: [] } },
  'appleReminders.create': { scope: 'shared', defaultValue: { bySpace: [] } },
  'appleReminders.lastPassAt': { scope: 'shared', defaultValue: null },
  'appleReminders.pending': { scope: 'shared', defaultValue: null },
  'appleReminders.status': { scope: 'local', defaultValue: null },
  'security.appLock': { scope: 'local', defaultValue: false },
  'notifications.signing': { scope: 'local', defaultValue: null },
};

/** Valeur par défaut d'un réglage. */
export function defaultSetting<K extends SettingKey>(key: K): SettingsValues[K] {
  return SETTINGS_DEFINITIONS[key].defaultValue;
}

export function isSharedSetting(key: SettingKey): boolean {
  return SETTINGS_DEFINITIONS[key].scope === 'shared';
}
