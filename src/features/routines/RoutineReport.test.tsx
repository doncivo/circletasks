import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SPACE_PERSO_ID } from '../../db/seed/defaultSpaces';
import type { LocalDate, RoutineId } from '../../domain/types';
import { DEFAULT_ROUTES, useNavigationStore } from '../app/navigation';
import { mockViewport, renderRoutines, seedLog, seedRoutine, setupRoutines, teardownRoutines, type RoutinesHarness } from './testKit';

// Aujourd'hui : ven. 2 oct. 2026 ; Sport lun., mer., ven. à 18:00 (Perso).
// Le panneau de rapport a lui aussi un titre : la carte est le titre contenu dans un <article>.
const card = (title: string): HTMLElement =>
  screen
    .getAllByRole('heading', { name: title })
    .map((heading) => heading.closest('article'))
    .find((article): article is HTMLElement => article !== null) as HTMLElement;
const FULL = { from: '2026-01-01' as LocalDate, to: '2026-12-31' as LocalDate };

async function seedSport(h: RoutinesHarness) {
  const sport = await seedRoutine(h, { title: 'Sport', scheduleType: 'weekdays', weekdays: [1, 3, 5], time: '18:00' as never, spaceId: SPACE_PERSO_ID, icon: { kind: 'lucide', name: 'dumbbell' } });
  // 7 derniers jours (26 sept. -> 2 oct.) : prévus lun. 28, mer. 30, ven. 2 ; validés 30 et 2 = 2 sur 3.
  for (const day of ['2026-09-30', '2026-10-02']) await seedLog(h, sport, day);
  return sport;
}

