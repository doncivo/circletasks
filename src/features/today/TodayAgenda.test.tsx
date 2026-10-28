import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nowLocalTime } from '../../domain/clock';
import { addDays } from '../../domain/localDate';
import type { Goal, Routine } from '../../domain/model';
import { asEntityId, asLocalTime, type LocalTime, type RoutineId } from '../../domain/types';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { useNavigationStore } from '../app/navigation';
import { mockViewport, renderToday, seedTask, setupToday, teardownToday, type TodayHarness } from './testKit';
import { registerTodaySource, type TodayExtras } from './todaySources';

/**
 * UI-REFONTE-02 — Aujourd'hui sur iPhone, l'agenda du jour (docs/maquettes-refonte/Jour.html et Jour-Sombre.html).
 * En-tête sans badge ni bascule, menu « Plus d’options », objectif en une ligne, colonne d'heures, ligne « maintenant »,
 * passé atténué, dû en gros, tiret pour les éléments sans heure, événements en ligne, plus d'icône décorative. PC inchangé.
 */

/** Heure locale décalée de `minutes` (positif ou négatif) par rapport à `base`, bornée dans la journée. */
function shift(base: LocalTime, minutes: number): LocalTime {
  const [h, m] = base.split(':').map(Number) as [number, number];
  const total = Math.min(23 * 60 + 59, Math.max(0, h * 60 + m + minutes));
  return asLocalTime(`${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`);
}

const spoken = (time: LocalTime): string => `${Number(time.slice(0, 2))} h ${time.slice(3)}`;

function routine(title: string, time: string | null): Routine {
  return {
    id: asEntityId<RoutineId>(`7000000${String(title.length % 10)}-0000-4000-8000-000000000000`),
    spaceId: SPACE_PRO_ID,
    title,
    icon: null,
    time: time === null ? null : asLocalTime(time),
    scheduleType: 'weekdays',
    weekdays: [2, 5],
    paused: false,
    archived: false,
    deletedAt: null,
  } as unknown as Routine;
}

