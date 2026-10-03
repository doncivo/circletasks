import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import type { ChecklistId, LocalDate } from '../../domain/types';
import { useAppStore } from '../app/appStore';
import { useNavigationStore } from '../app/navigation';
import { seedProject } from '../spaces/testKit';
import { loadTodayExtras } from '../today/todaySources';
import { renderToday } from '../today/testKit';
import { renderWeek } from '../week/testKit';
import { createChecklistUseCases } from './checklistUseCases';
import { registerChecklistsSource, unregisterChecklistsSource } from './checklistsSource';
import { mockViewport, seedChecklist, setupChecklists, teardownChecklists, type ChecklistsHarness } from './testKit';

// Aujourd'hui dans les tests : ven. 2 oct. 2026 ; semaine du lun. 28 sept. au dim. 4 oct.
const day = (iso: string) => iso as LocalDate;
const VALISE = ['Adaptateur de prise', 'Crème solaire', 'Attestation d’assurance', ['Passeport', true], ['Chargeur', true], ['Billets d’avion', true]] as const;

describe('Source des checklists : chargement par jour (C-03 critères 2, 5, 7, 8)', () => {
  let h: ChecklistsHarness;

  beforeEach(async () => {
    h = await setupChecklists('321');
    mockViewport(440);
    registerChecklistsSource();
    registerChecklistsSource(); // idempotent : une seule source
  });
  afterEach(async () => {
    unregisterChecklistsSource();
    await teardownChecklists(h);
  });

  it('une checklist datée n’apparaît que le jour de sa date, avec « cochés / total » (critère 2)', async () => {
    await seedChecklist(h, { title: 'Valise voyage', date: day('2026-10-02'), items: VALISE });
    const today = await loadTodayExtras(h.container, day('2026-10-02'), 'all');
    expect(today.extras.checklists.map((s) => [s.checklist.title, s.checked, s.total])).toEqual([['Valise voyage', 3, 6]]);
    expect((await loadTodayExtras(h.container, day('2026-10-03'), 'all')).extras.checklists).toEqual([]);
  });

  it('jamais reportée : la date passée ne l’affiche plus aujourd’hui (critère 5)', async () => {
    await seedChecklist(h, { title: 'Hier', date: day('2026-10-01'), items: ['a'] });
    expect((await loadTodayExtras(h.container, day('2026-10-02'), 'all')).extras.checklists).toEqual([]);
    expect((await loadTodayExtras(h.container, day('2026-10-01'), 'all')).extras.checklists).toHaveLength(1);
    // Toujours dans l’onglet Checklists, avec sa date.
    expect(await h.container.data.repos.checklists.listSummaries('all')).toMatchObject([{ checklist: { date: '2026-10-01' } }]);
  });

  it('sans date : absente ; toutes cochées : la ligne reste (critère 8)', async () => {
    await seedChecklist(h, { title: 'Sans date', items: ['a'] });
    await seedChecklist(h, { title: 'Terminée', date: day('2026-10-02'), items: [['a', true], ['b', true]] });
    const { extras } = await loadTodayExtras(h.container, day('2026-10-02'), 'all');
    expect(extras.checklists.map((s) => [s.checklist.title, s.checked, s.total])).toEqual([['Terminée', 2, 2]]);
  });

  it('le filtre d’espace s’applique (critère 7)', async () => {
    await seedChecklist(h, { title: 'Dossier', date: day('2026-10-02'), spaceId: SPACE_PRO_ID });
    await seedChecklist(h, { title: 'Courses', date: day('2026-10-02'), spaceId: SPACE_PERSO_ID });
    expect((await loadTodayExtras(h.container, day('2026-10-02'), SPACE_PERSO_ID)).extras.checklists.map((s) => s.checklist.title)).toEqual(['Courses']);
    expect((await loadTodayExtras(h.container, day('2026-10-02'), SPACE_PRO_ID)).extras.checklists.map((s) => s.checklist.title)).toEqual(['Dossier']);
  });
});

