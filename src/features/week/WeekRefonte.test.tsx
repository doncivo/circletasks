import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SPACE_PERSO_ID } from '../../db/seed/defaultSpaces';
import { insertCalendarAccount, insertExternalEvent } from '../../db/seed/externalEventFixtures';
import { asLocalDate } from '../../domain/types';
import { useAppStore } from '../app/appStore';
import { useNavigationStore } from '../app/navigation';
import { createTaskUseCases } from '../tasks/createTaskUseCases';
import { mockViewport, renderWeek, seedTask, setupWeek, teardownWeek, type WeekHarness } from './testKit';

/**
 * UI-REFONTE-03 — Semaine sur iPhone (docs/maquettes-refonte/Semaine-v2.html) : en-tête « semaine 40 » sans année, ligne de synthèse,
 * jours en minuscules, aujourd'hui au trait d'encre sans fond, week-end en gris, colonne d'heures et tiret, rond d'événement, faits à
 * leur heure, « en retard » le jour courant, « Rien de prévu », jour sélectionné et rangée d'ajout unique « Ajouter à jeudi 1 ».
 * Aujourd'hui du harnais : vendredi 2 oct. 2026 à 10:00 UTC (semaine ISO 40, du lundi 28 sept. au dimanche 4 oct.) ; PC inchangé.
 */

const day = (iso: string): HTMLElement => document.querySelector<HTMLElement>(`[data-date="${iso}"]`) as HTMLElement;
const titlesOf = (iso: string): string[] => [...day(iso).querySelectorAll('.ct-week-item__title')].map((el) => el.textContent ?? '');
const hoursOf = (iso: string): string[] => [...day(iso).querySelectorAll('.ct-week-item__time')].map((el) => el.textContent ?? '');
const summary = (): HTMLElement | null => document.querySelector<HTMLElement>('.ct-week__summary');
const addField = (): HTMLElement => screen.getByRole('combobox', { name: 'Nouvelle tâche' });
const dayHead = (iso: string): HTMLElement => within(day(iso)).getByRole('button', { name: /^Choisir / });

