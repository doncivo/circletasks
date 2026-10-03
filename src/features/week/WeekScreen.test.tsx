import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { asLocalDate } from '../../domain/types';
import { useAppStore } from '../app/appStore';
import { useNavigationStore } from '../app/navigation';
import { mockViewport, renderWeek, seedTask, setupWeek, teardownWeek, type WeekHarness } from './testKit';

/** Aujourd'hui du harnais : ven. 2 oct. 2026, semaine ISO 40 (lundi 28 sept. au dimanche 4 oct.). */
const day = (iso: string): HTMLElement => document.querySelector<HTMLElement>(`[data-date="${iso}"]`) as HTMLElement;
const titlesOf = (iso: string): string[] => [...day(iso).querySelectorAll('.ct-week-item__title')].map((el) => el.textContent ?? '');

describe('Semaine : sept jours (S-01)', () => {
  let h: WeekHarness;
  beforeEach(async () => {
    h = await setupWeek('301');
  });
  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    await teardownWeek(h);
  });

  describe('PC', () => {
    beforeEach(() => mockViewport(1440));

    it('affiche la semaine courante du lundi au dimanche, en sept colonnes (critères 1 et 11)', async () => {
      renderWeek(h.container);
      await waitFor(() => expect(day('2026-10-04')).toBeTruthy());
      const dates = [...document.querySelectorAll('.ct-week-day')].map((el) => el.getAttribute('data-date'));
      expect(dates).toEqual(['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04']);
      expect(document.querySelector('.ct-week__days')).toHaveAttribute('data-layout', 'pc');
      expect(day('2026-09-28')).toHaveTextContent('LUN.28');
      expect(day('2026-10-04')).toHaveTextContent('DIM.4');
    });

    it('affiche « Semaine 40 » et la plage « 28 septembre – 4 octobre 2026 » (critère 2)', async () => {
      renderWeek(h.container);
      expect(await screen.findByText('Semaine 40')).toBeInTheDocument();
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('28 septembre – 4 octobre 2026');
    });

    it('met en évidence le jour courant seulement, annoncé « aujourd’hui » (critère 3)', async () => {
      renderWeek(h.container);
      await waitFor(() => expect(day('2026-10-02')).toBeTruthy());
      const marked = [...document.querySelectorAll('.ct-week-day[data-today]')];
      expect(marked).toHaveLength(1);
      expect(marked[0]).toBe(day('2026-10-02'));
      expect(day('2026-10-02')).toHaveAttribute('aria-current', 'date');
      expect(screen.getByRole('group', { name: /aujourd’hui/ })).toBe(day('2026-10-02'));
      expect(day('2026-10-01')).not.toHaveAttribute('aria-current');
    });

    it('place chaque tâche dans son jour : heures triées puis sans heure dans l’ordre manuel (critères 4 et 5)', async () => {
      await seedTask(h, { title: 'Sans heure B', date: asLocalDate('2026-09-30') });
      await seedTask(h, { title: 'Sans heure A', date: asLocalDate('2026-09-30') });
      await seedTask(h, { title: 'À 14h', date: asLocalDate('2026-09-30'), time: '14:00' });
      await seedTask(h, { title: 'À 09h', date: asLocalDate('2026-09-30'), time: '09:00' });
      await seedTask(h, { title: 'Vendredi', date: asLocalDate('2026-10-02') });
      await seedTask(h, { title: 'Semaine suivante', date: asLocalDate('2026-10-05') });
      renderWeek(h.container);
      await screen.findByRole('button', { name: 'Vendredi' });
      expect(titlesOf('2026-09-30')).toEqual(['À 09h', 'À 14h', 'Sans heure B', 'Sans heure A']);
      expect(titlesOf('2026-10-02')).toEqual(['Vendredi']);
      expect(screen.queryByText('Semaine suivante')).not.toBeInTheDocument();
    });

    it('la carte affiche l’heure et l’espace dans sa sous-ligne (critère 5)', async () => {
      await seedTask(h, { title: 'Envoyer la facture', date: asLocalDate('2026-09-30'), time: '09:00' });
      renderWeek(h.container);
      const card = (await screen.findByRole('button', { name: 'Envoyer la facture' })).closest('.ct-week-item') as HTMLElement;
      expect(card).toHaveTextContent('09:00 · Pro');
    });

    it('le filtre d’espace s’applique aux sept jours (critère 6)', async () => {
      await seedTask(h, { title: 'Pro lundi', date: asLocalDate('2026-09-28'), spaceId: SPACE_PRO_ID });
      await seedTask(h, { title: 'Perso jeudi', date: asLocalDate('2026-10-01'), spaceId: SPACE_PERSO_ID });
      renderWeek(h.container);
      await screen.findByRole('button', { name: 'Pro lundi' });
      expect(screen.getByRole('button', { name: 'Perso jeudi' })).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Perso' }));
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Pro lundi' })).not.toBeInTheDocument());
      expect(screen.getByRole('button', { name: 'Perso jeudi' })).toBeInTheDocument();
      expect(useAppStore.getState().spaceFilter).toBe(SPACE_PERSO_ID);
    });

    it('cocher la case termine la tâche, qui reste barrée à sa place (critère 7)', async () => {
      const task = await seedTask(h, { title: 'À cocher', date: asLocalDate('2026-10-01') });
      renderWeek(h.container);
      fireEvent.click(await screen.findByRole('checkbox', { name: 'Terminer : À cocher' }));
      await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Rouvrir : À cocher' })).toBeInTheDocument());
      expect((await h.container.data.repos.tasks.getById(task.id))?.status).toBe('done');
      expect(screen.getByRole('button', { name: 'À cocher' })).toHaveAttribute('data-done', 'true');
    });

    it('un titre ouvre la fiche détail (critère 8)', async () => {
      const task = await seedTask(h, { title: 'À ouvrir', date: asLocalDate('2026-10-03') });
      renderWeek(h.container);
      fireEvent.click(await screen.findByRole('button', { name: 'À ouvrir' }));
      expect(useNavigationStore.getState().detail).toEqual({ type: 'task', id: task.id });
      expect(await screen.findByRole('complementary', { name: 'Détail de la tâche' })).toBeInTheDocument();
    });

    it('une tâche datée dans la semaine depuis une autre vue rejoint la grille sans rechargement', async () => {
      const task = await seedTask(h, { title: 'Venue d’ailleurs', date: asLocalDate('2026-10-12') });
      renderWeek(h.container);
      await waitFor(() => expect(day('2026-10-04')).toBeTruthy());
      expect(screen.queryByText('Venue d’ailleurs')).not.toBeInTheDocument();
      const moved = await h.container.data.repos.tasks.update(task.id, { date: asLocalDate('2026-10-04') });
      act(() => h.container.taskEntities.publish([moved]));
      expect(await screen.findByRole('button', { name: 'Venue d’ailleurs' })).toBeInTheDocument();
      expect(titlesOf('2026-10-04')).toEqual(['Venue d’ailleurs']);
    });

    it('affiche un squelette si le chargement dépasse 150 ms (A-09)', async () => {
      const original = h.container.data.repos.tasks.listForWeek.bind(h.container.data.repos.tasks);
      // Chargement tenu en attente par une promesse maîtrisée par le test : le squelette (minuterie de 150 ms) apparaît quel que
      // soit le retard de la machine, puis le chargement n'aboutit qu'une fois le squelette constaté (aucune course entre minuteries).
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      h.container.data.repos.tasks.listForWeek = async (...args) => {
        await gate;
        return original(...args);
      };
      renderWeek(h.container);
      expect(await screen.findAllByTestId('list-skeleton', {}, { timeout: 10_000 })).toHaveLength(7);
      expect(document.querySelector('.ct-week__days')).toHaveAttribute('aria-busy', 'true');
      release();
      await waitFor(() => expect(screen.queryAllByTestId('list-skeleton')).toHaveLength(0), { timeout: 10_000 });
    });

    it('un échec de chargement affiche un message et pas de grille', async () => {
      h.container.data.repos.tasks.listForWeek = () => Promise.reject(new Error('boom'));
      renderWeek(h.container);
      expect(await screen.findByRole('alert')).toHaveTextContent('Impossible de charger la semaine.');
      expect(document.querySelector('.ct-week__days')).toBeNull();
    });
  });

  describe('iPhone', () => {
    beforeEach(() => mockViewport(440));

    it('affiche sept sections verticales, « Semaine 40 · 2026 » et « 28 sept. – 4 oct. » (critères 1 et 2)', async () => {
      renderWeek(h.container);
      expect(await screen.findByText('Semaine 40 · 2026')).toBeInTheDocument();
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('28 sept. – 4 oct.');
      expect(document.querySelectorAll('.ct-week-day[data-layout="mobile"]')).toHaveLength(7);
    });

    it('la ligne affiche la case, l’heure éventuelle et le titre (critère 5)', async () => {
      await seedTask(h, { title: 'Envoyer la facture', date: asLocalDate('2026-09-30'), time: '09:00' });
      await seedTask(h, { title: 'Sans heure', date: asLocalDate('2026-09-30') });
      renderWeek(h.container);
      const row = (await screen.findByRole('button', { name: 'Envoyer la facture' })).closest('.ct-week-item') as HTMLElement;
      expect(row).toHaveTextContent('09:00Envoyer la facture');
      expect(within(row).getByRole('checkbox', { name: 'Terminer : Envoyer la facture' })).toBeInTheDocument();
      const plain = screen.getByRole('button', { name: 'Sans heure' }).closest('.ct-week-item') as HTMLElement;
      expect(plain.querySelector('.ct-week-item__time')).toBeNull();
    });

    it('un titre ouvre la fiche détail en feuille (critère 8)', async () => {
      await seedTask(h, { title: 'À ouvrir', date: asLocalDate('2026-10-03') });
      renderWeek(h.container);
      fireEvent.click(await screen.findByRole('button', { name: 'À ouvrir' }));
      expect(await screen.findByRole('dialog')).toBeInTheDocument();
    });
  });
});
