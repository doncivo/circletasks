import { createTaskUseCases } from '../../tasks/createTaskUseCases';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LocalDate } from '../../../domain/types';
import { createUnavailableReminders } from '../../../platform/reminders';
import { AppContainerProvider } from '../../app/AppContainerContext';
import { AppStatusBanner } from '../../app/AppStatusBanner';
import { mockViewport } from '../../today/testKit';
import { CalendarsSummaryRow } from '../CalendarsSummaryRow';
import { AppleRemindersSection } from './AppleRemindersSection';
import { appleRemindersState, appleRemindersStore } from './appleRemindersState';
import { runRemindersPass } from './remindersPass';
import { PERSO, PRO, setupRemindersHarness, type RemindersHarness } from './testKit';

let h: RemindersHarness;
beforeEach(async () => {
  mockViewport(440);
});
afterEach(() => h.close());

function renderSection() {
  return render(
    <AppContainerProvider container={h.container}>
      <AppStatusBanner />
      <CalendarsSummaryRow />
      <AppleRemindersSection />
    </AppContainerProvider>,
  );
}

const D = (value: string): LocalDate => value as LocalDate;

describe('section Rappels Apple de l’écran Agendas (K-05 critères 6, 7, 8, 12, 13, 14)', () => {
  it('accès non décidé : explication puis « Autoriser l’accès aux Rappels » ; la fenêtre iOS n’est demandée que sur ce geste, jamais au chargement', async () => {
    h = await setupRemindersHarness('5', { access: 'not-determined' });
    renderSection();
    expect(await screen.findByText(/Rien n’est lu avant que vous autorisiez l’accès/)).toBeInTheDocument();
    expect(h.reminders.calls.map((call) => call.name)).not.toContain('requestAccess');
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    h.reminders.add({ listId: 'L-courses', title: 'Pain' });
    fireEvent.click(screen.getByRole('button', { name: 'Autoriser l’accès aux Rappels' }));
    expect(await screen.findByRole('checkbox', { name: 'Afficher Courses' })).toBeInTheDocument();
    expect(h.reminders.calls.filter((call) => call.name === 'requestAccess')).toHaveLength(1);
    // Aucune liste n'est affichée tant que l'utilisateur n'en a pas choisi une : rien n'est importé.
    expect(await h.tasks()).toEqual([]);
  });

  it('accès refusé : état persistant avec renvoi aux réglages iOS, bandeau, aucune liste lue ; rétabli à la reprise : tout disparaît', async () => {
    h = await setupRemindersHarness('6', { access: 'denied' });
    renderSection();
    expect(await screen.findByText(/Autorisez-le dans Réglages d’iOS/)).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    await runRemindersPass(h.container, 'full');
    expect(await screen.findByText('L’accès aux Rappels est refusé')).toBeInTheDocument();
    expect(h.reminders.calls.filter((call) => call.name === 'lists' || call.name === 'fetch')).toEqual([]);
    h.reminders.setAccess('full');
    await h.showList({ id: 'L-courses', name: 'Courses', spaceId: PERSO });
    await runRemindersPass(h.container, 'full');
    await waitFor(() => expect(screen.queryByText('L’accès aux Rappels est refusé')).not.toBeInTheDocument());
    await appleRemindersState(h.container).clearFailure();
  });

  it('listes de Rappels : « Afficher » et l’espace, prérempli Pro ; la ligne de Réglages devient « 2 listes » ; cocher importe', async () => {
    h = await setupRemindersHarness('7');
    h.reminders.add({ listId: 'L-courses', title: 'Acheter du lait', due: { date: D('2026-10-09'), time: null } });
    renderSection();
    const courses = await screen.findByRole('checkbox', { name: 'Afficher Courses' });
    expect(courses).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('button', { name: 'Agendas · Rappels Apple : Aucun compte' })).toBeInTheDocument();
    fireEvent.click(courses);
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Afficher Courses' })).toHaveAttribute('aria-checked', 'true'));
    // Espace prérempli : Pro (ES-06).
    expect(appleRemindersStore.get(h.container).getState().lists.lists.find((list) => list.id === 'L-courses')).toMatchObject({ shown: true, spaceId: PRO });
    expect(within(screen.getByRole('combobox', { name: 'Espace de Courses' })).queryAllByRole('option').length).toBeGreaterThan(0);
    await waitFor(async () => expect(await h.tasks()).toHaveLength(1));
    expect((await h.tasks())[0]).toMatchObject({ title: 'Acheter du lait', spaceId: PRO });
    // Changer l'espace de la liste l'enregistre aussitôt.
    fireEvent.change(screen.getByRole('combobox', { name: 'Espace de Courses' }), { target: { value: PERSO } });
    await waitFor(() => expect(appleRemindersStore.get(h.container).getState().lists.lists.find((list) => list.id === 'L-courses')?.spaceId).toBe(PERSO));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Afficher Travail' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Agendas · Rappels Apple : 2 listes' })).toBeInTheDocument());
  });

  it('une liste affichée sans espace est refusée avec la raison', async () => {
    h = await setupRemindersHarness('8');
    renderSection();
    await screen.findByRole('checkbox', { name: 'Afficher Courses' });
    // Aucun espace connu (liste des espaces vide) : l'espace par défaut n'existe pas.
    const { useAppStore } = await import('../../app/appStore');
    useAppStore.getState().setSpaces([]);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Afficher Courses' }));
    expect(await screen.findByText('Choisissez un espace pour cette liste.')).toBeInTheDocument();
    expect(appleRemindersStore.get(h.container).getState().lists.lists).toEqual([]);
  });

  it('« Mis à jour à 11:00 », plafond « 500 rappels sur 740 importés », liste introuvable, liens inconnus, message de suppression à fermer', async () => {
    h = await setupRemindersHarness('9', { startAt: '2026-10-08T09:00:00.000Z' });
    await h.showList({ id: 'L-courses', name: 'Courses', spaceId: PERSO });
    for (let i = 0; i < 520; i += 1) h.reminders.add({ id: `P-${String(i)}`, listId: 'L-courses', title: `Pain ${String(i)}` });
    renderSection();
    await screen.findByRole('checkbox', { name: 'Afficher Courses' });
    fireEvent.click(screen.getByRole('button', { name: 'Actualiser les Rappels' }));
    // 09:00 UTC en octobre à Paris : 11:00.
    expect(await screen.findByText('Mis à jour à 11:00')).toBeInTheDocument();
    expect(screen.getByText(/500 rappels sur 520 importés/)).toBeInTheDocument();
    // Un rappel supprimé dans Rappels : message, qui se ferme.
    h.reminders.remove('P-3');
    h.db.clock.advance(60_000);
    fireEvent.click(screen.getByRole('button', { name: 'Actualiser les Rappels' }));
    expect(await screen.findByText(/1 rappel\(s\) supprimé\(s\) dans Rappels/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Fermer le message' }));
    await waitFor(() => expect(screen.queryByText(/supprimé\(s\) dans Rappels/)).not.toBeInTheDocument());
  });

  it('l’échec d’un passage reste affiché avec son code et le bandeau « Voir » mène à l’écran Agendas', async () => {
    h = await setupRemindersHarness('10');
    await h.showList({ id: 'L-courses', name: 'Courses', spaceId: PERSO });
    renderSection();
    await screen.findByRole('checkbox', { name: 'Afficher Courses' });
    h.reminders.failNext('lists', 'store-unavailable');
    fireEvent.click(screen.getByRole('button', { name: 'Actualiser les Rappels' }));
    expect(await screen.findByText('Les Rappels Apple n’ont pas pu être lus (store-unavailable).')).toBeInTheDocument();
    expect(screen.getAllByText('Les Rappels Apple n’ont pas pu être lus').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Actualiser les Rappels' }));
    await waitFor(() => expect(screen.queryByText(/store-unavailable/)).not.toBeInTheDocument());
  });

  it('sur PC (plugin indisponible) la section Rappels Apple ne propose aucun accès ni aucune liste modifiable', async () => {
    h = await setupRemindersHarness('11', { runtime: 'tauri', os: 'windows', reminders: createUnavailableReminders() });
    renderSection();
    await waitFor(() => expect(appleRemindersStore.get(h.container).getState().loaded).toBe(true));
    expect(screen.queryByRole('button', { name: 'Autoriser l’accès aux Rappels' })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(h.reminders.calls).toEqual([]);
  });
});

describe('créer aussi dans Rappels (K-06 critère 6, ADR 0008 §10.7)', () => {
  it('une ligne par espace avec interrupteur et liste de destination, désactivée par défaut ; activer sans liste affichée de cet espace est refusé avec la raison', async () => {
    h = await setupRemindersHarness('13');
    await h.showList({ id: 'L-courses', name: 'Courses', spaceId: PERSO });
    renderSection();
    const perso = await screen.findByRole('switch', { name: 'Créer aussi dans Rappels · Perso' });
    const pro = screen.getByRole('switch', { name: 'Créer aussi dans Rappels · Pro' });
    expect(perso).toHaveAttribute('aria-checked', 'false');
    expect(pro).toHaveAttribute('aria-checked', 'false');
    // Pro n'a aucune liste affichée : refus avec la raison, rien n'est écrit.
    fireEvent.click(pro);
    expect(await screen.findByText('Affichez d’abord une liste de cet espace.')).toBeInTheDocument();
    expect(appleRemindersStore.get(h.container).getState().create.bySpace).toEqual([]);
    // Perso a « Courses » : activé avec cette liste de destination.
    fireEvent.click(perso);
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Créer aussi dans Rappels · Perso' })).toHaveAttribute('aria-checked', 'true'));
    expect(appleRemindersStore.get(h.container).getState().create.bySpace).toEqual([{ spaceId: PERSO, enabled: true, listId: 'L-courses' }]);
    expect(await h.container.data.repos.settings.get('appleReminders.create')).toEqual({ bySpace: [{ spaceId: PERSO, enabled: true, listId: 'L-courses' }] });
  });

  it('décocher la liste de destination désactive le réglage et le dit', async () => {
    h = await setupRemindersHarness('14');
    await h.showList({ id: 'L-courses', name: 'Courses', spaceId: PERSO });
    renderSection();
    fireEvent.click(await screen.findByRole('switch', { name: 'Créer aussi dans Rappels · Perso' }));
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Créer aussi dans Rappels · Perso' })).toHaveAttribute('aria-checked', 'true'));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Afficher Courses' }));
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Créer aussi dans Rappels · Perso' })).toHaveAttribute('aria-checked', 'false'));
    expect(await screen.findByText('La création dans Rappels est désactivée : la liste de destination n’est plus affichée.')).toBeInTheDocument();
  });

  it('changer la liste de destination la mémorise ; une liste d’un autre espace n’est pas proposée', async () => {
    h = await setupRemindersHarness('15');
    await h.showList({ id: 'L-courses', name: 'Courses', spaceId: PERSO });
    await h.showList({ id: 'L-travail', name: 'Travail', spaceId: PRO });
    renderSection();
    const destination = await screen.findByRole('combobox', { name: 'Liste de destination · Perso' });
    expect(within(destination).queryByRole('option', { name: 'Travail' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('switch', { name: 'Créer aussi dans Rappels · Perso' }));
    await waitFor(() => expect(appleRemindersStore.get(h.container).getState().create.bySpace[0]).toMatchObject({ enabled: true, listId: 'L-courses' }));
  });
});

describe('QA K-05 : suppression retenue par la garde, gestes de l’utilisateur (ADR 0008 §10.6)', () => {
  async function held(suffix: string) {
    h = await setupRemindersHarness(suffix);
    await h.showList({ id: 'L-courses', name: 'Courses', spaceId: PERSO });
    for (let i = 0; i < 20; i += 1) h.reminders.add({ id: `Z-${String(i)}`, listId: 'L-courses', title: `Z ${String(i)}` });
    await h.pass();
    for (let i = 0; i < 15; i += 1) h.reminders.remove(`Z-${String(i)}`);
    await h.pass();
  }

  it('K-05 « 15 rappels sont absents de Rappels. Supprimer les tâches liées ? » : « Supprimer » met les tâches à la corbeille et la question disparaît', async () => {
    await held('70');
    renderSection();
    expect(await screen.findByText(/15 rappels sont absents de Rappels\. Supprimer les tâches liées \?/)).toBeInTheDocument();
    expect(await h.tasks()).toHaveLength(20);
    fireEvent.click(screen.getByRole('button', { name: 'Supprimer' }));
    await waitFor(() => expect(screen.queryByText(/sont absents de Rappels/)).not.toBeInTheDocument());
    expect((await h.tasks()).filter((task) => task.deletedAt === null)).toHaveLength(5);
  });

  it('K-05 « Garder et détacher » : aucune tâche supprimée, la question disparaît', async () => {
    await held('71');
    renderSection();
    await screen.findByText(/sont absents de Rappels/);
    fireEvent.click(screen.getByRole('button', { name: 'Garder et détacher' }));
    await waitFor(() => expect(screen.queryByText(/sont absents de Rappels/)).not.toBeInTheDocument());
    expect((await h.tasks()).filter((task) => task.deletedAt === null)).toHaveLength(5);
    expect((await h.taskByTitle('Z 0')).deletedAt).toBeNull();
    expect(await h.taskByTitle('Z 0')).toMatchObject({ source: 'local', externalId: null });
  });
});

describe('audit M2 : suppressions vers Rappels retenues, gestes de l’utilisateur', () => {
  it('« 12 tâches supprimées vont aussi supprimer leur rappel dans Rappels » : « Supprimer dans Rappels » les supprime et la question disparaît', async () => {
    h = await setupRemindersHarness('72');
    await h.showList({ id: 'L-courses', name: 'Courses', spaceId: PERSO });
    for (let i = 0; i < 14; i += 1) h.reminders.add({ id: `S-${String(i)}`, listId: 'L-courses', title: `S ${String(i)}` });
    await h.pass();
    await createTaskUseCases(h.container).remove((await h.tasks()).slice(0, 12).map((task) => task.id));
    await h.pass();
    renderSection();
    expect(await screen.findByText(/12 tâches supprimées vont aussi supprimer leur rappel dans Rappels/)).toBeInTheDocument();
    expect(h.reminders.all()).toHaveLength(14);
    fireEvent.click(screen.getByRole('button', { name: 'Supprimer dans Rappels' }));
    await waitFor(() => expect(screen.queryByText(/vont aussi supprimer leur rappel/)).not.toBeInTheDocument());
    expect(h.reminders.all()).toHaveLength(2);
  });
});

describe('geste destructeur en rouge (revue)', () => {
  it('« Supprimer dans Rappels » (garde de suppression massive) est en variante danger', async () => {
    h = await setupRemindersHarness('73');
    await h.showList({ id: 'L-courses', name: 'Courses', spaceId: PERSO });
    for (let i = 0; i < 14; i += 1) h.reminders.add({ id: `D-${String(i)}`, listId: 'L-courses', title: `D ${String(i)}` });
    await h.pass();
    await createTaskUseCases(h.container).remove((await h.tasks()).slice(0, 12).map((task) => task.id));
    await h.pass();
    renderSection();
    const button = await screen.findByRole('button', { name: 'Supprimer dans Rappels' });
    expect(button.className).toContain('ct-button--danger');
  });
});
