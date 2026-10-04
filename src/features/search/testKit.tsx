import { act, fireEvent, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import type { SpaceId } from '../../domain/types';
import { AppContainerProvider, useAppContainer } from '../app/AppContainerContext';
import { UndoToast } from '../app/UndoToast';
import type { AppContainer } from '../app/container';
import { toKeyInput } from '../app/shortcuts';
import { TodayScreen } from '../today/TodayScreen';
import { mockViewport, setupToday, teardownToday, type TodayHarness } from '../today/testKit';
import { SearchOverlay } from './SearchOverlay';
import { registerSearchShortcut } from './searchShortcut';

/** Aides des tests de la recherche (RC-01 à RC-04) : mêmes briques qu'Aujourd'hui (base en mémoire, conteneur, viewport simulé). */
export { mockViewport, setupToday as setupSearch, teardownToday as teardownSearch, SPACE_PERSO_ID, SPACE_PRO_ID };
export type { TodayHarness as SearchHarness };

/** Coquille minimale : Aujourd'hui, la surcouche de recherche, Ctrl+K branché sur le registre comme dans App.tsx. */
function Shell() {
  const container = useAppContainer();
  useEffect(() => registerSearchShortcut(container), [container]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (container.shortcuts.handle(toKeyInput(event))) event.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [container]);
  return (
    <>
      <TodayScreen />
      <SearchOverlay />
      <UndoToast />
    </>
  );
}

export function renderSearchShell(container: AppContainer) {
  return render(
    <AppContainerProvider container={container}>
      <Shell />
    </AppContainerProvider>,
  );
}

/** Ctrl+K sur l'élément (ou la fenêtre). */
export function pressCtrlK(target: Element | Window = window): void {
  fireEvent.keyDown(target, { key: 'k', code: 'KeyK', ctrlKey: true });
}

export const searchField = (): HTMLInputElement => screen.getByRole('searchbox', { name: 'Rechercher' });

/** Tape `text` dans le champ de recherche et attend la fin de la requête (le compteur ou le message se met à jour). */
export async function typeQuery(text: string): Promise<void> {
  await act(async () => {
    fireEvent.change(searchField(), { target: { value: text } });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Pose une tâche directement en base (indexée par les déclencheurs), sans passer par un écran. */
export async function insertTask(h: TodayHarness, fields: { id: string; title: string; note?: string; space?: SpaceId; date?: string | null; status?: 'todo' | 'done'; someday?: boolean; projectId?: string | null }): Promise<void> {
  await h.db.driver.execute(
    `INSERT INTO task (id, space_id, project_id, title, note, date, status, done_at, someday, created_at, updated_at, device_id, hlc) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '2026-10-01T08:00:00.000Z', '2026-10-01T08:00:00.000Z', 'd', 'h')`,
    [
      fields.id,
      fields.space ?? SPACE_PRO_ID,
      fields.projectId ?? null,
      fields.title,
      fields.note ?? '',
      fields.date === undefined ? '2026-09-23' : fields.date,
      fields.status ?? 'todo',
      fields.status === 'done' ? '2026-10-01T09:00:00.000Z' : null,
      fields.someday ? 1 : 0,
    ],
  );
}
