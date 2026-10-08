import { describe, expect, it } from 'vitest';
import { APP_LOCK_EXCURSION_MAX_MS, APP_LOCK_RELOCK_MS, parseAppLockSetting, shouldLock, type AppLockInput } from './appLock';
import { SETTINGS_DEFINITIONS, isSharedSetting } from './model/settings';

const T0 = Date.UTC(2026, 9, 8, 9, 0, 0);
const resume = (over: Partial<AppLockInput>): AppLockInput => ({ enabled: true, state: 'resume', now: T0, backgroundedAt: T0, excursion: null, ...over });

describe('shouldLock (I-03 critère 1, ADR 0013 §2.3)', () => {
  it('constantes : 30 s de reverrouillage, 5 min d’excursion au plus', () => {
    expect(APP_LOCK_RELOCK_MS).toBe(30_000);
    expect(APP_LOCK_EXCURSION_MAX_MS).toBe(300_000);
  });

  it('désactivé : jamais, quel que soit l’état', () => {
    expect(shouldLock({ enabled: false, state: 'cold-start', now: T0, backgroundedAt: null, excursion: null })).toBe(false);
    expect(shouldLock(resume({ enabled: false, backgroundedAt: null }))).toBe(false);
    expect(shouldLock(resume({ enabled: false, now: T0 + 3_600_000 }))).toBe(false);
    expect(shouldLock(resume({ enabled: false, now: T0 - 1 }))).toBe(false);
  });

  it('lancement à froid activé : toujours, même avec une excursion', () => {
    expect(shouldLock({ enabled: true, state: 'cold-start', now: T0, backgroundedAt: null, excursion: null })).toBe(true);
    expect(shouldLock({ enabled: true, state: 'cold-start', now: T0, backgroundedAt: T0 - 1, excursion: { startedAt: T0 - 2 } })).toBe(true);
  });

  it('retour : 29 999 ms non, 30 000 ms oui, au-delà oui', () => {
    expect(shouldLock(resume({ now: T0 }))).toBe(false);
    expect(shouldLock(resume({ now: T0 + 29_000 }))).toBe(false);
    expect(shouldLock(resume({ now: T0 + 29_999 }))).toBe(false);
    expect(shouldLock(resume({ now: T0 + 30_000 }))).toBe(true);
    expect(shouldLock(resume({ now: T0 + 31_000 }))).toBe(true);
  });

  it('retour : passage masqué inconnu ou non fini → verrouille', () => {
    expect(shouldLock(resume({ backgroundedAt: null }))).toBe(true);
    expect(shouldLock(resume({ backgroundedAt: Number.NaN }))).toBe(true);
    expect(shouldLock(resume({ backgroundedAt: Number.POSITIVE_INFINITY }))).toBe(true);
    expect(shouldLock(resume({ now: Number.NaN }))).toBe(true);
  });

  it('horloge qui recule : verrouille, même sous excursion', () => {
    expect(shouldLock(resume({ now: T0 - 1 }))).toBe(true);
    expect(shouldLock(resume({ now: T0 - 1, excursion: { startedAt: T0 - 10 } }))).toBe(true);
  });

  it('excursion couvrant le passage masqué et de moins de 5 min : pas de verrou, même après 30 s', () => {
    const excursion = { startedAt: T0 - 1_000 };
    expect(shouldLock(resume({ now: T0 + 60_000, excursion }))).toBe(false);
    expect(shouldLock(resume({ now: T0 - 1_000 + APP_LOCK_EXCURSION_MAX_MS - 1, excursion }))).toBe(false);
    // Bornes incluses : startedAt = backgroundedAt.
    expect(shouldLock(resume({ now: T0 + 60_000, excursion: { startedAt: T0 } }))).toBe(false);
  });

  it('excursion expirée (≥ 5 min) : règle des 30 s', () => {
    const excursion = { startedAt: T0 - 1_000 };
    expect(shouldLock(resume({ now: T0 - 1_000 + APP_LOCK_EXCURSION_MAX_MS, excursion }))).toBe(true);
    expect(shouldLock(resume({ now: T0 + 3_600_000, excursion }))).toBe(true);
    // Expirée mais retour rapide : pas de verrou (règle des 30 s).
    expect(shouldLock(resume({ now: T0 + 1_000, backgroundedAt: T0, excursion: { startedAt: T0 - APP_LOCK_EXCURSION_MAX_MS } }))).toBe(false);
  });

  it('excursion commencée après le passage masqué, ou non finie : ignorée', () => {
    expect(shouldLock(resume({ now: T0 + 60_000, excursion: { startedAt: T0 + 1 } }))).toBe(true);
    expect(shouldLock(resume({ now: T0 + 60_000, excursion: { startedAt: Number.NaN } }))).toBe(true);
    expect(shouldLock(resume({ now: T0 + 10_000, excursion: { startedAt: T0 + 1 } }))).toBe(false);
  });
});

describe('parseAppLockSetting (I-03 critère 2) : échec fermé', () => {
  it('booléens lus tels quels', () => {
    expect(parseAppLockSetting(true)).toEqual({ enabled: true, unreadable: false });
    expect(parseAppLockSetting(false)).toEqual({ enabled: false, unreadable: false });
  });

  it('absent ou null : désactivé', () => {
    expect(parseAppLockSetting(null)).toEqual({ enabled: false, unreadable: false });
    expect(parseAppLockSetting(undefined)).toEqual({ enabled: false, unreadable: false });
  });

  it('toute autre valeur : activé et illisible', () => {
    for (const raw of ['true', 'false', 1, 0, {}, [], { enabled: false }, Number.NaN, '']) {
      expect(parseAppLockSetting(raw)).toEqual({ enabled: true, unreadable: true });
    }
  });

  it('réglage local, défaut faux, jamais partagé', () => {
    expect(SETTINGS_DEFINITIONS['security.appLock']).toEqual({ scope: 'local', defaultValue: false });
    expect(isSharedSetting('security.appLock')).toBe(false);
  });
});
