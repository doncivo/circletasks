import type { SettingsValues, ThemeChoice } from '../../domain/model';
import type { RecapSettings } from '../../domain/recap';
import type { SpaceFilter } from '../../domain/types';
import { DEFAULT_TIME_FORMAT, TIME_FORMATS, type TimeFormat } from '../../domain/timeFormat';
import { DEFAULT_FIRST_WEEKDAY, FIRST_WEEKDAYS, type FirstWeekday } from '../../domain/week';
import type { AppContainer } from '../app/container';
import { parseThemeChoice } from './theme';

/** A-06 / SD-04 : écran dont la vue compacte est mémorisée (réglage local `view.compact`). */
export type CompactViewScreen = keyof SettingsValues['view.compact'];

/** Réglages lus par l'écran Réglages (T-06, A-03, N-04). */
export interface SettingsSnapshot {
  readonly carryOverUndone: boolean;
  readonly hideRoutines: boolean;
  readonly recaps: RecapSettings;
}

/**
 * Cas d'usage des réglages : seul point d'écriture de la table `settings` pour les stores d'écran (Réglages, Routines, Plus tard,
 * Aujourd'hui, Listes) et pour le filtre d'espace. Les stores gardent l'état affiché, l'optimisme et le retour en arrière ; ces cas
 * d'usage ne font que lire et écrire. Contrat : chaque méthode rejette si la base échoue (l'appelant décide du message).
 */
export interface SettingsUseCases {
  /** T-06, A-03, N-04 : valeurs affichées par l'écran Réglages. */
  load(): Promise<SettingsSnapshot>;
  /** T-06 : `tasks.carryOverUndone` (partagé). */
  setCarryOverUndone(value: boolean): Promise<void>;
  /** A-03 : `today.hideRoutines` (partagé). */
  setHideRoutines(value: boolean): Promise<void>;
  /** N-04 : récapitulatifs déjà validés (`validateRecapSettings`) ; matin puis soir. */
  saveRecaps(recaps: RecapSettings): Promise<void>;
  /** D-02 : miroir local `desktop.launchAtStartup` du choix « Démarrer avec Windows ». */
  setLaunchAtStartupMirror(value: boolean): Promise<void>;
  /** D-02 critère 6 : réaligne le miroir local sur l'état réel de l'entrée système (écrit seulement s'il diffère). */
  syncLaunchAtStartupMirror(actual: boolean): Promise<void>;
  /** A-06 / SD-04 : vue compacte d'un écran, les autres écrans gardent leur valeur. */
  setCompactView(screen: CompactViewScreen, compact: boolean): Promise<void>;
  /** ES-03 : filtre Pro / Perso / Tout mémorisé par appareil (`spaces.filter`, local). */
  saveSpaceFilter(filter: SpaceFilter): Promise<void>;
  // --- M12 apparence et formats (P-03) ---
  /** P-03 : premier jour de semaine et format d'heure (partagés). */
  loadFormats(): Promise<FormatSettings>;
  setFirstWeekday(value: FirstWeekday): Promise<void>;
  setTimeFormat(value: TimeFormat): Promise<void>;
  // --- fin M12 apparence et formats ---
  // --- M12 thème (P-02) ---
  /** P-02 : thème de cet appareil (`ui.theme`, local). */
  loadTheme(): Promise<ThemeChoice>;
  setTheme(value: ThemeChoice): Promise<void>;
  // --- fin M12 thème ---
}

/** P-03 : réglages d'affichage de la date et de l'heure. */
export interface FormatSettings {
  readonly firstWeekday: FirstWeekday;
  readonly timeFormat: TimeFormat;
}

export type SettingsDeps = Pick<AppContainer, 'data'>;

export function createSettingsUseCases(deps: SettingsDeps): SettingsUseCases {
  const settings = () => deps.data.repos.settings;
  return {
    async load() {
      const [carryOverUndone, hideRoutines, morning, evening] = await Promise.all([
        settings().get('tasks.carryOverUndone'),
        settings().get('today.hideRoutines'),
        settings().get('reminders.morningRecap'),
        settings().get('reminders.eveningRecap'),
      ]);
      return { carryOverUndone, hideRoutines, recaps: { morning, evening } };
    },
    async setCarryOverUndone(value) {
      await settings().set('tasks.carryOverUndone', value);
    },
    async setHideRoutines(value) {
      await settings().set('today.hideRoutines', value);
    },
    async saveRecaps(recaps) {
      await settings().set('reminders.morningRecap', recaps.morning);
      await settings().set('reminders.eveningRecap', recaps.evening);
    },
    async setLaunchAtStartupMirror(value) {
      await settings().set('desktop.launchAtStartup', value);
    },
    async syncLaunchAtStartupMirror(actual) {
      if (actual !== (await settings().get('desktop.launchAtStartup'))) await settings().set('desktop.launchAtStartup', actual);
    },
    async setCompactView(screen, compact) {
      const stored = await settings().get('view.compact');
      await settings().set('view.compact', { ...stored, [screen]: compact });
    },
    async saveSpaceFilter(filter) {
      await settings().set('spaces.filter', filter);
    },
    // --- M12 apparence et formats (P-03) ---
    async loadFormats() {
      const [firstWeekday, timeFormat] = await Promise.all([settings().get('general.firstWeekday'), settings().get('general.timeFormat')]);
      return {
        firstWeekday: FIRST_WEEKDAYS.includes(firstWeekday) ? firstWeekday : DEFAULT_FIRST_WEEKDAY,
        timeFormat: TIME_FORMATS.includes(timeFormat) ? timeFormat : DEFAULT_TIME_FORMAT,
      };
    },
    async setFirstWeekday(value) {
      await settings().set('general.firstWeekday', value);
    },
    async setTimeFormat(value) {
      await settings().set('general.timeFormat', value);
    },
    // --- fin M12 apparence et formats ---
    // --- M12 thème (P-02) ---
    async loadTheme() {
      return parseThemeChoice(await settings().get('ui.theme'));
    },
    async setTheme(value) {
      await settings().set('ui.theme', value);
    },
    // --- fin M12 thème ---
  };
}