describe('Rapport de la routine : PC (R-06)', () => {
  let h: RoutinesHarness;

  beforeEach(async () => {
    h = await setupRoutines('261');
    mockViewport(1440);
  });
  afterEach(() => teardownRoutines(h));

  it('cliquer une carte la sélectionne et ouvre son rapport : nom, fréquence, tuiles 7 / 30 / 90 jours, séries (critères 1, 5)', async () => {
    await seedSport(h);
    renderRoutines(h.container);
    fireEvent.click(await screen.findByRole('button', { name: 'Sport' }));
    const panel = await screen.findByRole('complementary', { name: 'Rapport de la routine' });
    expect(card('Sport')).toHaveAttribute('data-selected', 'true');
    expect(within(panel).getByRole('heading', { name: 'Sport' })).toBeInTheDocument();
    expect(within(panel).getByText('Lundi, mercredi, vendredi à 18:00 · Perso')).toBeInTheDocument();
    expect(within(panel).getByRole('group', { name: 'Taux sur 7 jours : 67 %' })).toHaveTextContent('7 JOURS67 %');
    // Routine créée au 1er sept. : 30 jours = depuis le départ ; seules 2 validations sur les jours prévus échus.
    expect(within(panel).getByRole('group', { name: /^Taux sur 30 jours : \d+ %$/ })).toBeInTheDocument();
    expect(within(panel).getByRole('group', { name: /^Taux sur 90 jours : \d+ %$/ })).toBeInTheDocument();
    expect(within(panel).getByText('Série en cours')).toBeInTheDocument();
    expect(within(panel).getByText('Meilleure série')).toBeInTheDocument();
  });

  it('carte de chaleur : libellés « 30 septembre, fait », états, aujourd’hui repéré ; mois précédent / suivant sans dépasser le mois courant (critères 3, 4, 7)', async () => {
    await seedSport(h);
    renderRoutines(h.container);
    fireEvent.click(await screen.findByRole('button', { name: 'Sport' }));
    const panel = await screen.findByRole('complementary', { name: 'Rapport de la routine' });
    expect(within(panel).getByText('OCTOBRE 2026')).toBeInTheDocument();
    const grid = within(panel).getByRole('group', { name: 'Carte de chaleur du mois' });
    expect(within(grid).getByRole('img', { name: '2 octobre, fait' })).toHaveAttribute('data-today', 'true');
    expect(within(grid).getByRole('img', { name: '5 octobre, prévu' })).toHaveAttribute('data-state', 'upcoming');
    expect(within(grid).getByRole('img', { name: '3 octobre' })).toHaveAttribute('data-state', 'none');
    expect(within(grid).getAllByRole('img')).toHaveLength(31);

    const next = within(panel).getByRole('button', { name: 'Mois suivant' });
    expect(next).toBeDisabled();
    fireEvent.click(within(panel).getByRole('button', { name: 'Mois précédent' }));
    expect(within(panel).getByText('SEPTEMBRE 2026')).toBeInTheDocument();
    const septembre = within(panel).getByRole('group', { name: 'Carte de chaleur du mois' });
    expect(within(septembre).getByRole('img', { name: '30 septembre, fait' })).toHaveAttribute('data-state', 'done');
    expect(within(septembre).getByRole('img', { name: '28 septembre, prévu, non fait' })).toHaveAttribute('data-state', 'missed');
    expect(within(septembre).getAllByRole('img')).toHaveLength(30);
    expect(next).toBeEnabled();
    fireEvent.click(next);
    expect(within(panel).getByText('OCTOBRE 2026')).toBeInTheDocument();
    expect(next).toBeDisabled();
  });

  it('« Fermer » et Échap ferment le panneau ; cliquer un rond n’ouvre pas le rapport', async () => {
    await seedSport(h);
    renderRoutines(h.container);
    fireEvent.click(await screen.findByRole('button', { name: 'Sport' }));
    const panel = await screen.findByRole('complementary', { name: 'Rapport de la routine' });
    fireEvent.click(within(panel).getByRole('button', { name: 'Fermer' }));
    await waitFor(() => expect(screen.queryByRole('complementary')).toBeNull());
    expect(card('Sport')).toHaveAttribute('data-selected', 'false');

    // Un clic sur un rond valide le jour sans ouvrir le rapport.
    fireEvent.click(within(card('Sport')).getByRole('checkbox', { name: 'Lundi' }));
    await waitFor(() => expect(within(card('Sport')).getByRole('checkbox', { name: 'Lundi, fait' })).toBeChecked());
    expect(screen.queryByRole('complementary')).toBeNull();

    // Clic sur le corps de la carte (hors boutons) : ouvre ; Échap : ferme.
    fireEvent.click(card('Sport').querySelector('.ct-routine-card__info') as HTMLElement);
    const again = await screen.findByRole('complementary', { name: 'Rapport de la routine' });
    fireEvent.keyDown(again, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('complementary')).toBeNull());
  });

  it('« Modifier » ouvre le formulaire dans le panneau ; « Éditer » aussi, sans passer par le rapport', async () => {
    await seedSport(h);
    renderRoutines(h.container);
    fireEvent.click(await screen.findByRole('button', { name: 'Sport' }));
    const panel = await screen.findByRole('complementary', { name: 'Rapport de la routine' });
    fireEvent.click(within(panel).getByRole('button', { name: 'Modifier' }));
    expect(await screen.findByRole('form', { name: 'Modifier la routine' })).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Modifier la routine' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Fermer' }));
    // Retour au rapport sélectionné.
    expect(await screen.findByRole('complementary', { name: 'Rapport de la routine' })).toBeInTheDocument();

    fireEvent.click(within(screen.getByRole('complementary')).getByRole('button', { name: 'Fermer' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Éditer la routine Sport' }));
    expect(await screen.findByRole('form', { name: 'Modifier la routine' })).toBeInTheDocument();
  });

  it('« Mettre en pause » / « Reprendre » et « Archiver » depuis le panneau (R-05 critères 1, 2, 5)', async () => {
    const sport = await seedSport(h);
    renderRoutines(h.container);
    fireEvent.click(await screen.findByRole('button', { name: 'Sport' }));
    const panel = await screen.findByRole('complementary', { name: 'Rapport de la routine' });
    fireEvent.click(within(panel).getByRole('button', { name: 'Mettre en pause' }));
    await waitFor(() => expect(within(screen.getByRole('complementary')).getByRole('button', { name: 'Reprendre' })).toBeInTheDocument());
    expect(card('Sport')).toHaveTextContent('En pause');
    expect((await h.container.data.repos.routines.getById(sport.id as RoutineId))?.paused).toBe(true);
    fireEvent.click(within(screen.getByRole('complementary')).getByRole('button', { name: 'Reprendre' }));
    await waitFor(() => expect(within(screen.getByRole('complementary')).getByRole('button', { name: 'Mettre en pause' })).toBeInTheDocument());

    fireEvent.click(within(screen.getByRole('complementary')).getByRole('button', { name: 'Archiver' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Archiver' }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Sport' })).toBeNull());
    expect(screen.queryByRole('complementary')).toBeNull();
    expect(await h.container.data.repos.routineLogs.listForRoutine(sport.id as RoutineId, FULL)).toHaveLength(2);
  });

  it('routine sans aucun jour prévu à ce jour : tuiles « — » ; routine sans heure : sous-titre sans « à »', async () => {
    await seedRoutine(h, { title: 'Future', startDate: '2026-11-01' as LocalDate });
    renderRoutines(h.container);
    fireEvent.click(await screen.findByRole('button', { name: 'Future' }));
    const panel = await screen.findByRole('complementary', { name: 'Rapport de la routine' });
    expect(within(panel).getByRole('group', { name: 'Taux sur 7 jours : —' })).toBeInTheDocument();
    expect(within(panel).getByText('Tous les jours · Pro')).toBeInTheDocument();
  });
});

