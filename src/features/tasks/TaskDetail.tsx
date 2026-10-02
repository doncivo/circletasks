import { Check, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { IconRef, Task } from '../../domain/model';
import type { PostponeTarget } from '../../domain/taskPostpone';
import type { PlainMessageKey } from '../../i18n';
import { t } from '../../i18n';
import { Button, DetailPanel, Icon, IconChooser, IconView, Sheet, TextField, resolveIconRefColor, useLayout } from '../../ui';
import { useFeatureStore, useTaskEntities } from '../app/AppContainerContext';
import { useNavigationStore } from '../app/navigation';
import { DeleteTaskConfirm } from './DeleteTaskConfirm';
import { PostponeAction } from './PostponeAction';
import { taskDetailStore } from './taskDetailStore';
import './TaskDetail.css';

/**
 * Fiche détail d'une tâche (A-08), limitée par T-03 aux zones icône et note : la
 * fiche complète (date, récurrence, rappels, espace, projet, objectif, boutons
 * Focus / Reporter / Un jour / Dupliquer / Supprimer) arrive avec A-08. Panneau à
 * droite sur PC, feuille plein écran sur iPhone (`useLayout`, ADR 0004).
 *
 * La tâche affichée est lue dans `container.taskEntities` (source unique, ADR 0004).
 */
export function TaskDetail() {
  const detail = useNavigationStore((s) => s.detail);
  const closeDetail = useNavigationStore((s) => s.closeDetail);
  const layout = useLayout();

  const taskId = detail?.type === 'task' ? detail.id : null;
  // Tâche lue dans la source unique (ADR 0004, avenant) : toute écriture, d'où qu'elle
  // vienne (liste, annulation), est reflétée ici sans copie à synchroniser.
  const entities = useTaskEntities();
  const task = taskId ? entities.get(taskId) : undefined;
  const status = useFeatureStore(taskDetailStore, (s) => s.status);
  const errorKey = useFeatureStore(taskDetailStore, (s) => s.errorKey);
  const load = useFeatureStore(taskDetailStore, (s) => s.load);
  const updateNote = useFeatureStore(taskDetailStore, (s) => s.updateNote);
  const updateIcon = useFeatureStore(taskDetailStore, (s) => s.updateIcon);
  const toggleDone = useFeatureStore(taskDetailStore, (s) => s.toggleDone);
  const postpone = useFeatureStore(taskDetailStore, (s) => s.postpone);
  const remove = useFeatureStore(taskDetailStore, (s) => s.remove);

  // Note non enregistrée (perte de focus pas encore survenue) : la fiche la
  // sauvegarde aussi à la fermeture (critère 8), y compris par Échap, qui ne
  // déclenche pas de `blur` sur le champ. `TaskDetailBody` tient la référence à
  // jour à chaque rendu (pas un effet : simple affectation, pas un `setState`).
  const flushNoteRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    if (taskId) void load(taskId);
  }, [taskId, load]);

  if (!taskId) return null;

  function handleClose(): void {
    flushNoteRef.current();
    closeDetail();
  }

  // La tâche affichée (`task?.id`) sert de clé à `TaskDetailBody` : changer de
  // tâche remonte un composant frais plutôt que de synchroniser le brouillon de
  // note et l'état du sélecteur d'icône par effet (pas de setState dans un effet).
  const content =
    task ? (
      <TaskDetailBody
        key={task.id}
        task={task}
        flushNoteRef={flushNoteRef}
        onClose={handleClose}
        showCloseButton={layout === 'mobile'}
        updateNote={updateNote}
        updateIcon={updateIcon}
        toggleDone={toggleDone}
        postpone={postpone}
        // Suppression confirmée (T-08, critère 2) : la tâche part dans la corbeille, la fiche se ferme
        // (sans réécrire la note : la tâche n'existe plus ; la perte de focus l'a déjà enregistrée).
        onDelete={async () => {
          if (await remove()) closeDetail();
        }}
        errorKey={status === 'error' ? errorKey : null}
      />
    ) : status === 'error' && errorKey ? (
      <p role="alert" className="ct-task-detail__error">
        {t(errorKey)}
      </p>
    ) : null;

  if (layout === 'pc') {
    return (
      <DetailPanel label={t('tasks.detailLabel')} onClose={handleClose} width={588}>
        {content}
      </DetailPanel>
    );
  }

  return (
    <Sheet open onClose={handleClose} label={t('tasks.detailLabel')}>
      {content}
    </Sheet>
  );
}

