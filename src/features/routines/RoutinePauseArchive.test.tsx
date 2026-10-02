import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SPACE_PERSO_ID } from '../../db/seed/defaultSpaces';
import { useAppStore } from '../app/appStore';
import { loadTodayExtras } from '../today/todaySources';
import type { LocalDate, RoutineId } from '../../domain/types';
import { registerRoutinesSource, unregisterRoutinesSource } from './routinesSource';
import { createRoutineUseCases } from './routineUseCases';
import { mockViewport, renderRoutines, seedLog, seedRoutine, setupRoutines, teardownRoutines, type RoutinesHarness } from './testKit';

// Aujourd'hui : ven. 2 oct. 2026.
const card = (title: string): HTMLElement => screen.getByRole('heading', { name: title }).closest('article') as HTMLElement;
const FULL = { from: '2026-01-01' as LocalDate, to: '2026-12-31' as LocalDate };

describe('Routines : pause et archivage (R-05)', () => {
  let h: RoutinesHarness;

  beforeEach(async () => {
    h = await setupRoutines('251');
    registerRoutinesSource();
    mockViewport(440);
  });
  afterEach(async () => {
    unregisterRoutinesSource();
    await teardownRoutines(h);
  });

  async function openEditor(title: string): Promise<HTMLElement> {
    fireEvent.click(await screen.findByRole('button', { name: `Éditer la routine ${title}` }));
    return screen.findByRole('form', { name: 'Modifier la routine' });
  }

  it('l’interrupteur « Mettre en pause » + Enregistrer : plus d’occurrence, « En pause » sur la carte, historique intact (critères 1, 2)', async () => {
    const lit = await seedRoutine(h, { title: 'Faire mon lit' });
    await seedLog(h, lit, '2026-10-01');
    expect((await loadTodayExtras(h.container, '2026-10-02' as LocalDate, 'all')).extras.routines).toHaveLength(1);

    renderRoutines(h.container);
    const form = await openEditor('Faire mon lit');
    expect(within(form).getByText('Aucune occurrence tant que la pause dure')).toBeInTheDocument();
    const toggle = within(form).getByRole('switch', { name: 'Mettre en pause' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(toggle);
    fireEvent.click(within(form).getByRole('button', { name: 'Enregistrer' }));
    await waitFor(() => expect(screen.queryByRole('form')).toBeNull());

    expect(card('Faire mon lit')).toHaveTextContent('En pause');
    // Plus d'occurrence dans Aujourd'hui ni dans la Semaine (même source).
    expect((await loadTodayExtras(h.container, '2026-10-02' as LocalDate, 'all')).extras.routines).toEqual([]);
    expect((await loadTodayExtras(h.container, '2026-10-05' as LocalDate, 'all')).extras.routines).toEqual([]);
    // Ronds inactifs, validations passées intactes.
    expect(within(card('Faire mon lit')).getByRole('checkbox', { name: 'Vendredi' })).toHaveAttribute('aria-disabled', 'true');
    expect(within(card('Faire mon lit')).getByRole('checkbox', { name: 'Jeudi, fait' })).toBeChecked();
    expect(await h.container.data.repos.routineLogs.listForRoutine(lit.id as RoutineId, FULL)).toHaveLength(1);
  });

  it('reprendre : la routine réapparaît dès aujourd’hui avec ses validations passées (critère 3)', async () => {
    const lit = await seedRoutine(h, { title: 'Faire mon lit', paused: true });
    await seedLog(h, lit, '2026-09-30');
    renderRoutines(h.container);
    const form = await openEditor('Faire mon lit');
    const toggle = within(form).getByRole('switch', { name: 'Mettre en pause' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(toggle);
    fireEvent.click(within(form).getByRole('button', { name: 'Enregistrer' }));
    await waitFor(() => expect(screen.queryByRole('form')).toBeNull());
    expect(card('Faire mon lit')).not.toHaveTextContent('En pause');
    expect((await loadTodayExtras(h.container, '2026-10-02' as LocalDate, 'all')).extras.routines).toHaveLength(1);
    expect(await h.container.data.repos.routineLogs.listForRoutine(lit.id as RoutineId, FULL)).toHaveLength(1);
  });

  it('un nouveau formulaire n’a ni pause ni « Archiver »', async () => {
    renderRoutines(h.container);
    fireEvent.click(await screen.findByRole('button', { name: 'Ajouter une routine' }));
    const form = await screen.findByRole('form', { name: 'Nouvelle routine' });
    expect(within(form).queryByRole('switch')).toBeNull();
    expect(within(form).queryByRole('button', { name: 'Archiver' })).toBeNull();
  });

  it('« Archiver » demande confirmation ; refuser ne change rien (critère 5)', async () => {
    await seedRoutine(h, { title: 'Faire mon lit' });
    renderRoutines(h.container);
    const form = await openEditor('Faire mon lit');
    fireEvent.click(within(form).getByRole('button', { name: 'Archiver' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Archiver « Faire mon lit » ?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Annuler' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByRole('form', { name: 'Modifier la routine' })).toBeInTheDocument();
    expect(card('Faire mon lit')).toBeInTheDocument();
  });

  it('archiver : la routine quitte l’onglet, Aujourd’hui et la Semaine, ses validations restent, annulation proposée (critères 5, 6)', async () => {
    const lit = await seedRoutine(h, { title: 'Faire mon lit' });
    await seedLog(h, lit, '2026-10-01');
    renderRoutines(h.container);
    const form = await openEditor('Faire mon lit');
    fireEvent.click(within(form).getByRole('button', { name: 'Archiver' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Son historique est conservé');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Archiver' }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Faire mon lit' })).toBeNull());
    expect(screen.queryByRole('form')).toBeNull();
    expect((await loadTodayExtras(h.container, '2026-10-02' as LocalDate, 'all')).extras.routines).toEqual([]);
    expect(await h.container.data.repos.routineLogs.listForRoutine(lit.id as RoutineId, FULL)).toHaveLength(1);
    expect(screen.getByRole('status')).toHaveTextContent('« Faire mon lit » archivée');

    // « Annuler » du message : la routine revient.
    fireEvent.click(within(screen.getByRole('status')).getByRole('button', { name: 'Annuler' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Faire mon lit' })).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /^Archivées/ })).toBeNull();
  });

  it('section « Archivées » : absente sans archive, repliée par défaut, liste avec « Restaurer » (critère 8, QB-05)', async () => {
    await seedRoutine(h, { title: 'Active' });
    renderRoutines(h.container);
    await screen.findByRole('heading', { name: 'Active' });
    expect(screen.queryByRole('button', { name: /^Archivées/ })).toBeNull();
  });

  it('archivées de l’espace filtré, dépliables, restaurables : réapparaît dans la liste et dans Aujourd’hui, annulation 5 s (critères 8, 9)', async () => {
    await seedRoutine(h, { title: 'Ancienne', archived: true });
    await seedRoutine(h, { title: 'Autre espace', archived: true, spaceId: SPACE_PERSO_ID });
    await seedRoutine(h, { title: 'Active' });
    renderRoutines(h.container);
    await screen.findByRole('heading', { name: 'Active' });
    const toggle = screen.getByRole('button', { name: 'Archivées (2)' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('list', { name: 'Routines archivées' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Ancienne' })).toBeNull();

    fireEvent.click(toggle);
    const list = screen.getByRole('list', { name: 'Routines archivées' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    fireEvent.click(within(list).getByRole('button', { name: 'Restaurer la routine Ancienne' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Ancienne' })).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Archivées (1)' })).toBeInTheDocument();
    expect((await loadTodayExtras(h.container, '2026-10-02' as LocalDate, 'all')).extras.routines.map((entry) => entry.routine.title).sort()).toEqual(['Active', 'Ancienne']);
    expect(screen.getByRole('status')).toHaveTextContent('« Ancienne » restaurée');

    fireEvent.click(within(screen.getByRole('status')).getByRole('button', { name: 'Annuler' }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Ancienne' })).toBeNull());
  });

  it('le filtre d’espace limite aussi la section « Archivées »', async () => {
    await seedRoutine(h, { title: 'Ancienne Pro', archived: true });
    await seedRoutine(h, { title: 'Ancienne Perso', archived: true, spaceId: SPACE_PERSO_ID });
    await seedRoutine(h, { title: 'Active' });
    useAppStore.getState().setSpaceFilter(SPACE_PERSO_ID);
    renderRoutines(h.container);
    fireEvent.click(await screen.findByRole('button', { name: 'Archivées (1)' }));
    expect(screen.getByText('Ancienne Perso')).toBeInTheDocument();
    expect(screen.queryByText('Ancienne Pro')).toBeNull();
  });
});

describe('cas d’usage : pause et archivage (R-05)', () => {
  let h: RoutinesHarness;

  beforeEach(async () => {
    h = await setupRoutines('252');
  });
  afterEach(() => teardownRoutines(h));

  it('setPaused / setArchived : état écrit, undo remet l’état d’avant, stale si la routine a changé depuis', async () => {
    const cases = createRoutineUseCases(h.container);
    const routine = await seedRoutine(h, { title: 'Faire mon lit' });
    const id = routine.id as RoutineId;

    expect((await cases.setPaused(id, true))?.paused).toBe(true);
    expect(await cases.setPaused(id, true)).toBeNull(); // déjà en pause : rien d'écrit
    expect(h.container.undo.getSnapshot().top).toMatchObject({ labelKey: 'routines.undo.paused', labelParams: { title: 'Faire mon lit' } });
    expect((await h.container.undo.undoLast()).status).toBe('undone');
    expect((await h.container.data.repos.routines.getById(id))?.paused).toBe(false);

    expect((await cases.setArchived(id, true))?.archived).toBe(true);
    expect((await h.container.undo.undoLast()).status).toBe('undone');
    expect((await h.container.data.repos.routines.getById(id))?.archived).toBe(false);

    await cases.setArchived(id, true);
    h.db.clock.advance(5);
    await h.container.data.repos.routines.update(id, { title: 'Renommée' }); // modifiée depuis
    expect((await h.container.undo.undoLast()).status).toBe('stale');
    expect((await h.container.data.repos.routines.getById(id))?.archived).toBe(true);

    expect(await cases.setPaused('80000000-0000-4000-8000-0000000000ee' as RoutineId, true)).toBeNull();
    expect(await cases.setArchived('80000000-0000-4000-8000-0000000000ee' as RoutineId, true)).toBeNull();
  });

  it('restaurer rend la routine avec ses réglages et son historique intacts (critère 9)', async () => {
    const cases = createRoutineUseCases(h.container);
    const routine = await seedRoutine(h, { title: 'Sport', scheduleType: 'weekdays', weekdays: [1, 3, 5], time: '18:00' as never });
    await seedLog(h, routine, '2026-09-28');
    await cases.setArchived(routine.id as RoutineId, true);
    expect((await cases.setArchived(routine.id as RoutineId, false))?.archived).toBe(false);
    const back = await h.container.data.repos.routines.getById(routine.id as RoutineId);
    expect(back).toMatchObject({ title: 'Sport', scheduleType: 'weekdays', weekdays: [1, 3, 5], time: '18:00', archived: false });
    expect(await h.container.data.repos.routineLogs.listForRoutine(routine.id as RoutineId, FULL)).toHaveLength(1);
  });
});
