import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { insertCalendarAccount, insertExternalEvent, type FixtureExternalEvent } from '../../db/seed/externalEventFixtures';
import { asLocalDate } from '../../domain/types';
import { useAppStore } from '../app/appStore';
import type { KeyInput } from '../app/shortcuts';
import { mockViewport, renderWeek, seedTask, setupWeek, teardownWeek, type WeekHarness } from './testKit';

/** Cas limites QA du lot S : année, changement d'heure, Q11 au glisser, Ctrl+Z, fuseaux, filtre d'espace. */
const day = (iso: string): HTMLElement => document.querySelector<HTMLElement>(`[data-date="${iso}"]`) as HTMLElement;
const titlesOf = (iso: string): string[] => [...day(iso).querySelectorAll('.ct-week-item__title')].map((el) => el.textContent ?? '');
const eventsOf = (iso: string): string[] => [...day(iso).querySelectorAll('.ct-week-event')].map((el) => el.textContent ?? '');
const key = (k: string, mods: Partial<KeyInput> = {}): KeyInput => ({ key: k, code: k, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, editable: false, ...mods });

function pointer(target: EventTarget, type: string, x: number, y = 10): void {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
  Object.defineProperty(event, 'pointerType', { value: 'mouse' });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  act(() => {
    target.dispatchEvent(event);
  });
}

function stubLayout(): void {
  const dates = [...document.querySelectorAll<HTMLElement>('.ct-week-day')].map((el) => el.dataset['date'] ?? '');
  document.elementsFromPoint = (x: number) => {
    const date = dates[Math.floor(x / 100)];
    return date ? [day(date)] : [document.body];
  };
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const slots = [...(this.closest('.ct-week-day')?.querySelectorAll('[data-drag-id]') ?? [])];
    const top = Math.max(0, slots.indexOf(this)) * 40;
    return { top, bottom: top + 40, left: 0, right: 100, width: 100, height: 40, x: 0, y: top, toJSON: () => ({}) };
  });
}

