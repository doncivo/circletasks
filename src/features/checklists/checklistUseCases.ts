import { nextItemOrder, validateChecklistText, type ChecklistTextError } from '../../domain/checklistRules';
import { newEntityId } from '../../domain/id';
import type { Checklist, ChecklistItem, ChecklistPatch, IconRef } from '../../domain/model';
import type { ChecklistId, ChecklistItemId, Result, SpaceId } from '../../domain/types';
import type { DataAccess } from '../../db/repositories';
import type { AppContainer } from '../app/container';
import type { UndoableCommand } from '../app/undo';
import { emitChecklistsChanged } from './checklistEvents';

/**
 * Cas d'usage « checklists » (ADR 0004) : les stores appellent ces fonctions, jamais les repositories directement. Les règles (textes de
 * 1 à 200 caractères, ordre) sont dans src/domain/checklistRules.ts. Chaque écriture annonce le changement (`emitChecklistsChanged`) pour
 * qu'Aujourd'hui, la Semaine et l'onglet Checklists se relisent, y compris après « Annuler » (T-13).
 */
export type ChecklistUseCaseDeps = Pick<AppContainer, 'clock' | 'ids' | 'data' | 'undo'>;

export interface NewChecklistInput {
  readonly title: string;
  readonly icon: IconRef | null;
  readonly spaceId: SpaceId;
}

/** Champs modifiables depuis la feuille « Modifier la checklist ». */
export type ChecklistUpdate = Pick<ChecklistPatch, 'title' | 'icon' | 'spaceId'>;

export type ChecklistSaveError = ChecklistTextError | 'not-found';

export interface ChecklistUseCases {
  /** C-01 critère 1 : crée une checklist vide (titre de 1 à 200 caractères). */
  create(input: NewChecklistInput): Promise<Result<Checklist, ChecklistTextError>>;
  /** C-01 critère 6 : titre, icône, espace. L'ancien titre est conservé s'il est refusé. */
  update(id: ChecklistId, patch: ChecklistUpdate): Promise<Result<Checklist, ChecklistSaveError>>;
  /** C-01 critère 6 : supprime la checklist (items conservés, masqués avec elle) ; annulable 5 s. Renvoie vrai si c'est fait. */
  remove(id: ChecklistId): Promise<boolean>;
  /** C-01 critère 3 : ajoute un item en fin de liste (texte de 1 à 200 caractères). Les ajouts d'une même base sont sérialisés. */
  addItem(checklistId: ChecklistId, text: string): Promise<Result<ChecklistItem, ChecklistSaveError>>;
  /**
   * C-02 critères 2 et 3 : fixe l'état voulu d'un item (et non « basculer » : deux gestes rapides finissent sur le dernier). Écriture
   * immédiate en base ; aucun message « Annuler » (geste réversible d'un toucher, D2). Un item supprimé entre-temps est ignoré.
   */
  setChecked(itemId: ChecklistItemId, checked: boolean): Promise<ChecklistItem | null>;
  /** C-02 critère 5 : texte modifié en ligne (1 à 200 caractères) ; l'ancien texte est conservé s'il est refusé. */
  renameItem(itemId: ChecklistItemId, text: string): Promise<Result<ChecklistItem, ChecklistSaveError>>;
}

/** Ajouts d'items en file par base : deux Entrée rapides ne reçoivent jamais le même ordre. */
const addQueues = new WeakMap<DataAccess, Promise<unknown>>();

function enqueueAdd<T>(data: DataAccess, work: () => Promise<T>): Promise<T> {
  const previous = addQueues.get(data) ?? Promise.resolve();
  const run = previous.then(work, work);
  addQueues.set(data, run.catch(() => undefined));
  return run;
}

/**
 * Annulation d'une suppression de checklist (T-13) : la restaure, seulement si elle n'a pas changé depuis (même hlc que celui écrit par
 * l'action ; sinon 'stale', rien n'est écrit).
 */
function deletedCommand(deps: ChecklistUseCaseDeps, written: Checklist): UndoableCommand {
  return {
    kind: 'checklist',
    count: 1,
    labelKey: 'checklists.undo.deleted',
    labelParams: { title: written.title },
    async undo() {
      const current = await deps.data.repos.checklists.getById(written.id as ChecklistId, { includeDeleted: true });
      if (!current || current.hlc !== written.hlc) return 'stale';
      await deps.data.repos.checklists.restore(written.id as ChecklistId);
      emitChecklistsChanged(deps.data);
      return 'undone';
    },
  };
}

export function createChecklistUseCases(deps: ChecklistUseCaseDeps): ChecklistUseCases {
  const { data } = deps;

  return {
    async create(input) {
      const title = validateChecklistText(input.title);
      if (!title.ok) return title;
      const checklist = await data.repos.checklists.create({
        id: newEntityId<ChecklistId>(deps.ids),
        spaceId: input.spaceId,
        title: title.value,
        icon: input.icon,
        date: null,
        isTemplate: false,
      });
      emitChecklistsChanged(data);
      return { ok: true, value: checklist };
    },

    async update(id, patch) {
      const current = await data.repos.checklists.getById(id);
      if (!current) return { ok: false, error: 'not-found' };
      let title: string | undefined;
      if (patch.title !== undefined) {
        const valid = validateChecklistText(patch.title);
        if (!valid.ok) return valid;
        title = valid.value;
      }
      const written = await data.repos.checklists.update(id, {
        ...(title !== undefined ? { title } : {}),
        ...(patch.icon !== undefined ? { icon: patch.icon } : {}),
        ...(patch.spaceId !== undefined ? { spaceId: patch.spaceId } : {}),
      });
      emitChecklistsChanged(data);
      return { ok: true, value: written };
    },

    async remove(id) {
      const current = await data.repos.checklists.getById(id);
      if (!current) return false;
      const written = await data.repos.checklists.softDelete(id);
      deps.undo.push(deletedCommand(deps, written));
      emitChecklistsChanged(data);
      return true;
    },

    async addItem(checklistId, text) {
      const valid = validateChecklistText(text);
      if (!valid.ok) return valid;
      return enqueueAdd(data, async () => {
        if (!(await data.repos.checklists.getById(checklistId))) return { ok: false, error: 'not-found' } as const;
        const items = await data.repos.checklistItems.listForChecklist(checklistId);
        const item = await data.repos.checklistItems.add({
          id: newEntityId<ChecklistItemId>(deps.ids),
          checklistId,
          text: valid.value,
          checked: false,
          sortOrder: nextItemOrder(items),
        });
        emitChecklistsChanged(data);
        return { ok: true, value: item } as const;
      });
    },

    async setChecked(itemId, checked) {
      const [current] = await data.repos.checklistItems.getByIds([itemId]);
      if (!current || current.deletedAt !== null) return null;
      const written = current.checked === checked ? current : await data.repos.checklistItems.setChecked(itemId, checked);
      if (written !== current) emitChecklistsChanged(data);
      return written;
    },

    async renameItem(itemId, text) {
      const valid = validateChecklistText(text);
      if (!valid.ok) return valid;
      const [current] = await data.repos.checklistItems.getByIds([itemId]);
      if (!current || current.deletedAt !== null) return { ok: false, error: 'not-found' };
      if (current.text === valid.value) return { ok: true, value: current };
      const written = await data.repos.checklistItems.rename(itemId, valid.value);
      emitChecklistsChanged(data);
      return { ok: true, value: written };
    },
  };
}
