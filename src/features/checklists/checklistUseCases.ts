import { checkedItemIds, duplicateAndReset, moveItem, nextItemOrder, sortItems, validateChecklistText, type ChecklistTextError } from '../../domain/checklistRules';
import { newEntityId } from '../../domain/id';
import type { Checklist, ChecklistItem, ChecklistPatch, IconRef } from '../../domain/model';
import type { ChecklistId, ChecklistItemId, LocalDate, Result, SpaceId } from '../../domain/types';
import type { DataAccess, Repositories } from '../../db/repositories';
import { getLocale, t, type MessageKey } from '../../i18n';
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

/** Champs modifiables depuis la feuille « Modifier la checklist » (C-04 : `isTemplate`, « Modèle réutilisable »). */
export type ChecklistUpdate = Pick<ChecklistPatch, 'title' | 'icon' | 'spaceId' | 'isTemplate'>;

export type ChecklistSaveError = ChecklistTextError | 'not-found';

export interface ChecklistUseCases {
  /** C-01 critère 1 : crée une checklist vide (titre de 1 à 200 caractères). */
  create(input: NewChecklistInput): Promise<Result<Checklist, ChecklistTextError>>;
  /** C-01 critère 6 : titre, icône, espace ; C-04 : marque ou démarque le modèle. L'ancien titre est conservé s'il est refusé. */
  update(id: ChecklistId, patch: ChecklistUpdate): Promise<Result<Checklist, ChecklistSaveError>>;
  /** C-01 critère 6 : supprime la checklist (items conservés, masqués avec elle) ; annulable 5 s. Renvoie vrai si c'est fait. */
  remove(id: ChecklistId): Promise<boolean>;
  /** C-01 critère 3 : ajoute un item en fin de liste (texte de 1 à 200 caractères). Les ajouts d'une même base sont sérialisés. */
  addItem(checklistId: ChecklistId, text: string): Promise<Result<ChecklistItem, ChecklistSaveError>>;
  /**
   * C-05 : « Effacer les cochés » — suppression logique de tous les items cochés, en une transaction ; annulable 5 s (les restaure à leur
   * place, 'stale' si l'un d'eux a changé). La confirmation est demandée par l'interface. Renvoie les items effacés (aucun : rien n'est écrit).
   */
  clearChecked(checklistId: ChecklistId): Promise<ChecklistItem[]>;
  /** C-05 : « Tout décocher » — décoche tous les items cochés d'un coup, sans confirmation ; annulable 5 s. Renvoie les items décochés. */
  uncheckAll(checklistId: ChecklistId): Promise<ChecklistItem[]>;
  /**
   * C-05 : « Réorganiser » — place l'item à la position `toIndex` (0 = en tête) ; les ordres sont renumérotés en une transaction ; annulable.
   * Renvoie la position finale (à partir de 1) et le total, null si rien ne change.
   */
  moveItem(checklistId: ChecklistId, itemId: ChecklistItemId, toIndex: number): Promise<{ readonly position: number; readonly total: number } | null>;
  /** C-05 critère 7 : « − » — supprime un item (suppression logique) ; annulable 5 s. Renvoie vrai si c'est fait. */
  removeItem(itemId: ChecklistItemId): Promise<boolean>;
  /**
   * C-04 : « Dupliquer et réinitialiser » — crée « <titre> (copie) » avec les mêmes items décochés, sans date, non modèle, en une seule
   * transaction (aucune copie partielle en cas d'échec) ; annulable 5 s (supprime la copie, 'stale' si elle a été modifiée). L'original
   * n'est pas touché. Renvoie la copie, null si la checklist n'existe plus.
   */
  duplicate(id: ChecklistId): Promise<Checklist | null>;
  /**
   * C-03 : associe la checklist à un jour (`date`) ou retire la date (null). Retirer la date est annulable 5 s ; poser ou changer le jour
   * ne l'est pas (geste réversible par le même sélecteur). Renvoie la checklist écrite, null si elle n'existe plus.
   */
  setDate(id: ChecklistId, date: LocalDate | null): Promise<Checklist | null>;
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

/**
 * Annulation du retrait de la date (T-13) : remet le jour d'avant, seulement si la checklist n'a pas changé depuis (même hlc que celui
 * écrit par l'action ; sinon 'stale', rien n'est écrit).
 */
function dateRemovedCommand(deps: ChecklistUseCaseDeps, written: Checklist, previous: LocalDate): UndoableCommand {
  return {
    kind: 'checklist',
    count: 1,
    labelKey: 'checklists.undo.dateRemoved',
    labelParams: { title: written.title },
    async undo() {
      const current = await deps.data.repos.checklists.getById(written.id as ChecklistId);
      if (!current || current.hlc !== written.hlc) return 'stale';
      await deps.data.repos.checklists.setDate(written.id as ChecklistId, previous);
      emitChecklistsChanged(deps.data);
      return 'undone';
    },
  };
}

/** Message d'un lot : singulier pour un seul élément, pluriel sinon (`Intl.PluralRules`). */
function countKey(count: number, one: MessageKey, many: MessageKey): MessageKey {
  return new Intl.PluralRules(getLocale()).select(count) === 'one' ? one : many;
}

/**
 * Annulation d'une action sur un lot d'items (T-13) : exécute `revert` seulement si aucun des items n'a changé depuis (mêmes hlc que
 * ceux écrits par l'action ; sinon 'stale', rien n'est écrit). Écrit en une transaction, puis annonce le changement.
 */
function itemsCommand(
  deps: ChecklistUseCaseDeps,
  written: readonly ChecklistItem[],
  label: { readonly key: MessageKey; readonly params?: Readonly<Record<string, string | number>> },
  revert: (repos: Repositories) => Promise<unknown>,
): UndoableCommand {
  return {
    kind: 'checklist',
    count: written.length,
    labelKey: label.key,
    ...(label.params ? { labelParams: label.params } : {}),
    async undo() {
      const current = await deps.data.repos.checklistItems.getByIds(written.map((item) => item.id as ChecklistItemId));
      if (current.length !== written.length || current.some((item, index) => item.hlc !== written[index]?.hlc)) return 'stale';
      await deps.data.transaction(revert);
      emitChecklistsChanged(deps.data);
      return 'undone';
    },
  };
}

/**
 * Annulation d'une duplication (T-13) : supprime la copie, seulement si ni elle ni ses items n'ont changé depuis (mêmes hlc que ceux
 * écrits par l'action ; sinon 'stale', rien n'est écrit).
 */
function duplicatedCommand(deps: ChecklistUseCaseDeps, written: Checklist, items: readonly ChecklistItem[]): UndoableCommand {
  return {
    kind: 'checklist',
    count: 1,
    labelKey: 'checklists.undo.duplicated',
    async undo() {
      const id = written.id as ChecklistId;
      const current = await deps.data.repos.checklists.getById(id);
      if (!current || current.hlc !== written.hlc) return 'stale';
      const now = await deps.data.repos.checklistItems.listForChecklist(id);
      const unchanged = now.length === items.length && now.every((item, index) => item.id === items[index]?.id && item.hlc === items[index]?.hlc);
      if (!unchanged) return 'stale';
      await deps.data.repos.checklists.softDelete(id);
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
        ...(patch.isTemplate !== undefined ? { isTemplate: patch.isTemplate } : {}),
      });
      emitChecklistsChanged(data);
      return { ok: true, value: written };
    },

