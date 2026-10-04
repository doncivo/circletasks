import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHlcClock } from '../../domain/hlc';
import type { ChecklistId, DeviceId, RoutineId, TaskId } from '../../domain/types';
import { asEntityId } from '../../domain/types';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { AppContainerProvider } from '../app/AppContainerContext';
import { useAppStore } from '../app/appStore';
import { createAppContainer, type AppContainer } from '../app/container';
import { INITIAL_NAVIGATION, useNavigationStore } from '../app/navigation';
import { AboutSection } from './AboutSection';
import { OnboardingHost } from './OnboardingHost';
import { SampleDataRow } from './SampleDataRow';
import { onboardingStore } from './onboardingStore';
import { createOnboardingUseCases } from './onboardingUseCases';
import { settingsStore } from './settingsStore';

const DEVICE = asEntityId<DeviceId>('60000000-0000-4000-8000-0000000000a5');

function viewport(width: number): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: width >= 1024 && query.includes('min-width: 1024px'),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

describe('Premier lancement (P-05)', () => {
  let db: TestDb;
  let container: AppContainer;

  const click = (element: HTMLElement) => act(async () => void fireEvent.click(element));
  const countOf = async (table: string): Promise<number> => (await db.driver.select<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE deleted_at IS NULL`))[0]?.n ?? 0;
  const renderHost = (c: AppContainer = container) =>
    render(
      <AppContainerProvider container={c}>
        <OnboardingHost />
      </AppContainerProvider>,
    );

  beforeEach(async () => {
    db = await openTestDb(DEVICE, '2026-10-05T08:00:00.000Z');
    container = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: DEVICE }), data: db.data, platform: { runtime: 'web', os: 'other' } });
    useAppStore.getState().setSpaces(await container.data.repos.spaces.listAll());
    (globalThis as { __ctOnboarding?: boolean }).__ctOnboarding = true;
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete (globalThis as { __ctOnboarding?: boolean }).__ctOnboarding;
    useAppStore.setState({ spaceFilter: 'all', spaces: [], projects: [], projectFilter: null, day: null });
    useNavigationStore.setState(INITIAL_NAVIGATION);
    await db.close();
  });

  describe('cas d’usage (critères 1, 6, 7, 8, 10)', () => {
    it('critère 1 : base neuve et réglage absent -> ouvrir ; réglage non posé tant que rien n’est fait', async () => {
      const useCases = createOnboardingUseCases(container);
      const started = await useCases.start();
      expect(started.decision).toBe('show');
      expect(started.steps).toEqual(['language', 'spaces', 'sample']);
      expect(await db.data.repos.settings.get('onboarding.completed')).toBe(false);
    });

    it('critère 1 : base qui contient déjà des données -> « terminé » posé en silence', async () => {
      await createOnboardingUseCases(container).createSampleData(); // n’importe quelle donnée : ici des tâches
      const useCases = createOnboardingUseCases(container);
      expect((await useCases.start()).decision).toBe('mark-done');
      expect(await db.data.repos.settings.get('onboarding.completed')).toBe(true);
      expect((await useCases.start()).decision).toBe('skip');
    });

    it('critère 1 : une seule routine ou un seul événement suffit à ne pas ouvrir l’assistant', async () => {
      await db.driver.execute(
        `INSERT INTO checklist (id, space_id, title, is_template, created_at, updated_at, device_id, hlc) VALUES ('c1', ?, 'Liste', 0, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', 'x', '0000000000000-0000-x')`,
        [SPACE_PRO_ID],
      );
      expect((await createOnboardingUseCases(container).start()).decision).toBe('mark-done');
    });

    it('critère 10 : une interruption rouvre à l’étape mémorisée', async () => {
      const useCases = createOnboardingUseCases(container);
      await useCases.saveStep('spaces');
      const started = await useCases.start();
      expect(started).toMatchObject({ decision: 'show', stepIndex: 1 });
      await useCases.saveStep('sample');
      expect((await useCases.start()).stepIndex).toBe(2);
    });

    it('critère 7 : passer termine l’assistant, il ne réapparaît pas', async () => {
      const useCases = createOnboardingUseCases(container);
      await useCases.saveStep('spaces');
      await useCases.skip();
      expect(await db.data.repos.settings.get('onboarding.completed')).toBe(true);
      expect(await db.data.repos.settings.get('onboarding.step')).toBeNull();
      expect((await useCases.start()).decision).toBe('skip');
    });

    it('critère 6 : 6 tâches, 2 routines, 1 checklist dans Pro et Perso, dates relatives, cas d’usage normaux', async () => {
      const ids = await createOnboardingUseCases(container).createSampleData();
      expect([ids.tasks.length, ids.routines.length, ids.checklists.length]).toEqual([6, 2, 1]);
      const tasks = await Promise.all(ids.tasks.map((id) => db.data.repos.tasks.getById(id as TaskId)));
      expect(tasks.map((task) => [task?.title, task?.spaceId === SPACE_PRO_ID ? 'Pro' : 'Perso', task?.date, task?.time, task?.someday])).toEqual([
        ['Préparer la réunion d’équipe', 'Pro', '2026-10-05', '09:30', false],
        ['Envoyer la facture du mois', 'Pro', '2026-10-05', null, false],
        ['Appeler le client', 'Pro', '2026-10-06', '14:00', false],
        ['Faire les courses', 'Perso', '2026-10-05', '18:30', false],
        ['Réserver le restaurant', 'Perso', '2026-10-07', null, false],
        ['Planifier les vacances', 'Perso', null, null, true],
      ]);
      const routines = await Promise.all(ids.routines.map((id) => db.data.repos.routines.getById(id as RoutineId)));
      expect(routines.map((routine) => [routine?.title, routine?.spaceId === SPACE_PRO_ID ? 'Pro' : 'Perso', routine?.scheduleType])).toEqual([
        ['Revue de la semaine', 'Pro', 'weekdays'],
        ['Marcher 20 minutes', 'Perso', 'daily'],
      ]);
      const checklist = await db.data.repos.checklists.getById(ids.checklists[0] as ChecklistId);
      expect(checklist).toMatchObject({ title: 'Valise du week-end', spaceId: SPACE_PERSO_ID });
      expect((await db.data.repos.checklistItems.listForChecklist(ids.checklists[0] as ChecklistId)).map((item) => item.text)).toEqual(['Chargeur', 'Trousse de toilette', 'Vêtements de rechange']);
      expect(await db.data.repos.settings.get('sample.ids')).toEqual(ids);
    });

    it('critère 6 : « Commencer » avec l’option crée les éléments une seule fois', async () => {
      const useCases = createOnboardingUseCases(container);
      await useCases.finish({ withSamples: true });
      await useCases.finish({ withSamples: true });
      expect(await countOf('task')).toBe(6);
      expect(await countOf('routine')).toBe(2);
      expect(await countOf('checklist')).toBe(1);
      expect(await db.data.repos.settings.get('onboarding.completed')).toBe(true);
    });

    it('critère 6 : sans l’option, aucune donnée n’est créée', async () => {
      await createOnboardingUseCases(container).finish({ withSamples: false });
      expect(await countOf('task')).toBe(0);
      expect(await db.data.repos.settings.get('onboarding.completed')).toBe(true);
    });

    it('critère 6 : supprimer les données d’exemple -> corbeille, routines archivées, annulable', async () => {
      const useCases = createOnboardingUseCases(container);
      const ids = await useCases.createSampleData();
      expect(await useCases.sampleExists()).toBe(true);
      expect(await useCases.removeSampleData()).toBe(9);
      expect(await useCases.sampleExists()).toBe(false);
      expect(await countOf('task')).toBe(0);
      expect(await countOf('checklist')).toBe(0);
      // Les tâches sont à la corbeille (restaurables), les routines archivées.
      expect(await db.data.repos.tasks.getById(ids.tasks[0] as TaskId, { includeDeleted: true })).toMatchObject({ deletedAt: expect.any(String) as string });
      expect((await db.data.repos.routines.getById(ids.routines[0] as RoutineId))?.archived).toBe(true);
      // Annuler : le dernier retrait (la checklist) revient.
      await container.undo.undoLast();
      expect(await countOf('checklist')).toBe(1);
      expect(await useCases.sampleExists()).toBe(true);
    });

    it('critère 8 : relancer le guide ne touche pas aux données', async () => {
      const useCases = createOnboardingUseCases(container);
      await useCases.finish({ withSamples: true });
      await useCases.relaunch();
      expect(await countOf('task')).toBe(6);
      expect(await useCases.sampleExists()).toBe(true);
      expect((await useCases.start(undefined, { force: true })).decision).toBe('show');
    });
  });

  describe('assistant (critères 1 à 4, 7, 9, 11, 12)', () => {
    it('hors app installée (navigateur) : jamais d’assistant, sauf demande des tests', async () => {
      delete (globalThis as { __ctOnboarding?: boolean }).__ctOnboarding;
      renderHost();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('app installée : s’ouvre sur une base neuve, « Étape 1 sur 3 », titre h1 « Bienvenue » avec le focus, pied « Ensuite »', async () => {
      const tauri = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: DEVICE }), data: db.data, platform: { runtime: 'tauri', os: 'windows' } });
      delete (globalThis as { __ctOnboarding?: boolean }).__ctOnboarding;
      renderHost(tauri);
      const dialog = await screen.findByRole('dialog', { name: 'Guide de bienvenue' });
      expect(within(dialog).getByText('Étape 1 sur 3')).toBeInTheDocument();
      const title = within(dialog).getByRole('heading', { level: 1, name: 'Bienvenue' });
      await waitFor(() => expect(title).toHaveFocus());
      expect(within(dialog).getByText('Ensuite : espaces, puis données d’exemple')).toBeInTheDocument();
      expect(within(dialog).getByRole('progressbar', { name: 'Progression du guide de bienvenue' })).toHaveAttribute('aria-valuenow', '1');
      // critère 11 : aucune demande de compte, de réseau ni de permission.
      expect(within(dialog).queryByText(/compte|notification|autoriser/i)).not.toBeInTheDocument();
    });

    it('critère 1 : sur une base qui contient déjà des données, rien ne s’affiche', async () => {
      await createOnboardingUseCases(container).createSampleData();
      renderHost();
      await waitFor(() => expect(onboardingStore.get(container).getState().ready).toBe(true));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(await db.data.repos.settings.get('onboarding.completed')).toBe(true);
    });

    it('critère 3 : langue Français non modifiable et premier jour de semaine appliqué tout de suite', async () => {
      renderHost();
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText('Français')).toBeInTheDocument();
      expect(within(dialog).queryByRole('combobox')).not.toBeInTheDocument();
      const group = within(dialog).getByRole('radiogroup', { name: 'Premier jour de la semaine' });
      expect(within(group).getByRole('radio', { name: 'Lundi' })).toHaveAttribute('aria-checked', 'true');
      await click(within(group).getByRole('radio', { name: 'Dimanche' }));
      await waitFor(() => expect(settingsStore.get(container).getState().firstWeekday).toBe('sunday'));
      await waitFor(async () => expect(await db.data.repos.settings.get('general.firstWeekday')).toBe('sunday'));
    });

    it('critères 4 et 2 : espaces (cartes ES-01), silence de Pro, « Continuer » / « Retour » sans perte, étape mémorisée', async () => {
      renderHost();
      const dialog = await screen.findByRole('dialog');
      await click(within(dialog).getByRole('button', { name: 'Continuer' }));
      expect(await within(dialog).findByRole('heading', { level: 1, name: 'Séparez le pro et le perso' })).toBeInTheDocument();
      expect(within(dialog).getByText('Étape 2 sur 3')).toBeInTheDocument();
      expect(within(dialog).getByText('ESPACE 1')).toBeInTheDocument();
      expect(within(dialog).getByText('ESPACE 2')).toBeInTheDocument();
      expect(within(dialog).getByText(/^Silence : /)).toBeInTheDocument();
      expect(within(dialog).getByText('Aucune plage de silence')).toBeInTheDocument();
      expect(within(dialog).getByText('Ensuite : données d’exemple')).toBeInTheDocument();
      expect(await db.data.repos.settings.get('onboarding.step')).toBe('spaces');
      // Renommer Perso : enregistré comme dans Réglages.
      const field = within(dialog).getByLabelText('Nom de l’espace 2');
      fireEvent.change(field, { target: { value: 'Maison' } });
      await act(async () => void fireEvent.blur(field));
      await waitFor(async () => expect((await db.data.repos.spaces.getById(SPACE_PERSO_ID))?.name).toBe('Maison'));
      // Retour puis Continuer : rien n’est perdu.
      await click(within(dialog).getByRole('button', { name: 'Retour' }));
      expect(await within(dialog).findByRole('heading', { level: 1, name: 'Bienvenue' })).toBeInTheDocument();
      await click(within(dialog).getByRole('button', { name: 'Continuer' }));
      expect(await within(dialog).findByDisplayValue('Maison')).toBeInTheDocument();
    });

    it('critère 4 : le lien « modifiable » masque l’assistant, ouvre l’éditeur du silence, et l’assistant revient au retour', async () => {
      renderHost();
      const dialog = await screen.findByRole('dialog');
      await click(within(dialog).getByRole('button', { name: 'Continuer' }));
      await click(await within(dialog).findByRole('button', { name: /Modifier le silence de l’espace Pro/ }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(useNavigationStore.getState().route).toMatchObject({ tab: 'settings', screen: 'quiet', spaceId: SPACE_PRO_ID });
      act(() => useNavigationStore.getState().navigate({ tab: 'settings', screen: 'home' }));
      const back = await screen.findByRole('dialog');
      expect(within(back).getByText('Étape 2 sur 3')).toBeInTheDocument();
    });

    it('critères 5 et 6 : étape « Données d’exemple », interrupteur désactivé par défaut, « Commencer » crée les éléments', async () => {
      renderHost();
      const dialog = await screen.findByRole('dialog');
      await click(within(dialog).getByRole('button', { name: 'Continuer' }));
      await click(await within(dialog).findByRole('button', { name: 'Continuer' }));
      expect(await within(dialog).findByText('Étape 3 sur 3')).toBeInTheDocument();
      const toggle = within(dialog).getByRole('switch', { name: 'Ajouter des données d’exemple' });
      expect(toggle).toHaveAttribute('aria-checked', 'false');
      expect(within(dialog).getByText('6 tâches, 2 routines, 1 checklist, dans Pro et Perso')).toBeInTheDocument();
      expect(within(dialog).queryByText(/Ensuite/)).not.toBeInTheDocument();
      await click(toggle);
      expect(toggle).toHaveAttribute('aria-checked', 'true');
      await click(within(dialog).getByRole('button', { name: 'Commencer' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(await countOf('task')).toBe(6);
      expect(await db.data.repos.settings.get('onboarding.completed')).toBe(true);
    });

    it('critère 6 : « Commencer » sans l’option ne crée rien', async () => {
      renderHost();
      const dialog = await screen.findByRole('dialog');
      await click(within(dialog).getByRole('button', { name: 'Continuer' }));
      await click(await within(dialog).findByRole('button', { name: 'Continuer' }));
      await click(await within(dialog).findByRole('button', { name: 'Commencer' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(await countOf('task')).toBe(0);
    });

    it('critère 7 : « Passer » ferme, conserve les choix et ne réapparaît pas', async () => {
      const { unmount } = renderHost();
      const dialog = await screen.findByRole('dialog');
      await click(within(dialog).getByRole('radio', { name: 'Samedi' }));
      await click(within(dialog).getByRole('button', { name: 'Passer le guide de bienvenue' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(await db.data.repos.settings.get('general.firstWeekday')).toBe('saturday');
      unmount();
      renderHost();
      await waitFor(() => expect(onboardingStore.get(container).getState().ready).toBe(true));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('critères 7 et 9 (PC) : la croix et Échap ferment l’assistant', async () => {
      viewport(1440);
      const first = renderHost();
      const dialog = await screen.findByRole('dialog');
      await click(within(dialog).getByRole('button', { name: 'Fermer le guide de bienvenue' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      first.unmount();
      await db.data.repos.settings.set('onboarding.completed', false);
      onboardingStore.get(container).setState({ ready: false, open: false });
      renderHost();
      const again = await screen.findByRole('dialog');
      expect(again.closest('.ct-onboarding')).toHaveAttribute('data-layout', 'pc');
      await act(async () => void fireEvent.keyDown(again, { key: 'Escape' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(await db.data.repos.settings.get('onboarding.completed')).toBe(true);
    });

    it('iPhone : plein écran, sans croix, Échap sans effet', async () => {
      viewport(440);
      renderHost();
      const dialog = await screen.findByRole('dialog');
      expect(dialog.closest('.ct-onboarding')).toHaveAttribute('data-layout', 'phone');
      expect(within(dialog).queryByRole('button', { name: 'Fermer le guide de bienvenue' })).not.toBeInTheDocument();
      await act(async () => void fireEvent.keyDown(dialog, { key: 'Escape' }));
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    it('critère 10 : fermer l’app en cours d’assistant le rouvre à l’étape en cours', async () => {
      const first = renderHost();
      const dialog = await screen.findByRole('dialog');
      await click(within(dialog).getByRole('button', { name: 'Continuer' }));
      await within(dialog).findByText('Étape 2 sur 3');
      first.unmount();
      // Nouveau lancement : nouveau conteneur sur la même base.
      const relaunched = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: DEVICE }), data: db.data, platform: { runtime: 'web', os: 'other' } });
      renderHost(relaunched);
      expect(await screen.findByText('Étape 2 sur 3')).toBeInTheDocument();
    });
  });

  describe('Réglages (critères 6 et 8)', () => {
    it('« Revoir le guide de bienvenue » (À PROPOS) rouvre l’assistant à la première étape, même avec des données', async () => {
      const useCases = createOnboardingUseCases(container);
      await useCases.finish({ withSamples: true });
      render(
        <AppContainerProvider container={container}>
          <AboutSection />
          <OnboardingHost />
        </AppContainerProvider>,
      );
      expect(screen.getByText('À PROPOS')).toBeInTheDocument();
      await waitFor(() => expect(onboardingStore.get(container).getState().ready).toBe(true));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      await click(screen.getByRole('button', { name: 'Revoir le guide de bienvenue' }));
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText('Étape 1 sur 3')).toBeInTheDocument();
      // Les données d’exemple existent déjà : l’étape ne les propose pas à nouveau.
      await click(within(dialog).getByRole('button', { name: 'Continuer' }));
      await click(await within(dialog).findByRole('button', { name: 'Continuer' }));
      expect(await within(dialog).findByText(/ne seront pas ajoutées une seconde fois/)).toBeInTheDocument();
      expect(within(dialog).queryByRole('switch')).not.toBeInTheDocument();
      await click(within(dialog).getByRole('button', { name: 'Commencer' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(await countOf('task')).toBe(6);
    });

    it('relance depuis Réglages avec les exemples : à la fermeture de l’assistant, la ligne « Supprimer les données d’exemple » apparaît sans rouvrir Réglages', async () => {
      render(
        <AppContainerProvider container={container}>
          <AboutSection />
          <SampleDataRow />
          <OnboardingHost />
        </AppContainerProvider>,
      );
      await waitFor(() => expect(onboardingStore.get(container).getState().ready).toBe(true));
      await click(await screen.findByRole('button', { name: 'Revoir le guide de bienvenue' }));
      const dialog = await screen.findByRole('dialog');
      expect(screen.queryByRole('button', { name: 'Supprimer les données d’exemple' })).not.toBeInTheDocument();
      await click(within(dialog).getByRole('button', { name: 'Continuer' }));
      await click(await within(dialog).findByRole('button', { name: 'Continuer' }));
      await click(await within(dialog).findByRole('switch', { name: 'Ajouter des données d’exemple' }));
      await click(within(dialog).getByRole('button', { name: 'Commencer' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(await screen.findByRole('button', { name: 'Supprimer les données d’exemple' })).toBeInTheDocument();
    });

    it('échec de création des exemples : le message est affiché hors de l’assistant (alerte dans la section DONNÉES)', async () => {
      render(
        <AppContainerProvider container={container}>
          <SampleDataRow />
          <OnboardingHost />
        </AppContainerProvider>,
      );
      const dialog = await screen.findByRole('dialog');
      await click(within(dialog).getByRole('button', { name: 'Continuer' }));
      await click(await within(dialog).findByRole('button', { name: 'Continuer' }));
      await click(await within(dialog).findByRole('switch', { name: 'Ajouter des données d’exemple' }));
      vi.spyOn(container.data.repos.spaces, 'listAll').mockRejectedValue(new Error('disque plein'));
      await click(within(dialog).getByRole('button', { name: 'Commencer' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Les données d’exemple n’ont pas pu être créées');
      expect(await db.data.repos.settings.get('onboarding.completed')).toBe(true);
      await click(screen.getByRole('button', { name: 'Fermer' }));
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('« Supprimer les données d’exemple » : visible tant qu’elles existent, confirmation, puis plus visible', async () => {
      render(
        <AppContainerProvider container={container}>
          <SampleDataRow />
        </AppContainerProvider>,
      );
      expect(screen.queryByText('Supprimer les données d’exemple')).not.toBeInTheDocument();
      cleanup();
      await createOnboardingUseCases(container).createSampleData();
      render(
        <AppContainerProvider container={container}>
          <SampleDataRow />
        </AppContainerProvider>,
      );
      await click(await screen.findByRole('button', { name: 'Supprimer les données d’exemple' }));
      const confirm = await screen.findByRole('alertdialog', { name: 'Supprimer les données d’exemple ?' });
      await waitFor(() => expect(within(confirm).getByRole('button', { name: 'Annuler' })).toHaveFocus());
      await click(within(confirm).getByRole('button', { name: 'Annuler' }));
      expect(await countOf('task')).toBe(6);
      await click(screen.getByRole('button', { name: 'Supprimer les données d’exemple' }));
      await click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Supprimer' }));
      expect(await screen.findByText('Données d’exemple supprimées')).toBeInTheDocument();
      expect(await countOf('task')).toBe(0);
    });
  });
});
