import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { useAppStore } from '../app/appStore';
import { mockViewport, renderRoutines, seedLog, seedRoutine, setupRoutines, teardownRoutines, type RoutinesHarness } from './testKit';

// Aujourd'hui dans les tests : ven. 2 oct. 2026 ; semaine du lun. 28 sept. au dim. 4 oct.
const card = (title: string): HTMLElement => screen.getByRole('heading', { name: title }).closest('article') as HTMLElement;
const save = () => screen.getByRole('button', { name: 'Enregistrer' });

describe('Routines : liste et création (R-01), iPhone', () => {
  let h: RoutinesHarness;

  beforeEach(async () => {
    h = await setupRoutines('201');
    mockViewport(440);
  });
  afterEach(() => teardownRoutines(h));

  it('sans routine : état vide, aucun élément factice', async () => {
    renderRoutines(h.container);
    expect(await screen.findByText(/Aucune routine/)).toBeInTheDocument();
    expect(screen.queryByRole('article')).toBeNull();
    expect(screen.getByText('Gérez vos routines ici et cochez-les dans la liste du jour.')).toBeInTheDocument();
  });

  it('« + » ouvre le formulaire « Nouvelle routine » sans archivage ni série (critère 1)', async () => {
    renderRoutines(h.container);
    fireEvent.click(await screen.findByRole('button', { name: 'Ajouter une routine' }));
    const dialog = await screen.findByRole('dialog', { name: 'Nouvelle routine' });
    expect(within(dialog).getByRole('heading', { name: 'Nouvelle routine' })).toBeInTheDocument();
    expect(within(dialog).queryByText('Archiver')).toBeNull();
    expect(within(dialog).queryByText('Mettre en pause')).toBeNull();
  });

  it('Enregistrer est grisé tant que le nom est vide ; « Jours choisis » exige un jour (critère 3)', async () => {
    renderRoutines(h.container);
    fireEvent.click(await screen.findByRole('button', { name: 'Ajouter une routine' }));
    await screen.findByRole('dialog');
    expect(save()).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Nom de la routine'), { target: { value: '   ' } });
    expect(save()).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Nom de la routine'), { target: { value: 'Sport' } });
    expect(save()).toBeEnabled();

    fireEvent.change(screen.getByLabelText('Fréquence'), { target: { value: 'weekdays' } });
    expect(save()).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Lundi' }));
    expect(save()).toBeEnabled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Lundi' }));
    expect(save()).toBeDisabled();
  });

  it('le sélecteur propose Tous les jours, Jours choisis, X fois par semaine ; le compteur reste entre 1 et 7 (critères 4, 5)', async () => {
    renderRoutines(h.container);
    fireEvent.click(await screen.findByRole('button', { name: 'Ajouter une routine' }));
    await screen.findByRole('dialog');
    const options = within(screen.getByLabelText('Fréquence')).getAllByRole('option').map((option) => option.textContent);
    expect(options.slice(0, 3)).toEqual(['Tous les jours', 'Jours choisis', 'X fois par semaine']);

    fireEvent.change(screen.getByLabelText('Fréquence'), { target: { value: 'x_per_week' } });
    expect(screen.queryByRole('checkbox', { name: 'Lundi' })).toBeNull(); // aucun jour à choisir
    const group = screen.getByRole('group', { name: 'Nombre de fois par semaine' });
    const minus = within(group).getByRole('button', { name: 'Diminuer' });
    const plus = within(group).getByRole('button', { name: 'Augmenter' });
    for (let i = 0; i < 10; i += 1) fireEvent.click(minus);
    expect(within(group).getByText('1')).toBeInTheDocument();
    expect(minus).toBeDisabled();
    for (let i = 0; i < 10; i += 1) fireEvent.click(plus);
    expect(within(group).getByText('7')).toBeInTheDocument();
    expect(plus).toBeDisabled();
  });

  it('crée une routine « Jours choisis » : date de départ = aujourd’hui, carte avec icône et ronds, persistée (critères 6, 7, 9, 12)', async () => {
    renderRoutines(h.container);
    fireEvent.click(await screen.findByRole('button', { name: 'Ajouter une routine' }));
    await screen.findByRole('dialog');
    fireEvent.change(screen.getByLabelText('Nom de la routine'), { target: { value: '  Sport  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Icône sport' }));
    fireEvent.change(screen.getByLabelText('Fréquence'), { target: { value: 'weekdays' } });
    for (const day of ['Lundi', 'Mercredi', 'Vendredi']) fireEvent.click(screen.getByRole('checkbox', { name: day }));
    fireEvent.click(save());

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const sport = card('Sport');
    expect(sport.querySelector('svg')).not.toBeNull(); // icône Lucide
    // Ronds L à D : jours non prévus en pointillés ; jours avant le départ (lun. 28 sept.) non prévus aussi.
    const rounds = within(sport).getAllByRole('checkbox');
    expect(rounds).toHaveLength(7);
    expect(rounds.map((round) => round.getAttribute('data-state'))).toEqual(['off', 'off', 'off', 'off', 'planned', 'off', 'off']);
    expect(within(sport).getByLabelText('0 sur 1 cette semaine')).toHaveTextContent('0/1');
    expect(sport).toHaveTextContent('Pro · lun., mer., ven.');

    const [stored] = await h.container.data.repos.routines.listForFilter('all');
    expect(stored).toMatchObject({ title: 'Sport', scheduleType: 'weekdays', weekdays: [1, 3, 5], startDate: '2026-10-02', icon: { kind: 'lucide', name: 'dumbbell' }, spaceId: SPACE_PRO_ID });
  });

  it('le nom, l’icône emoji et « X fois par semaine » sont enregistrés (critères 5, 6)', async () => {
    renderRoutines(h.container);
    fireEvent.click(await screen.findByRole('button', { name: 'Ajouter une routine' }));
    await screen.findByRole('dialog');
    fireEvent.change(screen.getByLabelText('Nom de la routine'), { target: { value: 'Courir' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Emoji' }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Choisir un emoji' })).getAllByRole('button')[0] as HTMLElement);
    fireEvent.change(screen.getByLabelText('Fréquence'), { target: { value: 'x_per_week' } });
    fireEvent.click(screen.getByRole('button', { name: 'Augmenter' })); // 3 -> 4
    fireEvent.click(save());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const [stored] = await h.container.data.repos.routines.listForFilter('all');
    expect(stored).toMatchObject({ title: 'Courir', scheduleType: 'x_per_week', timesPerWeek: 4, weekdays: [] });
    expect(stored?.icon?.kind).toBe('emoji');
    expect(card('Courir')).toHaveTextContent('4 fois par semaine');
    expect(within(card('Courir')).getByLabelText('0 sur 4 cette semaine')).toHaveTextContent('0/4');
  });

  it('l’espace proposé suit le filtre ; le filtre n’affiche que les routines de l’espace (critère 10)', async () => {
    await seedRoutine(h, { title: 'Revue des e-mails', spaceId: SPACE_PRO_ID });
    await seedRoutine(h, { title: 'Lire 20 minutes', spaceId: SPACE_PERSO_ID });
    useAppStore.getState().setSpaceFilter(SPACE_PERSO_ID);
    renderRoutines(h.container);
    await screen.findByRole('heading', { name: 'Lire 20 minutes' });
    expect(screen.queryByRole('heading', { name: 'Revue des e-mails' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Ajouter une routine' }));
    await screen.findByRole('dialog');
    const dialog = screen.getByRole('dialog');
    expect(within(within(dialog).getByRole('group', { name: 'Espace de la routine' })).getByRole('button', { name: 'Perso' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.change(within(dialog).getByLabelText('Nom de la routine'), { target: { value: 'Méditer' } });
    fireEvent.click(save());
    await waitFor(async () => expect((await h.container.data.repos.routines.listForFilter(SPACE_PERSO_ID)).map((r) => r.title)).toContain('Méditer'));
  });

  it('une routine quotidienne : compteur faits / 7 et rond du jour rempli, calculés depuis les validations (critère 8)', async () => {
    const water = await seedRoutine(h, { title: 'Boire de l’eau', time: '08:30' as never, spaceId: SPACE_PERSO_ID });
    await seedLog(h, water, '2026-09-28');
    await seedLog(h, water, '2026-09-29');
    renderRoutines(h.container);
    const eau = await screen.findByRole('heading', { name: 'Boire de l’eau' }).then((heading) => heading.closest('article') as HTMLElement);
    expect(within(eau).getByLabelText('2 sur 7 cette semaine')).toHaveTextContent('2/7');
    expect(within(eau).getByRole('checkbox', { name: 'Lundi, fait' })).toBeChecked();
    expect(within(eau).getByRole('checkbox', { name: 'Mercredi' })).not.toBeChecked();
    expect(eau).toHaveTextContent('08:30 · Perso');
  });
});

describe('Routines : PC', () => {
  let h: RoutinesHarness;

  beforeEach(async () => {
    h = await setupRoutines('202');
    mockViewport(1440);
  });
  afterEach(() => teardownRoutines(h));

  it('Ctrl+N ouvre le formulaire dans le panneau de droite, nom focalisé (critère 2)', async () => {
    renderRoutines(h.container);
    await screen.findByText(/Aucune routine/);
    expect(h.container.shortcuts.handle({ key: 'n', code: 'KeyN', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false, editable: false })).toBe('app.newTask');
    const panel = await screen.findByRole('complementary', { name: 'Nouvelle routine' });
    await waitFor(() => expect(within(panel).getByLabelText('Nom de la routine')).toHaveFocus());
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('le bouton « Ajouter » ouvre le même formulaire ; Échap le ferme sans rien créer', async () => {
    renderRoutines(h.container);
    fireEvent.click(await screen.findByRole('button', { name: 'Ajouter' }));
    const panel = await screen.findByRole('complementary', { name: 'Nouvelle routine' });
    fireEvent.keyDown(panel, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('complementary')).toBeNull());
    expect(await h.container.data.repos.routines.listForFilter('all')).toEqual([]);
  });

  it('affiche la phrase d’aide du pied de page PC et la grille de cartes', async () => {
    await seedRoutine(h, { title: 'Faire mon lit' });
    renderRoutines(h.container);
    await screen.findByRole('heading', { name: 'Faire mon lit' });
    expect(screen.getByText(/Cochez les routines dans la liste du jour/)).toHaveTextContent('nouvelle routine');
  });
});
