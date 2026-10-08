import type { Page } from '@playwright/test';

/**
 * Aides e2e des rappels (N-01, N-05, F-04) : le planificateur est le FAUX testé, posé en développement seulement par
 * `globalThis.__ctNotificationsFake = true` (et `__ctFocusEndFake` pour la fin de Focus), puis lu depuis la page.
 */
export interface FakeRequest {
  readonly id: string;
  readonly fireAt: string;
  readonly title: string;
  readonly body: string;
  readonly kind: string;
  readonly category?: string;
}

export interface FakeNotificationHooks {
  readonly calls: { type: string; requests?: FakeRequest[] }[];
  setPermission(value: string): void;
}

/** Action reçue telle que l'écrit le plugin dans son fichier (N-03). */
export interface FakeRawAction {
  readonly numericId: number;
  readonly actionId: 'done' | 'snooze15';
  readonly receivedAtMs: number;
  readonly sid: string | null;
  readonly deliveredAt: number | null;
}

/** Faux de la source d'actions (`__ctNotificationActionsFake`) : le fichier natif en mémoire. */
export interface FakeActionHooks {
  readonly file: FakeRawAction[];
  readonly calls: string[];
  registered: readonly { id: string; actions: readonly { id: string; title: string; foreground: boolean }[] }[];
  push(action: FakeRawAction, options?: { wake?: boolean }): void;
  failNext(command: 'registerActionTypes' | 'drain' | 'ack' | 'status'): void;
  setDelegate(value: boolean): void;
}

export interface FakeFocusEndCall {
  readonly type: 'schedule' | 'cancel';
  readonly sessionId: string;
  readonly fireAt?: string;
  readonly title?: string;
}

export interface FakeFocusEndHooks {
  readonly calls: FakeFocusEndCall[];
  failNext(error: Error): void;
}

declare global {
  interface Window {
    __ctNotifications?: FakeNotificationHooks;
    __ctNotificationActions?: FakeActionHooks;
    __ctFocusEnd?: FakeFocusEndHooks;
  }
}

/** Requêtes de tâche du dernier `replace` du faux planificateur. */
export const taskRequests = (page: Page): Promise<FakeRequest[]> =>
  page.evaluate(() => {
    const replaces = (window.__ctNotifications?.calls ?? []).filter((call) => call.type === 'replace');
    return (replaces.at(-1)?.requests ?? []).filter((request) => request.kind === 'task');
  });

/** Retour au premier plan : relance un passage de replanification (`resume`). */
export const resumeApp = (page: Page): Promise<void> => page.evaluate(() => void document.dispatchEvent(new Event('visibilitychange')));

/** Requêtes d'une nature (task, snooze…) du dernier `replace` du faux planificateur. */
export const requestsOfKind = (page: Page, kind: string): Promise<FakeRequest[]> =>
  page.evaluate((wanted) => {
    const replaces = (window.__ctNotifications?.calls ?? []).filter((call) => call.type === 'replace');
    return (replaces.at(-1)?.requests ?? []).filter((request) => request.kind === wanted);
  }, kind);

/** Action « Fait » ou « +15 min » écrite par le plugin pour la notification `sid` (réveille l'app comme le fait le natif). */
export const pushAction = (page: Page, actionId: 'done' | 'snooze15', sid: string, options: { wake?: boolean } = {}): Promise<void> =>
  page.evaluate(
    ([action, id, opts]) => {
      const now = Date.now();
      window.__ctNotificationActions?.push({ numericId: 70_001, actionId: action, receivedAtMs: now, sid: id, deliveredAt: now - 30_000 }, opts);
    },
    [actionId, sid, options] as const,
  );
