import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHlcClock } from '../../domain/hlc';
import { createAppContainer } from '../app/container';
import { mockViewport, renderToday, seedTask, setupToday, teardownToday, type TodayHarness } from './testKit';

const toggle = () => screen.getByRole('button', { name: 'Vue compacte' });

describe('Aujourd’hui : vue compacte (A-06)', () => {
  let h: TodayHarness;

  beforeEach(async () => {
    h = await setupToday('106');
    mockViewport(440);
    await seedTask(h, { title: 'Envoyer la facture', time: '09:00' });
    await seedTask(h, { title: 'Sans heure' });
  });
  afterEach(() => teardownToday(h));

  const row = (title: string) => screen.getByRole('button', { name: title }).closest('.ct-list-row') as HTMLElement;

  it('une ligne par élément : sous-lignes et icône masquées, pastille, heure à droite seulement si elle existe (critères 1, 2)', async () => {
    renderToday(h.container);
    await screen.findByRole('button', { name: 'Envoyer la facture' });
    expect(toggle()).toHaveAttribute('aria-pressed', 'false');
    expect(row('Envoyer la facture').querySelector('.ct-list-row__subtitle')).toHaveTextContent('09:00 · Pro');

    fireEvent.click(toggle());
    expect(toggle()).toHaveAttribute('aria-pressed', 'true');
    const facture = row('Envoyer la facture');
    expect(facture).toHaveAttribute('data-compact', 'true');
    expect(facture.querySelector('.ct-list-row__subtitle')).toBeNull();
    expect(facture.querySelector('.ct-list-row__dot')).not.toBeNull();
    expect(facture.querySelector('.ct-list-row__time')).toHaveTextContent('09:00');
    expect(facture).not.toHaveTextContent('Pro');
    expect(row('Sans heure').querySelector('.ct-list-row__time')).toBeNull();

    fireEvent.click(toggle());
    expect(toggle()).toHaveAttribute('aria-pressed', 'false');
    expect(row('Envoyer la facture').querySelector('.ct-list-row__subtitle')).not.toBeNull();
  });

  it('le choix est mémorisé et relu au redémarrage, séparément des autres écrans (critère 5)', async () => {
    renderToday(h.container);
    await screen.findByRole('button', { name: 'Envoyer la facture' });
    fireEvent.click(toggle());
    await waitFor(async () => expect((await h.container.data.repos.settings.get('view.compact')).today).toBe(true));
    expect(await h.container.data.repos.settings.get('view.compact')).toEqual({ today: true, routines: false, checklists: false, someday: false });
    cleanup();

    const restarted = createAppContainer({ clock: h.db.clock, hlc: createHlcClock({ clock: h.db.clock, deviceId: h.db.deviceId }), data: h.db.data });
    renderToday(restarted);
    await screen.findByRole('button', { name: 'Envoyer la facture' });
    await waitFor(() => expect(toggle()).toHaveAttribute('aria-pressed', 'true'));
  });

  it('terminer, ouvrir le détail et le mode édition fonctionnent en vue compacte (critère 6)', async () => {
    renderToday(h.container);
    await screen.findByRole('button', { name: 'Envoyer la facture' });
    fireEvent.click(toggle());
    fireEvent.click(screen.getByRole('checkbox', { name: 'Terminer : Sans heure' }));
    await screen.findByRole('checkbox', { name: 'Rouvrir : Sans heure' });
    fireEvent.click(screen.getByRole('button', { name: 'Envoyer la facture' }));
    expect(await screen.findByRole('dialog', { name: 'Détail de la tâche' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Fermer' }));
    fireEvent.click(screen.getByRole('button', { name: 'Mode édition' }));
    expect(screen.getByRole('button', { name: 'Sélectionner : Envoyer la facture' })).toBeInTheDocument();
  });

  it('les notes ne sont jamais affichées dans la liste compacte (critère 3)', async () => {
    const id = (await h.container.data.repos.tasks.listForDay(h.today, 'all'))[0]?.id;
    if (id) await h.container.data.repos.tasks.update(id, { note: 'Note secrète' });
    renderToday(h.container);
    await screen.findByRole('button', { name: 'Envoyer la facture' });
    fireEvent.click(toggle());
    expect(screen.queryByText('Note secrète')).toBeNull();
  });
});
