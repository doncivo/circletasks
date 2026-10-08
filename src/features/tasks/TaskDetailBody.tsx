import { Check, Pencil, X } from 'lucide-react';
import { lazy, Suspense, useId, useState, type KeyboardEvent } from 'react';
import { appleLinkState } from '../../domain/appleReminders';
import { canMoveToSomeday } from '../../domain/someday';
import type { RecurrenceFields, ReminderOffsetMin, Space, Task } from '../../domain/model';
import type { SeriesScope } from '../../domain/recurrenceEdit';
import type { LocalDate } from '../../domain/types';
import { t, type PlainMessageKey } from '../../i18n';
import { formatStamp } from '../../i18n/format';
import { Button, Icon, IconChooser, IconView, TextField, resolveIconRefColor } from '../../ui';
import { LinkedEventRow } from '../calendars/LinkedEventRow';
import { FocusLaunchButton } from '../focus/FocusLaunchButton';
import { FocusTaskTotalRow } from '../focus/FocusTaskTotalRow';
import { DeleteTaskConfirm } from './DeleteTaskConfirm';
import { DuplicatePrompt } from './DuplicatePrompt';
import { PostponeAction } from './PostponeAction';
import { TaskDetailDialogs } from './TaskDetailDialogs';
import { TaskDetailFields } from './TaskDetailFields';
import { TaskEditSheet } from './TaskEditSheet';
import type { InlineCancelRef } from './useInlineCancel';
import { useTaskDetailEdits, type TaskDetailApi } from './useTaskDetailEdits';

/** Chargée à la demande (budget du bundle de départ) : seules les tâches d'origine Rappels l'affichent. */
const AppleSourceRow = lazy(() => import('../calendars/appleReminders/AppleSourceRow').then((m) => ({ default: m.AppleSourceRow })));

export interface TaskDetailBodyProps {
  readonly task: Task;
  readonly api: TaskDetailApi;
  /** Enregistre la note en attente ; rend true si une question (T-10) doit être posée avant de fermer. */
  readonly flushNoteRef: { current: () => boolean };
  readonly cancelInlineRef: InlineCancelRef;
  readonly spaces: readonly Space[];
  readonly today: LocalDate;
  /** Instant courant (horodatage relatif « modifiée hier à 18:04 »). */
  readonly nowMs: number;
  readonly reminders: readonly ReminderOffsetMin[];
  /** Règle de la série (T-09), `null` : tâche non récurrente. */
  readonly recurrence: RecurrenceFields | null;
  /** Feuille iPhone (Detail.html) ; sinon panneau PC (PC-Aujourdhui.html). */
  readonly isMobile: boolean;
  readonly onClose: () => void;
  /** T-12 : « Dupliquer » ; la copie est créée à `date` (null : « Un jour »), la fiche reste sur l'original. */
  readonly duplicate: (date: LocalDate | null) => Promise<boolean>;
  /** Suppression confirmée (T-08) ; la fiche parente se ferme si elle réussit. `scope` : T-10. */
  readonly onDelete: (scope?: SeriesScope) => Promise<void>;
  /** Échec d'enregistrement ou de report à afficher (la tâche reste affichée). */
  readonly errorKey: PlainMessageKey | null;
}

/**
 * Contenu de la fiche d'une tâche (A-08), remonté (par `key`) à chaque changement de tâche. PC (PC-Aujourdhui.html) : lignes texte
 * éditées au clic, boutons Reporter / Un jour / Dupliquer en bas et Supprimer en texte rouge à droite ; terminer reste sur la case de
 * la ligne. iPhone (Detail.html) : ✕, « DÉTAIL » et crayon (Modifier, Q15) en tête, « Marquer comme terminée » encadré, boutons
 * sans icône, « Supprimer la tâche » en rouge. Focus (M10) et interrupteur d'objectif (OB-03) : absents tant que leurs modules
 * n'existent pas.
 */
