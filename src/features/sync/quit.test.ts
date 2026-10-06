// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHlcClock } from '../../domain/hlc';
import { asEntityId, type DeviceId } from '../../domain/types';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { createFakeDesktop, type FakeDesktop } from '../../platform/desktop/testing';
import { createAppContainer, type AppContainer } from '../app/container';
import { startDesktopIntegration } from '../app/desktop';
import { startSyncIntegration } from './startSync';
import { createFakeSyncService, type FakeSyncService } from './testKit';

/**
 * « Quitter » sur PC (Y-02 critère 1, ADR 0011 section 10.1 ; revue Y2 point 17) : le dernier cycle passe par le planificateur
 * (`beforeQuit`), 4,5 s au plus ; son minuteur est annulé dès que le cycle finit (aucun minuteur en double ni oublié).
 */

const SELF = asEntityId<DeviceId>('60000000-0000-4000-8000-0000000000d1');

let db: TestDb;
let sync: FakeSyncService;
let desktop: FakeDesktop;
let container: AppContainer;
const disposers: (() => void)[] = [];

beforeEach(async () => {
  db = await openTestDb(SELF, '2026-10-05T08:00:00.000Z');
  sync = createFakeSyncService({ phase: 'idle' });
  desktop = createFakeDesktop();
  container = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: SELF }), data: db.data, sync, desktop });
});

afterEach(async () => {
  for (const dispose of disposers.splice(0)) dispose();
  vi.useRealTimers();
  await db.close();
});

const fakeDocument = { visibilityState: 'visible', addEventListener: () => undefined, removeEventListener: () => undefined } as unknown as Document;

function start(): void {
  disposers.push(startSyncIntegration(container, { document: fakeDocument, setInterval: () => 0, clearInterval: () => undefined }).dispose);
  disposers.push(startDesktopIntegration(container).dispose);
  // `onQuitting` est appelé de façon synchrone par `startDesktopIntegration` (le faux pose son gestionnaire aussitôt) : aucune attente par sondage.
  expect(desktop.quittingHandler).not.toBeNull();
}

describe('« Quitter » : dernier cycle par le planificateur (revue Y2, point 17)', () => {
  it('cycle rapide : la sortie est confirmée sans attendre et aucun minuteur ne reste armé', async () => {
    start();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const before = vi.getTimerCount();
    await desktop.emitQuitting();
    expect(desktop.quitConfirmed).toBe(true);
    expect(sync.calls).toEqual(['open', 'quit']);
    expect(vi.getTimerCount()).toBe(before);
  });

  it('cycle bloqué : la sortie est confirmée à 4,5 s, pas avant', async () => {
    start();
    sync.hold = true;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const quitting = desktop.emitQuitting();
    await vi.advanceTimersByTimeAsync(4_499);
    expect(desktop.quitConfirmed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await quitting;
    expect(desktop.quitConfirmed).toBe(true);
    expect(sync.calls.filter((r) => r === 'quit')).toHaveLength(1);
    sync.release();
  });
});