describe('Semaine : cas limites QA (S-01 à S-05)', () => {
  let h: WeekHarness;
  const start = async (suffix: string, now: string, width = 1440): Promise<void> => {
    h = await setupWeek(suffix, now);
    useAppStore.getState().setTimeZone('Europe/Paris');
    mockViewport(width);
  };
  afterEach(async () => {
    useAppStore.setState({ timeZone: null });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await teardownWeek(h);
    delete (document as { elementsFromPoint?: unknown }).elementsFromPoint;
    vi.restoreAllMocks();
  });

  const seedAccount = (): Promise<void> =>
    insertCalendarAccount(h.db.driver, {
      id: 'acc',
      provider: 'google',
      label: 'Google Agenda',
      calendars: [
        { id: 'pro', name: 'Travail', spaceId: SPACE_PRO_ID, shown: true },
        { id: 'perso', name: 'Famille', spaceId: SPACE_PERSO_ID, shown: true },
      ],
    });
  const seedEvent = (e: Partial<FixtureExternalEvent> & Pick<FixtureExternalEvent, 'id' | 'title'>): Promise<void> =>
    insertExternalEvent(h.db.driver, { accountId: 'acc', calendarId: 'pro', startUtc: '2026-09-23T08:00:00Z', endUtc: '2026-09-23T09:00:00Z', ...e });

  it('S-01 c.2 / S-03 c.5 : semaine à cheval sur deux années, tâches du 31 déc. et du 1er janv. dans le bon jour (PC)', async () => {
    await start('401', '2026-12-30T10:00:00.000Z');
    await seedTask(h, { title: 'Réveillon', date: asLocalDate('2026-12-31') });
    await seedTask(h, { title: 'Jour de l’an', date: asLocalDate('2027-01-01') });
    renderWeek(h.container);
    await screen.findByText('Semaine 53');
    await screen.findByRole('button', { name: 'Jour de l’an' });
    expect([...document.querySelectorAll<HTMLElement>('.ct-week-day')].map((el) => el.dataset['date'])).toEqual([
      '2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02', '2027-01-03',
    ]);
    expect(titlesOf('2026-12-31')).toEqual(['Réveillon']);
    expect(titlesOf('2027-01-01')).toEqual(['Jour de l’an']);
  });

  it('S-03 c.5 : iPhone, plage « 28 déc. – 3 janv. » et « Semaine 53 · 2026 », puis semaine 1 de 2027', async () => {
    await start('402', '2026-12-30T10:00:00.000Z', 440);
    renderWeek(h.container);
    await screen.findByText('28 déc. – 3 janv.');
    expect(document.querySelector('.ct-week__caption')).toHaveTextContent('Semaine 53 · 2026');
    fireEvent.click(screen.getByRole('button', { name: 'Semaine suivante' }));
    expect(await screen.findByText('4 – 10 janv.')).toBeInTheDocument();
    await waitFor(() => expect(document.querySelector('.ct-week__caption')).toHaveTextContent('Semaine 1 · 2027'));
  });

  it('S-01 c.4 : changement d’heure (dim. 25 oct. 2026) : sept jours, 02:30 avant et après le recul restent le dimanche', async () => {
    await start('403', '2026-10-21T10:00:00.000Z');
    await seedAccount();
    await seedEvent({ id: 'avant', title: 'Avant recul', startUtc: '2026-10-25T00:30:00Z', endUtc: '2026-10-25T00:45:00Z' }); // 02:30 CEST
    await seedEvent({ id: 'apres', title: 'Apres recul', startUtc: '2026-10-25T01:30:00Z', endUtc: '2026-10-25T01:45:00Z' }); // 02:30 CET
    await seedEvent({ id: 'nuit', title: 'Fin de dimanche', startUtc: '2026-10-25T22:30:00Z', endUtc: '2026-10-25T22:45:00Z' }); // 23:30 CET
    await seedEvent({ id: 'lundi', title: 'Debut de lundi', startUtc: '2026-10-25T23:30:00Z', endUtc: '2026-10-25T23:45:00Z' }); // lundi 26 00:30
    await seedTask(h, { title: 'Dimanche matin', date: asLocalDate('2026-10-25'), time: '03:00' });
    renderWeek(h.container);
    await screen.findByText('Semaine 43');
    await screen.findByRole('button', { name: 'Dimanche matin' });
    expect(document.querySelectorAll('.ct-week-day')).toHaveLength(7);
    const sunday = eventsOf('2026-10-25');
    expect(sunday).toHaveLength(3);
    // Les deux 02:30 (CEST puis CET) ont la même heure locale : leur ordre relatif n'est pas affirmé, seul leur jour l'est.
    expect(sunday.slice(0, 2).every((text) => text.startsWith('02:30'))).toBe(true);
    expect(sunday.slice(0, 2).join('|')).toMatch(/Avant recul/);
    expect(sunday.slice(0, 2).join('|')).toMatch(/Apres recul/);
    expect(sunday[2]).toContain('23:30 Fin de dimanche');
    expect(eventsOf('2026-10-19')).toEqual([]);
  });

  it('S-02 c.10 / Q11 : glisser une tâche à 12:00 vers un jour chargé la place à son heure, avant les tâches sans heure', async () => {
    await start('404', '2026-10-02T10:00:00.000Z');
    await seedTask(h, { title: 'Tôt', date: asLocalDate('2026-10-01'), time: '08:00' });
    await seedTask(h, { title: 'Libre', date: asLocalDate('2026-10-01') });
    await seedTask(h, { title: 'Tard', date: asLocalDate('2026-10-01'), time: '18:00' });
    const moved = await seedTask(h, { title: 'Midi', date: asLocalDate('2026-09-30'), time: '12:00' });
    renderWeek(h.container);
    const card = (await screen.findByRole('button', { name: 'Midi' })).closest('[data-drag-id]') as HTMLElement;
    expect(titlesOf('2026-10-01')).toEqual(['Tôt', 'Tard', 'Libre']);
    stubLayout();
    pointer(card, 'pointerdown', 250);
    pointer(window, 'pointermove', 350, 150);
    pointer(window, 'pointerup', 350, 150);
    await waitFor(() => expect(titlesOf('2026-10-01')).toEqual(['Tôt', 'Midi', 'Tard', 'Libre']));
    expect(titlesOf('2026-09-30')).toEqual([]);
    expect(await h.container.data.repos.tasks.getById(moved.id)).toMatchObject({ date: '2026-10-01', time: '12:00' });
  });

  it('S-02 c.3 : glisser puis Ctrl+Z remet la tâche à son jour et à sa position', async () => {
    await start('405', '2026-10-02T10:00:00.000Z');
    await seedTask(h, { title: 'Premier', date: asLocalDate('2026-09-30') });
    const second = await seedTask(h, { title: 'Envoyer la facture', date: asLocalDate('2026-09-30') });
    renderWeek(h.container);
    const card = (await screen.findByRole('button', { name: 'Envoyer la facture' })).closest('[data-drag-id]') as HTMLElement;
    stubLayout();
    pointer(card, 'pointerdown', 250, 50);
    pointer(window, 'pointermove', 350, 20);
    pointer(window, 'pointerup', 350, 20);
    await waitFor(() => expect(titlesOf('2026-10-01')).toEqual(['Envoyer la facture']));
    expect(titlesOf('2026-09-30')).toEqual(['Premier']);
    act(() => {
      h.container.shortcuts.handle(key('z', { ctrlKey: true }));
    });
    await waitFor(() => expect(titlesOf('2026-09-30')).toEqual(['Premier', 'Envoyer la facture']));
    expect(titlesOf('2026-10-01')).toEqual([]);
    expect((await h.container.data.repos.tasks.getById(second.id))?.date).toBe('2026-09-30');
  });

  it('S-05 c.1 : un événement 22:30Z du 23 sept. (Paris) est le jeu. 24 à 00:30, pas le mer. 23', async () => {
    await start('406', '2026-09-23T10:00:00.000Z');
    await seedAccount();
    await seedEvent({ id: 'e', title: 'Nuit', startUtc: '2026-09-23T22:30:00Z', endUtc: '2026-09-23T23:30:00Z' });
    renderWeek(h.container);
    await screen.findByText('00:30 Nuit');
    expect(eventsOf('2026-09-24')).toHaveLength(1);
    expect(eventsOf('2026-09-23')).toEqual([]);
  });

  it('S-05 c.5 : un événement à cheval sur minuit local (23:30 à 00:30 Paris) s’affiche sur les deux jours', async () => {
    await start('407', '2026-09-23T10:00:00.000Z');
    await seedAccount();
    await seedEvent({ id: 'e', title: 'Soirée', startUtc: '2026-09-23T21:30:00Z', endUtc: '2026-09-23T22:30:00Z' });
    renderWeek(h.container);
    await screen.findAllByText(/Soirée/);
    expect(eventsOf('2026-09-23')).toHaveLength(1);
    expect(eventsOf('2026-09-24')).toHaveLength(1);
    expect(eventsOf('2026-09-25')).toEqual([]);
  });

  it('S-05 : un changement de fuseau déplace l’événement d’un jour à l’autre (Paris jeu. 24, Tunis mer. 23, Tokyo jeu. 24)', async () => {
    await start('408', '2026-09-23T10:00:00.000Z');
    await seedAccount();
    await seedEvent({ id: 'e', title: 'Nuit', startUtc: '2026-09-23T22:30:00Z', endUtc: '2026-09-23T22:45:00Z' });
    renderWeek(h.container);
    await screen.findByText('00:30 Nuit');
    expect(eventsOf('2026-09-24')).toHaveLength(1);
    act(() => useAppStore.getState().setTimeZone('Africa/Tunis'));
    await screen.findByText('23:30 Nuit');
    expect(eventsOf('2026-09-23')).toHaveLength(1);
    expect(eventsOf('2026-09-24')).toEqual([]);
    act(() => useAppStore.getState().setTimeZone('Asia/Tokyo'));
    await screen.findByText('07:30 Nuit');
    expect(eventsOf('2026-09-24')).toHaveLength(1);
    expect(eventsOf('2026-09-23')).toEqual([]);
  });

  it('S-05 c.4 : une journée entière n’est jamais décalée par un fuseau extrême (+14 h, -11 h)', async () => {
    await start('409', '2026-09-23T10:00:00.000Z');
    await seedAccount();
    await seedEvent({ id: 'c', title: 'Congé', allDay: true, startUtc: '2026-09-23T00:00:00Z', endUtc: '2026-09-24T00:00:00Z' });
    renderWeek(h.container);
    await screen.findByText(/Congé/);
    for (const zone of ['Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
      act(() => useAppStore.getState().setTimeZone(zone));
      await waitFor(() => expect(eventsOf('2026-09-23')).toHaveLength(1));
      expect(eventsOf('2026-09-24')).toEqual([]);
      expect(eventsOf('2026-09-22')).toEqual([]);
    }
  });

  it('S-05 c.7 / S-01 c.6 : le filtre Perso masque l’événement d’un agenda Pro et inversement, « Tout » montre les deux', async () => {
    await start('410', '2026-09-23T10:00:00.000Z');
    await seedAccount();
    await seedEvent({ id: 'p', title: 'Réunion pro', calendarId: 'pro' });
    await seedEvent({ id: 'f', title: 'Dîner famille', calendarId: 'perso', startUtc: '2026-09-23T17:00:00Z', endUtc: '2026-09-23T18:00:00Z' });
    await seedTask(h, { title: 'Tâche pro', date: asLocalDate('2026-09-23'), spaceId: SPACE_PRO_ID });
    await seedTask(h, { title: 'Tâche perso', date: asLocalDate('2026-09-23'), spaceId: SPACE_PERSO_ID });
    renderWeek(h.container);
    await screen.findByText(/Réunion pro/);
    expect(eventsOf('2026-09-23')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Perso' }));
    await waitFor(() => expect(eventsOf('2026-09-23')).toHaveLength(1));
    expect(eventsOf('2026-09-23')[0]).toContain('Dîner famille');
    expect(titlesOf('2026-09-23').filter((t) => !t.includes('Dîner'))).toEqual(['Tâche perso']);
    fireEvent.click(screen.getByRole('button', { name: 'Pro' }));
    await waitFor(() => expect(eventsOf('2026-09-23')[0]).toContain('Réunion pro'));
    expect(eventsOf('2026-09-23')).toHaveLength(1);
    expect(within(day('2026-09-23')).queryByText('Tâche perso')).not.toBeInTheDocument();
  });
});
