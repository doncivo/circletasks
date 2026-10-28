import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SPACE_PERSO_ID } from '../../db/seed/defaultSpaces';
import { newEntityId } from '../../domain/id';
import type { NewReminder, ReminderOffsetMin } from '../../domain/model';
import type { LocalTime, ReminderId, RoutineId } from '../../domain/types';
import { mockViewport, renderRoutines, seedRoutine, setupRoutines, teardownRoutines, type RoutinesHarness } from './testKit';

/**
 * N-FIX-04 (décision d'Ali du 2026-10-27). Aujourd'hui dans les tests : ven. 2 oct. 2026 ; plages Pro par défaut (19:00 → 08:00, week-end).
 * Une routine Pro à 20:00 : chaque rappel part au prochain matin de semaine à 08:00. L'app doit le dire sur le formulaire, dès le choix de
 * l'heure, et sur la ligne de la routine (trois états : tous, partiel, aucun).
 */
const card = (title: string): HTMLElement => screen.getByRole('heading', { name: title }).closest('article') as HTMLElement;

async function seedReminders(h: RoutinesHarness, id: RoutineId, offsets: readonly ReminderOffsetMin[]): Promise<void> {
  const reminders: NewReminder[] = offsets.map((offsetMin) => ({ id: newEntityId<ReminderId>(h.container.ids), targetType: 'routine', targetId: id, offsetMin, fireAt: '2026-10-02T20:00' as never }));
  await h.container.data.repos.reminders.replaceForTarget({ type: 'routine', id }, reminders);
}

describe('Routines : rappel dans la plage silencieuse (N-FIX-04)', () => {
  let h: RoutinesHarness;
  beforeEach(async () => {
    h = await setupRoutines('f04a');
    mockViewport(1440);
  });
  afterEach(() => teardownRoutines(h));

  it('ligne de la routine : Pro à 20:00 tous les jours = « Rappels décalés à 08:00 » ; Pro à 10:00 = « Rappels du week-end décalés au lundi 08:00 » ; Perso = rien', async () => {
    const soir = await seedRoutine(h, { title: 'Yoga du soir', time: '20:00' as LocalTime });
    await seedReminders(h, soir.id as RoutineId, [0]);
    const matin = await seedRoutine(h, { title: 'Lecture', time: '10:00' as LocalTime });
    await seedReminders(h, matin.id as RoutineId, [0]);
    const perso = await seedRoutine(h, { title: 'Marche', time: '20:00' as LocalTime, spaceId: SPACE_PERSO_ID });
    await seedReminders(h, perso.id as RoutineId, [0]);
    renderRoutines(h.container);
    await screen.findByRole('heading', { name: 'Yoga du soir' });
    expect(within(card('Yoga du soir')).getByText('Rappels décalés à 08:00')).toBeInTheDocument();
    expect(within(card('Lecture')).getByText('Rappels du week-end décalés au lundi 08:00')).toBeInTheDocument();
    expect(within(card('Marche')).queryByText(/décalé/)).toBeNull();
  });

  it('formulaire de modification : la ligne « Rappel décalé au lundi 08:00 — aucun rappel Pro après 19:00 » apparaît avec l’heure 20:00 et disparaît à 10:00', async () => {
    const soir = await seedRoutine(h, { title: 'Yoga du soir', time: '20:00' as LocalTime });
    await seedReminders(h, soir.id as RoutineId, [0]);
    renderRoutines(h.container);
    await screen.findByRole('heading', { name: 'Yoga du soir' });
    fireEvent.click(within(card('Yoga du soir')).getByRole('button', { name: /Modifier la routine/ }));
    const form = await screen.findByRole('form', { name: 'Modifier la routine' });
    // Vendredi 2 octobre 20:00 : soir, puis week-end entier, puis dimanche soir : lundi 08:00. Une seule cause : celle de l'heure choisie.
    expect(within(form).getByRole('status')).toHaveTextContent('Rappel décalé au lundi 08:00 — aucun rappel Pro après 19:00');
    fireEvent.click(within(form).getByRole('button', { name: /^Heure de la routine/ }));
    fireEvent.change(within(form).getByLabelText('Heure (HH:MM)'), { target: { value: '10:00' } });
    fireEvent.blur(within(form).getByLabelText('Heure (HH:MM)'));
    await waitFor(() => expect(within(form).queryByRole('status')).toBeNull());
  });

  it('formulaire de création : choisir Pro et 20:00 avec « À l’heure » cochée affiche la ligne tout de suite ; Perso la retire', async () => {
    renderRoutines(h.container);
    fireEvent.click(await screen.findByRole('button', { name: 'Ajouter' }));
    const form = await screen.findByRole('form', { name: 'Nouvelle routine' });
    fireEvent.change(within(form).getByLabelText('Nom de la routine'), { target: { value: 'Yoga du soir' } });
    fireEvent.click(within(form).getByRole('button', { name: /^Heure de la routine/ }));
    fireEvent.change(within(form).getByLabelText('Heure (HH:MM)'), { target: { value: '20:00' } });
    fireEvent.blur(within(form).getByLabelText('Heure (HH:MM)'));
    expect(within(form).getByRole('checkbox', { name: 'À l’heure' })).toHaveAttribute('aria-checked', 'true');
    expect(await within(form).findByRole('status')).toHaveTextContent('Rappel décalé au lundi 08:00 — aucun rappel Pro après 19:00');
    fireEvent.click(within(form).getByRole('button', { name: 'Perso' }));
    await waitFor(() => expect(within(form).queryByRole('status')).toBeNull());
  });
});