export function TaskDetailBody(props: TaskDetailBodyProps) {
  const { task, api, isMobile, spaces, today, nowMs, recurrence, onClose, errorKey } = props;
  const edits = useTaskDetailEdits(task, api, props.cancelInlineRef, props.flushNoteRef);
  const [duplicateOpen, setDuplicateOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const title = edits.title;
  const hintId = useId();
  const somedayHintId = useId();

  const onTitleKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key === 'Enter' || event.key === 'F2') {
      event.preventDefault();
      title.start();
    }
  };

  return (
    <div className="ct-task-detail" data-layout={isMobile ? 'mobile' : 'pc'}>
      {isMobile && (
        <div className="ct-task-detail__topRow">
          <button type="button" className="ct-task-detail__topButton" aria-label={t('common.close')} onClick={onClose}>
            <Icon icon={X} />
          </button>
          <span className="ct-task-detail__caption">{t('detail.caption')}</span>
          <button type="button" className="ct-task-detail__topButton" aria-label={t('detail.edit')} onClick={() => edits.sheet.setOpen(true)}>
            <Icon icon={Pencil} size={22} />
          </button>
        </div>
      )}

      <div className="ct-task-detail__header">
        <button
          type="button"
          className="ct-task-detail__iconButton"
          aria-label={task.icon ? t('tasks.changeIcon') : t('tasks.iconFieldLabel')}
          aria-expanded={iconPickerOpen}
          onClick={() => setIconPickerOpen((open) => !open)}
        >
          {task.icon ? <IconView icon={task.icon} size={28} color={resolveIconRefColor(task.icon)} /> : <span className="ct-task-detail__iconPlaceholder" aria-hidden="true" />}
        </button>
        {title.editing ? (
          <form
            className="ct-task-detail__titleField"
            onSubmit={(event) => {
              event.preventDefault();
              title.commit();
            }}
          >
            <TextField label={t('detail.titleLabel')} value={title.draft} onChange={title.setDraft} onBlur={title.commit} maxLength={200} autoFocus />
          </form>
        ) : (
          <h2 className="ct-task-detail__title">
            {isMobile ? (
              task.title
            ) : (
              <button type="button" className="ct-task-detail__titleButton" aria-describedby={hintId} onClick={title.start} onKeyDown={onTitleKeyDown}>
                {task.title}
              </button>
            )}
          </h2>
        )}
        {!isMobile && (
          <span id={hintId} className="ct-visually-hidden">
            {t('detail.titleEditHint')}
          </span>
        )}
      </div>

      {iconPickerOpen && (
        <div className="ct-task-detail__editor">
          <IconChooser
            value={task.icon}
            onChange={(icon) => {
              setIconPickerOpen(false);
              edits.chooseIcon(icon);
            }}
          />
          {task.icon && (
            <Button
              variant="secondary"
              onClick={() => {
                setIconPickerOpen(false);
                edits.chooseIcon(null);
              }}
            >
              {t('tasks.removeIcon')}
            </Button>
          )}
        </div>
      )}

      {/* « Marquer comme terminée » (iPhone, T-04, Detail.html) : bouton encadré avec case ; libellé constant, l'état est porté par
          `aria-pressed`. Sur PC, terminer reste sur la case de la ligne (PC-Aujourdhui.html n'a pas ce bouton). */}
      {isMobile && (
        <button type="button" className="ct-task-detail__doneButton" aria-pressed={task.status === 'done'} onClick={() => void api.toggleDone()}>
          <span className="ct-task-detail__doneBox" aria-hidden="true">
            {task.status === 'done' && <Icon icon={Check} size={16} strokeWidth={3} color="var(--ct-color-accent-on)" />}
          </span>
          {t('tasks.markDone')}
        </button>
      )}

      {errorKey && (
        <p role="alert" className="ct-task-detail__error">
          {t(errorKey)}
        </p>
      )}
      {edits.localErrorKey && (
        <p role="alert" className="ct-task-detail__error">
          {t(edits.localErrorKey)}
        </p>
      )}

      <TaskDetailFields
        task={task}
        layout={isMobile ? 'mobile' : 'pc'}
        spaces={spaces}
        today={today}
        reminders={props.reminders}
        setReminders={api.setReminders}
        onGoalChange={(goalId) => void api.updateFields({ goalId })}
        recurrence={recurrence}
        onPatch={edits.commitPatch}
        cancelInlineRef={props.cancelInlineRef}
        setRecurrence={api.setRecurrence}
        updateRecurrence={api.updateRecurrence}
        stopRecurrence={api.stopRecurrence}
      />
      {/* K-04 : lien en lecture seule vers l'événement d'agenda externe d'où vient la tâche. */}
      <LinkedEventRow task={task} />
      {/* K-05 : origine Rappels Apple (liste, récurrent, détachée), en lecture seule. */}
      {appleLinkState(task) !== 'ordinary' && (
        <Suspense fallback={null}>
          <AppleSourceRow task={task} />
        </Suspense>
      )}
      {/* M10 (F-03) : temps de concentration de la tâche, en lecture seule. */}
      <FocusTaskTotalRow taskId={task.id} />

      <TextField
        label={t('tasks.noteLabel')}
        visibleLabel
        multiline
        value={edits.noteDraft}
        onChange={edits.setNoteDraft}
        onBlur={edits.flushNote}
        className="ct-task-detail__note"
      />
      <p className="ct-task-detail__stamp">{t('detail.createdModified', { created: formatStamp(task.createdAt, nowMs), modified: formatStamp(task.updatedAt, nowMs) })}</p>

      <div className="ct-task-detail__spacer" />

      {/* M10 : « Lancer un Focus » (iPhone, Detail.html) au-dessus des boutons ; « Focus 25 min » (PC) en tête de la rangée. */}
      {isMobile && <FocusLaunchButton task={task} isMobile />}
      <div className="ct-task-detail__actions">
        {!isMobile && <FocusLaunchButton task={task} isMobile={false} />}
        <PostponeAction task={task} onPostpone={task.recurrenceId !== null ? edits.postponeScope.ask : api.postpone} />
        {/* « Un jour » (SD-03). */}
        {canMoveToSomeday(task) && (
          <Button variant="secondary" onClick={() => void api.moveToSomeday()} className="ct-task-detail__actionButton">
            {t('detail.somedayAction')}
          </Button>
        )}
        {/* Tâche récurrente (QB-11) : « Un jour » grisé, avec l'aide « Arrêtez d'abord la répétition » ; rien ne change au clic. */}
        {task.status === 'todo' && !task.someday && task.recurrenceId !== null && (
          <>
            <Button variant="secondary" ariaDisabled describedBy={somedayHintId} className="ct-task-detail__actionButton">
              {t('detail.somedayAction')}
            </Button>
            <span id={somedayHintId} className="ct-visually-hidden">
              {t('someday.recurrentHint')}
            </span>
          </>
        )}
        {/* « Dupliquer » (T-12 ; absent de PC-Aujourdhui.html, exigé par A-08) : possible aussi sur une tâche terminée. */}
        <Button variant="secondary" ariaLabel={t('tasks.duplicateLabel')} onClick={() => setDuplicateOpen(true)} className="ct-task-detail__actionButton">
          {t('tasks.duplicate')}
        </Button>
        {/* « Supprimer » (PC, à droite) : texte rouge, confirmation puis corbeille (T-08). */}
        {!isMobile && (
          <button type="button" className="ct-task-detail__delete" onClick={() => setConfirmOpen(true)}>
            {t('tasks.deleteTaskPc')}
          </button>
        )}
      </div>
      {isMobile && (
        <button type="button" className="ct-task-detail__delete" onClick={() => setConfirmOpen(true)}>
          {t('tasks.deleteTask')}
        </button>
      )}

      {duplicateOpen && (
        <DuplicatePrompt
          task={task}
          onClose={() => setDuplicateOpen(false)}
          onConfirm={(date) => {
            setDuplicateOpen(false);
            void props.duplicate(date);
          }}
        />
      )}
      {confirmOpen && (
        <DeleteTaskConfirm
          task={task}
          onCancel={() => setConfirmOpen(false)}
          onConfirm={(scope) => {
            setConfirmOpen(false);
            void props.onDelete(scope);
          }}
        />
      )}
      {isMobile && edits.sheet.open && (
        <TaskEditSheet task={task} spaces={spaces} today={today} recurrence={recurrence} reminders={props.reminders} onClose={() => edits.sheet.setOpen(false)} onSave={edits.sheet.save} />
      )}
      <TaskDetailDialogs task={task} edits={edits} />
    </div>
  );
}
