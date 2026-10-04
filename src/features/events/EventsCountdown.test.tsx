import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { insertCalendarAccount, insertExternalEvent } from '../../db/seed/externalEventFixtures';
import { useAppStore } from '../app/appStore';
import { renderToday } from '../today/testKit';
import { renderWeek } from '../week/testKit';
import { registerEventsSource, unregisterEventsSource } from './eventsSource';
import { createEventUseCases } from './eventUseCases';
import { mockViewport, renderEvents, seedEvent, setupEvents, teardownEvents, type EventsHarness } from './testKit';

const rowOf = (title: string): HTMLElement => screen.getByText(title, { selector: '.ct-event-row__title' }).closest('.ct-event-row') as HTMLElement;
const tagOf = (title: string): HTMLElement | null => rowOf(title).querySelector<HTMLElement>('.ct-event-row__tag');

describe('Compte à rebours dans la liste Événements (E-04), iPhone', () => {
  let h: EventsHarness;

  beforeEach(async () => {
    h = await setupEvents('461');
    mockViewport(440);
  });
  afterEach(() => teardownEvents(h));

  it('« J-12 » à douze jours, lu « dans 12 jours » ; « J-1 » la veille ; « Aujourd’hui » le jour même ; rien après (critères 1, 2, 7)', async () => {
    await seedEvent(h, { title: 'Dans douze jours', date: '2026-10-14' });
    await seedEvent(h, { title: 'Demain', date: '2026-10-03' });
    await seedEvent(h, { title: 'Aujourd’hui même', date: '2026-10-02' });
    await seedEvent(h, { title: 'Hier', date: '2026-10-01' });
    renderEvents(h.container);
    await screen.findByText('Dans douze jours');
    expect(tagOf('Dans douze jours')).toHaveTextContent('J-12dans 12 jours');
    expect(within(tagOf('Dans douze jours') as HTMLElement).getByText('J-12')).toHaveAttribute('aria-hidden', 'true');
    expect(tagOf('Dans douze jours')).toHaveAttribute('data-tag', 'countdown');
    expect(tagOf('Demain')).toHaveTextContent('J-1dans 1 jour');
    expect(tagOf('Aujourd’hui même')).toHaveTextContent('Aujourd’hui');
    expect(tagOf('Aujourd’hui même')).toHaveAttribute('data-tag', 'today');
    expect(tagOf('Hier')).toBeNull();
  });

  it('un événement non important garde « J-n » dans la liste (D1, critère 5) ; un anniversaire a le fond #FBE7E4', async () => {
    await seedEvent(h, { title: 'Réunion', date: '2026-10-05', important: false });
    await seedEvent(h, { title: 'Anniversaire de Karim', date: '1992-10-04', kind: 'birthday', repeat: 'yearly', birthYear: 1992, important: true });
    renderEvents(h.container);
    await screen.findByText('Réunion');
    expect(tagOf('Réunion')).toHaveTextContent('J-3');
    expect(tagOf('Anniversaire de Karim')).toHaveTextContent('J-2');
    expect(tagOf('Anniversaire de Karim')).toHaveAttribute('data-tag', 'birthday');
  });

  it('une série : chaque ligne future compte vers sa propre date, les passées n’ont pas de tag (critère 6)', async () => {
    await seedEvent(h, { title: 'Comité', date: '2026-08-31', repeat: 'monthly' });
    renderEvents(h.container);
    await screen.findAllByText('Comité');
    const rows = screen.getAllByText('Comité', { selector: '.ct-event-row__title' }).map((node) => node.closest('.ct-event-row') as HTMLElement);
    const tags = rows.map((row) => [row.getAttribute('data-date'), row.querySelector('.ct-event-row__tag')?.textContent ?? null]);
    expect(tags).toEqual([
      ['2026-08-31', null],
      ['2026-09-30', null],
      ['2026-10-31', 'J-29dans 29 jours'],
      ['2026-11-30', 'J-59dans 59 jours'],
      ['2026-12-31', 'J-90dans 90 jours'],
    ]);
  });

  it('un événement d’un agenda externe affiche « J-n » dans la liste ; un jour férié garde son tag « Férié » (critère 8)', async () => {
    useAppStore.getState().setTimeZone('Europe/Paris');
    await insertCalendarAccount(h.db.driver, { id: 'acc', provider: 'google', label: 'Google Agenda', calendars: [{ id: 'pro', name: 'Travail', spaceId: SPACE_PRO_ID, shown: true }] });
    await insertExternalEvent(h.db.driver, { id: 'ext-1', accountId: 'acc', calendarId: 'pro', title: 'Point externe', startUtc: '2026-10-09T08:00:00Z', endUtc: '2026-10-09T09:00:00Z' });
    await h.container.data.repos.settings.set('holidays.countries', { FR: false, TN: true });
    renderEvents(h.container);
    await screen.findByText('Point externe');
    expect(tagOf('Point externe')).toHaveTextContent('J-7dans 7 jours');
    expect(tagOf('Fête de l’Évacuation')).toHaveTextContent('Férié TN');
    expect(tagOf('Fête de l’Évacuation')).not.toHaveTextContent('J-');
  });

  it('minuit passé : les tags se mettent à jour sans relancer l’app (horloge injectable, critère 3)', async () => {
    await seedEvent(h, { title: 'Dans douze jours', date: '2026-10-14' });
    renderEvents(h.container);
    await screen.findByText('Dans douze jours');
    expect(tagOf('Dans douze jours')).toHaveTextContent('J-12');
    act(() => useAppStore.getState().setDay('2026-10-03' as never));
    await waitFor(() => expect(tagOf('Dans douze jours')).toHaveTextContent('J-11'));
    act(() => useAppStore.getState().setDay('2026-10-14' as never));
    await waitFor(() => expect(tagOf('Dans douze jours')).toHaveTextContent('Aujourd’hui'));
    act(() => useAppStore.getState().setDay('2026-10-15' as never));
    await waitFor(() => expect(tagOf('Dans douze jours')).toBeNull());
  });
});

