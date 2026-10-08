import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IsoDateTime, LocalDate } from '../../../domain/types';
import { createUnavailableReminders } from '../../../platform/reminders';
import { AppContainerProvider } from '../../app/AppContainerContext';
import { syncStore } from '../../sync/syncStore';
import { mockViewport } from '../../today/testKit';
import { AppleRemindersSection } from './AppleRemindersSection';
import { AppleSourceRow } from './AppleSourceRow';
import { appleRemindersState } from './appleRemindersState';
import { PERSO, PRO, setupRemindersHarness, type RemindersHarness } from './testKit';

/**
 * K-07 (critères 5, 7, 8 ; D1, D2) : sur le PC, la section Rappels Apple est en lecture seule ; elle montre ce que la synchro a apporté
 * (listes suivies, dernière lecture de l'iPhone, tâches liées, écritures en attente) et avertit sans jamais bloquer. Aucun appel de plugin.
 */
let h: RemindersHarness;
const NOW = '2026-10-08T10:00:00.000Z';

beforeEach(async () => {
  mockViewport(1280);
  h = await setupRemindersHarness('30', { startAt: NOW, runtime: 'tauri', os: 'windows', reminders: createUnavailableReminders() });
});
afterEach(() => h.close());

const IPHONE = { deviceId: 'iphone-1', platform: 'ios', self: false, status: 'active', seen: true } as const;

async function setDevices(devices: readonly object[]): Promise<void> {
  syncStore.get(h.container).setState({ status: { ...syncStore.get(h.container).getState().status, devices: devices as never } });
}

async function configure(values: { lastPassAt?: IsoDateTime | null; pending?: { count: number; at: IsoDateTime } | null; lists?: boolean }): Promise<void> {
  const settings = h.container.data.repos.settings;
  if (values.lists !== false) {
    await settings.set('appleReminders.lists', { lists: [{ id: 'L1', name: 'Courses', spaceId: PERSO, shown: true }, { id: 'L2', name: 'Travail', spaceId: PRO, shown: true }, { id: 'L3', name: 'Cachée', spaceId: PRO, shown: false }] });
  }
  if (values.lastPassAt !== undefined) await settings.set('appleReminders.lastPassAt', values.lastPassAt);
  if (values.pending !== undefined) await settings.set('appleReminders.pending', values.pending);
}

function renderSection() {
  return render(
    <AppContainerProvider container={h.container}>
      <AppleRemindersSection />
    </AppContainerProvider>,
  );
}

