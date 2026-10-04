import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SPACE_PERSO_ID } from '../../db/seed/defaultSpaces';
import { useAppStore } from '../app/appStore';
import { renderToday } from '../today/testKit';
import { mockViewport, renderEvents, seedEvent, setupEvents, teardownEvents, type EventsHarness } from './testKit';
import { registerEventsSource, unregisterEventsSource } from './eventsSource';

const subtitleOf = (title: string): string => screen.getByText(title, { selector: '.ct-event-row__title' }).closest('.ct-event-row')?.querySelector('.ct-event-row__subtitle')?.textContent?.replace(/ · (Pro|Perso)$/, '') ?? '';

/** Règle une roue (spinbutton) : flèche haut = élément suivant. */
function press(wheel: HTMLElement, key: string, times: number): void {
  for (let i = 0; i < times; i += 1) fireEvent.keyDown(wheel, { key });
}

describe('Anniversaire et date importante (E-02), iPhone', () => {
  let h: EventsHarness;

  beforeEach(async () => {
    h = await setupEvents('431');
    mockViewport(440);
  });
  afterEach(() => teardownEvents(h));

  async function openSheet(): Promise<HTMLElement> {
    renderEvents(h.container);
    fireEvent.click(await screen.findByRole('button', { name: 'Ajouter un événement' }));
    return screen.findByRole('dialog', { name: 'Nouvel événement' });
  }

  it('type « Anniversaire » : répétition Annuel imposée et grisée, journée entière implicite, icône gâteau, rappels et défauts (critères 1, 6)', async () => {
    const sheet = await openSheet();
    expect(within(sheet).getByRole('radio', { name: 'Événement' })).toBeChecked();
    expect(within(sheet).getByRole('radio', { name: 'Une fois' })).toBeEnabled();
    fireEvent.click(within(sheet).getByRole('radio', { name: 'Anniversaire' }));
    expect(within(sheet).getByRole('radio', { name: 'Annuel' })).toBeChecked();
    expect(within(sheet).getByRole('radio', { name: 'Annuel' })).toBeDisabled();
    expect(within(sheet).getByRole('radio', { name: 'Mensuel' })).toBeDisabled();
    expect(within(sheet).queryByRole('checkbox', { name: /Journée entière/ })).toBeNull();
    expect(within(sheet).getByRole('button', { name: /Icône gâteau/ })).toHaveAttribute('aria-pressed', 'true');
    expect(within(sheet).getByRole('checkbox', { name: 'La veille' })).toBeChecked();
    expect(within(sheet).getByRole('checkbox', { name: 'Le jour même' })).toBeChecked();
    expect(within(sheet).getByRole('checkbox', { name: '1 semaine avant' })).not.toBeChecked();
    fireEvent.click(within(sheet).getByRole('radio', { name: 'Date importante' }));
    expect(within(sheet).getByRole('button', { name: /Icône étoile/ })).toHaveAttribute('aria-pressed', 'true');
    expect(within(sheet).getByRole('checkbox', { name: 'La veille' })).toBeChecked();
  });

  it('année 1992 : « Annuel · 34 ans » en 2026, « 35 ans » en 2027, « Sans année » sans âge (critères 2, 3, 5)', async () => {
    const sheet = await openSheet();
    fireEvent.change(within(sheet).getByLabelText('Titre'), { target: { value: 'Anniversaire de Karim' } });
    fireEvent.click(within(sheet).getByRole('radio', { name: 'Anniversaire' }));
    const year = within(sheet).getByRole('spinbutton', { name: 'Année' });
    expect(year).toHaveAttribute('aria-valuetext', 'Sans année');
    // Jour et mois : 25 septembre ; année : 1992 (rang 1 + 92 après « Sans année »).
    press(within(sheet).getByRole('spinbutton', { name: 'Jour' }), 'ArrowUp', 23);
    press(within(sheet).getByRole('spinbutton', { name: 'Mois' }), 'ArrowDown', 1);
    press(year, 'ArrowUp', 93);
    expect(year).toHaveAttribute('aria-valuetext', '1992');
    fireEvent.click(within(sheet).getByRole('button', { name: 'Enregistrer' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const [stored] = await h.container.data.repos.events.listCandidatesForRange({ from: '1992-01-01' as never, to: '1992-12-31' as never }, 'all');
    expect(stored).toMatchObject({ kind: 'birthday', repeat: 'yearly', allDay: true, birthYear: 1992, startDate: '1992-09-25', important: true });
    expect(subtitleOf('Anniversaire de Karim')).toBe('Annuel · 34 ans');
    fireEvent.click(screen.getByRole('button', { name: 'Année suivante' }));
    await waitFor(() => expect(screen.getByText('2027')).toBeInTheDocument());
    await waitFor(() => expect(subtitleOf('Anniversaire de Karim')).toBe('Annuel · 35 ans'));
    // Rappels par défaut écrits : la veille et le jour même, à 09:00.
    const reminders = await h.container.data.repos.reminders.listForTarget({ type: 'event', id: (stored as NonNullable<typeof stored>).id });
    expect(reminders.map((r) => r.offsetMin).sort((a, b) => a - b)).toEqual([0, 1440]);
  });

  it('sans année : aucun âge nulle part ; l’événement est annuel à vie (critères 3, 5)', async () => {
    await seedEvent(h, { title: 'Fête du club', date: '2026-03-10', kind: 'birthday' });
    renderEvents(h.container);
    expect(await screen.findByText('Fête du club')).toBeInTheDocument();
    expect(subtitleOf('Fête du club')).toBe('Annuel');
    for (let i = 0; i < 3; i += 1) {
      fireEvent.click(screen.getByRole('button', { name: 'Année suivante' }));
      await waitFor(() => expect(screen.getByText(String(2027 + i))).toBeInTheDocument());
      expect(await screen.findByText('Fête du club')).toBeInTheDocument();
      expect(subtitleOf('Fête du club')).toBe('Annuel');
    }
  });

  it('date importante avec année : « 10 ans » ; l’âge de la naissance est « 0 an » puis « 1 an » (critère 4)', async () => {
    await seedEvent(h, { title: 'Mariage', date: '2016-06-01', kind: 'important', birthYear: 2016, repeat: 'yearly' });
    await seedEvent(h, { title: 'Naissance', date: '2025-03-01', kind: 'birthday', birthYear: 2025, repeat: 'yearly' });
    renderEvents(h.container);
    await screen.findByText('Mariage');
    expect(subtitleOf('Mariage')).toBe('Annuel · 10 ans');
    expect(subtitleOf('Naissance')).toBe('Annuel · 1 an');
  });

  it('modification : changer le type garde titre, espace et icône choisie, et n’ajoute pas de rappels (critère 7)', async () => {
    const event = await seedEvent(h, { title: 'Karim', date: '2026-10-20', spaceId: SPACE_PERSO_ID, icon: { kind: 'lucide', name: 'heart' } });
    renderEvents(h.container);
    fireEvent.click(await screen.findByRole('button', { name: /Karim/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Modifier l’événement' });
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Anniversaire' }));
    expect(within(dialog).getByLabelText('Titre')).toHaveValue('Karim');
    expect(within(dialog).getByRole('button', { name: 'Perso', pressed: true })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /Icône cœur/ })).toHaveAttribute('aria-pressed', 'true');
    expect(within(dialog).getByRole('checkbox', { name: 'La veille' })).not.toBeChecked();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Enregistrer' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await h.container.data.repos.events.getById(event.id)).toMatchObject({ kind: 'birthday', repeat: 'yearly', title: 'Karim', spaceId: SPACE_PERSO_ID, icon: { name: 'heart' }, startDate: '2026-10-20' });
  });

  it('repasser un anniversaire en événement : date au prochain jour, année de naissance retirée (critère 7)', async () => {
    const event = await seedEvent(h, { title: 'Karim', date: '1992-10-20', kind: 'birthday', birthYear: 1992, repeat: 'yearly' });
    renderEvents(h.container);
    fireEvent.click(await screen.findByRole('button', { name: /Karim/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Modifier l’événement' });
    expect(within(dialog).getByRole('spinbutton', { name: 'Année' })).toHaveAttribute('aria-valuetext', '1992');
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Événement' }));
    expect(within(dialog).getByRole('radio', { name: 'Une fois' })).toBeChecked();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Enregistrer' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await h.container.data.repos.events.getById(event.id)).toMatchObject({ kind: 'event', repeat: 'once', birthYear: null, startDate: '2026-10-20' });
  });

  it('le 29 févr. tombe le 28 les années non bissextiles (critère 5)', async () => {
    await seedEvent(h, { title: 'Bébé', date: '2024-02-29', kind: 'birthday', birthYear: 2024, repeat: 'yearly' });
    renderEvents(h.container);
    await screen.findByText('Bébé');
    expect(document.querySelector('[data-date="2026-02-28"]')).not.toBeNull();
    expect(subtitleOf('Bébé')).toBe('Annuel · 2 ans');
  });

  it('un anniversaire apparaît en bandeau #FBE7E4 dans Aujourd’hui à sa date (critère 5)', async () => {
    registerEventsSource();
    try {
      await seedEvent(h, { title: 'Anniversaire de Karim', date: '1992-10-02', kind: 'birthday', birthYear: 1992, repeat: 'yearly' });
      renderToday(h.container);
      const band = (await screen.findByText('Anniversaire de Karim')).closest('li');
      expect(band).toHaveAttribute('data-kind', 'birthday');
    } finally {
      unregisterEventsSource();
    }
  });

  it('le filtre d’espace s’applique aux anniversaires (critère 8)', async () => {
    await seedEvent(h, { title: 'Karim', date: '1992-10-20', kind: 'birthday', birthYear: 1992, repeat: 'yearly', spaceId: SPACE_PERSO_ID });
    useAppStore.getState().setSpaceFilter(SPACE_PERSO_ID);
    renderEvents(h.container);
    expect(await screen.findByText('Karim')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Pro', pressed: false }));
    await waitFor(() => expect(screen.queryByText('Karim')).toBeNull());
  });
});

describe('Année de naissance (E-02), PC', () => {
  let h: EventsHarness;

  beforeEach(async () => {
    h = await setupEvents('432');
    mockViewport(1440);
  });
  afterEach(() => teardownEvents(h));

  it('champ « Année de naissance » facultatif ; une année future ou hors plage bloque « Enregistrer » (critères 3, 4)', async () => {
    renderEvents(h.container);
    fireEvent.click(await screen.findByRole('button', { name: 'Ajouter' }));
    const sheet = await screen.findByRole('dialog', { name: 'Nouvel événement' });
    fireEvent.change(within(sheet).getByLabelText('Titre'), { target: { value: 'Karim' } });
    fireEvent.click(within(sheet).getByRole('radio', { name: 'Anniversaire' }));
    const save = within(sheet).getByRole('button', { name: 'Enregistrer' });
    const year = within(sheet).getByLabelText('Année de naissance (facultatif)');
    expect(year).toHaveAttribute('placeholder', 'Sans année');
    expect(save).toBeEnabled();
    fireEvent.change(year, { target: { value: '2999' } });
    expect(within(sheet).getByRole('alert')).toHaveTextContent('L’année de naissance ne peut pas être dans le futur.');
    expect(save).toBeDisabled();
    fireEvent.change(year, { target: { value: '19' } });
    expect(within(sheet).getByRole('alert')).toHaveTextContent('Année de naissance : entre 1900 et 2026.');
    expect(save).toBeDisabled();
    fireEvent.change(year, { target: { value: 'abc' } });
    expect(save).toBeDisabled();
    fireEvent.change(year, { target: { value: '' } });
    expect(save).toBeEnabled();
    fireEvent.change(year, { target: { value: '1992' } });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const [stored] = await h.container.data.repos.events.listCandidatesForRange({ from: '1992-01-01' as never, to: '1992-12-31' as never }, 'all');
    expect(stored).toMatchObject({ kind: 'birthday', birthYear: 1992, startDate: `1992-${h.today.slice(5)}` });
  });
});