describe('Rapport de la routine : iPhone (R-06, QB-06)', () => {
  let h: RoutinesHarness;

  beforeEach(async () => {
    h = await setupRoutines('262');
    mockViewport(440);
  });
  afterEach(() => {
    useNavigationStore.setState({ route: DEFAULT_ROUTES.routines });
    return teardownRoutines(h);
  });

  it('toucher le corps de la carte ouvre la feuille « Rapport de la routine », sans « Modifier » ; « Éditer » est le seul accès au formulaire (critère 6)', async () => {
    await seedSport(h);
    renderRoutines(h.container);
    await screen.findByRole('heading', { name: 'Sport' });
    fireEvent.click(card('Sport').querySelector('.ct-routine-card__info') as HTMLElement);
    const sheet = await screen.findByRole('dialog', { name: 'Rapport de la routine' });
    expect(within(sheet).getByRole('heading', { name: 'Sport' })).toBeInTheDocument();
    expect(within(sheet).getByRole('group', { name: 'Taux sur 7 jours : 67 %' })).toBeInTheDocument();
    expect(within(sheet).queryByRole('button', { name: 'Modifier' })).toBeNull();
    fireEvent.keyDown(sheet, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'Éditer la routine Sport' }));
    expect(await screen.findByRole('dialog', { name: 'Modifier la routine' })).toBeInTheDocument();
  });

  it('toucher un rond ou « Éditer » n’ouvre pas le rapport', async () => {
    await seedSport(h);
    renderRoutines(h.container);
    await screen.findByRole('heading', { name: 'Sport' });
    fireEvent.click(within(card('Sport')).getByRole('checkbox', { name: 'Lundi' }));
    await waitFor(() => expect(within(card('Sport')).getByRole('checkbox', { name: 'Lundi, fait' })).toBeChecked());
    expect(screen.queryByRole('dialog', { name: 'Rapport de la routine' })).toBeNull();
  });

  it('« Rapport du mois » ouvre la vue mensuelle de toutes les routines (critère 6)', async () => {
    await seedSport(h);
    renderRoutines(h.container);
    fireEvent.click(await screen.findByRole('button', { name: 'Rapport du mois' }));
    expect(useNavigationStore.getState().route).toEqual({ tab: 'routines', screen: 'report' });
  });
});
