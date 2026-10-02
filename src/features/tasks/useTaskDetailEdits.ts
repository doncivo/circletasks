import { useEffect, useRef, useState } from 'react';
import type { IconRef, RecurrenceFields, ReminderOffsetMin, Task, TaskPatch } from '../../domain/model';
import { scopeChoicesForEdit, type SeriesScope } from '../../domain/recurrenceEdit';
import type { PostponeTarget } from '../../domain/taskPostpone';
import type { PlainMessageKey } from '../../i18n';
import type { EditSheetResult } from './TaskEditSheet';
import { useInlineCancel, type InlineCancelRef } from './useInlineCancel';

/** Actions de la fiche (store `taskDetailStore`) : elles ne rejettent jamais et rendent true si écrites. */
export interface TaskDetailApi {
  readonly updateNote: (note: string) => Promise<void>;
  readonly updateIcon: (icon: IconRef | null) => Promise<void>;
  readonly updateFields: (patch: TaskPatch) => Promise<boolean>;
  readonly applySeriesEdit: (patch: TaskPatch, scope: SeriesScope) => Promise<boolean>;
  readonly setRecurrence: (rule: RecurrenceFields) => Promise<boolean>;
  readonly updateRecurrence: (rule: RecurrenceFields) => Promise<boolean>;
  readonly stopRecurrence: () => Promise<boolean>;
  readonly postpone: (target: PostponeTarget) => Promise<void>;
  readonly postponeSeries: (target: PostponeTarget, scope: SeriesScope) => Promise<void>;
  readonly toggleDone: () => Promise<void>;
  readonly moveToSomeday: () => Promise<boolean>;
  readonly setReminders: (offsets: readonly ReminderOffsetMin[]) => Promise<boolean>;
  readonly updateFieldsAndReminders: (patch: TaskPatch, offsets: readonly ReminderOffsetMin[]) => Promise<boolean>;
}

export interface TaskDetailEdits {
  readonly noteDraft: string;
  readonly setNoteDraft: (note: string) => void;
  /** Enregistre la note si elle a changé ; rend true si la question de portée est posée (la fiche ne doit pas se fermer). */
  readonly flushNote: () => boolean;
  /** Modification d'un champ : question de portée pour une occurrence récurrente, sinon écriture immédiate (A-08 critère 8). */
  readonly commitPatch: (patch: TaskPatch) => void;
  readonly chooseIcon: (icon: IconRef | null) => void;
  readonly localErrorKey: PlainMessageKey | null;
  readonly title: {
    readonly editing: boolean;
    readonly draft: string;
    readonly setDraft: (title: string) => void;
    readonly start: () => void;
    readonly commit: () => void;
  };
  readonly sheet: {
    readonly open: boolean;
    readonly setOpen: (open: boolean) => void;
    readonly save: (result: EditSheetResult) => void;
    readonly pending: EditSheetResult | null;
    /** Règle modifiée sur une série : « Toutes les suivantes » seulement (T-10 critère 4), posée avant l'enregistrement. */
    readonly pendingRule: EditSheetResult | null;
    readonly chooseRule: () => void;
    readonly cancelRule: () => void;
    readonly choose: (scope: SeriesScope) => void;
    readonly cancel: () => void;
  };
  /** Question « cette occurrence / toutes les suivantes » d'une modification de champ ou de note. */
  readonly scope: {
    readonly pending: TaskPatch | null;
    readonly choose: (scope: SeriesScope) => void;
    readonly cancel: () => void;
  };
  /** Report d'une occurrence récurrente en attente du choix de portée (T-10 critère 4). */
  readonly postponeScope: {
    readonly pending: PostponeTarget | null;
    readonly ask: (target: PostponeTarget) => Promise<void>;
    readonly choose: (scope: SeriesScope) => void;
    readonly cancel: () => void;
  };
}

/**
 * État et gestes d'édition de la fiche d'une tâche (A-08, T-03, T-10) : note, champs, titre sur place, feuille « Modifier »,
 * questions de portée pour une occurrence récurrente. La fiche et ses fenêtres ne font que l'afficher.
 */
