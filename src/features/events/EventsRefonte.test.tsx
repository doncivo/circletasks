import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockViewport, renderEvents, seedEvent, setupEvents, teardownEvents, type EventsHarness } from './testKit';

/**
 * UI-REFONTE-07 — Événements sur iPhone (docs/maquettes-refonte/Evenements-v2.html) : plus de filet ni de badges colorés, les fériés
 * reculent en gris avec le pays en toutes lettres, vos événements gardent l'encre et leur compte à rebours, pastille « Masquer les
 * fériés », rangée du bas « Vue calendrier » + « Événement ». Aujourd'hui du harnais : vendredi 2 oct. 2026. PC inchangé.
 */

const rowOf = (title: string): HTMLElement => screen.getByText(title, { selector: '.ct-event-row__title' }).closest('.ct-event-row') as HTMLElement;
const titles = (): string[] => Array.from(document.querySelectorAll('.ct-event-row__title')).map((node) => node.textContent ?? '');

describe('UI-REFONTE-07 — Événements iPhone', () => {
  let h: EventsHarness;
  afterEach(() => teardownEvents(h));

  async function start(suffix: string, width = 440, holidays = true): Promise<void> {
    h = await setupEvents(suffix, undefined, { holidays });
    mockViewport(width);
  }

  it('en-tête : titre et année, plus de filet, pastille « Masquer les fériés » à droite des espaces (critère 1)', async () => {
    await start('471');
    renderEvents(h.container);
    await screen.findByText('Toussaint');
    expect(screen.getByRole('heading', { level: 1, name: 'Événements' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Année suivante' })).toBeInTheDocument();
    expect(document.querySelector('.ct-events__rule')).toBeNull();
    const toggle = screen.getByRole('button', { name: 'Masquer les fériés' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(toggle).toHaveClass('ct-events__holidaysToggle');
  });

  it('fériés en gris, pays en toutes lettres, sans étiquette ; un événement propre garde l’encre et son compte à rebours (critère 2)', async () => {
    await start('472');
    await seedEvent(h, { title: 'Vol vers Tunis', date: '2026-12-03', important: true });
    renderEvents(h.container);
    await screen.findByText('Vol vers Tunis');
    const toussaint = rowOf('Toussaint');
    expect(toussaint).toHaveAttribute('data-source', 'holiday');
    expect(within(toussaint).getByText('Jour férié en France')).toBeInTheDocument();
    expect(toussaint.querySelector('.ct-event-row__tag')).toBeNull();
    expect(screen.queryByText('Férié FR')).toBeNull();
    expect(screen.queryByText('Férié TN')).toBeNull();
    expect(within(rowOf('Fête de l’Évacuation')).getByText('Jour férié en Tunisie')).toBeInTheDocument();
    expect(within(rowOf('Mouled')).getByText('Jour férié en Tunisie · date estimée')).toBeInTheDocument();
    const vol = rowOf('Vol vers Tunis');
    expect(vol).toHaveAttribute('data-source', 'local');
    expect(within(vol).getByText('J-62')).toBeInTheDocument();
    expect(within(vol).getByText('Journée entière · Pro')).toBeInTheDocument();
  });

  it('« Masquer les fériés » retire les fériés et leurs mois vides ; « Afficher les fériés » les remet (critère 3)', async () => {
    await start('473');
    await seedEvent(h, { title: 'Vol vers Tunis', date: '2026-12-03' });
    renderEvents(h.container);
    await screen.findByText('Toussaint');
    expect(screen.getByRole('heading', { level: 2, name: 'novembre' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Masquer les fériés' }));
    await waitFor(() => expect(screen.queryByText('Toussaint')).toBeNull());
    expect(titles()).toEqual(['Vol vers Tunis']);
    expect(screen.queryByRole('heading', { level: 2, name: 'novembre' })).toBeNull();
    const toggle = screen.getByRole('button', { name: 'Afficher les fériés' });
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(toggle);
    expect(await screen.findByText('Toussaint')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Masquer les fériés' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('UI-FIX-08 : « Masquer les fériés » est mémorisé (réglage local) : nouveau rendu → toujours masqué, même libellé (PRD-02, lot F)', async () => {
    await start('475');
    await seedEvent(h, { title: 'Vol vers Tunis', date: '2026-12-03' });
    renderEvents(h.container);
    await screen.findByText('Toussaint');
    fireEvent.click(screen.getByRole('button', { name: 'Masquer les fériés' }));
    await waitFor(() => expect(screen.queryByText('Toussaint')).toBeNull());
    await waitFor(async () => expect(await h.container.data.repos.settings.get('events.hideHolidays')).toBe(true));
    cleanup();
    renderEvents(h.container);
    await screen.findByText('Vol vers Tunis');
    expect(screen.queryByText('Toussaint')).toBeNull();
    expect(screen.getByRole('button', { name: 'Afficher les fériés' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('UI-FIX-08 : échec d’écriture du réglage → retour à la valeur enregistrée et message, rien de muet', async () => {
    await start('476');
    renderEvents(h.container);
    await screen.findByText('Toussaint');
    vi.spyOn(h.container.data.repos.settings, 'set').mockRejectedValueOnce(new Error('boom'));
    fireEvent.click(screen.getByRole('button', { name: 'Masquer les fériés' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Impossible d’enregistrer ce réglage.');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Masquer les fériés' })).toHaveAttribute('aria-pressed', 'false'));
    expect(screen.getByText('Toussaint')).toBeInTheDocument();
    vi.restoreAllMocks();
  });

  it('sans calendrier de fériés : pas de pastille (critère 1)', async () => {
    await start('474', 440, false);
    await seedEvent(h, { title: 'Réunion', date: '2026-10-20' });
    renderEvents(h.container);
    await screen.findByText('Réunion');
    expect(screen.queryByRole('button', { name: /les fériés$/ })).toBeNull();
  });

  it('bas de l’écran : « Vue calendrier » ouvre la feuille « Calendrier », « Événement » ouvre la feuille Ajout ; plus de bouton flottant (critère 4)', async () => {
    await start('475');
    renderEvents(h.container);
    await screen.findByText('Toussaint');
    const row = document.querySelector('.ct-events__bottomRow') as HTMLElement;
    expect(document.querySelector('.ct-fab')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Calendrier' })).toBeNull();
    const add = within(row).getByRole('button', { name: 'Ajouter un événement' });
    expect(add).toHaveTextContent('Événement');
    expect(add).toHaveClass('ct-events__addButton');
    fireEvent.click(within(row).getByRole('button', { name: 'Vue calendrier' }));
    expect(await screen.findByRole('dialog', { name: 'Calendrier' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Fermer' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Calendrier' })).toBeNull());
    fireEvent.click(add);
    expect(await screen.findByRole('dialog', { name: 'Nouvel événement' })).toBeInTheDocument();
  });

  it('PC : filet, étiquettes « Férié FR », bouton « Ajouter », pas de pastille des fériés (critère 7)', async () => {
    await start('476', 1440);
    renderEvents(h.container);
    await screen.findByText('Toussaint');
    expect(document.querySelector('.ct-events__rule')).not.toBeNull();
    expect(within(rowOf('Toussaint')).getByText('Férié FR')).toBeInTheDocument();
    expect(within(rowOf('Toussaint')).getByText('Jour férié en France')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ajouter' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /les fériés$/ })).toBeNull();
    expect(document.querySelector('.ct-events__addButton')).toBeNull();
  });
});
