import { expect, type Page } from '@playwright/test';
import type { RemindersAccess, ReminderItem } from '../../../src/platform/reminders';
import { openCalendarsScreen } from './calendars';
import { openToday } from './today';

/**
 * Aides e2e des Rappels Apple (K-05 à K-07) : le faux EventKit (`src/platform/reminders/fakeReminders.ts`) est exposé en développement
 * seulement par `globalThis.__ctRemindersFake = true` (posé avant le chargement de la page), puis piloté depuis le test par
 * `globalThis.__ctReminders` : listes, rappels, modifications « faites dans Rappels », pannes, journal des écritures. Aucun compte réel.
 */

/** Annonce le faux magasin AVANT le chargement de la page (iPhone). Le projet `pc` ne l'annonce jamais : les Rappels y sont en lecture seule. */
export async function useFakeReminders(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (globalThis as { __ctRemindersFake?: boolean }).__ctRemindersFake = true;
  });
}

export interface RemindersApi {
  addList(id: string, name: string, writable?: boolean): Promise<void>;
  add(input: { id?: string; listId: string; title: string; due?: { date: string; time: string | null } | null; completed?: boolean; recurring?: boolean }): Promise<ReminderItem>;
  edit(id: string, patch: { title?: string; due?: { date: string; time: string | null } | null; completed?: boolean }): Promise<void>;
  remove(id: string): Promise<void>;
  get(id: string): Promise<ReminderItem | null>;
  all(): Promise<ReminderItem[]>;
  writes(): Promise<{ kind: string; id: string; title?: string }[]>;
  setAccess(access: RemindersAccess): Promise<void>;
  failNext(command: string, code: string, times?: number): Promise<void>;
  emitChanged(): Promise<void>;
}

export function remindersOf(page: Page): RemindersApi {
  const arg = (value: unknown): string => JSON.stringify(value);
  const invoke = <T>(method: string, ...args: unknown[]): Promise<T> =>
    page.evaluate(`(async () => { const fake = globalThis.__ctReminders; if (!fake) throw new Error('faux magasin absent'); const out = fake.${method}(...${arg(args)}); return out === undefined ? null : JSON.parse(JSON.stringify(out)); })()`) as Promise<T>;
  return {
    addList: (id, name, writable = true) => invoke('addList', { id, name, writable }),
    add: (input) => invoke('add', input),
    edit: (id, patch) => invoke('edit', id, patch),
    remove: (id) => invoke('remove', id),
    get: (id) => invoke('get', id),
    all: () => invoke('all'),
    writes: () => page.evaluate(`JSON.parse(JSON.stringify(globalThis.__ctReminders.writes))`) as Promise<{ kind: string; id: string; title?: string }[]>,
    setAccess: (access) => invoke('setAccess', access),
    failNext: (command, code, times = 1) => invoke('failNext', command, code, times),
    emitChanged: () => invoke('emitChanged'),
  };
}

/** Attend que le faux soit exposé (page chargée) et prêt. */
export async function waitForFake(page: Page): Promise<RemindersApi> {
  await expect.poll(() => page.evaluate(() => (globalThis as { __ctReminders?: unknown }).__ctReminders !== undefined)).toBe(true);
  return remindersOf(page);
}

/** Aujourd'hui + écran Agendas d'un iPhone muni du faux : liste prête à être lue. */
export async function openRemindersScreen(page: Page): Promise<RemindersApi> {
  await openToday(page);
  const api = await waitForFake(page);
  return api;
}

export { openCalendarsScreen };

/** Date locale du navigateur à `offset` jours d'aujourd'hui, au format ISO. */
export async function localDate(page: Page, offset = 0): Promise<string> {
  return page.evaluate((days) => {
    const date = new Date();
    date.setDate(date.getDate() + days);
    const pad = (n: number): string => String(n).padStart(2, '0');
    return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }, offset);
}
