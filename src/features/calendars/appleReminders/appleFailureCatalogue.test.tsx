import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appReload } from '../../security/lockLayer';
import * as systemSettings from '../../../platform/systemSettings';
import { APPLE_FAILURE_ACTIONS, APPLE_FAILURE_CODES, type AppleFailureAction } from '../../../domain/appleFailures';
import { REMINDERS_ERROR_CODES } from '../../../platform/reminders';
import { en } from '../../../i18n/en';
import { fr } from '../../../i18n/fr';
import { AppContainerProvider } from '../../app/AppContainerContext';
import { mockViewport } from '../../today/testKit';
import { AppleRemindersSection } from './AppleRemindersSection';
import { appleRemindersState } from './appleRemindersState';
import { setupRemindersHarness, type RemindersHarness } from './testKit';

/** Aucune impasse : tout code d'échec d'un passage a un texte français et anglais ET au moins un geste utile à l'écran. */
let h: RemindersHarness | undefined;
afterEach(async () => {
  if (h !== undefined) await h.close();
  h = undefined;
});

describe('catalogue des échecs (revue : aucune impasse)', () => {
  it('chaque code (codes du plugin compris) a un texte FR et EN et au moins une action', () => {
    for (const code of REMINDERS_ERROR_CODES) expect(APPLE_FAILURE_CODES, code).toContain(code);
    for (const code of APPLE_FAILURE_CODES) {
      const key = code as keyof typeof fr.appleReminders.failureCode;
      expect(fr.appleReminders.failureCode[key], code).toEqual(expect.any(String));
      expect(en.appleReminders.failureCode[key as keyof typeof en.appleReminders.failureCode], code).toEqual(expect.any(String));
      expect(APPLE_FAILURE_ACTIONS[code].length, code).toBeGreaterThan(0);
    }
  });

  it('à l’écran, chaque échec montre son texte et son geste', async () => {
    mockViewport(390);
    const harness = await setupRemindersHarness('31');
    h = harness;
    const labels: Record<AppleFailureAction, string> = { retry: 'Réessayer', 'detach-unlisted': 'Détacher les tâches de ces listes', 'reset-lists': 'Réinitialiser le réglage des listes', 'choose-lists': 'Choisir les listes', 'ios-settings': 'Ouvrir les réglages', 'reopen-app': 'Relancer', ignore: 'Ignorer' };
    for (const code of APPLE_FAILURE_CODES) {
      if (code === 'access-denied') continue; // couvert par l'état d'accès refusé ci-dessous (la lecture de l'accès efface cet échec quand il est rétabli)
      await appleRemindersState(harness.container).fail(code);
      const view = render(
        <AppContainerProvider container={harness.container}>
          <AppleRemindersSection />
        </AppContainerProvider>,
      );
      const text = fr.appleReminders.failureCode[code as keyof typeof fr.appleReminders.failureCode];
      expect(await screen.findByText(text, { exact: false }), code).toBeInTheDocument();
      for (const action of APPLE_FAILURE_ACTIONS[code] as readonly AppleFailureAction[]) {
        const buttons = screen.getAllByRole('button', { name: labels[action] });
        expect(buttons.length, `${code} ${action}`).toBeGreaterThan(0);
        expect(buttons.some((button) => !(button as HTMLButtonElement).disabled), `${code} ${action} actif`).toBe(true);
      }
      view.unmount();
    }
  });
});

describe('chaque geste agit (revue : aucune impasse)', () => {
  it('un échec déterministe ne propose jamais seulement « Réessayer »', () => {
    for (const code of ['recurring-refused', 'invalid-input', 'not-found', 'list-not-found', 'read-only-list'] as const) {
      expect((APPLE_FAILURE_ACTIONS[code] as readonly AppleFailureAction[]).some((action) => action !== 'retry'), code).toBe(true);
    }
  });

  async function show(code: string) {
    mockViewport(390);
    const harness = await setupRemindersHarness('32');
    h = harness;
    await appleRemindersState(harness.container).fail(code);
    render(
      <AppContainerProvider container={harness.container}>
        <AppleRemindersSection />
      </AppContainerProvider>,
    );
    return harness;
  }

  it('« Ouvrir les réglages » ouvre les réglages d’iOS (accès refusé aussi), « Relancer » relance l’app, « Ignorer » efface l’échec', async () => {
    const reload = vi.spyOn(appReload, 'run').mockImplementation(() => undefined);
    const harness = await show('start-load-failed');
    fireEvent.click(await screen.findByRole('button', { name: 'Relancer' }));
    expect(reload).toHaveBeenCalledTimes(1);
    await appleRemindersState(harness.container).fail('invalid-input');
    fireEvent.click(await screen.findByRole('button', { name: 'Ignorer' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Ignorer' })).not.toBeInTheDocument());
    vi.restoreAllMocks();
  });

  it('accès refusé dans iOS : le bouton « Ouvrir les réglages » est actif et ouvre les réglages', async () => {
    const open = vi.spyOn(systemSettings, 'openAppSettings').mockResolvedValue(undefined);
    mockViewport(390);
    const harness = await setupRemindersHarness('33');
    h = harness;
    harness.reminders.setAccess('denied');
    render(
      <AppContainerProvider container={harness.container}>
        <AppleRemindersSection />
      </AppContainerProvider>,
    );
    const button = await screen.findByRole('button', { name: 'Ouvrir les réglages' });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    vi.restoreAllMocks();
  });
});
