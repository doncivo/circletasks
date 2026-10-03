import { fireEvent, render, screen } from '@testing-library/react';
import { newEntityId } from '../../domain/id';
import type { Checklist, ChecklistItem, IconRef } from '../../domain/model';
import type { ChecklistId, ChecklistItemId, LocalDate, SpaceId } from '../../domain/types';
import { SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { AppContainerProvider } from '../app/AppContainerContext';
import { UndoToast } from '../app/UndoToast';
import type { AppContainer } from '../app/container';
import { mockViewport, setupToday, teardownToday, type TodayHarness } from '../today/testKit';
import { ChecklistsScreen } from './ChecklistsScreen';

/** Aides des tests d'écran Checklists : mêmes briques que l'écran Aujourd'hui (base en mémoire, conteneur), données posées en base. */
export { mockViewport, setupToday as setupChecklists, teardownToday as teardownChecklists };
export type { TodayHarness as ChecklistsHarness };

export function renderChecklists(container: AppContainer) {
  return render(
    <AppContainerProvider container={container}>
      <ChecklistsScreen />
      <UndoToast />
    </AppContainerProvider>,
  );
}

export interface SeedChecklist {
  readonly title: string;
  readonly spaceId?: SpaceId;
  readonly icon?: IconRef | null;
  readonly date?: LocalDate | null;
  readonly isTemplate?: boolean;
  /** Textes des items, dans l'ordre ; `[texte, true]` : item coché. */
  readonly items?: readonly (string | readonly [string, boolean])[];
}

/** Crée une checklist (Pro par défaut) et ses items directement en base. */
export async function seedChecklist(h: TodayHarness, seed: SeedChecklist): Promise<{ checklist: Checklist; items: ChecklistItem[] }> {
  h.db.clock.advance(1);
  const checklist = await h.container.data.repos.checklists.create({
    id: newEntityId<ChecklistId>(h.container.ids),
    spaceId: seed.spaceId ?? SPACE_PRO_ID,
    title: seed.title,
    icon: seed.icon ?? null,
    date: seed.date ?? null,
    isTemplate: seed.isTemplate ?? false,
  });
  const items: ChecklistItem[] = [];
  let order = 0;
  for (const entry of seed.items ?? []) {
    order += 1;
    h.db.clock.advance(1);
    const [text, checked] = typeof entry === 'string' ? [entry, false] : entry;
    items.push(
      await h.container.data.repos.checklistItems.add({
        id: newEntityId<ChecklistItemId>(h.container.ids),
        checklistId: checklist.id as ChecklistId,
        text,
        checked,
        sortOrder: order,
      }),
    );
  }
  return { checklist, items };
}

/** Saisit un texte dans le champ « Nouvel élément » et valide par Entrée (soumission du formulaire du champ). */
export function typeItem(text: string): void {
  const input = screen.getByLabelText('Nouvel élément');
  fireEvent.change(input, { target: { value: text } });
  const form = input.closest('form');
  if (!form) throw new Error('formulaire du champ introuvable');
  fireEvent.submit(form);
}
