import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogJournal } from './buffer';
import { createMemoryLogTransport } from './memory';
import { LOG_BATCH_SIZE, LOG_BUFFER_SIZE, LOG_FLUSH_MS } from './types';

/** Document et fenêtre minimaux : visibilité pilotée par le test. */
function fakeEnv() {
  const listeners = new Map<string, (() => void)[]>();
  const on = (type: string, listener: () => void): void => {
    listeners.set(type, [...(listeners.get(type) ?? []), listener]);
  };
  const doc = { visibilityState: 'visible' as DocumentVisibilityState, addEventListener: on };
  const win = { addEventListener: on };
  const fire = (type: string): void => {
    for (const listener of listeners.get(type) ?? []) listener();
  };
  return { doc, win, fire };
}

describe('I-04 : tampon et vidage du journal (ADR 0014 §3)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-08T08:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function journalOn(transport = createMemoryLogTransport()) {
    const env = fakeEnv();
    const journal = createLogJournal(transport, { document: env.doc as unknown as Document, window: env.win as unknown as Window });
    return { journal, transport, env };
  }

  it('critère 3 : logFailure -> tampon, vidé vers log_append dans les 2 s, relu après redémarrage (même fichier)', async () => {
    const { journal, transport } = journalOn();
    journal.record('sync', 'sync-now {"reason":"open"}');
    expect(transport.stored).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(LOG_FLUSH_MS);
    expect(transport.stored).toEqual([{ at: '2026-10-08T08:00:00.000Z', scope: 'sync', code: 'sync-now', detail: '{"reason":"open"}' }]);
    journal.dispose();
    // Redémarrage simulé (ou restauration de la base : le journal n'est pas dans la base) : un nouveau journal relit le même fichier.
    const { journal: again } = journalOn(transport);
    expect(await again.read()).toEqual(transport.stored);
    again.dispose();
  });

  it('vidage au passage en arrière-plan et à pagehide', async () => {
    const { journal, transport, env } = journalOn();
    journal.record('backup-daily', new Error('sauvegarde : io'));
    env.doc.visibilityState = 'hidden';
    env.fire('visibilitychange');
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.stored).toHaveLength(1);
    journal.record('export-save', 'unsafe-folder');
    env.fire('pagehide');
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.stored).toHaveLength(2);
    journal.dispose();
  });

  it('lots de 100 au plus ; entrées identiques consécutives fusionnées (n)', async () => {
    const { journal, transport } = journalOn();
    const append = vi.spyOn(transport, 'append');
    for (let i = 0; i < 250; i += 1) journal.record('sync', `cycle-${String(i)}`);
    journal.record('sync', 'cycle-249');
    await journal.flush();
    expect(append.mock.calls.map(([batch]) => batch.length)).toEqual([LOG_BATCH_SIZE, LOG_BATCH_SIZE, 50]);
    expect(transport.stored.at(-1)).toMatchObject({ code: 'cycle-249', n: 2 });
    journal.dispose();
  });

  it('critère 10 : échec d’écriture visible (code), lot gardé et réessayé ; message effacé à la prochaine écriture réussie', async () => {
    const { journal, transport } = journalOn();
    const changes = vi.fn();
    journal.subscribe(changes);
    transport.failAppend('disk-full');
    journal.record('sync', 'sync-now');
    await journal.flush();
    expect(journal.status()).toEqual({ writeError: 'disk-full', readError: null });
    expect(changes).toHaveBeenCalledTimes(1);
    // Les entrées de la session restent lisibles depuis le tampon.
    transport.failRead('unreadable');
    expect((await journal.read()).map((entry) => entry.code)).toEqual(['sync-now']);
    expect(journal.status().readError).toBe('unreadable');
    transport.failRead(null);
    transport.failAppend(null);
    await vi.advanceTimersByTimeAsync(LOG_FLUSH_MS);
    expect(transport.stored.map((entry) => entry.code)).toEqual(['sync-now']);
    expect(journal.status().writeError).toBeNull();
    await journal.read();
    expect(journal.status()).toEqual({ writeError: null, readError: null });
    journal.dispose();
  });

  it('tampon circulaire de 500 entrées', async () => {
    const { journal, transport } = journalOn();
    transport.failAppend('io');
    for (let i = 0; i < LOG_BUFFER_SIZE + 20; i += 1) journal.record('sync', `e${String(i)}`);
    transport.failRead('io');
    const entries = await journal.read();
    expect(entries).toHaveLength(LOG_BUFFER_SIZE);
    expect(entries[0]?.code).toBe('e20');
    journal.dispose();
  });

  it('critère 8 : effacer vide le journal ; logs-cleared est la première entrée du nouveau journal', async () => {
    const { journal, transport } = journalOn();
    journal.record('sync', 'a');
    await journal.flush();
    await journal.clear();
    expect((await journal.read()).map((entry) => entry.code)).toEqual(['logs-cleared']);
    expect(transport.stored).toHaveLength(1);
    journal.dispose();
  });

  it('sans transport (fenêtre Focus du PC) : session seule, aucun état d’échec', async () => {
    const journal = createLogJournal(null, { document: null, window: null });
    journal.record('focus', 'x');
    expect(journal.persistent).toBe(false);
    expect((await journal.read()).map((entry) => entry.code)).toEqual(['x']);
    expect(journal.status()).toEqual({ writeError: null, readError: null });
    journal.dispose();
  });
});
