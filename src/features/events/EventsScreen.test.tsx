import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { insertCalendarAccount, insertExternalEvent } from '../../db/seed/externalEventFixtures';
import { useAppStore } from '../app/appStore';
import { useNavigationStore } from '../app/navigation';
import { seedProject } from '../spaces/testKit';
import { mockViewport, renderEvents, seedEvent, setupEvents, teardownEvents, type EventsHarness } from './testKit';

const rowOf = (title: string): HTMLElement => screen.getByText(title, { selector: '.ct-event-row__title' }).closest('.ct-event-row') as HTMLElement;
const titles = (): string[] => Array.from(document.querySelectorAll('.ct-event-row__title')).map((node) => node.textContent ?? '');

describe('Événements : liste de l’année (E-01), iPhone', () => {
  let h: EventsHarness;

  beforeEach(async () => {
    h = await setupEvents('401');
    mockViewport(440);
  });
  afterEach(() => teardownEvents(h));

  it('liste les occurrences par mois, passé grisé, étiquette « Aujourd’hui » le jour même (critère 1)', async () => {
    await seedEvent(h, { title: 'Hier', date: '2026-10-01' });
    await seedEvent(h, { title: 'Point client', date: '2026-10-02', start: '10:00', end: '11:00' });
    await seedEvent(h, { title: 'Comité de direction', date: '2026-11-05', repeat: 'monthly' });
    await seedEvent(h, { title: 'Janvier', date: '2026-01-15' });
    renderEvents(h.container);
    expect(await screen.findByRole('heading', { name: 'janvier', level: 2 })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'octobre', level: 2 })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'novembre', level: 2 })).toBeInTheDocument();
    // Série mensuelle : une ligne par mois à partir de novembre, jusqu’en décembre (D4).
    expect(titles()).toEqual(['Janvier', 'Hier', 'Point client', 'Comité de direction', 'Comité de direction']);
    expect(rowOf('Hier')).toHaveAttribute('data-past', 'true');
    expect(rowOf('Janvier')).toHaveAttribute('data-past', 'true');
    expect(rowOf('Point client')).not.toHaveAttribute('data-past');
    expect(within(rowOf('Point client')).getByText('Aujourd’hui')).toBeInTheDocument();
    expect(within(rowOf('Point client')).getByText('10:00 – 11:00 · Pro')).toBeInTheDocument();
    expect(within(rowOf('Hier')).getByText('Journée entière · Pro')).toBeInTheDocument();
  });

  it('état vide « Aucun événement en 2026 » et navigation d’année ← →', async () => {
    renderEvents(h.container);
    expect(await screen.findByText('Aucun événement en 2026')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Année suivante' }));
    expect(await screen.findByText('Aucun événement en 2027')).toBeInTheDocument();
    expect(screen.getByText('2027')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Année précédente' }));
    fireEvent.click(screen.getByRole('button', { name: 'Année précédente' }));
    expect(await screen.findByText('Aucun événement en 2025')).toBeInTheDocument();
  });

  it('un événement annuel apparaît chaque année, une série mensuelle ne remonte pas avant son début', async () => {
    await seedEvent(h, { title: 'Anniversaire', date: '2024-03-10', repeat: 'yearly' });
    renderEvents(h.container);
    expect(await screen.findByText('Anniversaire')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Année suivante' }));
    await waitFor(() => expect(screen.getByText('2027')).toBeInTheDocument());
    expect(await screen.findByText('Anniversaire')).toBeInTheDocument();
    for (let i = 0; i < 4; i += 1) fireEvent.click(screen.getByRole('button', { name: 'Année précédente' }));
    expect(await screen.findByText('Aucun événement en 2023')).toBeInTheDocument();
  });

  it('pastilles Pro / Perso / Tout : la liste suit le filtre ; l’espace est écrit sous « Tout » (critère 10)', async () => {
    await seedEvent(h, { title: 'Réunion Pro', date: '2026-10-10' });
    await seedEvent(h, { title: 'Dîner Perso', date: '2026-10-11', spaceId: SPACE_PERSO_ID });
    renderEvents(h.container);
    await screen.findByText('Réunion Pro');
    expect(within(rowOf('Dîner Perso')).getByText('Journée entière · Perso')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Perso', pressed: false }));
    await waitFor(() => expect(titles()).toEqual(['Dîner Perso']));
    expect(within(rowOf('Dîner Perso')).getByText('Journée entière')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Pro', pressed: false }));
    await waitFor(() => expect(titles()).toEqual(['Réunion Pro']));
  });

  it('sous un filtre projet, aucun événement (critère 10)', async () => {
    await seedEvent(h, { title: 'Réunion Pro', date: '2026-10-10' });
    const project = await seedProject(h, SPACE_PRO_ID, 'Mission');
    useAppStore.getState().setSpaceFilter(SPACE_PRO_ID);
    useAppStore.getState().setProjectFilter(project.id);
    renderEvents(h.container);
    expect(await screen.findByText(/Les événements n’ont pas de projet/)).toBeInTheDocument();
    expect(titles()).toEqual([]);
  });

  it('les événements d’un agenda externe sont en lecture seule, avec leur source (critère 1)', async () => {
    useAppStore.getState().setTimeZone('Europe/Paris');
    await insertCalendarAccount(h.db.driver, { id: 'acc', provider: 'google', label: 'Google Agenda', calendars: [{ id: 'pro', name: 'Travail', spaceId: SPACE_PRO_ID, shown: true }] });
    await insertExternalEvent(h.db.driver, { id: 'ext-1', accountId: 'acc', calendarId: 'pro', title: 'Point externe', startUtc: '2026-10-12T08:00:00Z', endUtc: '2026-10-12T09:00:00Z' });
    renderEvents(h.container);
    const title = await screen.findByText('Point externe');
    const row = title.closest('.ct-event-row') as HTMLElement;
    expect(row.tagName).toBe('DIV');
    expect(row).toHaveTextContent('10:00 – 11:00 · Google Agenda');
    expect(within(row).queryByRole('button')).toBeNull();
  });

  it('ouvre la fiche d’un événement local, modifie toute la série, le titre est obligatoire (critères 6 et 7)', async () => {
    const event = await seedEvent(h, { title: 'Comité', date: '2026-10-05', repeat: 'monthly' });
    renderEvents(h.container);
    fireEvent.click(await screen.findAllByRole('button', { name: /Comité/ }).then((nodes) => nodes[0] as HTMLElement));
    const dialog = await screen.findByRole('dialog', { name: 'Modifier l’événement' });
    const save = within(dialog).getByRole('button', { name: 'Enregistrer' });
    expect(within(dialog).getByRole('radio', { name: 'Mensuel' })).toBeChecked();
    expect(within(dialog).getByText('La modification s’applique à toute la série.')).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Titre'), { target: { value: '   ' } });
    expect(save).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Titre'), { target: { value: 'Comité stratégique' } });
    fireEvent.click(save);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect((await h.container.data.repos.events.getById(event.id))?.title).toBe('Comité stratégique');
    expect(await screen.findAllByText('Comité stratégique')).toHaveLength(3);
  });

  it('suppression avec confirmation puis « Annuler » restaure la série (critère 7)', async () => {
    const event = await seedEvent(h, { title: 'Comité', date: '2026-10-05', reminderOffsets: [1440] });
    renderEvents(h.container);
    fireEvent.click(await screen.findByRole('button', { name: /Comité/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Modifier l’événement' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Supprimer l’événement' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Supprimer' }));
    await waitFor(() => expect(titles()).toEqual([]));
    expect(await h.container.data.repos.events.getById(event.id)).toBeNull();
    expect(await h.container.data.repos.reminders.listForTarget({ type: 'event', id: event.id })).toEqual([]);
    fireEvent.click(await screen.findByRole('button', { name: 'Annuler' }));
    await waitFor(() => expect(titles()).toEqual(['Comité']));
    expect(await h.container.data.repos.reminders.listForTarget({ type: 'event', id: event.id })).toHaveLength(1);
  });
});

describe('Événements : feuille « Nouvel événement » (E-01), iPhone', () => {
  let h: EventsHarness;

  beforeEach(async () => {
    h = await setupEvents('402');
    mockViewport(440);
  });
  afterEach(() => teardownEvents(h));

  async function openSheet(): Promise<HTMLElement> {
    renderEvents(h.container);
    fireEvent.click(await screen.findByRole('button', { name: 'Ajouter un événement' }));
    return screen.findByRole('dialog', { name: 'Nouvel événement' });
  }

  it('« + » ouvre la feuille au segment Événement ; changer de segment conserve le titre (critère 2)', async () => {
    const sheet = await openSheet();
    expect(within(sheet).getByRole('button', { name: 'Événement', pressed: true })).toBeInTheDocument();
    fireEvent.change(within(sheet).getByLabelText('Titre'), { target: { value: 'Dîner' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Tâche' }));
    const task = await screen.findByRole('dialog', { name: 'Nouvelle tâche' });
    expect(within(task).getByLabelText('Titre')).toHaveValue('Dîner');
    fireEvent.click(within(task).getByRole('button', { name: 'Routine' }));
    const routine = await screen.findByRole('dialog', { name: 'Nouvelle routine' });
    expect(within(routine).getByLabelText('Nom de la routine')).toHaveValue('Dîner');
    fireEvent.click(within(routine).getByRole('button', { name: 'Événement' }));
    const back = await screen.findByRole('dialog', { name: 'Nouvel événement' });
    expect(within(back).getByLabelText('Titre')).toHaveValue('Dîner');
  });

  it('journée entière cochée par défaut : un seul jour sans heure ; décochée : Début et Fin, durée d’une heure (critère 3)', async () => {
    const sheet = await openSheet();
    const allDay = within(sheet).getByRole('checkbox', { name: /Journée entière/ });
    expect(allDay).toBeChecked();
    expect(within(sheet).getByRole('spinbutton', { name: 'Mois' })).toBeInTheDocument();
    expect(within(sheet).queryByText('Début')).toBeNull();
    fireEvent.click(allDay);
    expect(within(sheet).getByText('Début')).toBeInTheDocument();
    expect(within(sheet).getByText('Fin')).toBeInTheDocument();
    expect(within(sheet).queryByRole('spinbutton', { name: 'Mois' })).toBeNull();
    fireEvent.change(within(sheet).getByLabelText('Titre'), { target: { value: 'Point client' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Enregistrer' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const [event] = await h.container.data.repos.events.listCandidatesForRange({ from: h.today, to: h.today }, 'all');
    expect(event).toMatchObject({ title: 'Point client', allDay: false, startDate: h.today, startTime: '09:00', endDate: h.today, endTime: '10:00' });
  });

  it('enregistre un événement journée entière dans l’espace par défaut, avec répétition et rappels (critères 4, 5, 6)', async () => {
    const sheet = await openSheet();
    fireEvent.change(within(sheet).getByLabelText('Titre'), { target: { value: '  Anniversaire du club  ' } });
    fireEvent.click(within(sheet).getByRole('radio', { name: 'Annuel' }));
    fireEvent.click(within(sheet).getByRole('checkbox', { name: '1 semaine avant' }));
    fireEvent.click(within(sheet).getByRole('checkbox', { name: 'La veille' }));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Perso' }));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Enregistrer' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const [event] = await h.container.data.repos.events.listCandidatesForRange({ from: h.today, to: h.today }, 'all');
    if (!event) throw new Error('événement absent');
    expect(event).toMatchObject({ title: 'Anniversaire du club', spaceId: SPACE_PERSO_ID, repeat: 'yearly', allDay: true, startTime: null, kind: 'event' });
    const reminders = await h.container.data.repos.reminders.listForTarget({ type: 'event', id: event.id });
    expect(reminders.map((r) => r.offsetMin).sort((a, b) => a - b)).toEqual([1440, 10080]);
    expect(reminders.every((r) => r.fireAt.endsWith('T09:00'))).toBe(true);
    expect(await screen.findByText('Anniversaire du club')).toBeInTheDocument();
  });

  it('« Enregistrer » est inactif sans titre ; le titre est limité à 200 caractères (critère 6)', async () => {
    const sheet = await openSheet();
    expect(within(sheet).getByRole('button', { name: 'Enregistrer' })).toBeDisabled();
    expect(within(sheet).getByLabelText('Titre')).toHaveAttribute('maxlength', '200');
  });

  it('espace préselectionné : le filtre actif (ES-02)', async () => {
    useAppStore.getState().setSpaceFilter(SPACE_PERSO_ID);
    const sheet = await openSheet();
    expect(within(sheet).getByRole('button', { name: 'Perso', pressed: true })).toBeInTheDocument();
  });

  it('un événement créé hors du filtre actif annonce « Ajouté dans … » (ES-02 critère 4)', async () => {
    useAppStore.getState().setSpaceFilter(SPACE_PERSO_ID);
    const sheet = await openSheet();
    fireEvent.change(within(sheet).getByLabelText('Titre'), { target: { value: 'Réunion' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Pro' }));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Enregistrer' }));
    expect(await screen.findByText('Ajouté dans Pro')).toBeInTheDocument();
  });

  it('« Calendrier » ouvre la grille du mois en feuille ; toucher un jour ferme la feuille (critère 8)', async () => {
    await seedEvent(h, { title: 'Réunion', date: '2026-10-10' });
    renderEvents(h.container);
    fireEvent.click(await screen.findByRole('button', { name: 'Calendrier' }));
    const sheet = await screen.findByRole('dialog', { name: 'Calendrier' });
    expect(within(sheet).getByRole('heading', { name: 'Octobre 2026' })).toBeInTheDocument();
    expect(within(sheet).getAllByTestId('event-dot')).toHaveLength(1);
    fireEvent.click(within(sheet).getByRole('button', { name: '10 octobre, avec des événements' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('un événement ouvert depuis Aujourd’hui (navigation) affiche la fiche (critère 7)', async () => {
    const event = await seedEvent(h, { title: 'Comité', date: '2026-10-05' });
    renderEvents(h.container);
    await screen.findByText('Comité');
    useNavigationStore.getState().openDetail({ type: 'event', id: event.id });
    expect(await screen.findByRole('dialog', { name: 'Modifier l’événement' })).toBeInTheDocument();
  });
});

describe('Événements : PC (E-01 critères 8 et 9)', () => {
  let h: EventsHarness;

  beforeEach(async () => {
    h = await setupEvents('403');
    mockViewport(1440);
    Element.prototype.scrollTo = vi.fn();
  });
  afterEach(() => {
    Reflect.deleteProperty(Element.prototype, 'scrollTo');
    return teardownEvents(h);
  });

  it('volet droit : grille du mois avec un point par espace et par jour, carte des agendas sans compte', async () => {
    await seedEvent(h, { title: 'Réunion Pro', date: '2026-10-10' });
    await seedEvent(h, { title: 'Dîner Perso', date: '2026-10-10', spaceId: SPACE_PERSO_ID });
    await seedEvent(h, { title: 'Autre', date: '2026-10-20' });
    renderEvents(h.container);
    const aside = await screen.findByRole('complementary', { name: 'Calendrier' });
    expect(within(aside).getByRole('heading', { name: 'Octobre 2026' })).toBeInTheDocument();
    const day10 = within(aside).getByRole('button', { name: '10 octobre, avec des événements' });
    expect(within(day10).getAllByTestId('event-dot')).toHaveLength(2);
    expect(within(within(aside).getByRole('button', { name: '20 octobre, avec des événements' })).getAllByTestId('event-dot')).toHaveLength(1);
    expect(within(aside).getByRole('button', { name: '11 octobre' })).toBeInTheDocument();
    expect(within(aside).getByText('Agendas affichés')).toBeInTheDocument();
    expect(within(aside).getByText('Aucun agenda connecté')).toBeInTheDocument();
    fireEvent.click(within(aside).getByRole('button', { name: 'Réglages' }));
    expect(useNavigationStore.getState().route).toMatchObject({ tab: 'settings' });
  });

  it('cliquer un jour fait défiler la liste jusqu’à lui ; les flèches changent de mois', async () => {
    await seedEvent(h, { title: 'Réunion', date: '2026-10-10' });
    await seedEvent(h, { title: 'Plus tard', date: '2026-12-01' });
    renderEvents(h.container);
    const aside = await screen.findByRole('complementary', { name: 'Calendrier' });
    await screen.findByText('Réunion');
    const spy = Element.prototype.scrollTo as ReturnType<typeof vi.fn>;
    spy.mockClear();
    fireEvent.click(within(aside).getByRole('button', { name: '10 octobre, avec des événements' }));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy.mock.contexts.at(-1)).toBe(document.querySelector('.ct-events__list'));
    fireEvent.click(within(aside).getByRole('button', { name: 'Mois suivant' }));
    fireEvent.click(within(aside).getByRole('button', { name: 'Mois suivant' }));
    expect(within(aside).getByRole('heading', { name: 'Décembre 2026' })).toBeInTheDocument();
    fireEvent.click(within(aside).getByRole('button', { name: 'Mois suivant' }));
    expect(await screen.findByText('2027')).toBeInTheDocument();
    expect(within(aside).getByRole('heading', { name: 'Janvier 2027' })).toBeInTheDocument();
  });

  it('Ctrl+N ouvre la feuille Ajout au segment Événement ; la fiche s’ouvre à droite (critères 2 et 7)', async () => {
    const event = await seedEvent(h, { title: 'Comité', date: '2026-10-05' });
    renderEvents(h.container);
    await screen.findByText('Comité');
    expect(h.container.shortcuts.handle({ key: 'n', code: 'KeyN', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false, editable: false })).toBe('app.newTask');
    const sheet = await screen.findByRole('dialog', { name: 'Nouvel événement' });
    expect(within(sheet).getByRole('button', { name: 'Événement', pressed: true })).toBeInTheDocument();
    fireEvent.keyDown(sheet, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    useNavigationStore.getState().openDetail({ type: 'event', id: event.id });
    expect(await screen.findByRole('complementary', { name: 'Modifier l’événement' })).toBeInTheDocument();
  });
});