describe('Checklists dans Aujourd’hui (C-03 critères 2, 3, 4, 7)', () => {
  let h: ChecklistsHarness;

  beforeEach(async () => {
    h = await setupChecklists('322');
    mockViewport(440);
    registerChecklistsSource();
  });
  afterEach(async () => {
    unregisterChecklistsSource();
    await teardownChecklists(h);
  });

  it('la ligne affiche l’icône, le titre et « 3/6 » ; la toucher ouvre l’onglet sur elle (critères 2, 3)', async () => {
    const { checklist } = await seedChecklist(h, { title: 'Valise voyage', date: h.today, icon: { kind: 'lucide', name: 'briefcase' }, items: VALISE });
    renderToday(h.container);
    const row = await screen.findByRole('button', { name: /Valise voyage/ });
    expect(within(row).getByText('3/6')).toBeInTheDocument();
    expect(row.querySelector('svg')).not.toBeNull();
    expect(screen.getByRole('heading', { name: 'Checklists' })).toBeInTheDocument();
    fireEvent.click(row);
    expect(useNavigationStore.getState().route).toEqual({ tab: 'checklists', checklistId: checklist.id });
  });

  it('cocher un item met à jour le compteur sans recharger (critère 4)', async () => {
    const { items } = await seedChecklist(h, { title: 'Valise voyage', date: h.today, items: VALISE });
    renderToday(h.container);
    await screen.findByText('3/6');
    const item = items.find((candidate) => candidate.text === 'Crème solaire');
    await act(async () => {
      await createChecklistUseCases(h.container).setChecked(item?.id as never, true);
    });
    expect(await screen.findByText('4/6')).toBeInTheDocument();
  });

  it('une checklist datée d’hier ou sans date n’y figure pas ; « Tout » indique l’espace (critères 5, 7, 8)', async () => {
    await seedChecklist(h, { title: 'Hier', date: day('2026-10-01'), items: ['a'] });
    await seedChecklist(h, { title: 'Sans date', items: ['a'] });
    await seedChecklist(h, { title: 'Courses', date: h.today, spaceId: SPACE_PERSO_ID, items: ['a'] });
    renderToday(h.container);
    const row = await screen.findByRole('button', { name: /Courses/ });
    expect(within(row).getByText('Perso')).toBeInTheDocument();
    expect(screen.queryByText('Hier')).toBeNull();
    expect(screen.queryByText('Sans date')).toBeNull();
  });

  it('le filtre Pro masque une checklist Perso ; un filtre projet masque toutes les checklists (critère 7)', async () => {
    await seedChecklist(h, { title: 'Courses', date: h.today, spaceId: SPACE_PERSO_ID });
    await seedChecklist(h, { title: 'Dossier', date: h.today, spaceId: SPACE_PRO_ID });
    const project = await seedProject(h, SPACE_PRO_ID, 'Chantier');
    useAppStore.getState().setSpaceFilter(SPACE_PRO_ID);
    renderToday(h.container);
    await screen.findByRole('button', { name: /Dossier/ });
    expect(screen.queryByRole('button', { name: /Courses/ })).toBeNull();
    act(() => useAppStore.getState().setProjectFilter(project.id));
    await waitFor(() => expect(screen.queryByRole('button', { name: /Dossier/ })).toBeNull());
  });

  it('un modèle daté n’apparaît pas', async () => {
    await seedChecklist(h, { title: 'Modèle', date: h.today, isTemplate: true });
    renderToday(h.container);
    await waitFor(() => expect(document.querySelector('.ct-today-empty')).not.toBeNull());
    expect(screen.queryByText('Modèle')).toBeNull();
  });
});

describe('Checklists dans la Semaine (C-03 critères 2, 3, 4, 7)', () => {
  let h: ChecklistsHarness;

  beforeEach(async () => {
    h = await setupChecklists('323');
    registerChecklistsSource();
  });
  afterEach(async () => {
    unregisterChecklistsSource();
    await teardownChecklists(h);
  });

  it('PC : carte « Perso · checklist 0/8 » dans la colonne du jour, qui ouvre l’onglet (critères 2, 3)', async () => {
    mockViewport(1440);
    const { checklist } = await seedChecklist(h, { title: 'Courses', date: day('2026-10-03'), spaceId: SPACE_PERSO_ID, items: Array.from({ length: 8 }, (_, i) => `Article ${String(i + 1)}`) });
    renderWeek(h.container);
    const column = await screen.findByRole('group', { name: /samedi 3 oct/i });
    const open = await within(column).findByRole('button', { name: 'Ouvrir la checklist : Courses' });
    expect(column).toHaveTextContent('Perso · checklist 0/8');
    expect(screen.queryAllByRole('button', { name: 'Ouvrir la checklist : Courses' })).toHaveLength(1);
    fireEvent.click(open);
    expect(useNavigationStore.getState().route).toEqual({ tab: 'checklists', checklistId: checklist.id });
  });

  it('iPhone : ligne avec « 0/8 » ; cocher depuis le détail met la ligne à jour (critères 2, 4)', async () => {
    mockViewport(440);
    const { items } = await seedChecklist(h, { title: 'Courses', date: day('2026-10-03'), items: ['Lait', 'Pain'] });
    renderWeek(h.container);
    const column = await screen.findByRole('group', { name: /samedi 3 oct/i });
    await within(column).findByText('0/2');
    await act(async () => {
      await createChecklistUseCases(h.container).setChecked(items[0]?.id as never, true);
    });
    await within(column).findByText('1/2');
  });

  it('une checklist retirée (date null) quitte la Semaine aussitôt (critère 6)', async () => {
    mockViewport(1440);
    const { checklist } = await seedChecklist(h, { title: 'Courses', date: day('2026-10-03') });
    renderWeek(h.container);
    await screen.findByRole('button', { name: 'Ouvrir la checklist : Courses' });
    await act(async () => {
      await createChecklistUseCases(h.container).setDate(checklist.id as ChecklistId, null);
    });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Ouvrir la checklist : Courses' })).toBeNull());
  });
});
