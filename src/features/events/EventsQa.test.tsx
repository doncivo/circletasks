import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateEvent } from '../../domain/eventRules';
import { ageAtOccurrence } from '../../domain/eventKinds';
import { makeEvent } from '../../domain/eventTestKit';
import { asLocalDate as d } from '../../domain/types';
import { mockViewport, renderEvents, seedEvent, setupEvents, teardownEvents, type EventsHarness } from './testKit';

describe('QA lot E : cas limites', () => {
  it('E-01 critère 3 : plage de plusieurs jours puis « journée entière » : un seul jour, sans heure (domaine)', () => {
    const base = makeEvent({ startDate: d('2026-10-05'), endDate: d('2026-10-08'), allDay: false, startTime: '09:00' as never, endTime: '10:00' as never });
    const result = validateEvent({ ...base, allDay: true });
    expect(result.ok && result.value).toMatchObject({ allDay: true, startDate: '2026-10-05', endDate: '2026-10-05', startTime: null, endTime: null });
  });

  it('E-01 critère 3 : fin avant début refusée', () => {
    const base = makeEvent({ startDate: d('2026-10-05'), endDate: d('2026-10-04'), allDay: false, startTime: '09:00' as never, endTime: '10:00' as never });
    expect(validateEvent(base)).toEqual({ ok: false, error: 'end-before-start' });
  });

  it('E-02 critère 2 : l’âge du jour de l’anniversaire et de la veille suit l’année de l’occurrence, jamais sans année', () => {
    expect(ageAtOccurrence({ kind: 'birthday', birthYear: 1992 }, d('2026-09-25'))).toBe(34);
    expect(ageAtOccurrence({ kind: 'birthday', birthYear: null }, d('2026-09-25'))).toBeNull();
    expect(ageAtOccurrence({ kind: 'event', birthYear: 1992 }, d('2026-09-25'))).toBeNull();
  });

  describe('écran', () => {
    let h: EventsHarness;
    beforeEach(async () => {
      h = await setupEvents('4a1');
      mockViewport(440);
    });
    afterEach(() => teardownEvents(h));

    it('E-01 critère 3 : événement sur plusieurs jours, case « commence et finit le même jour » : enregistré sur un seul jour', async () => {
      const event = await seedEvent(h, { title: 'Séminaire', date: '2026-10-12', endDate: '2026-10-14', start: '09:00', end: '17:00' });
      renderEvents(h.container);
      fireEvent.click((await screen.findAllByRole('button', { name: /Séminaire/ }))[0] as HTMLElement);
      const dialog = await screen.findByRole('dialog', { name: 'Modifier l’événement' });
      const allDay = within(dialog).getByRole('checkbox', { name: /Journée entière/ });
      expect(allDay).not.toBeChecked();
      fireEvent.click(allDay);
      expect(within(dialog).queryByText('Fin')).toBeNull();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Enregistrer' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(await h.container.data.repos.events.getById(event.id)).toMatchObject({ allDay: true, startDate: '2026-10-12', endDate: '2026-10-12', startTime: null, endTime: null });
    });

    it('E-01 critère 4 : mensuel un 31, la ligne de février tombe le 28', async () => {
      await seedEvent(h, { title: 'Loyer', date: '2026-01-31', repeat: 'monthly' });
      renderEvents(h.container);
      await screen.findAllByText('Loyer');
      expect(document.querySelector('[data-date="2026-02-28"]')).not.toBeNull();
      expect(document.querySelector('[data-date="2026-04-30"]')).not.toBeNull();
      expect(document.querySelector('[data-date="2026-10-31"]')).not.toBeNull();
    });

    it('E-02 critère 2 : anniversaire le jour même affiche « Annuel · 34 ans » et « Aujourd’hui »', async () => {
      await seedEvent(h, { title: 'Karim', date: '1992-10-02', kind: 'birthday', birthYear: 1992, repeat: 'yearly' });
      renderEvents(h.container);
      const row = (await screen.findByText('Karim', { selector: '.ct-event-row__title' })).closest('.ct-event-row') as HTMLElement;
      expect(within(row).getByText(/Annuel · 34 ans/)).toBeInTheDocument();
      expect(within(row).getByText('Aujourd’hui')).toBeInTheDocument();
    });
  });
});