interface TaskDetailBodyProps {
  task: Task;
  flushNoteRef: React.MutableRefObject<() => void>;
  onClose: () => void;
  /** Feuille iPhone : `Sheet` ne porte pas de bouton de fermeture intégré (contrairement à `DetailPanel`, PC). */
  showCloseButton: boolean;
  updateNote: (note: string) => Promise<void>;
  updateIcon: (icon: IconRef | null) => Promise<void>;
  /** Bouton « Marquer comme terminée » / « Rouvrir » (T-04, Detail.html). */
  toggleDone: () => Promise<void>;
  /** « Reporter » / « Planifier » (T-05). */
  postpone: (target: PostponeTarget) => Promise<void>;
  /** Suppression confirmée (T-08) ; la fiche parente se ferme si elle réussit. */
  onDelete: () => Promise<void>;
  /** Échec d'enregistrement ou de report à afficher (la tâche reste affichée). */
  errorKey: PlainMessageKey | null;
}

/** Contenu de la fiche pour une tâche donnée ; remonté (par `key`) à chaque changement de tâche. */
function TaskDetailBody({ task, flushNoteRef, onClose, showCloseButton, updateNote, updateIcon, toggleDone, postpone, onDelete, errorKey }: TaskDetailBodyProps) {
  const [noteDraft, setNoteDraft] = useState(task.note);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  function flushNote(): void {
    if (noteDraft !== task.note) void updateNote(noteDraft);
  }

  // Tient la référence du parent à jour après chaque rendu (pas de tableau de
  // dépendances) : `handleClose` appelle toujours la dernière version de
  // `flushNote`, sans provoquer de rendu supplémentaire (mutation de ref, pas
  // `setState`).
  useEffect(() => {
    flushNoteRef.current = flushNote;
  });

  function chooseIcon(icon: IconRef | null): void {
    void updateIcon(icon);
    setPickerOpen(false);
  }

  return (
    <div className="ct-task-detail">
      {showCloseButton && (
        <div className="ct-task-detail__closeRow">
          <button type="button" className="ct-task-detail__close" aria-label={t('common.close')} onClick={onClose}>
            <Icon icon={X} />
          </button>
        </div>
      )}
      <div className="ct-task-detail__header">
        <button
          type="button"
          className="ct-task-detail__iconButton"
          aria-label={task.icon ? t('tasks.changeIcon') : t('tasks.iconFieldLabel')}
          aria-expanded={pickerOpen}
          onClick={() => setPickerOpen((open) => !open)}
        >
          {task.icon ? (
            <IconView icon={task.icon} size={28} color={resolveIconRefColor(task.icon)} />
          ) : (
            <span className="ct-task-detail__iconPlaceholder" aria-hidden="true" />
          )}
        </button>
        <h2 className="ct-task-detail__title">{task.title}</h2>
      </div>

      {/* « Marquer comme terminée » (T-04, Detail.html) : libellé constant, l'état est porté
          par `aria-pressed` seul ; la ligne appelante reflète la tâche via `taskEntities`. */}
      <Button
        variant="secondary"
        pressed={task.status === 'done'}
        onClick={() => void toggleDone()}
        className="ct-task-detail__doneButton"
      >
        <Icon icon={Check} size={18} />
        {t('tasks.markDone')}
      </Button>

      <PostponeAction task={task} onPostpone={postpone} />

      {errorKey && (
        <p role="alert" className="ct-task-detail__error">
          {t(errorKey)}
        </p>
      )}

      {pickerOpen && (
        <div className="ct-task-detail__iconEditor">
          <IconChooser value={task.icon} onChange={chooseIcon} />
          {task.icon && (
            <Button variant="secondary" onClick={() => chooseIcon(null)}>
              {t('tasks.removeIcon')}
            </Button>
          )}
        </div>
      )}

      <TextField
        label={t('tasks.noteLabel')}
        visibleLabel
        multiline
        value={noteDraft}
        onChange={setNoteDraft}
        onBlur={flushNote}
        className="ct-task-detail__note"
      />

      {/* « Supprimer la tâche » (iPhone) / « Supprimer » (PC) : texte rouge, confirmation puis corbeille (T-08). */}
      <button type="button" className="ct-task-detail__delete" onClick={() => setConfirmOpen(true)}>
        {t(showCloseButton ? 'tasks.deleteTask' : 'tasks.deleteTaskPc')}
      </button>
      {confirmOpen && (
        <DeleteTaskConfirm
          task={task}
          onCancel={() => setConfirmOpen(false)}
          onConfirm={() => {
            setConfirmOpen(false);
            void onDelete();
          }}
        />
      )}
    </div>
  );
}
