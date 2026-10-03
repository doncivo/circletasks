import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { DEFAULT_PRO_QUIET_HOURS } from '../../domain/quietHours';
import { asLocalDate, asLocalDateTime, type LocalTime, type SpaceId } from '../../domain/types';
import { AppContainerProvider } from '../app/AppContainerContext';
import { useAppStore } from '../app/appStore';
import { INITIAL_NAVIGATION, useNavigationStore } from '../app/navigation';
import { SettingsScreen } from '../settings/SettingsScreen';
import { createTaskUseCases } from '../tasks/createTaskUseCases';
import { mockViewport, setupToday, teardownToday, type TodayHarness } from '../today/testKit';
import { QuietHoursRoute } from './QuietHoursRoute';
import { createQuietHoursUseCases } from './quietHoursUseCases';
import { formatQuietSummary } from './quietText';

const range = (weekdays: number[], from: string, to: string) => ({ weekdays: weekdays as never, from: from as LocalTime, to: to as LocalTime });

describe('Plages silencieuses : cas d’usage et rappels (ES-07)', () => {
  let h: TodayHarness;
  beforeEach(async () => {
    h = await setupToday('e5010');
  });
  afterEach(() => teardownToday(h));

  const remindAt = async (spaceId: SpaceId, title: string, date: string, time: string) => {
    const created = await createTaskUseCases(h.container).create({ title, spaceId, date: asLocalDate(date), time: time as LocalTime, reminderOffsets: [0] });
    if (!created.ok) throw new Error('création impossible');
    return created.value;
  };
  const week = { from: asLocalDateTime('2026-09-21T00:00'), to: asLocalDateTime('2026-09-30T00:00') };

  it('base neuve : Pro a ses plages par défaut, Perso aucune (critère 1)', async () => {
    const [pro, perso] = await h.container.data.repos.spaces.listAll();
    expect(pro?.quietHours).toEqual(DEFAULT_PRO_QUIET_HOURS);
    expect(perso?.quietHours).toEqual([]);
  });

  it('échéances effectives : Pro mardi 20:00 → mercredi 08:00, samedi 10:00 → lundi 08:00, mardi 12:00 inchangé ; Perso inchangé (critère 5)', async () => {
    await remindAt(SPACE_PRO_ID, 'Pro mardi soir', '2026-09-22', '20:00');
    await remindAt(SPACE_PRO_ID, 'Pro samedi', '2026-09-26', '10:00');
    await remindAt(SPACE_PRO_ID, 'Pro midi', '2026-09-22', '12:00');
    await remindAt(SPACE_PERSO_ID, 'Perso mardi soir', '2026-09-22', '20:00');
    const effective = await createQuietHoursUseCases(h.container).listEffectiveReminders(week);
    const byTitle = new Map<string, string>();
    for (const item of effective) {
      const task = await h.container.data.repos.tasks.getById(item.reminder.targetId as never);
      byTitle.set(task?.title ?? '', `${item.fireAt} → ${item.effectiveFireAt}`);
    }
    expect(Object.fromEntries(byTitle)).toEqual({
      'Pro mardi soir': '2026-09-22T20:00 → 2026-09-23T08:00',
      'Pro samedi': '2026-09-26T10:00 → 2026-09-28T08:00',
      'Pro midi': '2026-09-22T12:00 → 2026-09-22T12:00',
      'Perso mardi soir': '2026-09-22T20:00 → 2026-09-22T20:00',
    });
  });

  it('la fenêtre porte sur l’échéance effective : un rappel du samedi décalé au lundi est listé le lundi, pas le samedi', async () => {
    await remindAt(SPACE_PRO_ID, 'Pro samedi', '2026-09-26', '10:00');
    const useCases = createQuietHoursUseCases(h.container);
    expect(await useCases.listEffectiveReminders({ from: asLocalDateTime('2026-09-26T00:00'), to: asLocalDateTime('2026-09-28T00:00') })).toEqual([]);
    const monday = await useCases.listEffectiveReminders({ from: asLocalDateTime('2026-09-28T00:00'), to: asLocalDateTime('2026-09-29T00:00') });
    expect(monday.map((item) => item.effectiveFireAt)).toEqual(['2026-09-28T08:00']);
  });

  it('modifier une plage recalcule l’échéance effective des rappels de l’espace ; fire_at n’est jamais modifié (critère 7)', async () => {
    const task = await remindAt(SPACE_PRO_ID, 'Pro mardi soir', '2026-09-22', '20:00');
    const useCases = createQuietHoursUseCases(h.container);
    const before = await h.container.data.repos.reminders.listForTarget({ type: 'task', id: task.id });
    expect((await useCases.listEffectiveReminders(week))[0]?.effectiveFireAt).toBe('2026-09-23T08:00');

    const saved = await useCases.save(SPACE_PRO_ID, [range([2], '22:00', '23:00')]);
    expect(saved.ok).toBe(true);
    // Plus de silence à 20:00 : l'échéance effective redevient celle d'origine.
    expect((await useCases.listEffectiveReminders(week))[0]?.effectiveFireAt).toBe('2026-09-22T20:00');
    await useCases.save(SPACE_PRO_ID, [range([2], '19:00', '21:30')]);
    expect((await useCases.listEffectiveReminders(week))[0]?.effectiveFireAt).toBe('2026-09-22T21:30');

    const after = await h.container.data.repos.reminders.listForTarget({ type: 'task', id: task.id });
    expect(after.map((r) => [r.fireAt, r.hlc, r.updatedAt])).toEqual(before.map((r) => [r.fireAt, r.hlc, r.updatedAt]));
  });

  it('des plages invalides sont refusées et l’ancien réglage reste (critères 3, 4)', async () => {
    const useCases = createQuietHoursUseCases(h.container);
    expect(await useCases.save(SPACE_PRO_ID, [range([1], '10:00', '10:00')])).toEqual({ ok: false, error: { index: 0, error: 'empty-range' } });
    expect(await useCases.save(SPACE_PRO_ID, [range([1], '19:00', '08:00'), range([], '19:00', '08:00')])).toEqual({ ok: false, error: { index: 1, error: 'no-days' } });
    expect(await useCases.save('00000000-0000-4000-8000-0000000000ff' as SpaceId, [])).toEqual({ ok: false, error: 'space-not-found' });
    expect((await h.container.data.repos.spaces.getById(SPACE_PRO_ID))?.quietHours).toEqual(DEFAULT_PRO_QUIET_HOURS);
    // L'enregistrement porte un nouveau hlc (préférence partagée, ES-01 critère 8).
    const before = (await h.container.data.repos.spaces.getById(SPACE_PERSO_ID))?.hlc ?? '';
    await useCases.save(SPACE_PERSO_ID, [range([1, 2], '12:00', '14:00')]);
    expect(String((await h.container.data.repos.spaces.getById(SPACE_PERSO_ID))?.hlc) > before).toBe(true);
  });

  it('les rappels d’une routine suivent aussi les plages de son espace', async () => {
    const { seedRoutine } = await import('../routines/testKit');
    const routine = await seedRoutine(h, { title: 'Sport', spaceId: SPACE_PRO_ID, time: '20:30' as LocalTime });
    await h.container.data.repos.reminders.replaceForTarget({ type: 'routine', id: routine.id }, [
      { id: 'a0000000-0000-4000-8000-000000000001' as never, targetType: 'routine', targetId: routine.id, offsetMin: 0, fireAt: asLocalDateTime('2026-09-23T20:30') },
    ]);
    const [item] = await createQuietHoursUseCases(h.container).listEffectiveReminders(week);
    expect(item).toMatchObject({ spaceId: SPACE_PRO_ID, fireAt: '2026-09-23T20:30', effectiveFireAt: '2026-09-24T08:00' });
  });

  it('un rappel dont l’élément n’existe plus n’est pas décalé', async () => {
    await h.container.data.repos.reminders.replaceForTarget({ type: 'task', id: 'b0000000-0000-4000-8000-000000000001' as never }, [
      { id: 'a0000000-0000-4000-8000-000000000002' as never, targetType: 'task', targetId: 'b0000000-0000-4000-8000-000000000001' as never, offsetMin: 0, fireAt: asLocalDateTime('2026-09-22T20:00') },
    ]);
    const [item] = await createQuietHoursUseCases(h.container).listEffectiveReminders(week);
    expect(item).toMatchObject({ spaceId: null, effectiveFireAt: '2026-09-22T20:00' });
  });
});