describe('Interrupteur « Compte à rebours » (E-04 critères 5 et 7), iPhone', () => {
  let h: EventsHarness;

  beforeEach(async () => {
    h = await setupEvents('462');
    mockViewport(440);
  });
  afterEach(() => teardownEvents(h));

  async function openSheet(): Promise<HTMLElement> {
    renderEvents(h.container);
    fireEvent.click(await screen.findByRole('button', { name: 'Ajouter un événement' }));
    return screen.findByRole('dialog', { name: 'Nouvel événement' });
  }

  it('bouton à état « Afficher le compte à rebours » : désactivé pour un événement, activé d’office pour un anniversaire (D2)', async () => {
    const sheet = await openSheet();
    const toggle = within(sheet).getByRole('button', { name: 'Afficher le compte à rebours' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(within(sheet).getByText('Compte à rebours (Aujourd’hui)')).toBeInTheDocument();
    fireEvent.click(within(sheet).getByRole('radio', { name: 'Anniversaire' }));
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(within(sheet).getByRole('radio', { name: 'Date importante' }));
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(within(sheet).getByRole('radio', { name: 'Événement' }));
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
  });

  it('le libellé affiche l’aperçu « (J-n) » de la date saisie', async () => {
    const sheet = await openSheet();
    fireEvent.click(within(sheet).getByRole('radio', { name: 'Anniversaire' }));
    // Jour du 2 oct. (aujourd'hui) puis 4 : deux crans en avant sur la roue des jours.
    const day = within(sheet).getByRole('spinbutton', { name: 'Jour' });
    fireEvent.keyDown(day, { key: 'ArrowUp' });
    fireEvent.keyDown(day, { key: 'ArrowUp' });
    expect(within(sheet).getByText('Compte à rebours (J-2)')).toBeInTheDocument();
  });

  it('enregistre l’état de l’interrupteur dans le champ « important » (critère 5)', async () => {
    const sheet = await openSheet();
    fireEvent.change(within(sheet).getByLabelText('Titre'), { target: { value: 'Échéance' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Afficher le compte à rebours' }));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Enregistrer' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const [event] = await h.container.data.repos.events.listCandidatesForRange({ from: h.today, to: h.today }, 'all');
    expect(event).toMatchObject({ title: 'Échéance', important: true });
  });

  it('la fiche d’un événement important affiche « J-n » (série : prochaine occurrence) ; sans compte à rebours, pas de tag (critères 1, 6)', async () => {
    await seedEvent(h, { title: 'Comité', date: '2026-08-05', repeat: 'monthly', important: true });
    await seedEvent(h, { title: 'Simple', date: '2026-10-20' });
    renderEvents(h.container);
    fireEvent.click((await screen.findAllByRole('button', { name: /Comité/ }))[0] as HTMLElement);
    const dialog = await screen.findByRole('dialog', { name: 'Modifier l’événement' });
    // Prochaine occurrence : le 5 octobre, dans 3 jours.
    expect(within(dialog).getByText('J-3')).toBeInTheDocument();
    expect(within(dialog).getByText('dans 3 jours')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Afficher le compte à rebours' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Fermer' }));
    fireEvent.click(await screen.findByRole('button', { name: /Simple/ }));
    const second = await screen.findByRole('dialog', { name: 'Modifier l’événement' });
    expect(within(second).queryByText(/^J-/)).toBeNull();
    expect(within(second).getByRole('button', { name: 'Afficher le compte à rebours' })).toHaveAttribute('aria-pressed', 'false');
  });
});

describe('Compte à rebours dans les bandeaux d’Aujourd’hui et de la Semaine (E-04 critères 4, 5, 8)', () => {
  let h: EventsHarness;

  beforeEach(async () => {
    h = await setupEvents('463');
    mockViewport(440);
    registerEventsSource();
  });
  afterEach(async () => {
    unregisterEventsSource();
    await teardownEvents(h);
  });

  const column = async (iso: string): Promise<HTMLElement> =>
    waitFor(() => {
      const node = document.querySelector<HTMLElement>(`[data-date="${iso}"]`);
      if (!node) throw new Error('colonne absente');
      return node;
    });

  it('la Semaine : « J-2 » sur l’événement important de vendredi ; rien sur un événement non important', async () => {
    await seedEvent(h, { title: 'Important', date: '2026-10-04', important: true });
    await seedEvent(h, { title: 'Ordinaire', date: '2026-10-04', important: false });
    renderWeek(h.container);
    const day = await column('2026-10-04');
    const important = (await within(day).findByText('Important')).closest('.ct-week-event') as HTMLElement;
    expect(important).toHaveTextContent('J-2dans 2 jours');
    const ordinary = within(day).getByText('Ordinaire').closest('.ct-week-event') as HTMLElement;
    expect(ordinary.querySelector('.ct-week-event__tag')).toBeNull();
  });

  it('Aujourd’hui : « Aujourd’hui » sur le bandeau important du jour ; rien sans compte à rebours', async () => {
    await seedEvent(h, { title: 'Anniversaire', date: '1992-10-02', kind: 'birthday', repeat: 'yearly', birthYear: 1992, important: true });
    await seedEvent(h, { title: 'Ordinaire', date: '2026-10-02', important: false });
    renderToday(h.container);
    const band = (await screen.findByText('Anniversaire')).closest('li') as HTMLElement;
    expect(band.querySelector('.ct-today-event__tag')).toHaveTextContent('Aujourd’hui');
    const ordinary = screen.getByText('Ordinaire').closest('li') as HTMLElement;
    expect(ordinary.querySelector('.ct-today-event__tag')).toBeNull();
  });

  it('désactiver l’interrupteur retire le tag des bandeaux sans toucher la liste Événements (critère 5)', async () => {
    const event = await seedEvent(h, { title: 'Important', date: '2026-10-04', important: true });
    renderWeek(h.container);
    const day = await column('2026-10-04');
    await within(day).findByText('Important');
    expect(day.querySelector('.ct-week-event__tag')).not.toBeNull();
    await act(async () => {
      await createEventUseCases(h.container).update(event.id, {
        fields: { spaceId: event.spaceId, title: event.title, startDate: event.startDate, startTime: null, endDate: event.endDate, endTime: null, allDay: true, kind: 'event', repeat: 'once', important: false, icon: null, birthYear: null },
        reminderOffsets: [],
      });
    });
    await waitFor(() => expect(day.querySelector('.ct-week-event__tag')).toBeNull());
  });

  it('un événement d’agenda externe et un jour férié n’affichent jamais de compte à rebours dans les bandeaux (critère 8)', async () => {
    h.db.clock.set('2026-10-14T10:00:00.000Z');
    useAppStore.getState().setTimeZone('Europe/Paris');
    await insertCalendarAccount(h.db.driver, { id: 'acc', provider: 'google', label: 'Google Agenda', calendars: [{ id: 'pro', name: 'Travail', spaceId: SPACE_PRO_ID, shown: true }] });
    await insertExternalEvent(h.db.driver, { id: 'ext-1', accountId: 'acc', calendarId: 'pro', title: 'Point externe', startUtc: '2026-10-15T08:00:00Z', endUtc: '2026-10-15T09:00:00Z' });
    await h.container.data.repos.settings.set('holidays.countries', { FR: false, TN: true });
    renderWeek(h.container);
    const day = await column('2026-10-15');
    await within(day).findByText('Point externe');
    await within(day).findByText('Fête de l’Évacuation');
    expect(day.querySelector('.ct-week-event__tag')).toBeNull();
  });
});
