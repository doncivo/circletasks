import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStatusStore } from '../../app/appStatus';
import { startRemindersLazily } from './loadIntegration';
import type { RemindersIntegration } from './startReminders';
import { setupRemindersHarness, type RemindersHarness } from './testKit';

let h: RemindersHarness;
beforeEach(async () => {
  h = await setupRemindersHarness('27');
});
afterEach(() => h.close());

function documentStub() {
  const listeners = new Set<() => void>();
  const doc = {
    visibilityState: 'visible' as DocumentVisibilityState,
    addEventListener: (_: string, listener: () => void) => void listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => void listeners.delete(listener),
    resume() {
      for (const listener of listeners) listener();
    },
  };
  return doc;
}

const banner = () => useAppStatusStore.getState().sources['appleRemindersTrouble'];

describe('démarrage des Rappels Apple chargé à la demande (revue 4)', () => {
  it('chargement en échec : bandeau « n’ont pas pu démarrer » (texte fixe) ; nouvel essai à la reprise ; le bandeau disparaît au succès', async () => {
    const doc = documentStub();
    const integration: RemindersIntegration = { opened: () => Promise.resolve(), dispose: vi.fn() };
    const start = vi.fn(() => integration);
    const load = vi.fn().mockRejectedValueOnce(new Error('Failed to fetch dynamically imported module: https://secret.example/chunk.js')).mockResolvedValue({ startRemindersIntegration: start });
    const running = startRemindersLazily(h.container, { document: doc as never, load });
    await vi.waitFor(() => expect(banner()).toBeDefined());
    expect(banner()).toMatchObject({ detail: 'start-load-failed', message: 'Les Rappels Apple n’ont pas pu démarrer. Rouvrez l’app pour réessayer.' });
    expect(JSON.stringify(banner()?.message)).not.toContain('secret');
    expect(start).not.toHaveBeenCalled();
    doc.resume();
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(banner()).toBeUndefined());
    // Déjà démarrée : une reprise de plus ne recharge rien.
    doc.resume();
    expect(load).toHaveBeenCalledTimes(2);
    running.dispose();
    expect(integration.dispose).toHaveBeenCalledTimes(1);
  });

  it('démontage pendant le chargement : rien n’est démarré, aucun bandeau', async () => {
    const doc = documentStub();
    let release: (value: { startRemindersIntegration(): RemindersIntegration }) => void = () => undefined;
    const start = vi.fn();
    const running = startRemindersLazily(h.container, { document: doc as never, load: () => new Promise((resolve) => (release = resolve as never)) });
    running.dispose();
    release({ startRemindersIntegration: start as never });
    await Promise.resolve();
    await Promise.resolve();
    expect(start).not.toHaveBeenCalled();
    expect(banner()).toBeUndefined();
  });
});
