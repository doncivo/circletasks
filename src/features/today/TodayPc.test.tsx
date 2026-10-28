import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { asLocalDate } from '../../domain/types';
import { mockViewport, renderToday, seedTask, setupToday, teardownToday, type TodayHarness } from './testKit';

/**
 * UI-REFONTE-08 — Aujourd'hui sur PC (docs/maquettes-refonte/PC-Jour.html) : barre fixe nommée (pastilles, Rechercher, Objectif, Rapport,
 * Un jour, Ajouter, Édition, Compacte), colonne du jour bornée avec l'agenda (heures, dû, « maintenant »), seconde colonne « Demain »,
 * « Cette semaine », « Raccourcis », champ d'ajout avec Date et Scanner ; ni badge, ni filet, ni bouton flottant. iPhone inchangé.
 * Aujourd'hui du harnais : vendredi 2 oct. 2026, 10:00 UTC (12:00 Paris).
 */

const topbar = (): HTMLElement => document.querySelector('.ct-today__topbar') as HTMLElement;

describe('UI-REFONTE-08 — Aujourd’hui PC', () => {
  let h: TodayHarness;
  afterEach(() => teardownToday(h));

  async function start(suffix: string, width = 1440): Promise<void> {
    h = await setupToday(suffix);
    mockViewport(width);
  }

  it('barre fixe : pastilles, Rechercher, puis Objectif, Rapport, Un jour, Ajouter, Édition et Compacte nommés ; plus d’icônes muettes ni de bouton flottant (critère 1)', async () => {
    await start('381');
    await seedTask(h, { title: 'Relire le contrat', time: '14:00' });
    renderToday(h.container);
    await screen.findByRole('button', { name: 'Relire le contrat' });
    const bar = topbar();
    expect(bar).not.toBeNull();
    expect(within(bar).getByRole('button', { name: 'Tout' })).toBeInTheDocument();
    expect(within(bar).getByRole('button', { name: 'Rechercher' })).toBeInTheDocument();
    expect(within(bar).getByRole('button', { name: 'Objectif de la semaine' })).toHaveTextContent('Objectif');
    expect(within(bar).getByRole('button', { name: 'Rapport mensuel' })).toHaveTextContent('Rapport');
    expect(within(bar).getByRole('button', { name: /^Un jour/ })).toHaveTextContent('Un jour');
    expect(within(bar).getByRole('button', { name: 'Ajouter' })).toHaveTextContent('Ajouter');
    const edit = within(bar).getByRole('button', { name: 'Mode édition' });
    expect(edit).toHaveTextContent('Édition');
    expect(edit).toHaveAttribute('aria-pressed', 'false');
    const compact = within(bar).getByRole('button', { name: 'Vue compacte' });
    expect(compact).toHaveTextContent('Compacte');
    expect(compact).toHaveAttribute('aria-pressed', 'false');
    expect(document.querySelector('.ct-today__quickIcons')).toBeNull();
    expect(document.querySelector('.ct-fab')).toBeNull();
    expect(document.querySelector('.ct-today__bottomRow')).toBeNull();
    // Les bascules agissent : mode édition puis vue compacte.
    fireEvent.click(edit);
    expect(await screen.findByRole('button', { name: 'Sélectionner : Relire le contrat' })).toBeInTheDocument();
    expect(within(bar).getByRole('button', { name: 'Mode édition' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(within(bar).getByRole('button', { name: 'Mode édition' }));
    fireEvent.click(compact);
    await waitFor(() => expect(document.querySelector('.ct-list-row[data-compact="true"]')).not.toBeNull());
    // « Ajouter » ouvre la feuille « Nouvelle tâche ».
    fireEvent.click(within(bar).getByRole('button', { name: 'Ajouter' }));
    expect(await screen.findByRole('dialog', { name: 'Nouvelle tâche' })).toBeInTheDocument();
  });

  it('colonne du jour : mois, jour en grand, flèches, ni badge ni filet ; l’agenda du jour avec sa ligne « maintenant » (critère 2)', async () => {
    await start('382');
    await seedTask(h, { title: 'Envoyer la facture', time: '08:00' });
    await seedTask(h, { title: 'Relire le contrat', time: '18:00' });
    await seedTask(h, { title: 'Préparer le dépôt GitHub' });
    renderToday(h.container);
    await screen.findByRole('button', { name: 'Relire le contrat' });
    const column = document.querySelector('.ct-today__dayColumn') as HTMLElement;
    expect(column).not.toBeNull();
    expect(within(column).getByRole('heading', { level: 1 })).toHaveTextContent(/vendredi 2/i);
    expect(within(column).getByText(/octobre 2026/)).toBeInTheDocument();
    expect(within(column).getByRole('button', { name: 'Jour précédent' })).toBeInTheDocument();
    expect(within(column).getByRole('button', { name: 'Jour suivant' })).toBeInTheDocument();
    expect(document.querySelector('.ct-today__badge')).toBeNull();
    expect(document.querySelector('.ct-today__rule')).toBeNull();
    expect(document.querySelector('.ct-today__list--agenda')).not.toBeNull();
    expect(document.querySelector('.ct-agenda__now')).not.toBeNull();
    const phases = [...document.querySelectorAll<HTMLElement>('.ct-agenda__line')].map((line) => [line.querySelector('.ct-list-row__title')?.textContent, line.dataset['phase']]);
    expect(phases).toEqual([
      ['Envoyer la facture', 'due'],
      ['Relire le contrat', 'upcoming'],
      ['Préparer le dépôt GitHub', 'untimed'],
    ]);
    expect(document.querySelector('.ct-today-banners')).toBeNull();
    // Champ d'ajout avec Date (T-14) et Scanner (Q-04), en bas de la colonne.
    expect(within(column).getByLabelText('Nouvelle tâche')).toBeInTheDocument();
    expect(within(column).getByRole('button', { name: /^Scan/ })).toBeInTheDocument();
  });

  it('seconde colonne : « Demain », « Cette semaine », « Raccourcis » (critère 3)', async () => {
    await start('383');
    await seedTask(h, { title: 'Courses demain', date: asLocalDate('2026-10-03'), time: '11:00' });
    await seedTask(h, { title: 'Sans heure demain', date: asLocalDate('2026-10-03') });
    await seedTask(h, { title: 'Dimanche repos', date: asLocalDate('2026-10-04') });
    await seedTask(h, { title: 'Lundi prochain', date: asLocalDate('2026-10-05') });
    renderToday(h.container);
    const side = (await screen.findByRole('heading', { name: 'Demain' })).closest('.ct-today__side') as HTMLElement;
    expect(side).not.toBeNull();
    await within(side).findByText('Courses demain');
    const tomorrow = within(side).getByText('Courses demain').closest('.ct-today-side__row') as HTMLElement;
    expect(tomorrow).toHaveTextContent('11:00');
    expect(within(side).getByText('Sans heure demain').closest('.ct-today-side__row')).toHaveTextContent('—');
    expect(within(side).getByRole('heading', { name: 'Cette semaine' })).toBeInTheDocument();
    expect(within(side).getByText('Dimanche repos').closest('.ct-today-side__row')).toHaveTextContent('dim.');
    // La semaine suivante n'y est pas.
    expect(within(side).queryByText('Lundi prochain')).toBeNull();
    expect(within(side).getByRole('heading', { name: 'Raccourcis' })).toBeInTheDocument();
    expect(within(side).getByText(/nouvelle tâche/)).toBeInTheDocument();
    expect(within(side).getByRole('button', { name: /tous les raccourcis/ })).toBeInTheDocument();
  });

  it('seconde colonne : jours vides dits (« Rien de prévu ») (critère 3)', async () => {
    await start('384');
    renderToday(h.container);
    const side = (await screen.findByRole('heading', { name: 'Demain' })).closest('.ct-today__side') as HTMLElement;
    await waitFor(() => expect(within(side).getAllByText('Rien de prévu')).toHaveLength(2));
  });

  it('iPhone : rien ne change (barre absente, menu « Plus d’options », rangée d’ajout de l’agenda) (critère 5)', async () => {
    await start('385', 440);
    await seedTask(h, { title: 'Appeler le notaire', time: '14:00' });
    renderToday(h.container);
    await screen.findByRole('button', { name: 'Appeler le notaire' });
    expect(document.querySelector('.ct-today__topbar')).toBeNull();
    expect(document.querySelector('.ct-today__side')).toBeNull();
    expect(screen.getByRole('button', { name: 'Plus d’options' })).toBeInTheDocument();
    expect(document.querySelector('.ct-agenda__add')).not.toBeNull();
  });
});
