import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LocalDate } from '../../domain/types';
import { mockViewport, renderRoutines, seedLog, seedRoutine, setupRoutines, teardownRoutines, type RoutinesHarness } from './testKit';

// Aujourd'hui : ven. 2 oct. 2026.
const save = () => screen.getByRole('button', { name: 'Enregistrer' });
const frequency = () => screen.getByLabelText('Fréquence');
const interval = () => screen.getByTestId('interval-value');
const group = () => screen.getByRole('group', { name: 'Fréquence : tous les N' });

async function openCreate(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: /^Ajouter/ }));
  await screen.findByRole('form', { name: 'Nouvelle routine' });
  fireEvent.change(screen.getByLabelText('Nom de la routine'), { target: { value: 'Séance d’étirements' } });
  fireEvent.change(frequency(), { target: { value: 'every_n' } });
}

describe('Routines : « Tous les N jours / semaines » (R-07)', () => {
  let h: RoutinesHarness;

  afterEach(() => teardownRoutines(h));

  describe('iPhone', () => {
    beforeEach(async () => {
      h = await setupRoutines('211');
      mockViewport(440);
    });

    it('N vaut 2 par défaut, « − » inactif à 2, « + » inactif à 30 ; passer aux semaines ramène N à 8 (critère 1)', async () => {
      renderRoutines(h.container);
      await openCreate();
      expect(interval()).toHaveTextContent('2');
      expect(within(group()).getByRole('button', { name: 'Diminuer' })).toBeDisabled();
      const plus = within(group()).getByRole('button', { name: 'Augmenter' });
      for (let i = 0; i < 40; i += 1) fireEvent.click(plus);
      expect(interval()).toHaveTextContent('30');
      expect(plus).toBeDisabled();

      fireEvent.click(within(group()).getByRole('button', { name: 'semaines' }));
      expect(interval()).toHaveTextContent('8');
      expect(plus).toBeDisabled();
      fireEvent.click(within(group()).getByRole('button', { name: 'jours' }));
      expect(interval()).toHaveTextContent('8');
      fireEvent.click(plus);
      expect(interval()).toHaveTextContent('9');
    });

    it('l’aperçu montre les 4 prochaines fois depuis aujourd’hui, à partir de la date de départ (critère 3)', async () => {
      renderRoutines(h.container);
      await openCreate();
      fireEvent.click(within(group()).getByRole('button', { name: 'Augmenter' })); // N = 3
      // Départ par défaut : aujourd'hui, ven. 2 oct.
      expect(screen.getByText('Prochaines fois : ven. 2, lun. 5, jeu. 8, dim. 11 oct.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Ven. 2 oct.' })).toBeInTheDocument();
    });

    it('« Toutes les N semaines » : jours préréglés sur le jour de départ, au moins un jour exigé (critère 5, QB-04)', async () => {
      renderRoutines(h.container);
      await openCreate();
      expect(screen.queryByRole('checkbox', { name: 'Lundi' })).toBeNull(); // mode jours : pas de ronds
      fireEvent.click(within(group()).getByRole('button', { name: 'semaines' }));
      // Départ ven. 2 oct. : seul « V » est coché.
      expect(screen.getByRole('checkbox', { name: 'Vendredi' })).toBeChecked();
      expect(screen.getByRole('checkbox', { name: 'Lundi' })).not.toBeChecked();
      expect(save()).toBeEnabled();
      fireEvent.click(screen.getByRole('checkbox', { name: 'Vendredi' }));
      expect(save()).toBeDisabled();
      fireEvent.click(screen.getByRole('checkbox', { name: 'Lundi' }));
      fireEvent.click(screen.getByRole('checkbox', { name: 'Jeudi' }));
      expect(save()).toBeEnabled();
      // Aperçu : lun. 5 oct. est dans une semaine « hors cycle » depuis le départ du ven. 2 (semaine de départ), puis toutes les 2 semaines.
      expect(screen.getByText(/Prochaines fois : /)).toBeInTheDocument();
    });

    it('enregistre « Toutes les 2 semaines » (lun. et jeu.) avec la date de départ (critères 5, 9)', async () => {
      renderRoutines(h.container);
      await openCreate();
      fireEvent.click(within(group()).getByRole('button', { name: 'semaines' }));
      fireEvent.click(screen.getByRole('checkbox', { name: 'Vendredi' }));
      fireEvent.click(screen.getByRole('checkbox', { name: 'Lundi' }));
      fireEvent.click(screen.getByRole('checkbox', { name: 'Jeudi' }));
      fireEvent.click(save());
      await waitFor(() => expect(screen.queryByRole('form')).toBeNull());
      const [stored] = await h.container.data.repos.routines.listForFilter('all');
      expect(stored).toMatchObject({ scheduleType: 'every_n_weeks', interval: 2, weekdays: [1, 4], startDate: '2026-10-02', timesPerWeek: null });
      const card = screen.getByRole('heading', { name: 'Séance d’étirements' }).closest('article') as HTMLElement;
      expect(card).toHaveTextContent('toutes les 2 semaines : lun., jeu.');
    });

    it('enregistre « Tous les 3 jours » ; la carte compte les occurrences de la semaine et grise les jours non prévus (critère 6)', async () => {
      renderRoutines(h.container);
      await openCreate();
      fireEvent.click(within(group()).getByRole('button', { name: 'Augmenter' }));
      fireEvent.click(save());
      await waitFor(() => expect(screen.queryByRole('form')).toBeNull());
      const [stored] = await h.container.data.repos.routines.listForFilter('all');
      expect(stored).toMatchObject({ scheduleType: 'every_n_days', interval: 3, weekdays: [], startDate: '2026-10-02' });
      const card = screen.getByRole('heading', { name: 'Séance d’étirements' }).closest('article') as HTMLElement;
      // Semaine du 28 sept. au 4 oct. : départ le ven. 2 -> ven. 2 seulement (dim. 5 est dans la semaine suivante).
      expect(within(card).getAllByRole('checkbox').map((round) => round.getAttribute('data-state'))).toEqual(['off', 'off', 'off', 'off', 'planned', 'off', 'off']);
      expect(card).toHaveTextContent('0/1');
      expect(card).toHaveTextContent('tous les 3 jours');
    });

    it('modifier N ou la date de départ conserve les validations passées (critère 8)', async () => {
      const routine = await seedRoutine(h, { title: 'Arroser', scheduleType: 'every_n_days', interval: 3, startDate: '2026-09-21' as LocalDate });
      await seedLog(h, routine, '2026-09-21');
      await seedLog(h, routine, '2026-09-24');
      renderRoutines(h.container);
      fireEvent.click(await screen.findByRole('button', { name: 'Éditer la routine Arroser' }));
      await screen.findByRole('form', { name: 'Modifier la routine' });
      expect(frequency()).toHaveValue('every_n');
      expect(interval()).toHaveTextContent('3');
      fireEvent.click(within(group()).getByRole('button', { name: 'Augmenter' })); // N = 4
      fireEvent.click(save());
      await waitFor(() => expect(screen.queryByRole('form')).toBeNull());
      const updated = await h.container.data.repos.routines.getById(routine.id);
      expect(updated).toMatchObject({ interval: 4, startDate: '2026-09-21' });
      const logs = await h.container.data.repos.routineLogs.listForRoutine(routine.id, { from: '2026-01-01' as LocalDate, to: '2026-12-31' as LocalDate });
      expect(logs.map((log) => log.date)).toEqual(['2026-09-21', '2026-09-24']);
    });
  });

  describe('PC', () => {
    beforeEach(async () => {
      h = await setupRoutines('212');
      mockViewport(1440);
    });

    it('une date de départ passée est acceptée et décale l’aperçu (critères 2, 3)', async () => {
      renderRoutines(h.container);
      await openCreate();
      fireEvent.click(within(group()).getByRole('button', { name: 'Augmenter' })); // N = 3
      const field = screen.getByRole('combobox', { name: 'Date de départ' });
      fireEvent.change(field, { target: { value: '21/09/2026' } });
      fireEvent.keyDown(field, { key: 'Enter' });
      await waitFor(() => expect(screen.getByText('Prochaines fois : sam. 3, mar. 6, ven. 9, lun. 12 oct.')).toBeInTheDocument());
      fireEvent.click(save());
      await waitFor(() => expect(screen.queryByRole('form')).toBeNull());
      const [stored] = await h.container.data.repos.routines.listForFilter('all');
      expect(stored).toMatchObject({ scheduleType: 'every_n_days', interval: 3, startDate: '2026-09-21' });
    });
  });
});
