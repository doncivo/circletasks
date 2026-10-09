import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { calendarsStore, type CalendarsState } from './calendarsStore';
import { setupCalendarHarness, type CalendarHarness } from './testKit';
import type * as ConnectModuleNs from './calendarsConnect';

type ConnectModule = typeof ConnectModuleNs;

/**
 * Module de connexion chargé à la demande (calendarsConnect.ts, revue finale de la PR #25) : jamais chargé au démarrage sans
 * secret orphelin ; s'il ne se charge pas, les références orphelines relues restent affichées (message et « Réessayer
 * l'effacement »), et le nouvel essai recharge le module.
 */
const loader = vi.hoisted(() => ({ fail: false, imports: 0 }));

// Vitest garde le module simulé d'un test à l'autre : l'échec est donc simulé à chaque mise en service du module (même chemin que
// l'échec de `import()` dans le store : la promesse du module est rejetée, puis oubliée pour le nouvel essai).
vi.mock('./calendarsConnect', async (importOriginal) => {
  const original = await importOriginal<ConnectModule>();
  return {
    ...original,
    createConnectActions: (...args: Parameters<typeof original.createConnectActions>) => {
      loader.imports += 1;
      if (loader.fail) throw new Error('bloc calendarsConnect indisponible');
      return original.createConnectActions(...args);
    },
  };
});

const REF = 'circletasks.calendar.icloud.a7000000-0000-4000-8000-0000000000f1';

let h: CalendarHarness;
const state = (): CalendarsState => calendarsStore.get(h.container).getState();

beforeEach(async () => {
  loader.fail = false;
  loader.imports = 0;
  h = await setupCalendarHarness('41');
});
afterEach(() => h.close());

describe('calendarsConnect chargé à la demande', () => {
  it('aucune référence orpheline : le chargement de l’écran ne charge pas le module de connexion', async () => {
    await state().load();
    expect(state().status).toBe('ready');
    expect(loader.imports).toBe(0);
    expect(state().orphanSecrets).toEqual([]);
  });

  it('module indisponible : références relues affichées (message), « Réessayer l’effacement » recharge le module et efface', async () => {
    await h.container.calendars.vault.set(REF, 'mot-de-passe-de-test');
    await h.container.data.repos.settings.set('calendars.orphanSecrets', [{ provider: 'icloud', tokenRef: REF }]);
    loader.fail = true;
    await state().load();
    expect(state().status).toBe('ready');
    expect(state().orphanSecrets).toEqual([{ provider: 'icloud', tokenRef: REF }]);
    loader.fail = false;
    await state().retryForgetSecrets();
    expect(state().orphanSecrets).toEqual([]);
    expect(await h.container.calendars.vault.has(REF)).toBe(false);
    expect(await h.container.data.repos.settings.get('calendars.orphanSecrets')).toBeNull();
  });

  it('module toujours indisponible au nouvel essai : la référence reste affichée et un message le dit', async () => {
    await h.container.calendars.vault.set(REF, 'mot-de-passe-de-test');
    await h.container.data.repos.settings.set('calendars.orphanSecrets', [{ provider: 'icloud', tokenRef: REF }]);
    loader.fail = true;
    await state().load();
    await state().retryForgetSecrets();
    expect(state().orphanSecrets).toEqual([{ provider: 'icloud', tokenRef: REF }]);
    expect(state().messageKey).toBe('calendars.errorFailed');
    expect(await h.container.calendars.vault.has(REF)).toBe(true);
  });
});
