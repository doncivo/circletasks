import type { IsoDateTime } from '../../domain/types';
import { MAX_REMINDERS_PER_LIST } from '../../domain/appleReminders';
import {
  RemindersError,
  type FetchInput,
  type FetchResult,
  type ReminderDue,
  type ReminderItem,
  type ReminderList,
  type RemindersAccess,
  type RemindersErrorCode,
  type RemindersPlatform,
  type UpsertInput,
} from './types';

/**
 * Magasin EventKit en mémoire et plateforme qui le sert (K-05 à K-07, ADR 0008 §10.4) : listes, rappels, modification, achèvement,
 * suppression, événement `changed`, accès, pannes injectées, journal des appels et des ÉCRITURES. Il applique les mêmes refus que le
 * plugin Swift (accès, liste absente ou en lecture seule, rappel récurrent, entrée invalide) et rend, comme lui, l'élément relu après
 * une écriture. Utilisé par Vitest et par les tests de bout en bout (injecté en `globalThis.__ctReminders`, développement seulement).
 * Jamais chargé dans l'app installée.
 */

export interface FakeRemindersCall {
  readonly name: string;
  readonly args?: unknown;
}

/** Écriture reçue par le magasin (jamais une lecture) : sert à prouver « aucun appel d'écriture ». */
export interface FakeRemindersWrite {
  readonly kind: 'create' | 'update' | 'complete' | 'delete';
  readonly id: string;
  readonly at: IsoDateTime;
  readonly title?: string;
  readonly due?: ReminderDue | null;
  readonly completed?: boolean;
  readonly completedAt?: IsoDateTime | null;
}

export type FakeCommand = 'status' | 'requestAccess' | 'lists' | 'fetch' | 'upsert' | 'setCompleted' | 'delete';

export interface NewFakeReminder {
  readonly id?: string;
  readonly listId: string;
  readonly title: string;
  readonly due?: ReminderDue | null;
  readonly completed?: boolean;
  readonly completedAt?: IsoDateTime | null;
  readonly recurring?: boolean;
  readonly externalRef?: string | null;
}

export interface FakeRemindersOptions {
  /** Instant courant (ms) : `modifiedAt` et `createdAt`. Défaut : l'horloge système. */
  readonly now?: () => number;
  readonly access?: RemindersAccess;
  /** Réponse à `requestAccess` (la fenêtre iOS) : `full` si acceptée. */
  readonly onRequest?: RemindersAccess;
  readonly lists?: readonly ReminderList[];
}

export interface FakeReminders extends RemindersPlatform {
  readonly calls: FakeRemindersCall[];
  readonly writes: FakeRemindersWrite[];
  setAccess(access: RemindersAccess): void;
  setRequestAnswer(access: RemindersAccess): void;
  addList(list: ReminderList): void;
  removeList(id: string): void;
  renameList(id: string, name: string): void;
  setWritable(id: string, writable: boolean): void;
  /** Rappel ajouté dans l'app Rappels (pas un appel de la plateforme : aucune écriture journalisée). */
  add(input: NewFakeReminder): ReminderItem;
  /** Modification faite dans l'app Rappels : `modifiedAt` avance. */
  edit(id: string, patch: { readonly title?: string; readonly due?: ReminderDue | null; readonly completed?: boolean; readonly listId?: string; readonly recurring?: boolean }): ReminderItem;
  remove(id: string): void;
  get(id: string): ReminderItem | undefined;
  all(): ReminderItem[];
  /** Déclenche `changed` chez les abonnés. */
  emitChanged(): void;
  /** La prochaine commande de ce nom rejette avec ce code (`times` fois, défaut une). */
  failNext(command: FakeCommand, code: RemindersErrorCode, times?: number): void;
  /** Nombre d'écouteurs `changed` actifs. */
  listenerCount(): number;
}

function iso(ms: number): IsoDateTime {
  return new Date(ms).toISOString() as IsoDateTime;
}

