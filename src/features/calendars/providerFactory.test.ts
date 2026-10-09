import { describe, expect, it, vi } from 'vitest';

/**
 * Audit B3 : un fournisseur dont le code ne se charge pas n'est ni « réseau » ni silencieux : résultat `unavailable` (état « Indisponible » du compte),
 * journal à code fixe (jamais le message de l'erreur, qui peut nommer une URL).
 */
vi.mock('./providers/google', () => {
  throw new Error('Failed to fetch dynamically imported module: https://secret.example/google.js');
});

describe('fournisseur non chargeable (audit B3)', () => {
  it('rend `unavailable` et journalise un code fixe', async () => {
    const log = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { createProviderFor } = await import('./providerFactory');
    const provider = createProviderFor({ provider: 'google', tokenRef: 'circletasks.calendar.google.x', username: '' }, {} as never, () => 0, () => 'UTC');
    expect(await provider.listCalendars()).toEqual({ ok: false, error: { kind: 'unavailable' } });
    expect(await provider.fetchEvents('c', { fromUtc: '2026-10-01T00:00:00.000Z', toUtc: '2026-10-02T00:00:00.000Z' } as never, null)).toEqual({ ok: false, error: { kind: 'unavailable' } });
    const written = JSON.stringify(log.mock.calls);
    expect(written).toContain('provider-load-failed');
    expect(written).not.toContain('secret.example');
    log.mockRestore();
  });
});