describe('Plages silencieuses dans Réglages (ES-07 critères 2, 3, 4)', () => {
  let h: TodayHarness;
  beforeEach(async () => {
    mockViewport(440);
    h = await setupToday('e5011');
  });
  afterEach(async () => {
    useNavigationStore.setState(INITIAL_NAVIGATION);
    await teardownToday(h);
  });

  const renderSettings = () =>
    render(
      <AppContainerProvider container={h.container}>
        <SettingsScreen />
      </AppContainerProvider>,
    );
  const renderEditor = (spaceId: SpaceId) => {
    useNavigationStore.getState().navigate({ tab: 'settings', screen: 'quiet', spaceId });
    return render(
      <AppContainerProvider container={h.container}>
        <QuietHoursRoute />
      </AppContainerProvider>,
    );
  };

  it('section RAPPELS : « Silence Pro — 19:00 – 08:00, week-end » et « Silence Perso — Aucune »', async () => {
    renderSettings();
    expect(await screen.findByRole('button', { name: 'Silence Pro : 19:00 – 08:00, week-end' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Silence Perso : Aucune' })).toBeInTheDocument();
    expect(screen.getByText('RAPPELS')).toBeInTheDocument();
  });

  it('résumés texte : toute la journée, jours choisis', () => {
    expect(formatQuietSummary([])).toBe('Aucune');
    expect(formatQuietSummary(DEFAULT_PRO_QUIET_HOURS)).toBe('19:00 – 08:00, week-end');
    expect(formatQuietSummary([range([1, 3], '12:00', '14:00'), range([3], '00:00', '00:00')])).toBe('lun., mer. 12:00 – 14:00, mer., toute la journée');
  });

  it('ouvrir la ligne affiche les deux plages de Pro, avec jours, heures et « Toute la journée »', async () => {
    renderEditor(SPACE_PRO_ID);
    expect(await screen.findByRole('heading', { name: /Silence\s*Pro/ })).toBeInTheDocument();
    const first = screen.getByRole('region', { name: 'Plage 1' });
    expect(within(first).getAllByRole('checkbox', { checked: true })).toHaveLength(7); // les sept jours
    expect(within(first).getByLabelText('Début de la plage 1 (HH:MM)')).toHaveValue('19:00');
    expect(within(first).getByLabelText('Fin de la plage 1 (HH:MM)')).toHaveValue('08:00');
    const second = screen.getByRole('region', { name: 'Plage 2' });
    expect(within(second).getByRole('switch', { name: 'Toute la journée, plage 2' })).toHaveAttribute('aria-checked', 'true');
    expect(within(second).queryByLabelText('Début de la plage 2 (HH:MM)')).toBeNull();
    expect(within(second).getByRole('checkbox', { name: 'Samedi' })).toHaveAttribute('aria-checked', 'true');
    expect(within(second).getByRole('checkbox', { name: 'Lundi' })).toHaveAttribute('aria-checked', 'false');
  });

  it('ajoute, modifie et supprime des plages ; enregistre et revient à Réglages avec le nouveau résumé (critère 3)', async () => {
    renderEditor(SPACE_PERSO_ID);
    expect(await screen.findByText('Aucune plage : les rappels de cet espace ne sont jamais décalés.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Ajouter une plage' }));
    const first = screen.getByRole('region', { name: 'Plage 1' });
    fireEvent.change(within(first).getByLabelText('Début de la plage 1 (HH:MM)'), { target: { value: '12h' } });
    fireEvent.change(within(first).getByLabelText('Fin de la plage 1 (HH:MM)'), { target: { value: '14:30' } });
    fireEvent.click(within(first).getByRole('checkbox', { name: 'Mardi' })); // retire mardi
    fireEvent.click(screen.getByRole('button', { name: 'Ajouter une plage' }));
    const second = screen.getByRole('region', { name: 'Plage 2' });
    fireEvent.click(within(second).getByRole('switch', { name: 'Toute la journée, plage 2' }));
    fireEvent.click(screen.getByRole('button', { name: 'Supprimer la plage 2' }));
    expect(screen.queryByRole('region', { name: 'Plage 2' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));
    await waitFor(async () => expect((await h.container.data.repos.spaces.getById(SPACE_PERSO_ID))?.quietHours).toEqual([{ weekdays: [1, 3, 4, 5], from: '12:00', to: '14:30' }]));
    expect(useNavigationStore.getState().route).toEqual({ tab: 'settings', screen: 'home' });
    expect(useAppStore.getState().spaces.find((s) => s.id === SPACE_PERSO_ID)?.quietHours).toHaveLength(1);
  });

  it('une plage « toute la journée » s’enregistre en 00:00 → 00:00', async () => {
    renderEditor(SPACE_PERSO_ID);
    fireEvent.click(await screen.findByRole('button', { name: 'Ajouter une plage' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Toute la journée, plage 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));
    await waitFor(async () => expect((await h.container.data.repos.spaces.getById(SPACE_PERSO_ID))?.quietHours).toEqual([{ weekdays: [1, 2, 3, 4, 5], from: '00:00', to: '00:00' }]));
  });

  it('début = fin refusé hors « Toute la journée » ; aucun jour ; heure illisible : l’ancien réglage reste (critère 4)', async () => {
    renderEditor(SPACE_PRO_ID);
    const first = await screen.findByRole('region', { name: 'Plage 1' });
    const save = () => fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));
    fireEvent.change(within(first).getByLabelText('Fin de la plage 1 (HH:MM)'), { target: { value: '19:00' } });
    save();
    expect(await screen.findByRole('alert')).toHaveTextContent('Plage 1 : le début et la fin doivent différer, ou cochez « Toute la journée ».');
    fireEvent.change(within(first).getByLabelText('Fin de la plage 1 (HH:MM)'), { target: { value: '25:00' } });
    save();
    expect(await screen.findByRole('alert')).toHaveTextContent('Heure non comprise pour la plage 1 (exemple : 19:00).');
    fireEvent.change(within(first).getByLabelText('Fin de la plage 1 (HH:MM)'), { target: { value: '08:00' } });
    for (const day of ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche']) fireEvent.click(within(first).getByRole('checkbox', { name: day }));
    save();
    expect(await screen.findByRole('alert')).toHaveTextContent('Choisissez au moins un jour pour la plage 1.');
    expect((await h.container.data.repos.spaces.getById(SPACE_PRO_ID))?.quietHours).toEqual(DEFAULT_PRO_QUIET_HOURS);
    expect(useNavigationStore.getState().route).toMatchObject({ screen: 'quiet' });
  });

  it('sur PC, l’éditeur rappelle que les rappels sont envoyés par l’iPhone ; pas sur iPhone (critère 9)', async () => {
    mockViewport(1440);
    const pc = renderEditor(SPACE_PRO_ID);
    expect(await screen.findByText('Les rappels sont envoyés par l’iPhone ; le PC n’en émet aucun.')).toBeInTheDocument();
    pc.unmount();
    mockViewport(440);
    renderEditor(SPACE_PRO_ID);
    await screen.findByRole('heading', { name: /Silence/ });
    expect(screen.queryByText(/le PC n’en émet aucun/)).toBeNull();
  });

  it('un espace inconnu dans la route ramène à Réglages', async () => {
    renderEditor('00:00' as never);
    await waitFor(() => expect(useNavigationStore.getState().route).toEqual({ tab: 'settings', screen: 'home' }));
  });
});

describe('Plages silencieuses : portée (ES-07 critères 8 et 9)', () => {
  const src = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const sourcesOf = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return sourcesOf(path);
      return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
    });

  it('les récapitulatifs (N-04) et le module Focus n’appliquent aucune plage silencieuse', () => {
    for (const file of [join(src, 'domain', 'recap.ts'), join(src, 'features', 'reminders', 'recapText.ts'), join(src, 'features', 'reminders', 'recapUseCases.ts')]) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/quiet|effectiveFireAt/i);
    }
  });

  it('aucune notification n’est émise ni planifiée par les plages (ordre 1 ; le PC n’en émet jamais)', () => {
    for (const file of [...sourcesOf(join(src, 'features', 'spaces')), join(src, 'domain', 'quietHours.ts')]) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/plugin-notification|new Notification\(|Notification\.requestPermission|sendNotification|scheduleNotification/);
    }
  });
});
