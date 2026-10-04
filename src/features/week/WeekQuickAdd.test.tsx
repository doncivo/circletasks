import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { asLocalDate } from '../../domain/types';
import { mockViewport, renderWeek, setupWeek, teardownWeek, type WeekHarness } from './testKit';

/** Aujourd'hui du harnais : ven. 2 oct. 2026 (semaine du lundi 28 sept. au dimanche 4 oct.). */
const day = (iso: string): HTMLElement => document.querySelector<HTMLElement>(`[data-date="${iso}"]`) as HTMLElement;
const addButton = (iso: string): HTMLElement => within(day(iso)).getByRole('button', { name: /^Ajouter une tâche/ });
const titlesOf = (iso: string): string[] => [...day(iso).querySelectorAll('.ct-week-item__title')].map((el) => el.textContent ?? '');
const stored = async (h: WeekHarness, iso: string) => h.container.data.repos.tasks.listForDay(asLocalDate(iso), 'all');

describe('Semaine : ajout rapide par jour (S-04)', () => {
  let h: WeekHarness;
  beforeEach(async () => {
    h = await setupWeek('304');
  });
  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    await teardownWeek(h);
  });

  for (const [name, width] of [['PC', 1440], ['iPhone', 440]] as const) {
    describe(name, () => {
      beforeEach(() => mockViewport(width));

      it('chaque jour, vide ou non, présente « + Ajouter » en bas de sa colonne ou section (critère 1)', async () => {
        await h.container.data.repos.tasks.create({
          id: '50000000-0000-4000-8000-000000000001' as never,
          spaceId: SPACE_PRO_ID,
          projectId: null,
          title: 'Déjà là',
          note: '',
          date: asLocalDate('2026-09-30'),
          time: null,
          status: 'todo',
          doneAt: null,
          sortOrder: 1,
          carriedOver: false,
          recurrenceId: null,
          seriesIndex: null,
          seriesTemplate: null,
          goalId: null,
          icon: null,
          someday: false,
          source: 'local',
          externalId: null,
          externalEventId: null,
        });
        renderWeek(h.container);
        await screen.findByRole('button', { name: 'Déjà là' });
        const buttons = screen.getAllByRole('button', { name: /^Ajouter une tâche/ });
        expect(buttons).toHaveLength(7);
        for (const button of buttons) expect(button).toHaveTextContent('+ Ajouter');
        // En bas de chaque jour : après les éléments.
        const column = day('2026-09-30');
        expect(column.querySelector('.ct-week-day__body')?.lastElementChild).toBe(addButton('2026-09-30'));
        expect(addButton('2026-10-01')).toHaveAccessibleName('Ajouter une tâche, jeu. 1');
      });

      it('un clic ouvre un champ focalisé « Nouvelle tâche pour jeu. 1 » (critère 2)', async () => {
        renderWeek(h.container);
        await screen.findByRole('heading', { level: 1 });
        fireEvent.click(addButton('2026-10-01'));
        const field = within(day('2026-10-01')).getByRole('textbox', { name: 'Nouvelle tâche pour jeu. 1' });
        expect(field).toHaveFocus();
        expect(screen.queryByRole('button', { name: 'Ajouter une tâche, jeu. 1' })).not.toBeInTheDocument();
        expect(screen.getAllByRole('button', { name: /^Ajouter une tâche/ })).toHaveLength(6);
      });

      it('Entrée crée la tâche du jour, sans heure, en Pro sous « Tout » ; le champ reste ouvert, vide et focalisé (critères 3, 5)', async () => {
        renderWeek(h.container);
        await screen.findByRole('heading', { level: 1 });
        fireEvent.click(addButton('2026-10-01'));
        const field = within(day('2026-10-01')).getByRole('textbox');
        fireEvent.change(field, { target: { value: '  Réunion d’équipe  ' } });
        fireEvent.submit(field.closest('form') as HTMLFormElement);
        expect(await screen.findByRole('button', { name: 'Réunion d’équipe' })).toBeInTheDocument();
        expect(titlesOf('2026-10-01')).toEqual(['Réunion d’équipe']);
        const [task] = await stored(h, '2026-10-01');
        expect(task).toMatchObject({ title: 'Réunion d’équipe', date: '2026-10-01', time: null, spaceId: SPACE_PRO_ID, status: 'todo' });
        await waitFor(() => expect(within(day('2026-10-01')).getByRole('textbox')).toHaveValue(''));
        expect(within(day('2026-10-01')).getByRole('textbox')).toHaveFocus();
      });

      it('l’espace est celui du filtre actif (T-01 / ES-02)', async () => {
        renderWeek(h.container);
        await screen.findByRole('heading', { level: 1 });
        fireEvent.click(screen.getByRole('button', { name: 'Perso' }));
        fireEvent.click(await screen.findByRole('button', { name: 'Ajouter une tâche, mar. 29' }));
        const field = within(day('2026-09-29')).getByRole('textbox');
        fireEvent.change(field, { target: { value: 'Perso courses' } });
        fireEvent.submit(field.closest('form') as HTMLFormElement);
        await screen.findByRole('button', { name: 'Perso courses' });
        expect((await stored(h, '2026-09-29'))[0]?.spaceId).toBe(SPACE_PERSO_ID);
      });

      it('Q-06, Q-02 : « #perso », une heure et une date écrites sont lues ; la date du texte l’emporte sur la colonne', async () => {
        renderWeek(h.container);
        await screen.findByRole('heading', { level: 1 });
        fireEvent.click(addButton('2026-10-01'));
        const field = within(day('2026-10-01')).getByRole('textbox');
        fireEvent.change(field, { target: { value: 'Courses 14h #perso' } });
        expect(await screen.findByRole('group', { name: 'Ce qui sera appliqué' })).toHaveTextContent('Perso');
        fireEvent.submit(field.closest('form') as HTMLFormElement);
        await waitFor(async () => expect((await stored(h, '2026-10-01')).length).toBe(1));
        expect((await stored(h, '2026-10-01'))[0]).toMatchObject({ title: 'Courses', spaceId: SPACE_PERSO_ID, time: '14:00' });
        fireEvent.change(field, { target: { value: 'Rapport le 5 octobre' } });
        fireEvent.submit(field.closest('form') as HTMLFormElement);
        await waitFor(async () => expect((await stored(h, '2026-10-05')).length).toBe(1));
        expect((await stored(h, '2026-10-05'))[0]).toMatchObject({ title: 'Rapport', time: null });
      });

      it('Échap referme le champ sans rien créer, le focus revient au bouton (critère 4)', async () => {
        renderWeek(h.container);
        await screen.findByRole('heading', { level: 1 });
        fireEvent.click(addButton('2026-10-01'));
        const field = within(day('2026-10-01')).getByRole('textbox');
        fireEvent.change(field, { target: { value: 'Abandonnée' } });
        fireEvent.keyDown(field, { key: 'Escape' });
        expect(within(day('2026-10-01')).queryByRole('textbox')).not.toBeInTheDocument();
        await waitFor(() => expect(addButton('2026-10-01')).toHaveFocus());
        expect(await stored(h, '2026-10-01')).toEqual([]);
        // Rouvert, le champ repart vide.
        fireEvent.click(addButton('2026-10-01'));
        expect(within(day('2026-10-01')).getByRole('textbox')).toHaveValue('');
      });

      it('quitter un champ vide le referme ; un titre commencé reste ouvert (critère 4)', async () => {
        renderWeek(h.container);
        await screen.findByRole('heading', { level: 1 });
        fireEvent.click(addButton('2026-10-01'));
        fireEvent.blur(within(day('2026-10-01')).getByRole('textbox'));
        expect(within(day('2026-10-01')).queryByRole('textbox')).not.toBeInTheDocument();

        fireEvent.click(addButton('2026-10-01'));
        const field = within(day('2026-10-01')).getByRole('textbox');
        fireEvent.change(field, { target: { value: 'En cours' } });
        fireEvent.blur(field);
        expect(within(day('2026-10-01')).getByRole('textbox')).toHaveValue('En cours');
      });

      it('un champ vide ou d’espaces ne crée rien et reste ouvert (critères 4 et 5)', async () => {
        renderWeek(h.container);
        await screen.findByRole('heading', { level: 1 });
        fireEvent.click(addButton('2026-10-01'));
        const field = within(day('2026-10-01')).getByRole('textbox');
        fireEvent.submit(field.closest('form') as HTMLFormElement);
        fireEvent.change(field, { target: { value: '     ' } });
        fireEvent.submit(field.closest('form') as HTMLFormElement);
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(await stored(h, '2026-10-01')).toEqual([]);
        expect(within(day('2026-10-01')).getByRole('textbox')).toBeInTheDocument();
      });

      it('la longueur du titre est limitée à 200 caractères (critère 5, T-01)', async () => {
        renderWeek(h.container);
        await screen.findByRole('heading', { level: 1 });
        fireEvent.click(addButton('2026-10-01'));
        expect(within(day('2026-10-01')).getByRole('textbox')).toHaveAttribute('maxlength', '200');
      });

      it('l’ajout est possible sur un jour passé (critère 6)', async () => {
        renderWeek(h.container);
        await screen.findByRole('heading', { level: 1 });
        fireEvent.click(addButton('2026-09-28'));
        const field = within(day('2026-09-28')).getByRole('textbox');
        fireEvent.change(field, { target: { value: 'Rétroactive' } });
        fireEvent.submit(field.closest('form') as HTMLFormElement);
        expect(await screen.findByRole('button', { name: 'Rétroactive' })).toBeInTheDocument();
        expect((await stored(h, '2026-09-28'))[0]).toMatchObject({ title: 'Rétroactive', date: '2026-09-28' });
      });

      it('cinq tâches réparties sur la semaine se créent sans quitter l’écran, chacune visible aussitôt (critère 8)', async () => {
        renderWeek(h.container);
        await screen.findByRole('heading', { level: 1 });
        const plan: [string, string][] = [
          ['2026-09-28', 'Lundi'],
          ['2026-09-29', 'Mardi'],
          ['2026-09-30', 'Mercredi'],
          ['2026-10-02', 'Vendredi'],
          ['2026-10-04', 'Dimanche'],
        ];
        for (const [iso, title] of plan) {
          fireEvent.click(addButton(iso));
          const field = within(day(iso)).getByRole('textbox');
          fireEvent.change(field, { target: { value: title } });
          fireEvent.submit(field.closest('form') as HTMLFormElement);
          const started = performance.now();
          await within(day(iso)).findByRole('button', { name: title });
          expect(performance.now() - started).toBeLessThan(500);
        }
        for (const [iso, title] of plan) expect(titlesOf(iso)).toEqual([title]);
        expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
      });

      it('un échec d’écriture affiche un message et garde le titre saisi', async () => {
        h.container.data.repos.tasks.create = () => Promise.reject(new Error('boom'));
        renderWeek(h.container);
        await screen.findByRole('heading', { level: 1 });
        fireEvent.click(addButton('2026-10-01'));
        const field = within(day('2026-10-01')).getByRole('textbox');
        fireEvent.change(field, { target: { value: 'Perdue ?' } });
        fireEvent.submit(field.closest('form') as HTMLFormElement);
        expect(await screen.findByRole('alert')).toHaveTextContent('Impossible de créer cette tâche.');
        expect(within(day('2026-10-01')).getByRole('textbox')).toHaveValue('Perdue ?');
      });
    });
  }

  it('iPhone : le champ est amené au centre de l’écran à l’ouverture, au-dessus du clavier (critère 7)', async () => {
    mockViewport(440);
    const calls: ScrollIntoViewOptions[] = [];
    Element.prototype.scrollIntoView = function scroll(options?: boolean | ScrollIntoViewOptions) {
      if (typeof options === 'object') calls.push(options);
    };
    try {
      renderWeek(h.container);
      await screen.findByRole('heading', { level: 1 });
      fireEvent.click(addButton('2026-10-03'));
      await waitFor(() => expect(calls).toContainEqual(expect.objectContaining({ block: 'center' })));
    } finally {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });
});
