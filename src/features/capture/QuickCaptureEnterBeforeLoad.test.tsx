import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SPACE_PERSO_ID } from '../../db/seed/defaultSpaces';
import { AppContainerProvider } from '../app/AppContainerContext';
import { useAppStore } from '../app/appStore';
import { TaskCreateSheet, type TaskCreateSheetProps } from '../tasks/TaskCreateSheet';
import { mockViewport, setupToday, teardownToday, type TodayHarness } from '../today/testKit';

// Q-05-FIX-01 : le bloc des options (import dynamique après le premier affichage) est remplacé par un bloc vide qui ne signale jamais
// qu'il est prêt : la feuille doit rester utilisable sans lui (bouton nommé et actif, Entrée qui crée la tâche).
vi.mock('../tasks/TaskCreateOptions', () => ({ TaskCreateOptions: () => null }));

/**
 * Q-05-FIX-01 — régression du critère 9 de Q-05 par UI-REFONTE-01 : tant que le bloc à la demande n'avait pas livré « Ajouter la tâche »,
 * le bouton de soumission était désactivé (« Chargement… ») et l'Entrée sur un titre valide ne faisait rien, sans retour.
 */
describe('Q-05-FIX-01 — Entrée avant l’arrivée du bloc des options', () => {
  let h: TodayHarness;
  beforeEach(async () => {
    mockViewport(440);
    h = await setupToday('c605');
  });
  afterEach(async () => {
    cleanup();
    await teardownToday(h);
  });

  function renderSheet(onCreate: TaskCreateSheetProps['onCreate']) {
    const spaces = useAppStore.getState().spaces;
    return render(
      <AppContainerProvider container={h.container}>
        <TaskCreateSheet viewedDate={h.today} today={h.today} spaces={spaces} initialSpaceId={SPACE_PERSO_ID} onClose={() => undefined} onCreate={onCreate} />
      </AppContainerProvider>,
    );
  }
  const field = (): HTMLElement => screen.getByLabelText('Titre');

  it('le bouton porte « Ajouter la tâche » et est actif dès qu’un titre valide est saisi, sans attendre le bloc (critère 1)', () => {
    renderSheet(() => Promise.resolve(true));
    fireEvent.change(field(), { target: { value: 'Acheter du pain' } });
    const button = screen.getByRole('button', { name: 'Ajouter la tâche' });
    expect(button).toBeEnabled();
    expect(screen.queryByText('Chargement…')).toBeNull();
  });

  it('Entrée sur un titre valide crée la tâche, une seule fois (critère 2)', async () => {
    const onCreate = vi.fn<TaskCreateSheetProps['onCreate']>(() => Promise.resolve(true));
    renderSheet(onCreate);
    fireEvent.change(field(), { target: { value: 'Acheter du pain #perso' } });
    await act(async () => {
      fireEvent.keyDown(field(), { key: 'Enter' });
      await Promise.resolve();
    });
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate.mock.calls[0]?.[0]).toMatchObject({ title: 'Acheter du pain' });
  });

  it('Entrée sur un titre vide : tremblement, rien n’est créé (T-01, inchangé)', async () => {
    const onCreate = vi.fn(() => Promise.resolve(true));
    renderSheet(onCreate);
    await act(async () => {
      fireEvent.keyDown(field(), { key: 'Enter' });
      await Promise.resolve();
    });
    expect(field().closest('.ct-task-sheet__titleRow')).toHaveAttribute('data-shake', 'true');
    expect(onCreate).not.toHaveBeenCalled();
  });
});