describe('UI-REFONTE-03 — Semaine iPhone', () => {
  let h: WeekHarness;
  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    await teardownWeek(h);
  });

  async function start(suffix: string, now = '2026-10-02T10:00:00.000Z', width = 440): Promise<void> {
    h = await setupWeek(suffix, now);
    mockViewport(width);
  }

  /** Jeu de la maquette rapporté à la semaine du harnais : une oubliée lundi, une faite mercredi, trois aujourd'hui, une samedi. */
  async function seedWeek(): Promise<void> {
    await seedTask(h, { title: 'Oubliée lundi', date: asLocalDate('2026-09-28') });
    const done = await seedTask(h, { title: 'Relire le contrat', date: asLocalDate('2026-09-30'), time: '11:00' });
    await createTaskUseCases(h.container).complete(done.id);
    const doneToday = await seedTask(h, { title: 'Envoyer la facture', date: asLocalDate('2026-10-02'), time: '08:00' });
    await createTaskUseCases(h.container).complete(doneToday.id);
    await seedTask(h, { title: 'Appeler le notaire', date: asLocalDate('2026-10-02'), time: '08:30' }); // heure dépassée à 10:00 UTC (12:00 Paris)
    await seedTask(h, { title: 'Sport', date: asLocalDate('2026-10-02'), time: '23:00' });
    await seedTask(h, { title: 'Préparer le dépôt GitHub', date: asLocalDate('2026-10-02') });
    await seedTask(h, { title: 'Courses', date: asLocalDate('2026-10-03'), spaceId: SPACE_PERSO_ID });
  }

  it('en-tête : « semaine 40 » en minuscule sans l’année courante, plage courte, ni filet ni « Cette semaine » sur la semaine courante (critères 1 et 3)', async () => {
    await start('331');
    renderWeek(h.container);
    await waitFor(() => expect(day('2026-10-04')).toBeTruthy());
    expect(document.querySelector('.ct-week__caption')).toHaveTextContent(/^semaine 40$/);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('28 sept. – 4 oct.');
    expect(document.querySelector('.ct-week__rule')).toBeNull();
    expect(screen.getByRole('button', { name: 'Semaine précédente' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Semaine suivante' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cette semaine' })).toBeNull();

    // Semaine précédente : la pastille apparaît et ramène à la semaine courante.
    fireEvent.click(screen.getByRole('button', { name: 'Semaine précédente' }));
    await waitFor(() => expect(day('2026-09-21')).toBeTruthy());
    expect(document.querySelector('.ct-week__caption')).toHaveTextContent(/^semaine 39$/);
    fireEvent.click(screen.getByRole('button', { name: 'Cette semaine' }));
    await waitFor(() => expect(day('2026-10-02')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Cette semaine' })).toBeNull();
  });

  it('en-tête : l’année n’apparaît que hors de l’année courante (« semaine 1 · 2027 »)', async () => {
    await start('332', '2026-12-30T10:00:00.000Z');
    renderWeek(h.container);
    await waitFor(() => expect(day('2026-12-28')).toBeTruthy());
    expect(document.querySelector('.ct-week__caption')).toHaveTextContent(/^semaine 53$/);
    fireEvent.click(screen.getByRole('button', { name: 'Semaine suivante' }));
    await waitFor(() => expect(day('2027-01-04')).toBeTruthy());
    expect(document.querySelector('.ct-week__caption')).toHaveTextContent(/^semaine 1 · 2027$/);
  });

  it('synthèse : « 5 tâches restantes · 2 faites · 2 en retard », le retard compte le jour passé et l’heure dépassée du jour (critère 2)', async () => {
    await start('333');
    await seedWeek();
    renderWeek(h.container);
    await screen.findByRole('button', { name: 'Courses' });
    expect(summary()).toHaveTextContent('5 tâches restantes · 2 faites · 2 en retard');
    expect(summary()?.querySelector('.ct-week__summaryLate')).toHaveTextContent('2 en retard');

    // Terminer l'oubliée de lundi : un retard de moins, une faite de plus.
    fireEvent.click(screen.getByRole('checkbox', { name: 'Terminer : Oubliée lundi' }));
    await waitFor(() => expect(summary()).toHaveTextContent('4 tâches restantes · 3 faites · 1 en retard'));

    // Filtre Perso : une seule tâche, singulier, segment « en retard » absent à zéro.
    fireEvent.click(screen.getByRole('button', { name: 'Perso' }));
    await waitFor(() => expect(summary()).toHaveTextContent(/^1 tâche restante · aucune faite$/));
    expect(summary()?.querySelector('.ct-week__summaryLate')).toBeNull();
  });

  it('synthèse : semaine sans tâche, « Rien de prévu cette semaine » ; PC : aucune synthèse (critères 2 et 12)', async () => {
    await start('334');
    renderWeek(h.container);
    await waitFor(() => expect(day('2026-10-04')).toBeTruthy());
    await waitFor(() => expect(summary()).toHaveTextContent('Rien de prévu cette semaine'));
    expect(summary()?.querySelector('.ct-week__summaryLate')).toBeNull();
  });

  it('sections : jours en minuscules, aujourd’hui au trait et annoncé, jours passés et week-end marqués, « Rien de prévu » (critères 4 et 6)', async () => {
    await start('335');
    await seedTask(h, { title: 'Seule', date: asLocalDate('2026-09-29') });
    renderWeek(h.container);
    await screen.findByRole('button', { name: 'Seule' });
    const weekdays = [...document.querySelectorAll('.ct-week-day__weekday')].map((el) => el.textContent);
    expect(weekdays).toEqual(['lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.', 'dim.']);
    expect(day('2026-10-02')).toHaveAttribute('data-today', 'true');
    expect(day('2026-10-02')).toHaveAttribute('aria-current', 'date');
    expect(screen.getByRole('group', { name: /aujourd’hui/ })).toBe(day('2026-10-02'));
    expect(document.querySelectorAll('.ct-week-day[data-today]')).toHaveLength(1);
    // Jours passés et week-end : attributs pour la feuille de style (numéro atténué, jour gris).
    for (const iso of ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01']) expect(day(iso)).toHaveAttribute('data-past', 'true');
    expect(day('2026-10-02')).not.toHaveAttribute('data-past');
    expect(day('2026-10-03')).toHaveAttribute('data-weekend', 'true');
    expect(day('2026-10-04')).toHaveAttribute('data-weekend', 'true');
    expect(day('2026-10-01')).not.toHaveAttribute('data-weekend');
    // Jour vide : « Rien de prévu » ; le jour pourvu n'en a pas.
    expect(day('2026-09-28').querySelector('.ct-week-day__empty')).toHaveTextContent('Rien de prévu');
    expect(day('2026-09-29').querySelector('.ct-week-day__empty')).toBeNull();
    // Plus de bouton « + Ajouter » par section sur iPhone.
    expect(screen.queryAllByRole('button', { name: /^Ajouter une tâche,/ })).toHaveLength(0);
  });

  it('lignes : colonne d’heures ou tiret, faits barrés à leur heure, « en retard » le jour courant seulement (critère 5)', async () => {
    await start('336');
    await seedWeek();
    renderWeek(h.container);
    await screen.findByRole('button', { name: 'Courses' });
    // Aujourd'hui : la faite de 08:00 reste à son heure, avant la due de 08:30 ; le sans heure vient après.
    expect(titlesOf('2026-10-02')).toEqual(['Envoyer la facture', 'Appeler le notaire', 'Sport', 'Préparer le dépôt GitHub']);
    expect(hoursOf('2026-10-02')).toEqual(['08:00', '08:30', '23:00', '—']);
    const done = screen.getByRole('button', { name: 'Envoyer la facture' }).closest('.ct-week-item') as HTMLElement;
    expect(done).toHaveAttribute('data-done', 'true');
    expect(done.querySelector('.ct-week-item__late')).toBeNull();
    const late = screen.getByRole('button', { name: 'Appeler le notaire' }).closest('.ct-week-item') as HTMLElement;
    expect(late).toHaveAttribute('data-late', 'true');
    expect(late.querySelector('.ct-week-item__late')).toHaveTextContent('en retard');
    const upcoming = screen.getByRole('button', { name: 'Sport' }).closest('.ct-week-item') as HTMLElement;
    expect(upcoming).not.toHaveAttribute('data-late');
    expect(upcoming.querySelector('.ct-week-item__late')).toBeNull();
    // Jour passé : pas de mention « en retard » en ligne (la synthèse la porte) ; tiret pour le sans heure.
    const forgotten = screen.getByRole('button', { name: 'Oubliée lundi' }).closest('.ct-week-item') as HTMLElement;
    expect(forgotten.querySelector('.ct-week-item__late')).toBeNull();
    expect(hoursOf('2026-09-28')).toEqual(['—']);
    // Mercredi : la faite garde son heure.
    expect(hoursOf('2026-09-30')).toEqual(['11:00']);
  });

  it('événement : rond au trait portant son type, heure dans la colonne, ouvre la fiche (critère 5)', async () => {
    await start('337');
    await insertCalendarAccount(h.db.driver, { id: 'acc', provider: 'google', label: 'Google Agenda', calendars: [{ id: 'pro', name: 'Travail', spaceId: SPACE_PERSO_ID, shown: true }] });
    await insertExternalEvent(h.db.driver, { id: 'ev1', accountId: 'acc', calendarId: 'pro', title: 'Point client', startUtc: '2026-10-01T08:00:00Z', endUtc: '2026-10-01T09:00:00Z' });
    await seedTask(h, { title: 'Après le point', date: asLocalDate('2026-10-01'), time: '11:00' });
    renderWeek(h.container);
    const event = (await screen.findByRole('button', { name: /Point client/ })).closest('.ct-week-event') as HTMLElement;
    expect(event.querySelector('.ct-week-event__mark')).toHaveAttribute('data-kind', 'external');
    expect(event.querySelector('.ct-week-item__time')).toHaveTextContent(/^\d{2}:\d{2}$/);
    expect(event.querySelector('.ct-week-event__mark')?.querySelector('svg')).toBeNull();
    // L'événement de 10:00 locale précède la tâche de 11:00 dans la même colonne d'heures.
    const rows = [...day('2026-10-01').querySelectorAll('.ct-week-item__title')].map((el) => el.textContent);
    expect(rows).toEqual(['Point client', 'Après le point']);
    fireEvent.click(screen.getByRole('button', { name: /Point client/ }));
    await waitFor(() => expect(useNavigationStore.getState().detail).toMatchObject({ type: 'externalEvent' }));
  });

  it('ajout : rangée unique en bas, « Ajouter à vendredi 2 » par défaut, un toucher sur un jour le sélectionne, Entrée crée dans ce jour (critère 7)', async () => {
    await start('338');
    renderWeek(h.container);
    await waitFor(() => expect(day('2026-10-04')).toBeTruthy());
    const row = document.querySelector('.ct-week__addRow') as HTMLElement;
    expect(row).toBeTruthy();
    expect(within(row).getByRole('combobox', { name: 'Nouvelle tâche' })).toHaveAttribute('placeholder', 'Ajouter à vendredi 2');
    expect(within(row).getByRole('button', { name: 'Ajouter' })).toBeInTheDocument();
    expect(dayHead('2026-10-02')).toHaveAttribute('aria-pressed', 'true');
    expect(dayHead('2026-10-01')).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(dayHead('2026-10-01'));
    expect(dayHead('2026-10-01')).toHaveAttribute('aria-pressed', 'true');
    expect(dayHead('2026-10-02')).toHaveAttribute('aria-pressed', 'false');
    expect(addField()).toHaveAttribute('placeholder', 'Ajouter à jeudi 1');

    fireEvent.change(addField(), { target: { value: 'Réunion d’équipe' } });
    fireEvent.submit(addField().closest('form') as HTMLFormElement);
    await screen.findByRole('button', { name: 'Réunion d’équipe' });
    expect(titlesOf('2026-10-01')).toEqual(['Réunion d’équipe']);
    expect(addField()).toHaveValue('');
    expect(await h.container.data.repos.tasks.listForDay(asLocalDate('2026-10-01'), 'all')).toHaveLength(1);
    // Changer de semaine : le jour visé redevient aujourd'hui s'il est affiché, sinon le premier jour de la semaine.
    fireEvent.click(screen.getByRole('button', { name: 'Semaine suivante' }));
    await waitFor(() => expect(day('2026-10-05')).toBeTruthy());
    expect(addField()).toHaveAttribute('placeholder', 'Ajouter à lundi 5');
  });

  it('ajout : le filtre d’espace s’applique à la tâche créée et la synthèse se met à jour (critères 2 et 7)', async () => {
    await start('339');
    renderWeek(h.container);
    await waitFor(() => expect(day('2026-10-04')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Perso' }));
    fireEvent.change(addField(), { target: { value: 'Courses' } });
    fireEvent.submit(addField().closest('form') as HTMLFormElement);
    await screen.findByRole('button', { name: 'Courses' });
    const [task] = await h.container.data.repos.tasks.listForDay(asLocalDate('2026-10-02'), 'all');
    expect(task).toMatchObject({ spaceId: SPACE_PERSO_ID, date: '2026-10-02' });
    await waitFor(() => expect(summary()).toHaveTextContent(/^1 tâche restante · aucune faite$/));
    expect(useAppStore.getState().spaceFilter).toBe(SPACE_PERSO_ID);
  });

  it('PC : en-tête « Semaine 40 », « LUN. », filet, sept « + Ajouter », aucune synthèse ni rangée d’ajout (critère 12)', async () => {
    await start('340', '2026-10-02T10:00:00.000Z', 1440);
    await seedTask(h, { title: 'Carte PC', date: asLocalDate('2026-09-30'), time: '09:00' });
    renderWeek(h.container);
    await screen.findByRole('button', { name: 'Carte PC' });
    expect(document.querySelector('.ct-week__caption')).toHaveTextContent(/^Semaine 40$/);
    expect(day('2026-09-28')).toHaveTextContent('LUN.28');
    expect(document.querySelector('.ct-week__rule')).not.toBeNull();
    expect(screen.getAllByRole('button', { name: /^Ajouter une tâche,/ })).toHaveLength(7);
    expect(summary()).toBeNull();
    expect(document.querySelector('.ct-week__addRow')).toBeNull();
    expect(document.querySelector('.ct-week-day__empty')).toBeNull();
    expect(screen.getByRole('button', { name: 'Cette semaine' })).toHaveAttribute('aria-disabled', 'true');
  });
});