describe('section Rappels Apple sur le PC (K-07 critères 5 et 7)', () => {
  it('lecture seule : listes suivies avec leur espace, ni connexion, ni choix de liste, ni réglage de création, « Se règle sur l’iPhone »', async () => {
    await configure({ lastPassAt: '2026-10-08T09:30:00.000Z' as IsoDateTime });
    await setDevices([IPHONE]);
    renderSection();
    expect(await screen.findByText('Les Rappels Apple se lisent sur l’iPhone et arrivent ici par la synchro.')).toBeInTheDocument();
    expect(screen.getByText('Courses')).toBeInTheDocument();
    expect(screen.getByText('Travail')).toBeInTheDocument();
    expect(screen.queryByText('Cachée')).not.toBeInTheDocument();
    expect(screen.getByText('Se règle sur l’iPhone')).toBeInTheDocument();
    for (const control of ['checkbox', 'switch', 'combobox']) expect(screen.queryByRole(control)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Autoriser|Actualiser/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/CRÉER AUSSI/)).not.toBeInTheDocument();
    expect(h.reminders.calls).toEqual([]);
  });

  it('heure de la dernière lecture : « à 12:30 », « hier à … », « le … à … » ; absente : « Aucune lecture… »', async () => {
    await configure({ lastPassAt: '2026-10-08T09:30:00.000Z' as IsoDateTime });
    await setDevices([IPHONE]);
    const view = renderSection();
    expect(await screen.findByText('Mis à jour sur l’iPhone à 11:30')).toBeInTheDocument();
    view.unmount();
    await h.container.data.repos.settings.set('appleReminders.lastPassAt', '2026-10-07T20:15:00.000Z' as IsoDateTime);
    await appleRemindersState(h.container).reload();
    const second = renderSection();
    expect(await screen.findByText('Mis à jour sur l’iPhone hier à 22:15')).toBeInTheDocument();
    second.unmount();
    await h.container.data.repos.settings.set('appleReminders.lastPassAt', '2026-10-03T07:00:00.000Z' as IsoDateTime);
    await appleRemindersState(h.container).reload();
    renderSection();
    expect(await screen.findByText(/^Mis à jour sur l’iPhone le .* à 09:00$/)).toBeInTheDocument();
  });

  it('plus de 24 h : avertissement sans bloquer (24 h moins une minute : aucun) ; jamais lu ; aucun iPhone associé', async () => {
    await setDevices([IPHONE]);
    await configure({ lastPassAt: new Date(Date.parse(NOW) - 24 * 3_600_000 + 60_000).toISOString() as IsoDateTime });
    const fresh = renderSection();
    await screen.findByText(/Mis à jour sur l’iPhone/);
    expect(screen.queryByText(/ouvrez CircleTasks sur l’iPhone/)).not.toBeInTheDocument();
    fresh.unmount();
    await h.container.data.repos.settings.set('appleReminders.lastPassAt', new Date(Date.parse(NOW) - 24 * 3_600_000 - 60_000).toISOString() as IsoDateTime);
    await appleRemindersState(h.container).reload();
    const stale = renderSection();
    expect(await screen.findByText(/^Rappels mis à jour sur l’iPhone le .* à .* : ouvrez CircleTasks sur l’iPhone pour les actualiser\.$/)).toBeInTheDocument();
    stale.unmount();
    await h.container.data.repos.settings.set('appleReminders.lastPassAt', null);
    await appleRemindersState(h.container).reload();
    const never = renderSection();
    expect(await screen.findByText('Les Rappels n’ont pas encore été lus par l’iPhone : ouvrez CircleTasks sur l’iPhone pour les importer.')).toBeInTheDocument();
    never.unmount();
    await setDevices([]);
    renderSection();
    expect(await screen.findByText('Aucun iPhone n’est associé : les Rappels ne peuvent pas être actualisés.')).toBeInTheDocument();
  });

  it('personne n’utilise les Rappels (aucune liste, aucune lecture) : aucun avertissement', async () => {
    await setDevices([]);
    renderSection();
    expect(await screen.findByText('Aucune liste n’est suivie pour le moment.')).toBeInTheDocument();
    expect(screen.queryByText(/Aucun iPhone n’est associé/)).not.toBeInTheDocument();
    expect(screen.queryByText(/n’ont pas encore été lus/)).not.toBeInTheDocument();
  });

  it('nombre de tâches liées et écritures en attente publiées par l’iPhone (K-07 critère 8)', async () => {
    await setDevices([IPHONE]);
    await configure({ lastPassAt: '2026-10-08T09:30:00.000Z' as IsoDateTime, pending: { count: 3, at: NOW as IsoDateTime } });
    for (const [index, title] of ['Un', 'Deux'].entries()) {
      await h.container.data.repos.tasks.create({
        id: `94000000-0000-4000-8000-00000000000${String(index)}` as never, spaceId: PERSO, projectId: null, title, note: '', date: '2026-10-09' as LocalDate, time: null, status: 'todo', doneAt: null, sortOrder: index, carriedOver: false, recurrenceId: null, seriesIndex: null, seriesTemplate: null, goalId: null, icon: null, someday: false, source: 'apple_reminders', externalId: `R-${String(index)}`, appleListId: 'L1', appleRecurring: false, externalEventId: null,
      });
    }
    renderSection();
    expect(await screen.findByText('2 tâche(s) liée(s) à Rappels')).toBeInTheDocument();
    expect(screen.getByText('3 modification(s) en attente d’envoi vers Rappels au prochain passage de l’iPhone.')).toBeInTheDocument();
  });
});

