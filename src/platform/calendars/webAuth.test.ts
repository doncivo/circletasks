import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock, isTauri: () => true }));

import { createMemoryCalendarPlatform } from './memory';
import { createTauriCalendarPlatform, toPlatformError } from './tauriCalendars';
import { CalendarPlatformError, isWebAuthFailure, simulatorEndpoints } from './types';

/** K-TECH-01 : codes de la feuille d'authentification web de l'iPhone, de Rust à l'interface (ADR 0008 §9.3). */
describe('codes web-auth', () => {
  beforeEach(() => invokeMock.mockReset());

  it('les rejets de Rust deviennent leur code ; un rejet inattendu reste « unsupported », jamais son texte', () => {
    for (const code of ['web-auth-unavailable', 'web-auth-failed', 'cancelled', 'state-mismatch', 'config-missing', 'network'] as const) {
      expect(toPlatformError(code).code).toBe(code);
    }
    expect(toPlatformError('https://accounts.google.com/?code=secret').code).toBe('unsupported');
    expect(toPlatformError('https://accounts.google.com/?code=secret').message).not.toContain('secret');
  });

  it("la commande d'autorisation de Google rejette avec le code reçu, sur tous les systèmes", async () => {
    const platform = createTauriCalendarPlatform();
    invokeMock.mockRejectedValueOnce('web-auth-failed');
    await expect(platform.oauth.authorizeGoogle('circletasks.calendar.google.a')).rejects.toMatchObject({ code: 'web-auth-failed' });
    invokeMock.mockRejectedValueOnce('web-auth-unavailable');
    await expect(platform.oauth.authorizeGoogle('circletasks.calendar.google.a')).rejects.toMatchObject({ code: 'web-auth-unavailable' });
    invokeMock.mockResolvedValueOnce(null);
    await expect(platform.oauth.authorizeGoogle('circletasks.calendar.google.a')).resolves.toBeUndefined();
    expect(invokeMock).toHaveBeenLastCalledWith('calendar_oauth_google_authorize', { tokenRef: 'circletasks.calendar.google.a' });
  });

  it('isWebAuthFailure ne reconnaît que les deux codes de la feuille', () => {
    expect(isWebAuthFailure('web-auth-failed')).toBe(true);
    expect(isWebAuthFailure('web-auth-unavailable')).toBe(true);
    for (const code of ['cancelled', 'config-missing', 'unsupported', 'network'] as const) expect(isWebAuthFailure(code)).toBe(false);
  });

  it("le coffre mémoire injecte l'échec après le contrôle de configuration, comme Rust", async () => {
    const endpoints = simulatorEndpoints('http://127.0.0.1:9', 'http://127.0.0.1:9');
    const configured = createMemoryCalendarPlatform(endpoints, { googleClientId: 'sim', webAuthFailure: () => 'web-auth-unavailable' });
    await expect(configured.oauth.authorizeGoogle('circletasks.calendar.google.a')).rejects.toEqual(new CalendarPlatformError('web-auth-unavailable'));
    const unconfigured = createMemoryCalendarPlatform(endpoints, { webAuthFailure: () => 'web-auth-unavailable' });
    await expect(unconfigured.oauth.authorizeGoogle('circletasks.calendar.google.a')).rejects.toEqual(new CalendarPlatformError('config-missing'));
  });
});
