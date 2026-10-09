import type { OsFamily, Runtime } from '../runtime';
import { createFakeReminders, type FakeReminders } from './fakeReminders';
import { RemindersError, type RemindersPlatform } from './types';
import { createUnavailableReminders } from './unavailableReminders';

export * from './types';
export { createFakeReminders, type FakeReminders, type FakeRemindersWrite, type FakeRemindersCall, type NewFakeReminder, type FakeRemindersOptions } from './fakeReminders';
export { createUnavailableReminders } from './unavailableReminders';

/**
 * Résolveur (ADR 0008 §10.4) : l'adaptateur du plugin Swift pour (`tauri`, `ios`) seulement, chargé à la demande ; l'implémentation
 * « indisponible » partout ailleurs (PC, navigateur de développement, Playwright, Vitest) : aucun appel de plugin, les Rappels n'arrivent
 * sur PC que par la synchro.
 *
 * En développement seulement (`import.meta.env.DEV`, absent d'un build), un test de bout en bout peut poser `globalThis.__ctReminders`
 * (plateforme injectée) ou `globalThis.__ctRemindersFake = true` (le faux testé de `fakeReminders.ts`, exposé ensuite en
 * `globalThis.__ctReminders` pour que le test pilote le magasin), avant le chargement de la page.
 */
export function openRemindersPlatform(runtime: Runtime, os: OsFamily): RemindersPlatform {
  if (import.meta.env.DEV) {
    const scope = globalThis as { __ctReminders?: RemindersPlatform | FakeReminders; __ctRemindersFake?: boolean };
    if (!scope.__ctReminders && scope.__ctRemindersFake === true) scope.__ctReminders = createFakeReminders();
    if (scope.__ctReminders) return scope.__ctReminders;
  }
  if (runtime === 'tauri' && os === 'ios') return createLazyReminders();
  return createUnavailableReminders();
}

/** Charge l'adaptateur à la première utilisation ; un chargement impossible rejette `store-unavailable` (visible), jamais un silence. */
function createLazyReminders(): RemindersPlatform {
  let loaded: Promise<RemindersPlatform> | null = null;
  const real = (): Promise<RemindersPlatform> => {
    loaded ??= import('./tauriReminders').then(
      (module) => module.createTauriReminders(),
      () => {
        loaded = null;
        throw new RemindersError('store-unavailable');
      },
    );
    return loaded;
  };
  return {
    available: true,
    status: () => real().then((platform) => platform.status()),
    requestAccess: () => real().then((platform) => platform.requestAccess()),
    lists: () => real().then((platform) => platform.lists()),
    fetch: (input) => real().then((platform) => platform.fetch(input)),
    upsert: (input) => real().then((platform) => platform.upsert(input)),
    setCompleted: (input) => real().then((platform) => platform.setCompleted(input)),
    delete: (input) => real().then((platform) => platform.delete(input)),
    onChanged: (listener) => real().then((platform) => platform.onChanged(listener)),
  };
}
