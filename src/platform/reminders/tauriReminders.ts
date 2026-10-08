import { addPluginListener, invoke } from '@tauri-apps/api/core';
import { isIsoDateTime, isLocalDate, isLocalTime, type IsoDateTime, type LocalTime } from '../../domain/types';
import { REMINDERS_ERROR_CODES, RemindersError, type FetchResult, type ReminderItem, type ReminderList, type RemindersAccess, type RemindersErrorCode, type RemindersPlatform } from './types';

/**
 * Adaptateur iOS des Rappels Apple (K-05 à K-07, ADR 0008 §10.4) : SEUL fichier de `src` qui nomme `plugin:reminders|`. Le plugin Swift
 * `reminders` n'existe que dans le build iOS (cfg Rust, capability `reminders-ios.json`) ; le résolveur ne charge ce fichier que pour
 * (`tauri`, `ios`). Les réponses sont analysées strictement : une réponse inattendue est un échec (`read-failed`), jamais une liste vide ;
 * un rejet est un code du contrat, tout autre rejet devient `store-unavailable`. Le contrat est `tests/fixtures/calendars/reminders-contract.json`.
 */

const PLUGIN = 'plugin:reminders|';
const PLUGIN_NAME = 'reminders';

export type RemindersInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
export type RemindersListen = (event: string, handler: () => void) => Promise<() => void>;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const bad = (): RemindersError => new RemindersError('read-failed');

/** Rejet du plugin (un code en chaîne) → erreur ; tout autre rejet : `store-unavailable`, jamais son texte. */
export function failureOf(error: unknown): RemindersError {
  if (error instanceof RemindersError) return error;
  const text = typeof error === 'string' ? error : error instanceof Error ? error.message : isRecord(error) && typeof error['message'] === 'string' ? error['message'] : '';
  const code = (REMINDERS_ERROR_CODES as readonly string[]).includes(text) ? (text as RemindersErrorCode) : 'store-unavailable';
  return new RemindersError(code);
}

export function parseAccess(value: unknown): RemindersAccess {
  const access = isRecord(value) ? value['access'] : undefined;
  if (access === 'not-determined' || access === 'denied' || access === 'restricted' || access === 'full') return access;
  throw bad();
}

function parseList(value: unknown): ReminderList {
  if (!isRecord(value) || typeof value['id'] !== 'string' || value['id'] === '' || typeof value['name'] !== 'string' || typeof value['writable'] !== 'boolean') throw bad();
  return { id: value['id'], name: value['name'], writable: value['writable'] };
}

const nullableInstant = (value: unknown): IsoDateTime | null => {
  if (value === null) return null;
  if (typeof value === 'string' && isIsoDateTime(value)) return value;
  throw bad();
};

export function parseItem(value: unknown): ReminderItem {
  if (!isRecord(value)) throw bad();
  const { id, externalRef, listId, title, due, completed, completedAt, recurring, modifiedAt, createdAt } = value;
  if (typeof id !== 'string' || id === '' || typeof listId !== 'string' || typeof title !== 'string' || typeof completed !== 'boolean' || typeof recurring !== 'boolean') throw bad();
  if (externalRef !== null && typeof externalRef !== 'string') throw bad();
  let parsedDue: ReminderItem['due'] = null;
  if (due !== null) {
    if (!isRecord(due) || typeof due['date'] !== 'string' || !isLocalDate(due['date'])) throw bad();
    const time = due['time'];
    if (time !== null && !(typeof time === 'string' && isLocalTime(time))) throw bad();
    parsedDue = { date: due['date'], time: time as LocalTime | null };
  }
  return { id, externalRef, listId, title, due: parsedDue, completed, completedAt: nullableInstant(completedAt), recurring, modifiedAt: nullableInstant(modifiedAt), createdAt: nullableInstant(createdAt) };
}

export function parseFetch(value: unknown): FetchResult {
  if (!isRecord(value) || !Array.isArray(value['lists']) || !Array.isArray(value['byId']) || !Array.isArray(value['missing']) || !Array.isArray(value['missingLists'])) throw bad();
  const lists = (value['lists'] as unknown[]).map((entry) => {
    if (!isRecord(entry) || typeof entry['listId'] !== 'string' || !isCount(entry['total']) || !Array.isArray(entry['items'])) throw bad();
    return { listId: entry['listId'], total: entry['total'], items: (entry['items'] as unknown[]).map(parseItem) };
  });
  const strings = (raw: unknown[]): string[] =>
    raw.map((entry) => {
      if (typeof entry !== 'string') throw bad();
      return entry;
    });
  return { lists, byId: (value['byId'] as unknown[]).map(parseItem), missing: strings(value['missing'] as unknown[]), missingLists: strings(value['missingLists'] as unknown[]) };
}

function parseWritten(value: unknown): ReminderItem {
  if (!isRecord(value)) throw bad();
  return parseItem(value['item']);
}

export function createTauriReminders(
  call: RemindersInvoke = (command, args) => invoke(command, args),
  listen: RemindersListen = async (event, handler) => {
    const listener = await addPluginListener(PLUGIN_NAME, event, handler);
    return () => void listener.unregister();
  },
): RemindersPlatform {
  const run = async (command: string, args?: Record<string, unknown>): Promise<unknown> => {
    try {
      return await call(`${PLUGIN}${command}`, args);
    } catch (error) {
      throw failureOf(error);
    }
  };
  return {
    available: true,
    status: async () => parseAccess(await run('status')),
    requestAccess: async () => parseAccess(await run('request_access')),
    lists: async () => {
      const value = await run('lists');
      if (!isRecord(value) || !Array.isArray(value['lists'])) throw bad();
      return (value['lists'] as unknown[]).map(parseList);
    },
    fetch: async (input) =>
      parseFetch(await run('fetch', { listIds: input.listIds, limitPerList: input.limitPerList, ids: input.ids.map((ref) => ({ id: ref.id, externalRef: ref.externalRef })) })),
    upsert: async (input) =>
      parseWritten(await run('upsert', { id: input.id, listId: input.listId, title: input.title, due: input.due === null ? null : { date: input.due.date, time: input.due.time }, completed: input.completed, completedAt: input.completedAt })),
    setCompleted: async (input) => parseWritten(await run('set_completed', { id: input.id, completed: input.completed, completedAt: input.completedAt })),
    delete: async (input) => {
      await run('delete', { id: input.id });
    },
    onChanged: async (listener) => {
      try {
        return await listen('changed', listener);
      } catch (error) {
        throw failureOf(error);
      }
    },
  };
}