export function useTaskDetailEdits(
  task: Task,
  api: TaskDetailApi,
  cancelInlineRef: InlineCancelRef,
  flushNoteRef: { current: () => boolean },
): TaskDetailEdits {
  const [noteDraft, setNoteDraft] = useState(task.note);
  // La note change hors de la zone de saisie (« Annuler » d'une modification, T-10 critère 8) : le champ la suit.
  const [seenNote, setSeenNote] = useState(task.note);
  if (task.note !== seenNote) {
    setSeenNote(task.note);
    setNoteDraft(task.note);
  }
  const [pendingEdit, setPendingEdit] = useState<TaskPatch | null>(null);
  const [pendingSheet, setPendingSheet] = useState<EditSheetResult | null>(null);
  const [pendingRule, setPendingRule] = useState<EditSheetResult | null>(null);
  const [pendingPostpone, setPendingPostpone] = useState<PostponeTarget | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [localErrorKey, setLocalErrorKey] = useState<PlainMessageKey | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(task.title);
  /** Note en cours d'écriture après le choix : la perte de focus qui suit ne repose pas la question. */
  const savingNote = useRef<string | null>(null);

  useInlineCancel(cancelInlineRef, editingTitle, () => setEditingTitle(false));

  /** La modification d'une occurrence récurrente passe par la question ; rend true si elle est posée. */
  function askScope(patch: TaskPatch): boolean {
    if (scopeChoicesForEdit(task, patch).length === 0) return false;
    setPendingEdit(patch);
    return true;
  }

  function flushNote(): boolean {
    if (noteDraft === task.note || savingNote.current === noteDraft) return false;
    if (askScope({ note: noteDraft })) return true;
    void api.updateNote(noteDraft);
    return false;
  }
  // Tient la référence du parent à jour après chaque rendu : `handleClose` appelle toujours la dernière version.
  useEffect(() => {
    flushNoteRef.current = flushNote;
  });

  function commitPatch(patch: TaskPatch): void {
    setLocalErrorKey(null);
    if (task.recurrenceId !== null && patch.someday === true) {
      setLocalErrorKey('tasks.seriesError'); // une occurrence garde une date (T-09 critère 5)
      return;
    }
    if (!askScope(patch)) void api.updateFields(patch);
  }

  async function applySheet(result: EditSheetResult, scope?: SeriesScope): Promise<void> {
    const hasPatch = Object.keys(result.patch).length > 0;
    if (hasPatch && !scope && result.reminders !== undefined) {
      // Champs et rappels : une seule transaction, rien d'écrit en cas d'échec (N-02).
      if (!(await api.updateFieldsAndReminders(result.patch, result.reminders))) return;
    } else {
      if (hasPatch) {
        const ok = scope ? await api.applySeriesEdit(result.patch, scope) : await api.updateFields(result.patch);
        if (!ok) return;
      }
      if (result.reminders !== undefined) await api.setReminders(result.reminders);
    }
    if (result.rule === undefined) return;
    if (task.recurrenceId === null) {
      if (result.rule) await api.setRecurrence(result.rule);
    } else if (result.rule === null) await api.stopRecurrence();
    else await api.updateRecurrence(result.rule);
  }

  return {
    noteDraft,
    setNoteDraft,
    flushNote,
    commitPatch,
    localErrorKey,
    chooseIcon: (icon) => {
      if (!askScope({ icon })) void api.updateIcon(icon);
    },
    title: {
      editing: editingTitle,
      draft: titleDraft,
      setDraft: setTitleDraft,
      start: () => {
        setTitleDraft(task.title);
        setEditingTitle(true);
      },
      commit: () => {
        setEditingTitle(false);
        if (titleDraft.trim() !== task.title) commitPatch({ title: titleDraft });
      },
    },
    sheet: {
      open: sheetOpen,
      setOpen: setSheetOpen,
      pending: pendingSheet,
      save: (result) => {
        setSheetOpen(false);
        setLocalErrorKey(null);
        if (task.recurrenceId !== null && result.patch.someday === true) {
          setLocalErrorKey('tasks.seriesError');
          return;
        }
        if (task.recurrenceId !== null && result.rule) setPendingRule(result);
        else if (scopeChoicesForEdit(task, result.patch).length > 0) setPendingSheet(result);
        else void applySheet(result);
      },
      pendingRule,
      chooseRule: () => {
        const result = pendingRule;
        setPendingRule(null);
        if (!result) return;
        if (scopeChoicesForEdit(task, result.patch).length > 0) setPendingSheet(result);
        else void applySheet(result);
      },
      cancelRule: () => setPendingRule(null),
      choose: (scope) => {
        const result = pendingSheet;
        setPendingSheet(null);
        if (result) void applySheet(result, scope);
      },
      cancel: () => setPendingSheet(null),
    },
    scope: {
      pending: pendingEdit,
      choose: (scope) => {
        const patch = pendingEdit;
        setPendingEdit(null);
        if (!patch) return;
        savingNote.current = patch.note ?? null;
        void api.applySeriesEdit(patch, scope).then((ok) => {
          savingNote.current = null;
          if (!ok && patch.note !== undefined) setNoteDraft(task.note);
        });
      },
      cancel: () => {
        if (pendingEdit?.note !== undefined) setNoteDraft(task.note);
        setPendingEdit(null);
      },
    },
    postponeScope: {
      pending: pendingPostpone,
      ask: async (target) => setPendingPostpone(target),
      choose: (scope) => {
        const target = pendingPostpone;
        setPendingPostpone(null);
        if (target) void api.postponeSeries(target, scope);
      },
      cancel: () => setPendingPostpone(null),
    },
  };
}
