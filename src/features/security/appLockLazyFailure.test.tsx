import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppContainer } from '../app/container';
import { AppLockGate } from './AppLockGate';
import { bootAppLock } from './appLockBoot';
import { resetAppLockStore, useAppLockStore } from './appLockStore';
import { appReload } from './lockLayer';

/** I-03-6 / I-03-9 : chargement à la demande en échec (hors ligne de l'installation, bundle abîmé) : échec fermé, message visible. */

// Module sans startAppLockFor : l'import réussit mais l'appel échoue (chargement abîmé) ; ensureLockLayer reste fourni à l'écran de verrou.
vi.mock('./startAppLock', () => ({
  ensureLockLayer: () => {
    const existing = document.getElementById('ct-lock-layer');
    if (existing) return existing;
    const layer = document.createElement('div');
    layer.id = 'ct-lock-layer';
    document.body.appendChild(layer);
    return layer;
  },
}));

const flush = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  });
};

// Règle d'Ali : aucun délai allongé. Le bloc de l'écran de verrou (lazy) est préchargé explicitement : l'import est fait avant les
// assertions, `findBy` garde sa durée normale.
beforeAll(async () => {
  await import('./LockScreen');
});

beforeEach(() => {
  resetAppLockStore();
  document.body.innerHTML = '';
});

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset['appLock'];
});

describe('I-03 chargement à la demande du contrôleur en échec', () => {
  const iphone = { authenticator: { supported: true } } as unknown as AppContainer;

  it('I-03-6 contrôleur introuvable : verrouillé, coquille jamais montée, message du plugin', async () => {
    const lock = await bootAppLock(iphone);
    expect(useAppLockStore.getState()).toMatchObject({ phase: 'locked', shellReady: false, message: { kind: 'plugin', code: 'unavailable' } });
    expect(document.documentElement.dataset['appLock']).toBe('locked');
    lock.dispose();
  });

  it('I-03-6 contrôleur introuvable : l’écran de verrou affiche le message, aucune ligne de tâche', async () => {
    await bootAppLock(iphone);
    render(
      <AppLockGate>
        <ul>
          <li>{'Acheter du lait'}</li>
        </ul>
      </AppLockGate>,
    );
    expect(await screen.findByRole('heading', { name: 'CircleTasks est verrouillée' })).toBeInTheDocument();
    await flush();
    expect(screen.getByRole('alert')).toHaveTextContent('unavailable');
    expect(screen.queryByText('Acheter du lait')).toBeNull();
    expect(screen.getByRole('button', { name: 'Réessayer' })).toBeInTheDocument();
  });

  it('I-03-6 contrôleur introuvable : « Réessayer » sans actions ne déverrouille jamais', async () => {
    await bootAppLock(iphone);
    render(
      <AppLockGate>
        <p>{'Contenu'}</p>
      </AppLockGate>,
    );
    const reload = vi.spyOn(appReload, 'run').mockImplementation(() => undefined);
    const retry = await screen.findByRole('button', { name: 'Réessayer' });
    retry.click();
    await flush();
    // Import du contrôleur échoué, non réessayable : « Réessayer » relance l'app (revue 3).
    expect(reload).toHaveBeenCalledTimes(1);
    expect(useAppLockStore.getState().phase).toBe('locked');
    expect(screen.queryByText('Contenu')).toBeNull();
    reload.mockRestore();
  });

  it('I-03-3 PC et navigateur : contrôleur jamais chargé, déverrouillé', async () => {
    await bootAppLock({ authenticator: { supported: false } } as unknown as AppContainer);
    expect(useAppLockStore.getState()).toMatchObject({ phase: 'unlocked', shellReady: true, enabled: false });
  });
});