describe('fiche d’une tâche liée sur le PC (K-07 critères 2 et 8, D2)', () => {
  async function makeTask(extra: Record<string, unknown> = {}) {
    return h.container.data.repos.tasks.create({
      id: '95000000-0000-4000-8000-000000000001' as never, spaceId: PERSO, projectId: null, title: 'Appeler', note: '', date: '2026-10-09' as LocalDate, time: null, status: 'todo', doneAt: null, sortOrder: 1, carriedOver: false, recurrenceId: null, seriesIndex: null, seriesTemplate: null, goalId: null, icon: null, someday: false, source: 'apple_reminders', externalId: 'R-1', appleListId: 'L1', appleRecurring: false, externalEventId: null, ...extra,
    });
  }
  const renderRow = (task: Awaited<ReturnType<typeof makeTask>>) =>
    render(
      <AppContainerProvider container={h.container}>
        <AppleSourceRow task={task} />
      </AppContainerProvider>,
    );

  it('« Source : Rappels · liste Courses » ; « Sera envoyée vers Rappels au prochain passage de l’iPhone » tant que la modification est plus récente que la dernière lecture, puis disparaît', async () => {
    // Les réglages et la tâche existent avant la dernière lecture de l'iPhone (l'horloge logique ne recule jamais).
    h.db.clock.set('2026-10-08T07:00:00.000Z');
    await configure({ lastPassAt: '2026-10-08T09:30:00.000Z' as IsoDateTime });
    await appleRemindersState(h.container).reload();
    h.db.clock.set('2026-10-08T08:00:00.000Z');
    let task = await makeTask();
    // Modifiée avant la dernière lecture de l'iPhone : rien en attente.
    h.db.clock.set('2026-10-08T09:00:00.000Z');
    task = await h.container.data.repos.tasks.update(task.id, { title: 'Appeler le notaire' });
    const view = renderRow(task);
    expect(await screen.findByText('Source : Rappels · liste Courses')).toBeInTheDocument();
    expect(screen.queryByText('Sera envoyée vers Rappels au prochain passage de l’iPhone')).not.toBeInTheDocument();
    view.unmount();
    // Modifiée après : la mention apparaît.
    h.db.clock.set('2026-10-08T09:45:00.000Z');
    task = await h.container.data.repos.tasks.complete(task.id, '2026-10-08T09:45:00.000Z' as IsoDateTime);
    const waiting = renderRow(task);
    expect(await screen.findByText('Sera envoyée vers Rappels au prochain passage de l’iPhone')).toBeInTheDocument();
    waiting.unmount();
    // L'iPhone a envoyé et republié sa lecture : la mention disparaît.
    await h.container.data.repos.settings.set('appleReminders.lastPassAt', '2026-10-08T09:50:00.000Z' as IsoDateTime);
    await appleRemindersState(h.container).reload();
    renderRow(task);
    await screen.findByText('Source : Rappels · liste Courses');
    await waitFor(() => expect(screen.queryByText('Sera envoyée vers Rappels au prochain passage de l’iPhone')).not.toBeInTheDocument());
  });

  it('une note modifiée sur le PC n’annonce aucun envoi', async () => {
    h.db.clock.set('2026-10-08T07:00:00.000Z');
    await configure({ lastPassAt: '2026-10-08T09:30:00.000Z' as IsoDateTime });
    await appleRemindersState(h.container).reload();
    h.db.clock.set('2026-10-08T08:00:00.000Z');
    let task = await makeTask();
    h.db.clock.set('2026-10-08T09:45:00.000Z');
    task = await h.container.data.repos.tasks.update(task.id, { note: 'à apporter' });
    renderRow(task);
    await screen.findByText('Source : Rappels · liste Courses');
    expect(screen.queryByText('Sera envoyée vers Rappels au prochain passage de l’iPhone')).not.toBeInTheDocument();
  });

  it('tâche détachée : « Détachée de Rappels le {date} » ; tâche ordinaire : rien', async () => {
    h.db.clock.set('2026-10-06T10:00:00.000Z');
    const attached = await makeTask();
    h.db.clock.set('2026-10-07T10:00:00.000Z');
    const detached = await h.container.data.repos.tasks.setAppleLink(attached.id, { source: 'local', externalId: null, appleListId: 'L1', appleRecurring: false });
    const view = renderRow(detached);
    expect(await screen.findByText(/^Détachée de Rappels le .+$/)).toBeInTheDocument();
    view.unmount();
    h.db.clock.set('2026-10-08T10:00:00.000Z');
    const plain = await h.container.data.repos.tasks.setAppleLink(attached.id, { source: 'local', externalId: null, appleListId: null, appleRecurring: false });
    const none = renderRow(plain);
    expect(none.container).toBeEmptyDOMElement();
  });
});
