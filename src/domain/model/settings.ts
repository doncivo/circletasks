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
  /** P-05. */
  'onboarding.completed': boolean;
  /** D-01 : fermer la fenêtre réduit l'app en zone de notification (PC). */
  'desktop.closeToTray': boolean;
  /** D-02 : démarrage avec Windows, réduit. */
  'desktop.launchAtStartup': boolean;
  /** D-03 : dernière vérification de mise à jour (toutes les 24 h). Pas d'« ignorer cette version » (QB-16). */
  'desktop.updater': { readonly lastCheckAt: IsoDateTime | null };
  /** D-04 : capture rapide globale (PC), combinaison en notation du registre ; local à l'appareil. */
  'shortcut.quickCapture': { readonly enabled: boolean; readonly keys: string };
  /** ADR 0005 : identifiant de cet appareil, créé au premier lancement. */
  'device.id': DeviceId | null;
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
  'desktop.closeToTray': { scope: 'local', defaultValue: true },
  'desktop.launchAtStartup': { scope: 'local', defaultValue: false },
  'desktop.updater': { scope: 'local', defaultValue: { lastCheckAt: null } },
  'shortcut.quickCapture': { scope: 'local', defaultValue: { enabled: true, keys: 'Ctrl+Alt+Space' } },
  'device.id': { scope: 'local', defaultValue: null },
};

/** Valeur par défaut d'un réglage. */
export function defaultSetting<K extends SettingKey>(key: K): SettingsValues[K] {
  return SETTINGS_DEFINITIONS[key].defaultValue;
}

export function isSharedSetting(key: SettingKey): boolean {
  return SETTINGS_DEFINITIONS[key].scope === 'shared';
}