    async clearChecked(checklistId) {
      const cleared = await data.transaction(async (repos) => {
        const ids = checkedItemIds(await repos.checklistItems.listForChecklist(checklistId));
        return ids.length === 0 ? [] : repos.checklistItems.softDelete(ids);
      });
      if (cleared.length === 0) return [];
      const ids = cleared.map((item) => item.id as ChecklistItemId);
      deps.undo.push(
        itemsCommand(deps, cleared, { key: countKey(cleared.length, 'checklists.undo.clearedOne', 'checklists.undo.clearedMany'), params: { count: cleared.length } }, (repos) =>
          repos.checklistItems.restore(ids),
        ),
      );
      emitChecklistsChanged(data);
      return cleared;
    },

    async uncheckAll(checklistId) {
      const unchecked = await data.transaction(async (repos) => {
        const ids = checkedItemIds(await repos.checklistItems.listForChecklist(checklistId));
        return ids.length === 0 ? [] : repos.checklistItems.setCheckedMany(ids, false);
      });
      if (unchecked.length === 0) return [];
      const ids = unchecked.map((item) => item.id as ChecklistItemId);
      deps.undo.push(itemsCommand(deps, unchecked, { key: 'checklists.undo.unchecked' }, (repos) => repos.checklistItems.setCheckedMany(ids, true)));
      emitChecklistsChanged(data);
      return unchecked;
    },

    async moveItem(checklistId, itemId, toIndex) {
      const moved = await data.transaction(async (repos) => {
        const items = await repos.checklistItems.listForChecklist(checklistId);
        const writes = moveItem(items, itemId, toIndex);
        if (writes.length === 0) return null;
        const before = items.filter((item) => writes.some((write) => write.id === item.id)).map((item) => ({ id: item.id as ChecklistItemId, sortOrder: item.sortOrder }));
        await repos.checklistItems.setSortOrders(writes);
        const written = await repos.checklistItems.getByIds(writes.map((write) => write.id));
        const order = sortItems(items.map((item) => ({ id: item.id, sortOrder: writes.find((write) => write.id === item.id)?.sortOrder ?? item.sortOrder })));
        return { written, before, position: order.findIndex((item) => item.id === itemId) + 1, total: order.length };
      });
      if (!moved) return null;
      deps.undo.push(itemsCommand(deps, moved.written, { key: 'checklists.undo.moved' }, (repos) => repos.checklistItems.setSortOrders(moved.before)));
      emitChecklistsChanged(data);
      return { position: moved.position, total: moved.total };
    },

    async removeItem(itemId) {
      const [current] = await data.repos.checklistItems.getByIds([itemId]);
      if (!current || current.deletedAt !== null) return false;
      const removed = await data.repos.checklistItems.softDelete([itemId]);
      deps.undo.push(itemsCommand(deps, removed, { key: 'checklists.undo.itemRemoved', params: { text: current.text } }, (repos) => repos.checklistItems.restore([itemId])));
      emitChecklistsChanged(data);
      return true;
    },

    async duplicate(id) {
      const copy = await data.transaction(async (repos) => {
        const source = await repos.checklists.getById(id);
        if (!source) return null;
        const plan = duplicateAndReset(source, await repos.checklistItems.listForChecklist(id), deps.ids, t('checklists.copySuffix'));
        return repos.checklists.createWithItems(plan.checklist, plan.items);
      });
      if (!copy) return null;
      deps.undo.push(duplicatedCommand(deps, copy.checklist, copy.items));
      emitChecklistsChanged(data);
      return copy.checklist;
    },

    async setDate(id, date) {
      const current = await data.repos.checklists.getById(id);
      if (!current) return null;
      if (current.date === date) return current;
      const written = await data.repos.checklists.setDate(id, date);
      if (date === null && current.date !== null) deps.undo.push(dateRemovedCommand(deps, written, current.date));
      emitChecklistsChanged(data);
      return written;
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
