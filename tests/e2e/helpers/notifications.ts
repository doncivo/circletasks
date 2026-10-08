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
}

export interface FakeNotificationHooks {
  readonly calls: { type: string; requests?: FakeRequest[] }[];
  setPermission(value: string): void;
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
