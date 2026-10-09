import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockViewport, setupToday, teardownToday, type TodayHarness } from '../today/testKit';

/**
 * Q-05 (revue de la PR #19, I3) : formulaire Événement ou Routine PAS ENCORE chargé au moment du toucher. Les modules sont remis à neuf : `AddSheet`
 * est une instance où les formulaires à la demande n'ont jamais été chargés (les autres tests les préchargent, comme le fait l'app au repos).
 * Attendu : la feuille du segment s'ouvre aussitôt avec un repli neutre (zone vide), puis le formulaire arrive et se remplit ; limite connue :
 * le focus n'est alors PAS posé dans le geste (le clavier iOS peut ne pas monter), il est posé à l'arrivée du formulaire (fiche Q-05).
 */
describe('AddSheet : segments Événement et Routine pas encore chargés', () => {
  let h: TodayHarness;
  beforeEach(async () => {
    mockViewport(440);
    h = await setupToday('ad05');
  });
  afterEach(async () => {
    cleanup();
    vi.resetModules();
    await teardownToday(h);
  });

  async function openFresh() {
    vi.resetModules();
    const { AppContainerProvider } = await import('../app/AppContainerContext');
    const { useAppStore } = await import('../app/appStore');
    const { AddSheet } = await import('./AddSheet');
    useAppStore.getState().setSpaces(await h.container.data.repos.spaces.listAll());
    render(
      <AppContainerProvider container={h.container}>
        <AddSheet initialSegment="task" date={h.today} taskSheet={{ viewedDate: h.today, onCreate: () => Promise.resolve(true) }} onClose={() => undefined} />
      </AppContainerProvider>,
    );
  }

  it('segment Événement : repli visible dans la feuille, puis formulaire utilisable et focalisé à son arrivée', async () => {
    await openFresh();
    fireEvent.click(screen.getByRole('button', { name: 'Événement' }));
    // Aussitôt après le toucher : la feuille du segment existe, son contenu n'est pas arrivé (repli neutre, aucun champ).
    const dialog = screen.getByRole('dialog', { name: 'Nouvel événement' });
    expect(dialog.querySelector('.ct-app__placeholder')).not.toBeNull();
    expect(within(dialog).queryByLabelText('Titre')).toBeNull();
    // Le formulaire arrive : champ focalisé (hors geste, limite connue), saisie possible.
    const title = await within(dialog).findByLabelText('Titre');
    expect(dialog.querySelector('.ct-app__placeholder')).toBeNull();
    expect(title).toHaveFocus();
    fireEvent.change(title, { target: { value: 'Dîner' } });
    expect(title).toHaveValue('Dîner');
  });

  it('segment Routine : repli visible, puis formulaire utilisable', async () => {
    await openFresh();
    fireEvent.click(screen.getByRole('button', { name: 'Routine' }));
    const dialog = screen.getByRole('dialog', { name: 'Nouvelle routine' });
    expect(dialog.querySelector('.ct-app__placeholder')).not.toBeNull();
    const name = await within(dialog).findByLabelText('Nom de la routine');
    expect(dialog.querySelector('.ct-app__placeholder')).toBeNull();
    expect(name).toHaveFocus();
    fireEvent.change(name, { target: { value: 'Marcher' } });
    expect(name).toHaveValue('Marcher');
  });
});
