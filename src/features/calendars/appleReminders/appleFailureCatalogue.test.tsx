import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
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
    const labels = { retry: 'Réessayer', 'detach-unlisted': 'Détacher les tâches de ces listes', 'reset-lists': 'Réinitialiser le réglage des listes', 'choose-lists': 'Choisir les listes' } as const;
    for (const code of APPLE_FAILURE_CODES) {
      if (code === 'access-denied') continue; // état d'accès : bloc dédié (« Autorisez-le dans Réglages d’iOS »)
      await appleRemindersState(harness.container).fail(code);
      const view = render(
        <AppContainerProvider container={harness.container}>
          <AppleRemindersSection />
        </AppContainerProvider>,
      );
      const text = fr.appleReminders.failureCode[code as keyof typeof fr.appleReminders.failureCode];
      expect(await screen.findByText(text, { exact: false }), code).toBeInTheDocument();
      for (const action of APPLE_FAILURE_ACTIONS[code] as readonly AppleFailureAction[]) {
        if (action === 'ios-settings' || action === 'reopen-app') continue;
        expect(screen.getAllByRole('button', { name: labels[action] }).length, `${code} ${action}`).toBeGreaterThan(0);
      }
      view.unmount();
    }
  });
});
