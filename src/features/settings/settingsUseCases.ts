import type { SettingsValues } from '../../domain/model';
import type { RecapSettings } from '../../domain/recap';
import type { SpaceFilter } from '../../domain/types';
import type { AppContainer } from '../app/container';

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
  };
}
