import { fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SPACE_PERSO_ID } from '../../db/seed/defaultSpaces';
import type { LocalTime, Weekday } from '../../domain/types';
import { mockViewport, renderRoutines, seedLog, seedRoutine, setupRoutines, teardownRoutines, type RoutinesHarness } from './testKit';

/**
 * UI-REFONTE-05 — Routines sur iPhone (docs/maquettes-refonte/Routines-v2.html) : synthèse de la semaine sous le titre, plus de bascule
 * « Vue compacte » ni de filet décoratif, carte sans icône ni horloge avec « Modifier » au trait, pastilles sans compteur, ligne
 * d'informations « 22:30 · Perso · du lundi au vendredi · 3 sur 5 cette semaine », aide retirée, rangée du bas « Rapport du mois » +
 * « Routine ». Aujourd'hui du harnais : vendredi 2 oct. 2026 (semaine du lundi 28 sept. au dimanche 4 oct.). PC inchangé.
 */

const card = (title: string): HTMLElement => screen.getByRole('heading', { name: title }).closest('article') as HTMLElement;
const summary = (): HTMLElement | null => document.querySelector<HTMLElement>('.ct-routines__summary');
const weekdays = (...days: number[]): Weekday[] => days as Weekday[];

describe('UI-REFONTE-05 — Routines iPhone', () => {
  let h: RoutinesHarness;
  afterEach(() => teardownRoutines(h));

  async function start(suffix: string, width = 440): Promise<void> {
    h = await setupRoutines(suffix);
    mockViewport(width);
  }

  /** Deux routines Perso : « Boire de l’eau » tous les jours (2 validations), « Sport » mardi et vendredi (1 validation). */
  async function seedWeek(): Promise<void> {
    const water = await seedRoutine(h, { title: 'Boire de l’eau', time: '08:30' as LocalTime, spaceId: SPACE_PERSO_ID, icon: 'lucide:droplet' as never });
    await seedLog(h, water, '2026-09-28');
    await seedLog(h, water, '2026-09-29');
    const sport = await seedRoutine(h, { title: 'Sport', time: '18:00' as LocalTime, spaceId: SPACE_PERSO_ID, scheduleType: 'weekdays', weekdays: weekdays(2, 5) });
    await seedLog(h, sport, '2026-09-29');
  }

  it('en-tête : synthèse « Semaine du 28 sept. au 4 oct. · 3 sur 9 faites », ni filet décoratif ni « Vue compacte » (critère 1)', async () => {
    await start('351');
    await seedWeek();
    renderRoutines(h.container);
    await screen.findByRole('heading', { name: 'Sport' });
    expect(summary()).toHaveTextContent('Semaine du 28 sept. au 4 oct. · 3 sur 9 faites');
    expect(document.querySelector('.ct-routines__rule')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Vue compacte' })).toBeNull();
    // Le filtre d'espace recalcule la synthèse : rien en Pro.
    fireEvent.click(screen.getByRole('button', { name: 'Pro' }));
    await screen.findByText(/Aucune routine/);
    expect(summary()).toBeNull();
  });

  it('en-tête : singulier « 1 sur 1 faite », même mois « Semaine du 5 au 11 oct. », routines sans jour prévu (critère 1)', async () => {
    await start('352', 440);
    const lit = await seedRoutine(h, { title: 'Faire mon lit', scheduleType: 'weekdays', weekdays: weekdays(5) });
    await seedLog(h, lit, '2026-10-02');
    renderRoutines(h.container);
    await screen.findByRole('heading', { name: 'Faire mon lit' });
    expect(summary()).toHaveTextContent('Semaine du 28 sept. au 4 oct. · 1 sur 1 faite');
  });

  it('en-tête : des routines mais aucun jour prévu (départ la semaine prochaine) : « Aucune routine prévue cette semaine » (critère 1)', async () => {
    await start('358');
    await seedRoutine(h, { title: 'Méditer', startDate: '2026-10-05' as never });
    renderRoutines(h.container);
    await screen.findByRole('heading', { name: 'Méditer' });
    expect(summary()).toHaveTextContent('Aucune routine prévue cette semaine');
  });

  it('carte : titre, « Modifier » au trait, aucune icône ni horloge, pastilles sans compteur (critère 2)', async () => {
    await start('353');
    await seedWeek();
    renderRoutines(h.container);
    const water = await screen.findByRole('heading', { name: 'Boire de l’eau' }).then((heading) => heading.closest('article') as HTMLElement);
    const edit = within(water).getByRole('button', { name: 'Modifier la routine Boire de l’eau' });
    expect(edit).toHaveTextContent('Modifier');
    expect(water.querySelector('svg')).toBeNull();
    const week = water.querySelector('.ct-routine-card__week') as HTMLElement;
    expect(week.querySelectorAll('[role="checkbox"]')).toHaveLength(7);
    expect(week.querySelector('.ct-routine-card__counter')).toBeNull();
    expect(week.textContent).toBe('LMMJVSD');
    // Les pastilles gardent leurs états et leurs actions.
    expect(within(week).getByRole('checkbox', { name: 'Lundi, fait' })).toBeChecked();
    expect(within(week).getByRole('checkbox', { name: 'Mercredi' })).not.toBeChecked();
    fireEvent.click(within(week).getByRole('checkbox', { name: 'Mercredi' }));
    expect(await within(week).findByRole('checkbox', { name: 'Mercredi, fait' })).toBeChecked();
  });

  it('ligne d’informations : « 08:30 · Perso · tous les jours · 2 sur 7 cette semaine », « 18:00 · Perso · mardi et vendredi · 1 sur 2 cette semaine » (critères 2 et 3)', async () => {
    await start('354');
    await seedWeek();
    renderRoutines(h.container);
    await screen.findByRole('heading', { name: 'Sport' });
    expect(card('Boire de l’eau').querySelector('.ct-routine-card__info')).toHaveTextContent('08:30 · Perso · tous les jours · 2 sur 7 cette semaine');
    // La série en cours (R-04) reste dans la ligne, avant le compteur.
    expect(card('Sport').querySelector('.ct-routine-card__info')).toHaveTextContent('18:00 · Perso · mardi et vendredi · série 1 séance · 1 sur 2 cette semaine');
    // Le compteur garde son libellé accessible et vit dans la ligne d'informations.
    const counter = within(card('Sport')).getByLabelText('1 sur 2 cette semaine');
    expect(counter).toHaveTextContent('1 sur 2 cette semaine');
    expect(counter.closest('.ct-routine-card__info')).not.toBeNull();
    expect(card('Sport').textContent).not.toContain('1/2');
  });

  it('fréquences en toutes lettres : « du lundi au vendredi », « lundi, mercredi et vendredi », « 3 fois par semaine », « tous les 3 jours », « toutes les 2 semaines, le mardi et le jeudi » (critère 3)', async () => {
    await start('355');
    await seedRoutine(h, { title: 'Aller au lit', scheduleType: 'weekdays', weekdays: weekdays(1, 2, 3, 4, 5) });
    await seedRoutine(h, { title: 'Courir', scheduleType: 'weekdays', weekdays: weekdays(1, 3, 5) });
    await seedRoutine(h, { title: 'Lire', scheduleType: 'x_per_week', timesPerWeek: 3 });
    await seedRoutine(h, { title: 'Arroser', scheduleType: 'every_n_days', interval: 3, startDate: '2026-09-28' as never });
    await seedRoutine(h, { title: 'Ménage', scheduleType: 'every_n_weeks', interval: 2, weekdays: weekdays(2, 4), startDate: '2026-09-28' as never });
    renderRoutines(h.container);
    await screen.findByRole('heading', { name: 'Ménage' });
    // Sous « Tout », l'espace précède la fréquence (« Pro · du lundi au vendredi · … »).
    expect(card('Aller au lit').querySelector('.ct-routine-card__info')).toHaveTextContent(/^Pro · du lundi au vendredi · /);
    expect(card('Courir').querySelector('.ct-routine-card__info')).toHaveTextContent(/^Pro · lundi, mercredi et vendredi · /);
    expect(card('Lire').querySelector('.ct-routine-card__info')).toHaveTextContent(/^Pro · 3 fois par semaine · /);
    expect(card('Arroser').querySelector('.ct-routine-card__info')).toHaveTextContent(/^Pro · tous les 3 jours · /);
    expect(card('Ménage').querySelector('.ct-routine-card__info')).toHaveTextContent(/^Pro · toutes les 2 semaines, le mardi et le jeudi · /);
  });

  it('aide retirée, rangée du bas « Rapport du mois » + « Routine » (libellé « Ajouter une routine »), plus de bouton flottant (critères 4 et 5)', async () => {
    await start('356');
    await seedWeek();
    renderRoutines(h.container);
    await screen.findByRole('heading', { name: 'Sport' });
    expect(screen.queryByText(/Gérez vos routines ici/)).toBeNull();
    const row = document.querySelector('.ct-routines__bottomRow') as HTMLElement;
    expect(row).not.toBeNull();
    expect(within(row).getByRole('button', { name: 'Rapport du mois' })).toBeInTheDocument();
    const add = within(row).getByRole('button', { name: 'Ajouter une routine' });
    expect(add).toHaveTextContent('Routine');
    expect(add).toHaveClass('ct-routines__addButton');
    expect(document.querySelector('.ct-fab')).toBeNull();
    fireEvent.click(add);
    expect(await screen.findByRole('dialog', { name: 'Nouvelle routine' })).toBeInTheDocument();
  });

  it('PC : grille inchangée, « Vue compacte », compteur « 2/7 » à droite des pastilles, « lun., mer., ven. », « Modifier » (critère 9)', async () => {
    await start('357', 1440);
    await seedWeek();
    await seedRoutine(h, { title: 'Courir', scheduleType: 'weekdays', weekdays: weekdays(1, 3, 5) });
    renderRoutines(h.container);
    await screen.findByRole('heading', { name: 'Courir' });
    expect(summary()).toBeNull();
    expect(document.querySelector('.ct-routines__rule')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Vue compacte' })).toBeInTheDocument();
    expect(within(card('Boire de l’eau')).getByLabelText('2 sur 7 cette semaine')).toHaveTextContent('2/7');
    expect(card('Courir')).toHaveTextContent('lun., mer., ven.');
    expect(within(card('Courir')).getByRole('button', { name: 'Modifier la routine Courir' })).toHaveTextContent('Modifier');
    expect(screen.getByRole('button', { name: 'Ajouter' })).toBeInTheDocument();
  });
});
