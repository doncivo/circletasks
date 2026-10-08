import { afterEach, describe, expect, it, vi } from 'vitest';
import { type createFakeHaptics, createNoopHaptics, openHaptics } from './index';
import { createTauriHaptics } from './tauriHaptics';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('adaptateur Tauri du plugin haptics (ADR 0013 §1.1 et §1.2)', () => {
  it('commandes et arguments du Swift : impact_feedback { style }, notification_feedback { type }, selection_feedback', () => {
    const call = vi.fn(() => Promise.resolve(undefined));
    const haptics = createTauriHaptics(() => undefined, call);
    haptics.impact('medium');
    haptics.notification('success');
    haptics.selection();
    expect(call.mock.calls).toEqual([
      ['plugin:haptics|impact_feedback', { style: 'medium' }],
      ['plugin:haptics|notification_feedback', { type: 'success' }],
      ['plugin:haptics|selection_feedback', undefined],
    ]);
  });

  it('cosmétique : un rejet n’est jamais levé ; journalisé une fois par commande et par processus', async () => {
    const log = vi.fn();
    const haptics = createTauriHaptics(log, () => Promise.reject(new Error('not allowed by ACL')));
    expect(() => {
      haptics.impact('light');
      haptics.impact('heavy');
      haptics.selection();
      haptics.selection();
    }).not.toThrow();
    await flush();
    expect(log.mock.calls.flat()).toEqual(['haptics-failed:impact_feedback', 'haptics-failed:selection_feedback']);
  });

  it('un appel qui lève de façon synchrone est traité comme un rejet', async () => {
    const log = vi.fn();
    const haptics = createTauriHaptics(log, () => {
      throw new Error('window is not defined');
    });
    expect(() => haptics.notification('error')).not.toThrow();
    await flush();
    expect(log).toHaveBeenCalledWith('haptics-failed:notification_feedback');
  });
});

describe('résolveur et implémentations (A-07 critère 14)', () => {
  afterEach(() => {
    delete (globalThis as { __ctHaptics?: unknown }).__ctHaptics;
    delete (globalThis as { __ctHapticsFake?: unknown }).__ctHapticsFake;
  });

  it('PC et navigateur : implémentation vide, ne fait rien et ne lève rien', () => {
    for (const [runtime, os] of [['tauri', 'windows'], ['web', 'ios'], ['web', 'other']] as const) {
      const haptics = openHaptics(runtime, os, { log: () => undefined });
      expect(() => {
        haptics.impact('light');
        haptics.notification('warning');
        haptics.selection();
      }).not.toThrow();
    }
    expect(() => createNoopHaptics().impact('heavy')).not.toThrow();
  });

  it('faux : enregistre les appels ; développement : __ctHapticsFake l’expose en __ctHaptics', () => {
    (globalThis as { __ctHapticsFake?: boolean }).__ctHapticsFake = true;
    const haptics = openHaptics('web', 'other', { log: () => undefined });
    haptics.impact('light');
    haptics.notification('success');
    haptics.selection();
    expect((globalThis as { __ctHaptics?: ReturnType<typeof createFakeHaptics> }).__ctHaptics?.calls).toEqual([
      { type: 'impact', style: 'light' },
      { type: 'notification', kind: 'success' },
      { type: 'selection' },
    ]);
  });
});
