import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHlcClock } from '../../domain/hlc';
import { asEntityId, type DeviceId } from '../../domain/types';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { createFakeDesktop, type FakeDesktop } from '../../platform/desktop/testing';
import { createAppContainer, type AppContainer } from '../app/container';
import { quickCaptureStore, type QuickCaptureState } from './quickCaptureStore';
import { DEFAULT_QUICK_CAPTURE_KEYS, createQuickCaptureUseCases } from './quickCaptureUseCases';

const DEVICE = asEntityId<DeviceId>('60000000-0000-4000-8000-0000000000d4');

describe('capture rapide globale (D-04)', () => {
  let db: TestDb;
  let desktop: FakeDesktop;
  let container: AppContainer;
  const store = () => quickCaptureStore.get(container);
  const state = (): QuickCaptureState => store().getState();
  const saved = () => db.data.repos.settings.get('shortcut.quickCapture');

  beforeEach(async () => {
    db = await openTestDb(DEVICE);
    desktop = createFakeDesktop();
    container = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: DEVICE }), data: db.data, desktop });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await db.close();
  });

  it('démarrage : lit le réglage (défaut Ctrl+Alt+Espace) et enregistre auprès du système (critère 9)', async () => {
    await state().init();
    expect(desktop.globalChord).toBe(DEFAULT_QUICK_CAPTURE_KEYS);
    expect(state()).toMatchObject({ loaded: true, keys: 'Ctrl+Alt+Space', status: 'active' });
  });

  it('démarrage : relit la combinaison enregistrée, sans rien enregistrer si désactivée', async () => {
    await createQuickCaptureUseCases(container).save({ enabled: true, keys: 'Ctrl+Shift+Space' });
    await state().init();
    expect(desktop.globalChord).toBe('Ctrl+Shift+Space');
    await db.data.repos.settings.set('shortcut.quickCapture', { enabled: false, keys: 'Alt+F9' });
    desktop.globalChord = null;
    const other = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: DEVICE }), data: db.data, desktop });
    await quickCaptureStore.get(other).getState().init();
    expect(desktop.globalChord).toBeNull();
    expect(quickCaptureStore.get(other).getState()).toMatchObject({ status: 'off', keys: 'Alt+F9' });
  });

  it('démarrage : combinaison prise entre-temps = état « indisponible », l’app reste utilisable (critère 9)', async () => {
    desktop.takenChords.add('Ctrl+Alt+Space');
    await state().init();
    expect(state()).toMatchObject({ status: 'unavailable', keys: 'Ctrl+Alt+Space' });
  });

  it('sans intégration PC (navigateur, iPhone), rien ne se passe', async () => {
    const bare = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: DEVICE }), data: db.data });
    await quickCaptureStore.get(bare).getState().init();
    expect(quickCaptureStore.get(bare).getState().loaded).toBe(false);
  });

  it('une nouvelle combinaison remplace l’ancienne tout de suite et se mémorise (critère 5)', async () => {
    await state().init();
    await state().applyChord('Ctrl+Shift+Space');
    expect(desktop.globalChord).toBe('Ctrl+Shift+Space');
    expect(state()).toMatchObject({ keys: 'Ctrl+Shift+Space', status: 'active', capturing: false, errorKey: null });
    expect(state().announcement).toBe('Capture rapide : Ctrl+Maj+Espace');
    expect(await saved()).toEqual({ enabled: true, keys: 'Ctrl+Shift+Space' });
  });

  it('refuse une combinaison déjà utilisée par l’application, sans appeler le système (critère 6)', async () => {
    await state().init();
    desktop.shortcutCalls.length = 0;
    await state().applyChord('Ctrl+N');
    expect(desktop.shortcutCalls).toEqual([]);
    expect(state()).toMatchObject({ keys: 'Ctrl+Alt+Space', errorKey: 'shortcutsUi.errors.appConflict' });
    expect(desktop.globalChord).toBe('Ctrl+Alt+Space');
  });

  it('refus du système (déjà prise par une autre application) : l’ancienne reste active et le message s’affiche (critère 7)', async () => {
    await state().init();
    desktop.takenChords.add('Ctrl+Shift+Space');
    await state().applyChord('Ctrl+Shift+Space');
    expect(state()).toMatchObject({ keys: 'Ctrl+Alt+Space', status: 'active', errorKey: 'shortcutsUi.errors.inUse' });
    expect(desktop.globalChord).toBe('Ctrl+Alt+Space');
    expect(await saved()).toEqual({ enabled: true, keys: 'Ctrl+Alt+Space' });
  });

  it.each([
    ['reserved', 'shortcutsUi.errors.reserved'],
    ['no-modifier', 'shortcutsUi.errors.noModifier'],
    ['windows-key', 'shortcutsUi.errors.windowsKey'],
    ['syntax', 'shortcutsUi.errors.syntax'],
    ['unavailable', 'shortcutsUi.errors.unavailable'],
  ] as const)('refus « %s » du système : message dédié, rien ne change', async (reason, errorKey) => {
    await state().init();
    desktop.nextRegisterFailure = reason;
    await state().applyChord('Ctrl+Shift+Space');
    expect(state()).toMatchObject({ keys: 'Ctrl+Alt+Space', errorKey });
  });

  it('« Rétablir » remet Ctrl+Alt+Espace (critère 8)', async () => {
    await state().init();
    await state().applyChord('Alt+F9');
    await state().reset();
    expect(desktop.globalChord).toBe('Ctrl+Alt+Space');
    expect(state().keys).toBe('Ctrl+Alt+Space');
    expect(await saved()).toEqual({ enabled: true, keys: 'Ctrl+Alt+Space' });
  });

  it('« Désactiver » retire le raccourci du système, « activer » le rétablit (critère 8)', async () => {
    await state().init();
    await state().setEnabled(false);
    expect(desktop.globalChord).toBeNull();
    expect(state()).toMatchObject({ status: 'off', keys: 'Ctrl+Alt+Space' });
    expect(await saved()).toEqual({ enabled: false, keys: 'Ctrl+Alt+Space' });
    await state().setEnabled(true);
    expect(desktop.globalChord).toBe('Ctrl+Alt+Space');
    expect(state().status).toBe('active');
    expect(state().announcement).toBe('Capture rapide activée : Ctrl+Alt+Espace');
  });

  it('réactivation impossible (combinaison prise) : « indisponible » avec le message', async () => {
    await state().init();
    await state().setEnabled(false);
    desktop.takenChords.add('Ctrl+Alt+Space');
    await state().setEnabled(true);
    expect(state()).toMatchObject({ status: 'unavailable', errorKey: 'shortcutsUi.errors.inUse' });
  });

  it('réglage non écrit : le système revient à l’ancienne combinaison', async () => {
    await state().init();
    vi.spyOn(db.data.repos.settings, 'set').mockRejectedValue(new Error('disque plein'));
    await state().applyChord('Alt+F9');
    expect(desktop.globalChord).toBe('Ctrl+Alt+Space');
    expect(state()).toMatchObject({ keys: 'Ctrl+Alt+Space', errorKey: 'shortcutsUi.settings.saveError' });
  });

  it('capture : Échap annule sans rien changer (critère 10)', async () => {
    await state().init();
    state().beginCapture();
    expect(state()).toMatchObject({ capturing: true, announcement: 'Appuyez sur la nouvelle combinaison' });
    desktop.shortcutCalls.length = 0;
    state().cancelCapture();
    expect(state()).toMatchObject({ capturing: false, keys: 'Ctrl+Alt+Space', errorKey: null, announcement: 'Combinaison inchangée' });
    expect(desktop.shortcutCalls).toEqual([]);
  });

  it('le raccourci global déclenche « Ajout rapide » (Q-01 attendu : champ d’ajout d’Aujourd’hui)', async () => {
    await state().init();
    let presses = 0;
    await desktop.onQuickAdd(() => void presses++);
    desktop.pressGlobalShortcut();
    expect(presses).toBe(1);
    await state().setEnabled(false);
    desktop.pressGlobalShortcut();
    expect(presses).toBe(1);
  });
});
