import { addPluginListener, invoke } from '@tauri-apps/api/core';
import { NOTIFICATION_ACTION_IDS, type RawNotificationAction } from '../../domain/notificationActions';
import { NotificationActionSourceError, type ActionDrain, type ActionSourceStatus, type NotificationActionSource } from './actions';

/**
 * Source des actions sur l'iPhone (N-03, ADR 0012 avenant N3.2) : SEUL fichier de `src` qui nomme `plugin:notification-actions|`.
 * Le plugin Swift `notification-actions` n'existe que dans le build iOS (cfg Rust, capability `notifications-ios.json`) ; le résolveur
 * ne charge ce fichier que pour (`tauri`, `ios`). Les réponses sont analysées strictement : une réponse inattendue est un échec
 * (`bad-response`), jamais une file vide.
 */

const PLUGIN = 'plugin:notification-actions|';
const PLUGIN_NAME = 'notification-actions';

export type ActionsInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
export type ActionsListen = (event: string, handler: () => void) => Promise<() => void>;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;

/** Plugin absent ou commande refusée par la capability : l'état du système. */
const UNAVAILABLE_MESSAGE = /window is not defined|__TAURI|reading 'invoke'|not allowed|plugin .*not found|command .*not found|not registered|unknown command|no such plugin/i;

function failureOf(error: unknown): NotificationActionSourceError {
  if (error instanceof NotificationActionSourceError) return error;
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return new NotificationActionSourceError(UNAVAILABLE_MESSAGE.test(message) ? 'unavailable' : 'rejected');
}

/** Une ligne du fichier natif (`{ n, a, t, sid, at }`) ou null si elle ne respecte pas le format. */
function parseLine(value: unknown): RawNotificationAction | null {
  if (!isRecord(value)) return null;
  const { n, a, t, sid, at } = value;
  if (typeof n !== 'number' || !Number.isInteger(n)) return null;
  if (typeof a !== 'string' || !(NOTIFICATION_ACTION_IDS as readonly string[]).includes(a)) return null;
  if (typeof t !== 'number' || !Number.isFinite(t)) return null;
  if (sid !== null && typeof sid !== 'string') return null;
  if (at !== null && (typeof at !== 'number' || !Number.isFinite(at))) return null;
  return { numericId: n, actionId: a as RawNotificationAction['actionId'], receivedAtMs: t, sid: sid === '' ? null : sid, deliveredAt: at };
}

export function parseDrain(value: unknown): ActionDrain {
  if (!isRecord(value) || !Array.isArray(value['entries']) || !isCount(value['lines']) || !isCount(value['unreadable']) || !isCount(value['writeFailures'])) {
    throw new NotificationActionSourceError('bad-response');
  }
  const entries: RawNotificationAction[] = [];
  let unreadable = value['unreadable'];
  for (const line of value['entries'] as unknown[]) {
    const parsed = parseLine(line);
    if (parsed === null) unreadable += 1;
    else entries.push(parsed);
  }
  // Une entrée rejetée ici était physiquement dans le fichier : elle compte déjà dans `lines`, pas dans `unreadable` du natif.
  return { entries, lines: value['lines'], unreadable, writeFailures: value['writeFailures'] };
}

export function createTauriNotificationActionSource(
  call: ActionsInvoke = (command, args) => invoke(command, args),
  listen: ActionsListen = async (event, handler) => {
    const listener = await addPluginListener(PLUGIN_NAME, event, handler);
    return () => void listener.unregister();
  },
): NotificationActionSource {
  const run = async (command: string, args?: Record<string, unknown>): Promise<unknown> => {
    try {
      return await call(`${PLUGIN}${command}`, args);
    } catch (error) {
      throw failureOf(error);
    }
  };
  return {
    registerActionTypes: async (types) => {
      await run('register_action_types', { types: types.map((type) => ({ id: type.id, actions: type.actions.map((action) => ({ id: action.id, title: action.title, foreground: action.foreground })) })) });
    },
    drain: async () => parseDrain(await run('drain')),
    ack: async ({ lines, writeFailures }) => {
      await run('ack', { count: lines, writeFailures });
    },
    status: async (): Promise<ActionSourceStatus> => {
      const value = await run('status');
      if (!isRecord(value) || typeof value['delegate'] !== 'boolean' || typeof value['delegateAtLaunch'] !== 'boolean' || !isCount(value['categories'])) throw new NotificationActionSourceError('bad-response');
      return { delegate: value['delegate'], delegateAtLaunch: value['delegateAtLaunch'], categories: value['categories'] };
    },
    onWake: async (listener) => {
      try {
        return await listen('action', listener);
      } catch (error) {
        throw failureOf(error);
      }
    },
  };
}
