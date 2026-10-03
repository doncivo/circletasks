import { act } from '@testing-library/react';
import { newEntityId } from '../../domain/id';
import type { Project } from '../../domain/model';
import type { HexColor, ProjectId, SpaceId } from '../../domain/types';
import { useAppStore } from '../app/appStore';
import type { TodayHarness } from '../today/testKit';

/** Aides des tests « Espaces et projets » : projets posés directement en base puis publiés comme au démarrage (App.tsx). */
export async function seedProject(h: TodayHarness, spaceId: SpaceId, name: string, extra: Partial<{ archived: boolean; color: HexColor; sortOrder: number }> = {}): Promise<Project> {
  h.db.clock.advance(1);
  const existing = await h.container.data.repos.projects.listForFilter('all', { includeArchived: true });
  const created = await h.container.data.repos.projects.create({
    id: newEntityId<ProjectId>(h.container.ids),
    spaceId,
    name,
    color: extra.color ?? ('#2f6b7a' as HexColor),
    archived: extra.archived ?? false,
    sortOrder: extra.sortOrder ?? existing.length + 1,
  });
  const all = await h.container.data.repos.projects.listForFilter('all', { includeArchived: true });
  act(() => useAppStore.getState().setProjects(all));
  return created;
}
