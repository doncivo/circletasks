import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppLockGate } from './AppLockGate';
import { resetAppLockStore, useAppLockStore } from './appLockStore';
import { appReload } from './lockLayer';

/** I-03-6 (revue 3, QA D2) : le code de l'écran de verrou (LockScreen, lazy) ne se charge pas : l'app reste verrouillée, message visible. */

vi.mock('./LockScreen', () => {
  throw new Error('chunk introuvable');
});

/** Attente d'un état, par tours de React (un compteur, jamais une durée) : l'import en échec se règle en quelques tours. */
async function untilPresent<T>(query: () => T | null, maxTurns = 50): Promise<T> {
  for (let turn = 0; turn < maxTurns; turn += 1) {
    const found = query();
    if (found !== null) return found;
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  }
  throw new Error(`état jamais atteint après ${String(maxTurns)} tours`);
}

beforeEach(() => {
  resetAppLockStore();
  useAppLockStore.setState({ phase: 'locked', enabled: true, shellReady: false, message: null });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('I-03-6 écran de verrou chargé à la demande en échec', () => {
  it('I-03-6 le contenu n’est pas rendu et un verrou statique annonce le message (role alert)', async () => {
    render(
      <AppLockGate>
        <p>{'Acheter du lait'}</p>
      </AppLockGate>,
    );
    const alert = await untilPresent(() => screen.queryByRole('alert'));
    expect(alert).toHaveTextContent('L’écran de verrou n’a pas pu être chargé. Vos données sont intactes : relancez l’app.');
    expect(screen.getByRole('heading', { name: 'CircleTasks est verrouillée' })).toBeInTheDocument();
    expect(screen.queryByText('Acheter du lait')).toBeNull();
  });

  it('I-03-6 « Réessayer » relance l’app et ne déverrouille jamais', async () => {
    const reload = vi.spyOn(appReload, 'run').mockImplementation(() => undefined);
    render(
      <AppLockGate>
        <p>{'Acheter du lait'}</p>
      </AppLockGate>,
    );
    fireEvent.click(await untilPresent(() => screen.queryByRole('button', { name: 'Réessayer' })));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(useAppLockStore.getState().phase).toBe('locked');
    expect(screen.queryByText('Acheter du lait')).toBeNull();
  });
});

describe('I-03-6 contrôleur introuvable (revue 3) : couche posée par le module léger', () => {
  it('I-03-6 bootAppLock en échec masque body avant tout rendu', async () => {
    vi.doMock('./startAppLock', () => ({}));
    document.body.innerHTML = '<div id="root"><p>contenu</p></div>';
    const { bootAppLock } = await import('./appLockBoot');
    await bootAppLock({ authenticator: { supported: true } } as never);
    expect(document.getElementById('root')).toHaveAttribute('hidden');
    expect(document.getElementById('root')).toHaveAttribute('inert');
    expect(document.getElementById('ct-lock-layer')).not.toBeNull();
    vi.doUnmock('./startAppLock');
    const { applyLockToDocument } = await import('./lockLayer');
    applyLockToDocument(document, false);
  });
});
