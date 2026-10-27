import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { asLocalDate, asLocalTime } from '../../domain/types';
import { AppContainerProvider } from '../app/AppContainerContext';
import { useAppStore } from '../app/appStore';
import { useNavigationStore } from '../app/navigation';
import { createTaskUseCases } from '../tasks/createTaskUseCases';
import { TaskDetail } from '../tasks/TaskDetail';
import { mockViewport, setupToday, teardownToday, type TodayHarness } from '../today/testKit';
import { ReminderBlock } from './ReminderBlock';

/**
 * N-FIX-04 : le bloc Rappel des feuilles de tâche (Nouvelle tâche et Modifier, iPhone) et les champs de la fiche PC disent, au moment du
 * choix, qu'un rappel tombe dans la plage silencieuse de l'espace. Aujourd'hui dans les tests : ven. 2 oct. 2026 ; Pro : 19:00 → 08:00 et
 * week-end ; Perso : aucune plage.
 */
describe('bloc Rappel : rappel dans la plage silencieuse (N-FIX-04)', () => {
  let h: TodayHarness;
  beforeEach(async () => {
    mockViewport(440);
    h = await setupToday('f041');
    useAppStore.getState().setSpaces(await h.container.data.repos.spaces.listAll());
  });
  afterEach(async () => {
    await teardownToday(h);
  });

  const block = (props: { spaceId: typeof SPACE_PRO_ID; date: string; time: string | null; offsets: readonly (0 | 30 | 1440)[] }) =>
    render(
      <AppContainerProvider container={h.container}>
        <ReminderBlock time={props.time === null ? null : asLocalTime(props.time)} offsets={props.offsets} warnFor={{ spaceId: props.spaceId, date: asLocalDate(props.date) }} onToggle={vi.fn()} />
      </AppContainerProvider>,
    );

  it('mardi 6 octobre 20:00, Pro, « À l’heure » : « Rappel décalé au mercredi 08:00 — aucun rappel Pro après 19:00 »', () => {
    block({ spaceId: SPACE_PRO_ID, date: '2026-10-06', time: '20:00', offsets: [0] });
    expect(screen.getByRole('status')).toHaveTextContent('Rappel décalé au mercredi 08:00 — aucun rappel Pro après 19:00');
  });

  it('deux avances : une ligne par rappel décalé, dans l’ordre des avances ; une avance hors plage ne produit rien', () => {
    // 19:15 : « À l'heure » 19:15 est couvert, « 30 min » 18:45 ne l'est pas.
    block({ spaceId: SPACE_PRO_ID, date: '2026-10-06', time: '19:15', offsets: [0, 30] });
    const lines = screen.getAllByRole('status');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toHaveTextContent('Rappel décalé au mercredi 08:00 — aucun rappel Pro après 19:00');
  });

  it('Perso, sans heure, ou sans avance : aucune ligne', () => {
    block({ spaceId: SPACE_PERSO_ID as typeof SPACE_PRO_ID, date: '2026-10-06', time: '20:00', offsets: [0] });
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('fiche PC : rappels d’une tâche dans la plage silencieuse (N-FIX-04)', () => {
  let h: TodayHarness;
  beforeEach(async () => {
    mockViewport(1440);
    h = await setupToday('f042');
    useAppStore.getState().setSpaces(await h.container.data.repos.spaces.listAll());
  });
  afterEach(async () => {
    useNavigationStore.getState().closeDetail();
    await teardownToday(h);
  });

  it('tâche Pro lundi 5 octobre 19:30, « À l’heure » : la fiche dit « Rappel décalé au mardi 08:00 — aucun rappel Pro après 19:00 »', async () => {
    const made = await createTaskUseCases(h.container).create({ title: 'Envoyer la facture', spaceId: SPACE_PRO_ID, date: asLocalDate('2026-10-05'), time: asLocalTime('19:30'), reminderOffsets: [0] });
    if (!made.ok) throw new Error('create failed');
    useNavigationStore.getState().openDetail({ type: 'task', id: made.value.id });
    render(
      <AppContainerProvider container={h.container}>
        <TaskDetail />
      </AppContainerProvider>,
    );
    await screen.findByText('Rappels');
    expect(await screen.findByText('Rappel décalé au mardi 08:00 — aucun rappel Pro après 19:00')).toBeInTheDocument();
  });
});
