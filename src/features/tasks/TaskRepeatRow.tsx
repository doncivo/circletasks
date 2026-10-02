import { useState } from 'react';
import type { RecurrenceFields, Task } from '../../domain/model';
import { RULE_EDIT_SCOPES, ruleChanged } from '../../domain/recurrenceEdit';
import { recurrenceLabel } from '../../domain/recurrenceLabel';
import { t } from '../../i18n';
import { formatMessageRef } from '../../i18n/formatRecurrence';
import { Button, ChoiceDialog, RecurrencePicker } from '../../ui';
import { DetailRow } from './DetailRow';

export interface TaskRepeatRowProps {
  readonly task: Task;
  /** Règle de la série (T-09), null : « Une fois ». */
  readonly recurrence: RecurrenceFields | null;
  /** Pose une règle sur une tâche datée (T-09) ; true si posée. */
  readonly setRecurrence: (rule: RecurrenceFields) => Promise<boolean>;
  /** T-10 : nouvelle règle pour « toutes les suivantes » ; true si écrite. */
  readonly updateRecurrence: (rule: RecurrenceFields) => Promise<boolean>;
  /** T-10 : « Arrêter la répétition » ; true si arrêtée. */
  readonly stopRecurrence: () => Promise<boolean>;
}

/**
 * Ligne « Répétition » de la fiche (PC-Aujourdhui.html, Detail.html : « Mensuelle, le 23 ») : texte cliquable qui ouvre l'éditeur de
 * règle sous la ligne (T-09 pose, T-10 modifie ou arrête). Une tâche terminée ou sans date n'est pas modifiable (texte seul ; pas
 * de ligne pour une tâche sans date et sans règle).
 */
export function TaskRepeatRow({ task, recurrence, setRecurrence, updateRecurrence, stopRecurrence }: TaskRepeatRowProps) {
  const recurrent = task.recurrenceId !== null;
  const [open, setOpen] = useState(false);
  /** `undefined` : règle non touchée ; `null` : « Une fois » choisi (arrêt). */
  const [draft, setDraft] = useState<RecurrenceFields | null | undefined>(undefined);
  const [scopeOpen, setScopeOpen] = useState(false);

  if (recurrent && !recurrence) return null;
  if (!recurrent && task.date === null) return null;
  const editable = task.status !== 'done';
  const value = recurrence ? formatMessageRef(recurrenceLabel(recurrence, task.date)) : t('tasks.repeatOnce');

  function toggle(): void {
    setDraft(recurrent ? undefined : null);
    setOpen((current) => !current);
  }

  function apply(): void {
    setScopeOpen(false);
    if (draft === undefined || (draft !== null && recurrence && !ruleChanged(recurrence, draft))) {
      setOpen(false);
      return;
    }
    // « Une fois » : arrêt de la répétition ; sinon « toutes les suivantes » seulement (T-10 critère 4).
    const done = recurrent ? (draft === null ? stopRecurrence() : updateRecurrence(draft)) : draft ? setRecurrence(draft) : Promise.resolve(false);
    void done.then((ok) => {
      if (ok) setOpen(false);
    });
  }

  return (
    <>
      <DetailRow label={t('tasks.repeatLabel')}>
        {editable ? (
          <button
            type="button"
            className="ct-task-detail__valueButton"
            data-testid="recurrence-detail"
            aria-label={t(recurrent ? 'tasks.repeatEditLabel' : 'tasks.repeatActionLabel')}
            aria-expanded={open}
            onClick={toggle}
          >
            {value}
          </button>
        ) : (
          <span data-testid="recurrence-detail">{value}</span>
        )}
      </DetailRow>
      {open && editable && (
        <div className="ct-task-detail__editor">
          <RecurrencePicker value={draft === undefined ? recurrence : draft} onChange={setDraft} startDate={task.date} />
          <div className="ct-task-detail__editorActions">
            <Button
              disabled={draft === undefined || (!recurrent && draft === null)}
              onClick={() => (recurrent && draft !== null ? setScopeOpen(true) : apply())}
            >
              {t('tasks.repeatApply')}
            </Button>
            {recurrent && (
              <Button
                variant="secondary"
                onClick={() =>
                  void stopRecurrence().then((ok) => {
                    if (ok) setOpen(false);
                  })
                }
              >
                {t('tasks.repeatStop')}
              </Button>
            )}
          </div>
        </div>
      )}
      {scopeOpen && (
        <ChoiceDialog
          title={t('tasks.seriesRuleTitle')}
          description={t('tasks.seriesRuleBody')}
          options={RULE_EDIT_SCOPES.map((id) => ({ id, label: t('tasks.seriesScopeFollowing') }))}
          onChoose={apply}
          onCancel={() => setScopeOpen(false)}
        />
      )}
    </>
  );
}