export function createFakeReminders(options: FakeRemindersOptions = {}): FakeReminders {
  const now = options.now ?? (() => Date.now());
  let access: RemindersAccess = options.access ?? 'full';
  let requestAnswer: RemindersAccess = options.onRequest ?? 'full';
  const lists = new Map<string, ReminderList>((options.lists ?? []).map((list) => [list.id, list]));
  const items = new Map<string, ReminderItem>();
  const listeners = new Set<() => void>();
  const failures = new Map<FakeCommand, { code: RemindersErrorCode; times: number }>();
  const calls: FakeRemindersCall[] = [];
  const writes: FakeRemindersWrite[] = [];
  let counter = 0;

  const nextId = (): string => `R-${String(++counter).padStart(4, '0')}`;
  const record = (name: FakeCommand, args?: unknown): void => {
    calls.push(args === undefined ? { name } : { name, args });
    const failure = failures.get(name);
    if (failure) {
      failure.times -= 1;
      if (failure.times <= 0) failures.delete(name);
      throw new RemindersError(failure.code);
    }
  };
  const requireFull = (): void => {
    if (access !== 'full') throw new RemindersError('access-denied');
  };
  const sortKey = (item: ReminderItem): string => (item.due ? `0|${item.due.date}|${item.due.time ?? '00:00'}` : '1|');
  const ordered = (listId: string): ReminderItem[] =>
    [...items.values()]
      .filter((item) => item.listId === listId && !item.completed)
      .sort((a, b) => {
        const byDue = sortKey(a).localeCompare(sortKey(b));
        if (byDue !== 0) return byDue;
        const byCreation = (a.createdAt ?? '').localeCompare(b.createdAt ?? '');
        return byCreation !== 0 ? byCreation : a.id.localeCompare(b.id);
      });
  const changed = (): void => {
    for (const listener of [...listeners]) listener();
  };
  const write = (entry: FakeRemindersWrite): void => {
    writes.push(entry);
  };

  /** Exécute la commande ; un refus devient un rejet de la promesse (jamais une exception synchrone, comme le plugin). */
  const attempt = <T>(body: () => T): Promise<T> => {
    try {
      return Promise.resolve(body());
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new RemindersError('store-unavailable'));
    }
  };

  const platform: FakeReminders = {
    available: true,
    calls,
    writes,

    status() {
      return attempt(() => {
        record('status');
        return access;
      });
    },
    requestAccess() {
      return attempt(() => {
        record('requestAccess');
        if (access === 'not-determined') access = requestAnswer;
        return access;
      });
    },
    lists() {
      return attempt(() => {
        record('lists');
        requireFull();
        return [...lists.values()].map((list) => ({ ...list }));
      });
    },
    fetch(input: FetchInput) {
      return attempt(() => {
        record('fetch', input);
        requireFull();
        if (input.limitPerList < 1 || input.limitPerList > 5000) throw new RemindersError('invalid-input');
        const missingLists: string[] = [];
        const result: { listId: string; total: number; items: ReminderItem[] }[] = [];
        for (const listId of input.listIds) {
          if (!lists.has(listId)) {
            missingLists.push(listId);
            continue;
          }
          const all = ordered(listId);
          result.push({ listId, total: all.length, items: all.slice(0, Math.min(input.limitPerList, MAX_REMINDERS_PER_LIST * 10)) });
        }
        const byId: ReminderItem[] = [];
        const missing: string[] = [];
        const scope = new Set(input.scopeListIds ?? input.listIds);
        for (const ref of input.ids) {
          const found = items.get(ref.id) ?? (ref.externalRef === null ? undefined : [...items.values()].find((item) => item.externalRef === ref.externalRef));
          if (found) byId.push(scope.has(found.listId) ? found : { id: found.id, listId: found.listId, externalRef: null, title: '', due: null, completed: false, completedAt: null, recurring: false, modifiedAt: null, createdAt: null });
          else missing.push(ref.id);
        }
        const value: FetchResult = { lists: result, byId, missing, missingLists };
        return value;
      });
    },
    upsert(input: UpsertInput) {
      return attempt(() => {
        record('upsert', input);
        requireFull();
        const title = input.title.trim();
        if (title === '') throw new RemindersError('invalid-input');
        let item: ReminderItem;
        if (input.id === null) {
          const list = lists.get(input.listId);
          if (!list) throw new RemindersError('list-not-found');
          if (!list.writable) throw new RemindersError('read-only-list');
          const id = nextId();
          item = {
            id,
            externalRef: `EXT-${id}`,
            listId: list.id,
            title,
            due: input.due,
            completed: input.completed,
            completedAt: input.completed ? (input.completedAt ?? iso(now())) : null,
            recurring: false,
            modifiedAt: iso(now()),
            createdAt: iso(now()),
          };
          write({ kind: 'create', id, at: iso(now()), title, due: input.due, completed: input.completed });
        } else {
          const existing = items.get(input.id);
          if (!existing) throw new RemindersError('not-found');
          if (existing.recurring) throw new RemindersError('recurring-refused');
          if (!lists.get(existing.listId)?.writable) throw new RemindersError('read-only-list');
          item = { ...existing, title, due: input.due, completed: input.completed, completedAt: input.completed ? (input.completedAt ?? existing.completedAt ?? iso(now())) : null, modifiedAt: iso(now()) };
          write({ kind: 'update', id: existing.id, at: iso(now()), title, due: input.due, completed: input.completed });
        }
        items.set(item.id, item);
        changed();
        return item;
      });
    },
    setCompleted(input) {
      return attempt(() => {
        record('setCompleted', input);
        requireFull();
        const existing = items.get(input.id);
        if (!existing) throw new RemindersError('not-found');
        if (existing.recurring) throw new RemindersError('recurring-refused');
        if (!lists.get(existing.listId)?.writable) throw new RemindersError('read-only-list');
        const item: ReminderItem = { ...existing, completed: input.completed, completedAt: input.completed ? (input.completedAt ?? iso(now())) : null, modifiedAt: iso(now()) };
        items.set(item.id, item);
        write({ kind: 'complete', id: item.id, at: iso(now()), completed: input.completed, completedAt: item.completedAt });
        changed();
        return item;
      });
    },
    delete(input) {
      return attempt(() => {
        record('delete', input);
        requireFull();
        const existing = items.get(input.id);
        if (!existing) return;
        if (existing.recurring) throw new RemindersError('recurring-refused');
        if (!lists.get(existing.listId)?.writable) throw new RemindersError('read-only-list');
        items.delete(input.id);
        write({ kind: 'delete', id: input.id, at: iso(now()) });
        changed();
      });
    },
    onChanged(listener) {
      listeners.add(listener);
      return Promise.resolve(() => void listeners.delete(listener));
    },

    setAccess(next) {
      access = next;
    },
    setRequestAnswer(next) {
      requestAnswer = next;
    },
    addList(list) {
      lists.set(list.id, { ...list });
    },
    removeList(id) {
      lists.delete(id);
      for (const [key, item] of [...items]) if (item.listId === id) items.delete(key);
    },
    renameList(id, name) {
      const list = lists.get(id);
      if (list) lists.set(id, { ...list, name });
    },
    setWritable(id, writable) {
      const list = lists.get(id);
      if (list) lists.set(id, { ...list, writable });
    },
    add(input) {
      const id = input.id ?? nextId();
      const item: ReminderItem = {
        id,
        externalRef: input.externalRef === undefined ? `EXT-${id}` : input.externalRef,
        listId: input.listId,
        title: input.title,
        due: input.due ?? null,
        completed: input.completed ?? false,
        completedAt: input.completed ? (input.completedAt ?? iso(now())) : null,
        recurring: input.recurring ?? false,
        modifiedAt: iso(now()),
        createdAt: iso(now()),
      };
      items.set(id, item);
      return item;
    },
    edit(id, patch) {
      const existing = items.get(id);
      if (!existing) throw new Error(`rappel inconnu : ${id}`);
      const completed = patch.completed ?? existing.completed;
      const item: ReminderItem = {
        ...existing,
        title: patch.title ?? existing.title,
        due: patch.due === undefined ? existing.due : patch.due,
        listId: patch.listId ?? existing.listId,
        recurring: patch.recurring ?? existing.recurring,
        completed,
        completedAt: completed ? (existing.completedAt ?? iso(now())) : null,
        modifiedAt: iso(now()),
      };
      items.set(id, item);
      return item;
    },
    remove(id) {
      items.delete(id);
    },
    get: (id) => items.get(id),
    all: () => [...items.values()],
    emitChanged: changed,
    failNext(command, code, times = 1) {
      failures.set(command, { code, times });
    },
    listenerCount: () => listeners.size,
  };
  return platform;
}