describe('Aujourd’hui iPhone : l’agenda du jour (UI-REFONTE-02)', () => {
  let h: TodayHarness;
  let now: LocalTime;
  const unregister: (() => void)[] = [];

  beforeEach(async () => {
    // 12:00 locales de l'horloge de test : des heures avant et après restent dans la journée.
    h = await setupToday('202', '2026-10-02T12:00:00.000Z');
    now = nowLocalTime(h.container.clock);
    if (now < '06:00' || now > '20:00') throw new Error(`heure locale de test hors plage : ${now}`);
  });

  afterEach(async () => {
    for (const off of unregister.splice(0)) off();
    await teardownToday(h);
  });

  function plug(source: Partial<TodayExtras>): void {
    unregister.push(registerTodaySource({ id: 'test', load: () => Promise.resolve(source) }));
  }

  const agenda = (): HTMLElement => screen.getByRole('list', { name: 'Liste du jour' });
  const lineOf = (title: string): HTMLElement => screen.getByRole('button', { name: title }).closest('.ct-agenda__line') as HTMLElement;

  it('en-tête : mois et jour, Rechercher et « Plus d’options » ; plus de badge, de bascule édition ni de bouton Vue compacte (critères 1, 2)', async () => {
    mockViewport(440);
    renderToday(h.container);
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent(/^2 ven\.$/);
    expect(screen.getByText('oct. 2026')).toBeInTheDocument();
    expect(screen.queryByText('Aujourd’hui')).toBeNull();
    expect(screen.getByRole('button', { name: 'Rechercher' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Plus d’options' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mode édition' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Vue compacte' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Un jour/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Objectif de la semaine' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Rapport mensuel' })).toBeNull();
  });

  it('menu « Plus d’options » : Un jour, Objectif de la semaine, Rapport mensuel, Vue compacte, Mode édition (critère 2)', async () => {
    await seedTask(h, { title: 'Une tâche' });
    mockViewport(440);
    renderToday(h.container);
    fireEvent.click(await screen.findByRole('button', { name: 'Plus d’options' }));
    const menu = await screen.findByRole('dialog', { name: 'Plus d’options' });
    expect(within(menu).getByRole('menuitem', { name: 'Un jour' })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'Objectif de la semaine' })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'Rapport mensuel' })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitemcheckbox', { name: 'Vue compacte' })).toHaveAttribute('aria-checked', 'false');
    const edit = within(menu).getByRole('menuitemcheckbox', { name: 'Mode édition' });
    expect(edit).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(edit);
    // Mode édition (A-05) : rond de sélection sur la tâche, barre de sélection, menu refermé.
    expect(await screen.findByRole('button', { name: 'Sélectionner : Une tâche' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Plus d’options' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Plus d’options' }));
    expect(within(await screen.findByRole('dialog', { name: 'Plus d’options' })).getByRole('menuitemcheckbox', { name: 'Mode édition' })).toHaveAttribute('aria-checked', 'true');
  });

  it('« Objectif de la semaine » du menu ouvre l’écran Objectif ; « Un jour » ouvre « Un jour » ; « Rapport mensuel » ouvre le rapport (critère 2)', async () => {
    mockViewport(440);
    renderToday(h.container);
    fireEvent.click(await screen.findByRole('button', { name: 'Plus d’options' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Plus d’options' })).getByRole('menuitem', { name: 'Objectif de la semaine' }));
    await waitFor(() => expect(useNavigationStore.getState().route).toMatchObject({ tab: 'tasks', screen: 'goals' }));
    act(() => useNavigationStore.getState().navigate({ tab: 'tasks', screen: 'today' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Plus d’options' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Plus d’options' })).getByRole('menuitem', { name: 'Un jour' }));
    await waitFor(() => expect(useNavigationStore.getState().route).toMatchObject({ tab: 'tasks', screen: 'someday' }));
    act(() => useNavigationStore.getState().navigate({ tab: 'tasks', screen: 'today' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Plus d’options' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Plus d’options' })).getByRole('menuitem', { name: 'Rapport mensuel' }));
    await waitFor(() => expect(useNavigationStore.getState().route).toMatchObject({ tab: 'tasks', screen: 'report' }));
  });

  it('objectif épinglé en une ligne : « Objectif », titre, « 2/5 », sans cadre ni légende ; un toucher ouvre Objectif (critère 3)', async () => {
    plug({
      goals: [{ goal: { id: 'g', spaceId: SPACE_PRO_ID, title: 'Finaliser le PRD CircleTasks', icon: null, weekStart: '2026-09-28', pinned: true, status: 'open', createdAt: '2026-09-28T08:00:00.000Z', deletedAt: null } as unknown as Goal, progress: { done: 2, total: 5 } }],
    });
    mockViewport(440);
    renderToday(h.container);
    const line = await screen.findByRole('button', { name: 'Objectif : Finaliser le PRD CircleTasks, 2 sur 5' });
    expect(line).toHaveClass('ct-agenda-goal');
    expect(line).toHaveTextContent('Objectif');
    expect(line).toHaveTextContent('2/5');
    expect(document.querySelector('.ct-today-goal')).toBeNull();
    expect(screen.queryByText('Objectif de la semaine')).toBeNull();
    fireEvent.click(line);
    await waitFor(() => expect(useNavigationStore.getState().route).toMatchObject({ tab: 'tasks', screen: 'goals' }));
  });

  it('sans objectif épinglé : aucune ligne d’objectif (critère 3, règle 3)', async () => {
    await seedTask(h, { title: 'Seule' });
    mockViewport(440);
    renderToday(h.container);
    await screen.findByRole('button', { name: 'Seule' });
    expect(document.querySelector('.ct-agenda-goal')).toBeNull();
  });

  it('agenda : colonne d’heures, passé atténué, dû en tête avant « maintenant », à venir, tiret pour les sans heure, faits à leur heure (critères 5, 6)', async () => {
    await seedTask(h, { title: 'Envoyer la facture', time: shift(now, -120) });
    await seedTask(h, { title: 'Appeler le notaire', time: shift(now, -32), spaceId: SPACE_PERSO_ID });
    await seedTask(h, { title: 'Relire le contrat', time: shift(now, 90) });
    await seedTask(h, { title: 'Préparer le dépôt GitHub' });
    await seedTask(h, { title: 'Faire mon lit', spaceId: SPACE_PERSO_ID });
    plug({ routines: [{ routine: routine('Sport', shift(now, 180)), done: false }] });
    mockViewport(440);
    renderToday(h.container);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Terminer : Envoyer la facture' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Envoyer la facture' })).toHaveAttribute('data-done', 'true'));

    const items = within(agenda()).getAllByRole('listitem');
    const texts = items.map((item) => item.textContent ?? '');
    const at = (title: string) => texts.findIndex((text) => text.includes(title));
    const nowLine = within(agenda()).getByLabelText(`Il est ${spoken(now)}`);
    expect(nowLine).toHaveClass('ct-agenda__now');
    expect(nowLine).toHaveTextContent(now);
    const nowIndex = items.findIndex((item) => item.contains(nowLine));

    // Passé (fait), puis dû, puis « maintenant », puis à venir (tâche puis routine), puis sans heure.
    expect(at('Envoyer la facture')).toBeLessThan(at('Appeler le notaire'));
    expect(at('Appeler le notaire')).toBeLessThan(nowIndex);
    expect(nowIndex).toBeLessThan(at('Relire le contrat'));
    expect(at('Relire le contrat')).toBeLessThan(at('Sport'));
    expect(at('Sport')).toBeLessThan(at('Préparer le dépôt GitHub'));
    expect(at('Préparer le dépôt GitHub')).toBeLessThan(at('Faire mon lit'));

    const facture = lineOf('Envoyer la facture');
    expect(facture).toHaveAttribute('data-phase', 'past');
    expect(within(facture).getByText(shift(now, -120))).toHaveClass('ct-agenda__hour');
    expect(screen.getByRole('button', { name: 'Envoyer la facture' })).toHaveAttribute('data-done', 'true');

    const notaire = lineOf('Appeler le notaire');
    expect(notaire).toHaveAttribute('data-phase', 'due');
    expect(notaire).toHaveTextContent('En retard de 32 min');
    expect(notaire).toHaveTextContent('Perso');

    expect(lineOf('Relire le contrat')).toHaveAttribute('data-phase', 'upcoming');
    const sport = screen.getByText('Sport').closest('.ct-agenda__line') as HTMLElement;
    expect(sport).toHaveAttribute('data-phase', 'upcoming');
    expect(sport.querySelector('.ct-list-row__subtitle')).toHaveTextContent(/^Routine · Pro$/); // fréquence hors du départ (voir fiche, critère 6)

    const depot = lineOf('Préparer le dépôt GitHub');
    expect(depot).toHaveAttribute('data-phase', 'untimed');
    expect(within(depot).getByText('—')).toHaveClass('ct-agenda__hour');
    // Plus de sous-ligne « HH:MM · Espace » : l'heure est dans la colonne, l'espace seul reste en sous-ligne sous « Tout ».
    expect(notaire.querySelector('.ct-list-row__subtitle')).not.toHaveTextContent(shift(now, -32));
    expect(depot.querySelector('.ct-list-row__subtitle')).toHaveTextContent(/^Pro$/);
  });

  it('retard au-delà d’une heure : « En retard de 1 h 50 » ; une heure juste : « En retard de 2 h » (critère 5)', async () => {
    await seedTask(h, { title: 'Très en retard', time: shift(now, -110) });
    await seedTask(h, { title: 'Deux heures', time: shift(now, -120) });
    mockViewport(440);
    renderToday(h.container);
    expect((await screen.findByRole('button', { name: 'Très en retard' })).closest('.ct-agenda__line')).toHaveTextContent('En retard de 1 h 50');
    expect(screen.getByRole('button', { name: 'Deux heures' }).closest('.ct-agenda__line')).toHaveTextContent('En retard de 2 h');
  });

  it('événement : rond au trait, titre, source en sous-ligne, à son heure dans l’agenda ; plus de bandeau (critère 6)', async () => {
    await seedTask(h, { title: 'Après', time: shift(now, 60) });
    plug({ events: [{ id: 'e', title: 'Point client', allDay: false, startTime: shift(now, -60), spaceId: null, calendarName: 'Google Agenda', icon: null }] });
    mockViewport(440);
    renderToday(h.container);
    const point = (await screen.findByText('Point client')).closest('.ct-agenda__line') as HTMLElement;
    expect(point).toHaveAttribute('data-phase', 'past');
    expect(point.querySelector('.ct-agenda__eventMark')).not.toBeNull();
    expect(point).toHaveTextContent('Google Agenda');
    expect(within(point).getByText(shift(now, -60))).toHaveClass('ct-agenda__hour');
    expect(document.querySelector('.ct-today-event')).toBeNull();
    expect(screen.queryByRole('list', { name: 'Événements du jour' })).toBeNull();
    const texts = within(agenda()).getAllByRole('listitem').map((item) => item.textContent ?? '');
    expect(texts.findIndex((text) => text.includes('Point client'))).toBeLessThan(texts.findIndex((text) => text.includes('Après')));
  });

  it('plus d’icône décorative à droite d’une tâche sur iPhone (critère 6)', async () => {
    const task = await seedTask(h, { title: 'Avec icône' });
    await h.container.data.repos.tasks.update(task.id, { icon: { kind: 'lucide', name: 'ShoppingCart' } });
    mockViewport(440);
    renderToday(h.container);
    const line = (await screen.findByRole('button', { name: 'Avec icône' })).closest('.ct-agenda__line') as HTMLElement;
    expect(line.querySelector('.ct-list-row > svg, .ct-list-row > .ct-icon-view, .ct-icon-view')).toBeNull();
  });

  it('un autre jour que le jour courant : pas de ligne « maintenant », rien de passé ni de dû (critère 5)', async () => {
    const tomorrow = addDays(h.today, 1);
    await seedTask(h, { title: 'Demain tôt', date: tomorrow, time: shift(now, -60) });
    mockViewport(440);
    act(() => useNavigationStore.getState().navigate({ tab: 'tasks', screen: 'today', date: tomorrow }));
    renderToday(h.container);
    const line = (await screen.findByRole('button', { name: 'Demain tôt' })).closest('.ct-agenda__line') as HTMLElement;
    expect(line).toHaveAttribute('data-phase', 'upcoming');
    expect(document.querySelector('.ct-agenda__now')).toBeNull();
  });

  it('liste vide le jour courant : texte d’aide, ligne « maintenant » conservée, rangée d’ajout présente (critère 9)', async () => {
    mockViewport(440);
    renderToday(h.container);
    expect(await screen.findByText('Rien de prévu aujourd’hui.')).toBeInTheDocument();
    expect(await screen.findByLabelText(`Il est ${spoken(now)}`)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ajouter' })).toBeInTheDocument();
    expect(screen.getByLabelText('Nouvelle tâche')).toBeInTheDocument();
  });

  it('PC : en-tête avec badge, cartes et bascule inchangés ; aucun agenda (critère 13)', async () => {
    await seedTask(h, { title: 'Sur PC', time: shift(now, -60) });
    mockViewport(1440);
    renderToday(h.container);
    await screen.findByRole('button', { name: 'Sur PC' });
    expect(screen.getByText('Aujourd’hui')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mode édition' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Vue compacte' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Plus d’options' })).toBeNull();
    expect(document.querySelector('.ct-agenda__line')).toBeNull();
    expect(document.querySelector('.ct-agenda__now')).toBeNull();
  });
});
