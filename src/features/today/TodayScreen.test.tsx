import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { todayLocal } from '../../domain/clock';
import { createHlcClock } from '../../domain/hlc';
import { asEntityId, asLocalDate, type DeviceId } from '../../domain/types';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { SPACE_PERSO_ID } from '../../db/seed/defaultSpaces';
import { AppContainerProvider } from '../app/AppContainerContext';
import { UndoToast } from '../app/UndoToast';
import { createAppContainer, type AppContainer } from '../app/container';
import { useAppStore } from '../app/appStore';
import { INITIAL_NAVIGATION, useNavigationStore } from '../app/navigation';
import { createTaskUseCases } from '../tasks/createTaskUseCases';
import { TodayScreen } from './TodayScreen';

const DEVICE = asEntityId<DeviceId>('60000000-0000-4000-8000-000000000001');

function mockViewport(width: number): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: width >= 1024 && query.includes('min-width: 1024px'),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

function renderToday(container: AppContainer) {
  return render(
    <AppContainerProvider container={container}>
      <TodayScreen />
      <UndoToast />
    </AppContainerProvider>,
  );
}

describe('TodayScreen (T-01)', () => {
  let db: TestDb;
  let container: AppContainer;

  beforeEach(async () => {
    db = await openTestDb(DEVICE, '2026-10-02T08:00:00.000Z');
    container = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: DEVICE }), data: db.data });
    // Comme App.tsx (ADR 0004) : les espaces sont déjà dans useAppStore avant le
    // premier rendu de l'écran, jamais lus depuis db/seed par la feature.
    useAppStore.getState().setSpaces(await container.data.repos.spaces.listAll());
  });

  afterEach(async () => {
    // Démonte le composant (et ses abonnements/effets) avant de remettre à zéro
    // l'état global et de fermer la base, pour éviter tout effet en vol sur un état
    // déjà réinitialisé ou une connexion déjà fermée.
    cleanup();
    vi.unstubAllGlobals();
    useAppStore.getState().setSpaceFilter('all');
    useAppStore.getState().setSpaces([]);
    useNavigationStore.setState(INITIAL_NAVIGATION);
    await db.close();
  });

  it('Entrée dans le champ en ligne crée la tâche, vide le champ et garde le focus (critère 1)', async () => {
    mockViewport(1440);
    renderToday(container);

    const field = screen.getByLabelText('Nouvelle tâche');
    fireEvent.change(field, { target: { value: 'Appeler le notaire' } });
    fireEvent.submit(field.closest('form') as HTMLFormElement);

    expect(await screen.findByText('Appeler le notaire')).toBeInTheDocument();
    await waitFor(() => expect(field).toHaveValue(''));
  });

  it('l’état vide disparaît dès qu’une tâche est créée (critère 3)', async () => {
    mockViewport(1440);
    renderToday(container);

    expect(await screen.findByText('Rien de prévu aujourd’hui.')).toBeInTheDocument();

    const field = screen.getByLabelText('Nouvelle tâche');
    fireEvent.change(field, { target: { value: 'Appeler le notaire' } });
    fireEvent.submit(field.closest('form') as HTMLFormElement);

    expect(await screen.findByText('Appeler le notaire')).toBeInTheDocument();
    expect(screen.queryByText('Rien de prévu aujourd’hui.')).not.toBeInTheDocument();
  });

  it('un titre vide ou composé d’espaces ne crée rien (critère 2)', async () => {
    mockViewport(1440);
    renderToday(container);

    const field = screen.getByLabelText('Nouvelle tâche');
    fireEvent.change(field, { target: { value: '   ' } });
    fireEvent.submit(field.closest('form') as HTMLFormElement);

    await waitFor(() => expect(screen.getByText('Rien de prévu aujourd’hui.')).toBeInTheDocument());
    expect(field).toHaveValue('   ');
  });

  it('le champ Titre a le focus à l’ouverture de la feuille « Nouvelle tâche » (critère 4)', async () => {
    mockViewport(440);
    renderToday(container);

    fireEvent.click(screen.getByRole('button', { name: 'Ajouter' }));
    expect(await screen.findByRole('dialog', { name: 'Nouvelle tâche' })).toBeInTheDocument();
    expect(screen.getByLabelText('Titre')).toHaveFocus();
  });

  it('le sélecteur d’espace de la feuille est présélectionné sur le filtre actif (critère 10)', async () => {
    mockViewport(440);
    useAppStore.getState().setSpaceFilter(SPACE_PERSO_ID);
    renderToday(container);

    fireEvent.click(screen.getByRole('button', { name: 'Ajouter' }));
    const dialog = await screen.findByRole('dialog', { name: 'Nouvelle tâche' });
    expect(within(dialog).getByRole('button', { name: 'Perso' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(dialog).getByRole('button', { name: 'Pro' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('le bouton Enregistrer de la feuille « Nouvelle tâche » est désactivé tant que le titre est vide (critère 6)', async () => {
    mockViewport(440);
    renderToday(container);

    fireEvent.click(screen.getByRole('button', { name: 'Ajouter' }));
    const save = screen.getByRole('button', { name: 'Enregistrer' });
    expect(save).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Titre'), { target: { value: 'Envoyer la facture' } });
    expect(save).toBeEnabled();

    fireEvent.change(screen.getByLabelText('Titre'), { target: { value: '   ' } });
    expect(save).toBeDisabled();
  });

  it('Enregistrer dans la feuille crée la tâche et la ferme (critère 7)', async () => {
    mockViewport(440);
    renderToday(container);

    fireEvent.click(screen.getByRole('button', { name: 'Ajouter' }));
    fireEvent.change(screen.getByLabelText('Titre'), { target: { value: 'Faire les courses' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));

    expect(await screen.findByText('Faire les courses')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('affiche un message d’erreur si le chargement de la liste échoue, sans rejet non géré', async () => {
    mockViewport(1440);
    vi.spyOn(container.data.repos.tasks, 'listForDay').mockRejectedValueOnce(new Error('boom'));
    renderToday(container);

    expect(await screen.findByRole('alert')).toHaveTextContent('Impossible de charger les tâches du jour.');
  });

  it('Fermer la feuille ne crée rien (critère 8)', async () => {
    mockViewport(440);
    renderToday(container);

    fireEvent.click(screen.getByRole('button', { name: 'Ajouter' }));
    fireEvent.change(screen.getByLabelText('Titre'), { target: { value: 'Ne pas enregistrer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Fermer' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByText('Ne pas enregistrer')).not.toBeInTheDocument();
  });

  it('affiche l’heure sous le titre quand une tâche en a une (critère 2, T-02)', async () => {
    mockViewport(1440);
    renderToday(container);

    fireEvent.change(screen.getByLabelText('Nouvelle tâche'), { target: { value: 'Appeler le notaire' } });
    const dateField = screen.getByRole('combobox', { name: 'Date' });
    fireEvent.change(dateField, { target: { value: '14:00' } });
    fireEvent.keyDown(dateField, { key: 'Enter' });
    fireEvent.submit(screen.getByLabelText('Nouvelle tâche').closest('form') as HTMLFormElement);

    const row = await screen.findByText('Appeler le notaire');
    expect(row.closest('.ct-list-row')).toHaveTextContent('14:00');
  });

  it('une tâche datée sur un autre jour que l’affichage n’apparaît pas dans Aujourd’hui (critère 1, T-02)', async () => {
    mockViewport(1440);
    renderToday(container);

    fireEvent.change(screen.getByLabelText('Nouvelle tâche'), { target: { value: 'Jeudi prochain' } });
    const dateField = screen.getByRole('combobox', { name: 'Date' });
    fireEvent.change(dateField, { target: { value: '8/10' } });
    fireEvent.keyDown(dateField, { key: 'Enter' });
    fireEvent.submit(screen.getByLabelText('Nouvelle tâche').closest('form') as HTMLFormElement);

    await waitFor(() => expect(screen.getByText('Rien de prévu aujourd’hui.')).toBeInTheDocument());
    expect(screen.queryByText('Jeudi prochain')).not.toBeInTheDocument();
    const thursday = await container.data.repos.tasks.listForDay('2026-10-08' as never, 'all');
    expect(thursday.map((task) => task.title)).toEqual(['Jeudi prochain']);
  });

  it('la feuille « Nouvelle tâche » porte les roues jour, heures et minutes (iPhone, T-02, T-14)', async () => {
    mockViewport(440);
    renderToday(container);

    fireEvent.click(screen.getByRole('button', { name: 'Ajouter' }));
    const dialog = await screen.findByRole('dialog', { name: 'Nouvelle tâche' });
    fireEvent.change(screen.getByLabelText('Titre'), { target: { value: 'Faire les courses' } });
    // Roue des jours : « Aujourd'hui » (ven. 2 oct.) + 6 = jeu. 8 oct. ; heures : « — » + 10 = 09 ; minutes 00.
    const dayWheel = within(dialog).getByRole('spinbutton', { name: 'Jour' });
    for (let i = 0; i < 6; i += 1) fireEvent.keyDown(dayWheel, { key: 'ArrowUp' });
    const hourWheel = within(dialog).getByRole('spinbutton', { name: 'Heures' });
    for (let i = 0; i < 10; i += 1) fireEvent.keyDown(hourWheel, { key: 'ArrowUp' });
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const thursday = await container.data.repos.tasks.listForDay('2026-10-08' as never, 'all');
    expect(thursday).toMatchObject([{ title: 'Faire les courses', time: '09:00' }]);
  });

  it('choisit une icône Lucide dans la feuille « Nouvelle tâche » : affichée, décorative, à droite de la ligne (critères 1, 3, 4, 6)', async () => {
    mockViewport(440);
    renderToday(container);

    fireEvent.click(screen.getByRole('button', { name: 'Ajouter' }));
    const dialog = await screen.findByRole('dialog', { name: 'Nouvelle tâche' });
    fireEvent.change(within(dialog).getByLabelText('Titre'), { target: { value: 'Appeler le notaire' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Icône téléphone' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Enregistrer' }));

    const row = (await screen.findByText('Appeler le notaire')).closest('.ct-list-row') as HTMLElement;
    const icon = row.querySelector('svg');
    expect(icon).toHaveAttribute('aria-hidden', 'true');

    const persisted = await container.data.repos.tasks.listForDay(todayLocal(container.clock), 'all');
    expect(persisted[0]?.icon).toEqual({ kind: 'lucide', name: 'phone' });
  });

  it('choisir un emoji remplace l’icône Lucide choisie (un seul champ icon, critère 2)', async () => {
    mockViewport(440);
    renderToday(container);

    fireEvent.click(screen.getByRole('button', { name: 'Ajouter' }));
    const dialog = await screen.findByRole('dialog', { name: 'Nouvelle tâche' });
    fireEvent.change(within(dialog).getByLabelText('Titre'), { target: { value: 'Boire de l’eau' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Icône téléphone' }));
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Emoji' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Emoji goutte d’eau' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Enregistrer' }));

    await screen.findByText('Boire de l’eau');
    const persisted = await container.data.repos.tasks.listForDay(todayLocal(container.clock), 'all');
    expect(persisted[0]?.icon).toEqual({ kind: 'emoji', value: '💧' });
  });

  it('une tâche sans icône ne réserve aucun emplacement à droite de la ligne (critère 4)', async () => {
    mockViewport(1440);
    renderToday(container);

    fireEvent.change(screen.getByLabelText('Nouvelle tâche'), { target: { value: 'Sans icône' } });
    fireEvent.submit(screen.getByLabelText('Nouvelle tâche').closest('form') as HTMLFormElement);

    const row = (await screen.findByText('Sans icône')).closest('.ct-list-row') as HTMLElement;
    expect(row.querySelector('svg')).toBeNull();
  });

  it('la note d’une tâche n’apparaît pas dans la ligne Aujourd’hui, seulement dans le détail (critère 10)', async () => {
    mockViewport(1440);
    renderToday(container);

    fireEvent.change(screen.getByLabelText('Nouvelle tâche'), { target: { value: 'Avec une note' } });
    fireEvent.submit(screen.getByLabelText('Nouvelle tâche').closest('form') as HTMLFormElement);
    const rowTitle = await screen.findByText('Avec une note');
    const row = rowTitle.closest('.ct-list-row') as HTMLElement;

    fireEvent.click(screen.getByRole('button', { name: 'Avec une note' }));
    const panel = await screen.findByRole('complementary', { name: 'Détail de la tâche' });
    const note = within(panel).getByRole('textbox', { name: 'Note' });
    fireEvent.change(note, { target: { value: 'Secret de la note' } });
    fireEvent.blur(note);
    await waitFor(async () => {
      const persisted = await container.data.repos.tasks.listForDay(todayLocal(container.clock), 'all');
      expect(persisted[0]?.note).toBe('Secret de la note');
    });

    expect(within(row).queryByText('Secret de la note')).not.toBeInTheDocument();
    expect(row).not.toHaveTextContent('Secret de la note');
  });

  it('ouvre la fiche détail au clic du titre, modifie puis retire l’icône depuis la pastille (critère 5)', async () => {
    mockViewport(1440);
    renderToday(container);

    fireEvent.change(screen.getByLabelText('Nouvelle tâche'), { target: { value: 'Envoyer la facture' } });
    fireEvent.submit(screen.getByLabelText('Nouvelle tâche').closest('form') as HTMLFormElement);
    await screen.findByText('Envoyer la facture');

    fireEvent.click(screen.getByRole('button', { name: 'Envoyer la facture' }));
    const panel = await screen.findByRole('complementary', { name: 'Détail de la tâche' });
    const iconButton = () => panel.querySelector('.ct-task-detail__iconButton') as HTMLElement;

    expect(iconButton()).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(within(panel).getByRole('button', { name: 'Icône' }));
    expect(iconButton()).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(within(panel).getByRole('button', { name: 'Icône document' }));
    // Choisir referme le sélecteur aussitôt (pas de bouton supplémentaire) ; la
    // pastille reflète l'icône une fois l'écriture terminée (critère 5).
    await waitFor(() => expect(within(panel).getByRole('button', { name: 'Changer l’icône' })).toBeInTheDocument());
    expect(iconButton()).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(within(panel).getByRole('button', { name: 'Changer l’icône' }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Retirer l’icône' }));
    await waitFor(() => expect(within(panel).getByRole('button', { name: 'Icône' })).toBeInTheDocument());

    const persisted = await container.data.repos.tasks.listForDay(todayLocal(container.clock), 'all');
    expect(persisted[0]?.icon).toBeNull();
  });

  it('la ligne Aujourd’hui reflète aussitôt un changement d’icône ou de note fait dans le panneau (bloquant revue T-03)', async () => {
    mockViewport(1440);
    renderToday(container);

    fireEvent.change(screen.getByLabelText('Nouvelle tâche'), { target: { value: 'Envoyer la facture' } });
    fireEvent.submit(screen.getByLabelText('Nouvelle tâche').closest('form') as HTMLFormElement);
    const row = (await screen.findByText('Envoyer la facture')).closest('.ct-list-row') as HTMLElement;
    expect(row.querySelector('svg')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Envoyer la facture' }));
    const panel = await screen.findByRole('complementary', { name: 'Détail de la tâche' });
    fireEvent.click(within(panel).getByRole('button', { name: 'Icône' }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Icône document' }));

    // La ligne de la liste (pas seulement la base) affiche la nouvelle icône sans
    // recharger ni rouvrir l'écran : todayStore.setTaskInPlace est appelé par
    // TaskDetail après l'écriture réussie.
    await waitFor(() => expect(row.querySelector('svg')).not.toBeNull());
    expect(row.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  it('enregistre une note multi-lignes à la perte de focus, conservée au réaffichage (critères 7 à 9, 11)', async () => {
    mockViewport(1440);
    renderToday(container);

    fireEvent.change(screen.getByLabelText('Nouvelle tâche'), { target: { value: 'Envoyer la facture' } });
    fireEvent.submit(screen.getByLabelText('Nouvelle tâche').closest('form') as HTMLFormElement);
    await screen.findByText('Envoyer la facture');

    fireEvent.click(screen.getByRole('button', { name: 'Envoyer la facture' }));
    const panel = await screen.findByRole('complementary', { name: 'Détail de la tâche' });
    const note = within(panel).getByRole('textbox', { name: 'Note' });

    fireEvent.change(note, { target: { value: 'Ligne 1\nLigne 2' } });
    fireEvent.blur(note);

    await waitFor(async () => {
      const persisted = await container.data.repos.tasks.listForDay(todayLocal(container.clock), 'all');
      expect(persisted[0]?.note).toBe('Ligne 1\nLigne 2');
    });

    // Vide la note : enregistrée comme chaîne vide (critère 9).
    fireEvent.change(note, { target: { value: '' } });
    fireEvent.blur(note);
    await waitFor(async () => {
      const persisted = await container.data.repos.tasks.listForDay(todayLocal(container.clock), 'all');
      expect(persisted[0]?.note).toBe('');
    });
  });

  it('Échap ferme le panneau et enregistre la note en attente (critères 3, 8)', async () => {
    mockViewport(1440);
    renderToday(container);

    fireEvent.change(screen.getByLabelText('Nouvelle tâche'), { target: { value: 'Envoyer la facture' } });
    fireEvent.submit(screen.getByLabelText('Nouvelle tâche').closest('form') as HTMLFormElement);
    await screen.findByText('Envoyer la facture');

    fireEvent.click(screen.getByRole('button', { name: 'Envoyer la facture' }));
    const panel = await screen.findByRole('complementary', { name: 'Détail de la tâche' });
    const note = within(panel).getByRole('textbox', { name: 'Note' });
    fireEvent.change(note, { target: { value: 'À relire' } });
    fireEvent.keyDown(panel, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Détail de la tâche' })).not.toBeInTheDocument());
    const persisted = await container.data.repos.tasks.listForDay(todayLocal(container.clock), 'all');
    expect(persisted[0]?.note).toBe('À relire');
  });

  async function addTaskInline(title: string): Promise<void> {
    fireEvent.change(screen.getByLabelText('Nouvelle tâche'), { target: { value: title } });
    fireEvent.submit(screen.getByLabelText('Nouvelle tâche').closest('form') as HTMLFormElement);
    await screen.findByText(title);
  }

  it('cocher la case termine la tâche : case cochée, titre barré, libellé « Rouvrir », toast (T-04, critères 1, 3, 9)', async () => {
    mockViewport(1440);
    renderToday(container);
    await addTaskInline('Boire de l’eau');

    fireEvent.click(screen.getByRole('checkbox', { name: 'Terminer : Boire de l’eau' }));

    const box = await screen.findByRole('checkbox', { name: 'Rouvrir : Boire de l’eau' });
    expect(box).toHaveAttribute('aria-checked', 'true');
    const row = box.closest('.ct-list-row') as HTMLElement;
    expect(row).toHaveAttribute('data-done', 'true');
    expect(screen.getByRole('status')).toHaveTextContent('« Boire de l’eau » terminée');
    const persisted = await container.data.repos.tasks.listForDay(todayLocal(container.clock), 'all');
    expect(persisted[0]).toMatchObject({ status: 'done' });
    expect(persisted[0]?.doneAt).not.toBeNull();
  });

  it('une tâche terminée descend sous les tâches à faire (T-04, critère 2)', async () => {
    mockViewport(1440);
    renderToday(container);
    await addTaskInline('Première');
    db.clock.advance(1);
    await addTaskInline('Seconde');

    fireEvent.click(screen.getByRole('checkbox', { name: 'Terminer : Première' }));
    await screen.findByRole('checkbox', { name: 'Rouvrir : Première' });

    const titles = Array.from(document.querySelectorAll('.ct-list-row__title')).map((el) => el.textContent);
    expect(titles).toEqual(['Seconde', 'Première']);
  });

  it('Annuler dans les 5 s rouvre la tâche et remonte sa ligne (T-04, critère 3)', async () => {
    mockViewport(1440);
    renderToday(container);
    await addTaskInline('Première');
    db.clock.advance(1);
    await addTaskInline('Seconde');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Terminer : Première' }));
    await screen.findByRole('checkbox', { name: 'Rouvrir : Première' });

    fireEvent.click(screen.getByRole('button', { name: 'Annuler' }));

    await screen.findByRole('checkbox', { name: 'Terminer : Première' });
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
    const titles = Array.from(document.querySelectorAll('.ct-list-row__title')).map((el) => el.textContent);
    expect(titles).toEqual(['Première', 'Seconde']);
    const persisted = await container.data.repos.tasks.listForDay(todayLocal(container.clock), 'all');
    expect(persisted.find((t) => t.title === 'Première')).toMatchObject({ status: 'todo', doneAt: null });
  });

  it('le message disparaît après 5 s mais la tâche reste terminée (T-04, critère 3)', async () => {
    mockViewport(1440);
    renderToday(container);
    await addTaskInline('Boire de l’eau');
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      fireEvent.click(screen.getByRole('checkbox', { name: 'Terminer : Boire de l’eau' }));
      await screen.findByRole('status');

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_001);
      });

      expect(screen.queryByRole('status')).not.toBeInTheDocument();
      expect(screen.getByRole('checkbox', { name: 'Rouvrir : Boire de l’eau' })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('décocher une tâche terminée la rouvre sans message « Annuler » supplémentaire (T-04, critère 5)', async () => {
    mockViewport(1440);
    renderToday(container);
    await addTaskInline('Boire de l’eau');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Terminer : Boire de l’eau' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Rouvrir : Boire de l’eau' }));

    await screen.findByRole('checkbox', { name: 'Terminer : Boire de l’eau' });
    expect(container.undo.getSnapshot().size).toBe(1);
    const persisted = await container.data.repos.tasks.listForDay(todayLocal(container.clock), 'all');
    expect(persisted[0]).toMatchObject({ status: 'todo', doneAt: null });
  });

  it('Espace sur la ligne sélectionnée termine puis rouvre la tâche (T-04, critère 6)', async () => {
    mockViewport(1440);
    renderToday(container);
    await addTaskInline('Boire de l’eau');

    fireEvent.focus(screen.getByRole('button', { name: 'Boire de l’eau' }));
    await waitFor(() => expect(container.shortcuts.activeIds()).toContain('list.complete'));
    const press = () =>
      container.shortcuts.handle({ key: ' ', code: 'Space', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, editable: false });

    press();
    await screen.findByRole('checkbox', { name: 'Rouvrir : Boire de l’eau' });
    press();
    await screen.findByRole('checkbox', { name: 'Terminer : Boire de l’eau' });
  });

  it('PC : terminer se fait sur la case de la ligne (le panneau n’a pas de bouton « Marquer comme terminée »), la ligne le reflète (T-04, critère 1)', async () => {
    mockViewport(1440);
    renderToday(container);
    await addTaskInline('Envoyer la facture');

    fireEvent.click(screen.getByRole('button', { name: 'Envoyer la facture' }));
    const panel = await screen.findByRole('complementary', { name: 'Détail de la tâche' });
    expect(within(panel).queryByRole('button', { name: 'Marquer comme terminée' })).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Terminer : Envoyer la facture' }));

    expect(await screen.findByRole('checkbox', { name: 'Rouvrir : Envoyer la facture' })).toBeInTheDocument();
  });

  it('cocher dans la liste met à jour la fiche ouverte (source unique) : « Reporter » disparaît, puis revient en décochant', async () => {
    mockViewport(1440);
    renderToday(container);
    await addTaskInline('Envoyer la facture');
    fireEvent.click(screen.getByRole('button', { name: 'Envoyer la facture' }));
    const panel = await screen.findByRole('complementary', { name: 'Détail de la tâche' });
    expect(within(panel).getByRole('button', { name: 'Reporter' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Terminer : Envoyer la facture' }));
    await waitFor(() => expect(within(panel).queryByRole('button', { name: 'Reporter' })).toBeNull());

    fireEvent.click(screen.getByRole('checkbox', { name: 'Rouvrir : Envoyer la facture' }));
    await waitFor(() => expect(within(panel).getByRole('button', { name: 'Reporter' })).toBeInTheDocument());
    expect(container.undo.getSnapshot().size).toBe(1); // une seule complétion enregistrée
  });

  it('Annuler met à jour la fiche ouverte (source unique, sans rechargement)', async () => {
    mockViewport(1440);
    renderToday(container);
    await addTaskInline('Envoyer la facture');
    fireEvent.click(screen.getByRole('button', { name: 'Envoyer la facture' }));
    const panel = await screen.findByRole('complementary', { name: 'Détail de la tâche' });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Terminer : Envoyer la facture' }));
    await waitFor(() => expect(within(panel).queryByRole('button', { name: 'Reporter' })).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'Annuler' }));

    await waitFor(() => expect(within(panel).getByRole('button', { name: 'Reporter' })).toBeInTheDocument());
  });

  it('affiche l’erreur sans rejet non géré si l’écriture de la complétion échoue (T-04)', async () => {
    mockViewport(1440);
    renderToday(container);
    await addTaskInline('Boire de l’eau');
    vi.spyOn(container.data.repos.tasks, 'complete').mockRejectedValueOnce(new Error('boom'));

    fireEvent.click(screen.getByRole('checkbox', { name: 'Terminer : Boire de l’eau' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Impossible de terminer ou rouvrir cette tâche.');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Terminer : Boire de l’eau' })).toBeInTheDocument(); // liste conservée
  });

  async function openDetailOf(title: string) {
    fireEvent.click(screen.getByRole('button', { name: title }));
    return screen.findByRole('complementary', { name: 'Détail de la tâche' });
  }

  const ctrl = (key: string) => ({ key, code: `Key${key.toUpperCase()}`, ctrlKey: true, altKey: false, shiftKey: false, metaKey: false, editable: false });

  it('Reporter > Demain : la tâche quitte la liste, message avec titre, Annuler la remet (T-05, critères 1, 2, 6)', async () => {
    mockViewport(1440);
    renderToday(container);
    await addTaskInline('Courses');
    const panel = await openDetailOf('Courses');

    fireEvent.click(within(panel).getByRole('button', { name: 'Reporter' }));
    const menu = await screen.findByRole('menu', { name: 'Reporter la tâche' });
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Demain', 'Semaine prochaine', 'Choisir une date']);
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Demain' }));

    await waitFor(() => expect(screen.queryByRole('checkbox', { name: 'Terminer : Courses' })).not.toBeInTheDocument());
    expect(screen.getByRole('status')).toHaveTextContent('« Courses » reportée à demain');
    fireEvent.click(screen.getByRole('button', { name: 'Annuler' }));
    expect(await screen.findByRole('checkbox', { name: 'Terminer : Courses' })).toBeInTheDocument();
  });

  it('Échap ferme le menu sans rien reporter ni fermer la fiche (T-05, critère 1)', async () => {
    mockViewport(1440);
    renderToday(container);
    await addTaskInline('Courses');
    const panel = await openDetailOf('Courses');
    fireEvent.click(within(panel).getByRole('button', { name: 'Reporter' }));
    await screen.findByRole('menu');

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    expect(screen.getByRole('complementary', { name: 'Détail de la tâche' })).toBeInTheDocument();
    expect(container.undo.getSnapshot().size).toBe(0);
  });

  it('Choisir une date applique la date validée ; Fermer n’applique rien (T-05, critère 4)', async () => {
    mockViewport(1440);
    renderToday(container);
    await addTaskInline('Courses');
    const panel = await openDetailOf('Courses');

    fireEvent.click(within(panel).getByRole('button', { name: 'Reporter' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Choisir une date' }));
    let dialog = await screen.findByRole('dialog', { name: 'Choisir une date' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Fermer' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Choisir une date' })).not.toBeInTheDocument());
    expect(container.undo.getSnapshot().size).toBe(0);

    fireEvent.click(within(panel).getByRole('button', { name: 'Reporter' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Choisir une date' }));
    dialog = await screen.findByRole('dialog', { name: 'Choisir une date' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Date' }), { target: { value: '24/12/2026' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Valider' }));

    await waitFor(() => expect(screen.queryByRole('checkbox', { name: 'Terminer : Courses' })).not.toBeInTheDocument());
    expect(screen.getByRole('status')).toHaveTextContent(/^« Courses » reportée au jeu\. 24 déc\.Annuler$/);
    const [persisted] = await container.data.repos.tasks.listForDay(asLocalDate('2026-12-24'), 'all');
    expect(persisted).toMatchObject({ title: 'Courses', carriedOver: false });
  });

  it('Échap sur « Choisir une date » n’applique rien (T-05, critère 4)', async () => {
    mockViewport(1440);
    renderToday(container);
    await addTaskInline('Courses');
    const panel = await openDetailOf('Courses');
    fireEvent.click(within(panel).getByRole('button', { name: 'Reporter' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Choisir une date' }));
    const dialog = await screen.findByRole('dialog', { name: 'Choisir une date' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Date' }), { target: { value: '24/12/2026' } });

    fireEvent.keyDown(document.activeElement ?? dialog, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Choisir une date' })).not.toBeInTheDocument());
    expect(container.undo.getSnapshot().size).toBe(0);
    expect(screen.getByRole('checkbox', { name: 'Terminer : Courses' })).toBeInTheDocument();
  });

  it('le message de report disparaît après 5 s mais la date reste changée (T-05, critère 6)', async () => {
    mockViewport(1440);
    renderToday(container);
    await addTaskInline('Courses');
    const panel = await openDetailOf('Courses');
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      fireEvent.click(within(panel).getByRole('button', { name: 'Reporter' }));
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Demain' }));
      await screen.findByRole('status');

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_001);
      });

      expect(screen.queryByRole('status')).not.toBeInTheDocument();
      expect(screen.queryByRole('checkbox', { name: 'Terminer : Courses' })).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('Ctrl+D sur la ligne sélectionnée reporte à demain ; Ctrl+Z rétablit (T-05, critères 5, 6)', async () => {
    mockViewport(1440);
    renderToday(container);
    await addTaskInline('Courses');
    fireEvent.focus(screen.getByRole('button', { name: 'Courses' }));
    await waitFor(() => expect(container.shortcuts.activeIds()).toContain('list.postponeTomorrow'));

    container.shortcuts.handle(ctrl('d'));
    await waitFor(() => expect(screen.queryByRole('checkbox', { name: 'Terminer : Courses' })).not.toBeInTheDocument());

    container.shortcuts.handle(ctrl('z'));
    expect(await screen.findByRole('checkbox', { name: 'Terminer : Courses' })).toBeInTheDocument();
  });

  it('une tâche terminée n’a pas de bouton Reporter (T-05, critère 9)', async () => {
    mockViewport(1440);
    renderToday(container);
    await addTaskInline('Courses');
    const panel = await openDetailOf('Courses');
    expect(within(panel).getByRole('button', { name: 'Reporter' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Terminer : Courses' }));

    await waitFor(() => expect(within(panel).queryByRole('button', { name: 'Reporter' })).not.toBeInTheDocument());
  });

  it('une tâche « Un jour » propose « Planifier » au lieu de « Reporter » (T-05, critère 8)', async () => {
    mockViewport(1440);
    renderToday(container);
    const created = await createTaskUseCases(container).create({ title: 'Idée', spaceId: SPACE_PERSO_ID, date: null, someday: true });
    if (!created.ok) throw new Error('fixture');
    act(() => useNavigationStore.getState().openDetail({ type: 'task', id: created.value.id }));

    const panel = await screen.findByRole('complementary', { name: 'Détail de la tâche' });
    expect(await within(panel).findByRole('button', { name: 'Planifier' })).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: 'Reporter' })).not.toBeInTheDocument();
  });

  it('iPhone : Reporter ouvre une feuille d’actions avec Fermer (T-05, critère 1)', async () => {
    mockViewport(440);
    renderToday(container);
    await addTaskInline('Courses');
    fireEvent.click(screen.getByRole('button', { name: 'Courses' }));
    const sheet = await screen.findByRole('dialog', { name: 'Détail de la tâche' });

    fireEvent.click(within(sheet).getByRole('button', { name: 'Reporter' }));
    const actions = await screen.findByRole('dialog', { name: 'Reporter la tâche' });
    expect(within(actions).getAllByRole('button').map((b) => b.textContent)).toEqual(['Demain', 'Semaine prochaine', 'Choisir une date', 'Fermer']);
    fireEvent.click(within(actions).getByRole('button', { name: 'Semaine prochaine' }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Reporter la tâche' })).not.toBeInTheDocument());
    expect(screen.getByRole('dialog', { name: 'Détail de la tâche' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('« Courses » reportée au');
  });

  it('échec du report : message d’erreur, tâche conservée, pas de rejet non géré (T-05)', async () => {
    mockViewport(1440);
    renderToday(container);
    await addTaskInline('Courses');
    vi.spyOn(container.data, 'transaction').mockRejectedValueOnce(new Error('boom'));
    fireEvent.focus(screen.getByRole('button', { name: 'Courses' }));
    await waitFor(() => expect(container.shortcuts.activeIds()).toContain('list.postponeTomorrow'));

    container.shortcuts.handle(ctrl('d'));

    expect(await screen.findByRole('alert')).toHaveTextContent('Impossible de reporter cette tâche.');
    expect(screen.getByRole('checkbox', { name: 'Terminer : Courses' })).toBeInTheDocument();
  });

  it('iPhone : la fiche détail s’ouvre en feuille plein écran et se ferme par « Fermer » (A-08, critère 2)', async () => {
    mockViewport(440);
    renderToday(container);

    fireEvent.change(screen.getByLabelText('Nouvelle tâche'), { target: { value: 'Envoyer la facture' } });
    fireEvent.submit(screen.getByLabelText('Nouvelle tâche').closest('form') as HTMLFormElement);
    await screen.findByText('Envoyer la facture');

    fireEvent.click(screen.getByRole('button', { name: 'Envoyer la facture' }));
    const sheet = await screen.findByRole('dialog', { name: 'Détail de la tâche' });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Fermer' }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Détail de la tâche' })).not.toBeInTheDocument());
  });
});
