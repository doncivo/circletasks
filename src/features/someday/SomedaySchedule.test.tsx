import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SPACE_PERSO_ID } from '../../db/seed/defaultSpaces';
import { useNavigationStore } from '../app/navigation';
import { mockViewport, renderSomeday, seedSomeday, setupSomeday, teardownSomeday, type SomedayHarness } from './testKit';

// Aujourd'hui dans les tests : ven. 2 oct. 2026.
describe.each([
  ['iPhone', 440],
  ['PC', 1280],
])('Planifier depuis « Un jour » (SD-02), %s', (_name, width) => {
  let h: SomedayHarness;

  beforeEach(async () => {
    h = await setupSomeday(width < 1024 ? '412' : '413');
    mockViewport(width);
  });
  afterEach(() => teardownSomeday(h));

  const get = async (title: string) => (await h.container.data.repos.tasks.listSomeday('all')).find((task) => task.title === title);
  const byTitle = async (title: string) => {
    const [found] = (await h.container.data.repos.tasks.listForDay(h.today, 'all')).filter((task) => task.title === title);
    return found;
  };

  it('toucher une ligne la déploie avec les trois boutons ; une seule ligne à la fois (critère 1)', async () => {
    await seedSomeday(h, { title: 'Renouveler le passeport' });
    await seedSomeday(h, { title: 'Lire le rapport annuel' });
    renderSomeday(h.container);
    const first = await screen.findByRole('button', { name: 'Renouveler le passeport' });
    expect(first).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: 'Demain' })).toBeNull();

    fireEvent.click(first);
    expect(first).toHaveAttribute('aria-expanded', 'true');
    const group = screen.getByRole('group', { name: 'Planifier : Renouveler le passeport' });
    expect(within(group).getByRole('button', { name: 'Planifier aujourd’hui : Renouveler le passeport' })).toHaveTextContent('Aujourd’hui');
    expect(within(group).getByRole('button', { name: 'Planifier demain : Renouveler le passeport' })).toHaveTextContent('Demain');
    expect(within(group).getByRole('button', { name: 'Choisir une date pour : Renouveler le passeport' })).toHaveTextContent('Choisir une date');

    // Une autre ligne se déploie : la première se replie.
    fireEvent.click(screen.getByRole('button', { name: 'Lire le rapport annuel' }));
    expect(first).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getAllByRole('group', { name: /^Planifier : / })).toHaveLength(1);
    // Retoucher la ligne déployée la replie.
    fireEvent.click(screen.getByRole('button', { name: 'Lire le rapport annuel' }));
    expect(screen.queryByRole('group', { name: /^Planifier : / })).toBeNull();
  });

  it('« Aujourd’hui » : la tâche quitte la liste, le sous-titre baisse, elle est datée du jour sans heure (critère 2)', async () => {
    await seedSomeday(h, { title: 'Renouveler le passeport' });
    await seedSomeday(h, { title: 'Autre' });
    renderSomeday(h.container);
    fireEvent.click(await screen.findByRole('button', { name: 'Renouveler le passeport' }));
    fireEvent.click(screen.getByRole('button', { name: 'Planifier aujourd’hui : Renouveler le passeport' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Renouveler le passeport' })).toBeNull());
    expect(screen.getByText('1 tâche sans date, à planifier plus tard')).toBeInTheDocument();
    expect(await byTitle('Renouveler le passeport')).toMatchObject({ someday: false, date: h.today, time: null });
  });

  it('« Demain » : date de demain ; message « planifiée pour demain » 5 s ; Annuler la remet à sa position (critères 3 et 5)', async () => {
    await seedSomeday(h, { title: 'Première' });
    await seedSomeday(h, { title: 'Renouveler le passeport' });
    renderSomeday(h.container);
    await screen.findByRole('button', { name: 'Renouveler le passeport' });
    fireEvent.click(screen.getByRole('button', { name: 'Renouveler le passeport' }));
    fireEvent.click(screen.getByRole('button', { name: 'Planifier demain : Renouveler le passeport' }));
    const toast = await screen.findByRole('status');
    expect(toast).toHaveTextContent('« Renouveler le passeport » planifiée pour demain');
    const [planned] = (await h.container.data.repos.tasks.listForDay('2026-10-03' as never, 'all')).filter((task) => task.title === 'Renouveler le passeport');
    expect(planned).toMatchObject({ date: '2026-10-03', someday: false });
    fireEvent.click(within(toast).getByRole('button', { name: 'Annuler' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Renouveler le passeport' })).toBeInTheDocument());
    expect(Array.from(document.querySelectorAll('.ct-list-row__title')).map((node) => node.textContent)).toEqual(['Renouveler le passeport', 'Première']);
    expect(await get('Renouveler le passeport')).toMatchObject({ someday: true, date: null });
  });

  it('« Choisir une date » ouvre le sélecteur ; valider planifie à la date choisie (critère 4)', async () => {
    await seedSomeday(h, { title: 'Renouveler le passeport' });
    renderSomeday(h.container);
    fireEvent.click(await screen.findByRole('button', { name: 'Renouveler le passeport' }));
    fireEvent.click(screen.getByRole('button', { name: 'Choisir une date pour : Renouveler le passeport' }));
    const dialog = await screen.findByRole('dialog', { name: 'Choisir une date' });
    if (width >= 1024) {
      fireEvent.change(within(dialog).getByRole('textbox', { name: 'Date' }), { target: { value: '9/10' } });
    } else {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Demain' }));
    }
    fireEvent.click(within(dialog).getByRole('button', { name: 'Planifier' }));
    await waitFor(async () => expect((await get('Renouveler le passeport'))).toBeUndefined());
    const expected = width >= 1024 ? '2026-10-09' : '2026-10-03';
    const planned = (await h.container.data.repos.tasks.listForDay(expected as never, 'all'))[0];
    expect(planned).toMatchObject({ title: 'Renouveler le passeport', someday: false, date: expected });
  });

  it('« Fermer » du sélecteur n’y change rien (critère 4)', async () => {
    await seedSomeday(h, { title: 'Renouveler le passeport' });
    renderSomeday(h.container);
    fireEvent.click(await screen.findByRole('button', { name: 'Renouveler le passeport' }));
    fireEvent.click(screen.getByRole('button', { name: 'Choisir une date pour : Renouveler le passeport' }));
    const dialog = await screen.findByRole('dialog', { name: 'Choisir une date' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Fermer' }));
    expect(screen.queryByRole('dialog', { name: 'Choisir une date' })).toBeNull();
    expect(await get('Renouveler le passeport')).toMatchObject({ someday: true, date: null });
    expect(h.container.undo.getSnapshot().size).toBe(0);
  });

  it('espace, note et projet sont conservés (critère 6)', async () => {
    const created = await seedSomeday(h, { title: 'Trier les photos', spaceId: SPACE_PERSO_ID });
    await h.container.data.repos.tasks.update(created.id, { note: 'Vacances 2025' });
    renderSomeday(h.container);
    fireEvent.click(await screen.findByRole('button', { name: 'Trier les photos' }));
    fireEvent.click(screen.getByRole('button', { name: 'Planifier aujourd’hui : Trier les photos' }));
    await waitFor(async () => expect(await byTitle('Trier les photos')).toBeDefined());
    expect(await byTitle('Trier les photos')).toMatchObject({ spaceId: SPACE_PERSO_ID, note: 'Vacances 2025' });
  });

  it('« Ouvrir la fiche » ouvre le détail de la tâche', async () => {
    const task = await seedSomeday(h, { title: 'Renouveler le passeport' });
    renderSomeday(h.container);
    fireEvent.click(await screen.findByRole('button', { name: 'Renouveler le passeport' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ouvrir la fiche' }));
    expect(useNavigationStore.getState().detail).toEqual({ type: 'task', id: task.id });
  });
});

describe('Clavier PC dans « Un jour » (SD-02 critère 1, S-06 critère 8)', () => {
  let h: SomedayHarness;

  beforeEach(async () => {
    h = await setupSomeday('414');
    mockViewport(1280);
  });
  afterEach(() => teardownSomeday(h));

  const press = (key: string) =>
    act(() => {
      h.container.shortcuts.handle({ key, code: key, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, editable: false });
    });

  it('↑ / ↓ sélectionnent une ligne, qui montre ses boutons ; Espace la termine', async () => {
    const a = await seedSomeday(h, { title: 'A' });
    await seedSomeday(h, { title: 'B' });
    renderSomeday(h.container);
    // Tête de liste : B puis A.
    const titleB = await screen.findByRole('button', { name: 'B' });
    act(() => titleB.focus());
    press('ArrowDown');
    await waitFor(() => expect(screen.getByRole('button', { name: 'A' })).toHaveAttribute('aria-expanded', 'true'));
    expect(screen.getByRole('button', { name: 'Planifier demain : A' })).toBeInTheDocument();
    press('ArrowUp');
    await waitFor(() => expect(screen.getByRole('button', { name: 'B' })).toHaveAttribute('aria-expanded', 'true'));
    expect(screen.queryByRole('button', { name: 'Planifier demain : A' })).toBeNull();

    press('ArrowDown');
    await waitFor(() => expect(screen.getByRole('button', { name: 'A' })).toHaveAttribute('aria-expanded', 'true'));
    press(' ');
    await waitFor(async () => expect((await h.container.data.repos.tasks.getById(a.id))?.status).toBe('done'));
  });

  it('Entrée sur la ligne sélectionnée ouvre la fiche (S-06 critère 8)', async () => {
    const a = await seedSomeday(h, { title: 'A' });
    renderSomeday(h.container);
    act(() => screen.getByRole('button', { name: 'A' }).focus());
    press('ArrowDown');
    await waitFor(() => expect(screen.getByRole('button', { name: 'A' })).toHaveAttribute('aria-expanded', 'true'));
    press('Enter');
    expect(useNavigationStore.getState().detail).toEqual({ type: 'task', id: a.id });
  });
});
