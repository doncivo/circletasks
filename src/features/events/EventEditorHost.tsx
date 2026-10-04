import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { todayLocal } from '../../domain/clock';
import type { CalendarEvent, ReminderOffsetMin } from '../../domain/model';
import type { EventId } from '../../domain/types';
import { t } from '../../i18n';
import { ConfirmDialog, Sheet, useDetailSlot, useFocusTrap, useLayout } from '../../ui';
import { useAppContainer } from '../app/AppContainerContext';
import { useAppStore } from '../app/appStore';
import { useNavigationStore } from '../app/navigation';
import { onEventsChanged } from './eventEvents';
import { EventForm } from './EventForm';
import { createEventUseCases, type EventInput } from './eventUseCases';

function EditorPanel({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  const ref = useFocusTrap<HTMLElement>({ active: true, onEscape: onClose });
  return (
    <aside ref={ref} tabIndex={-1} aria-label={label} className="ct-detail-panel ct-events__panel" style={{ width: 548 }}>
      {children}
    </aside>
  );
}

interface Loaded {
  readonly event: CalendarEvent;
  readonly offsets: readonly ReminderOffsetMin[];
}

function EventEditor({ id }: { id: EventId }) {
  const container = useAppContainer();
  const layout = useLayout();
  const slot = useDetailSlot();
  const closeDetail = useNavigationStore((s) => s.closeDetail);
  const spaces = useAppStore((s) => s.spaces);
  const appDay = useAppStore((s) => s.day);
  const today = appDay ?? todayLocal(container.clock);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const event = await container.data.repos.events.getById(id);
        const offsets = await createEventUseCases(container).reminderOffsets(id);
        if (alive && event) setLoaded({ event, offsets });
      } catch {
        // fiche illisible : rien à montrer
      }
    })();
    // Supprimé ailleurs (annulation, autre écran) : la fiche se ferme.
    const off = onEventsChanged(container.data, () => {
      void container.data.repos.events.getById(id).then(
        (event) => {
          if (alive && !event) closeDetail();
        },
        () => undefined,
      );
    });
    return () => {
      alive = false;
      off();
    };
  }, [container, id, closeDetail]);

  if (loaded === null) return null;
  const { event, offsets } = loaded;

  async function save(input: EventInput): Promise<boolean> {
    const result = await createEventUseCases(container).update(id, input);
    if (!result.ok) {
      setError(t('events.saveError'));
      return false;
    }
    closeDetail();
    return true;
  }

  const label = t('events.sheet.editTitle');
  const form = (
    <EventForm
      event={event}
      spaces={spaces}
      initialSpaceId={event.spaceId}
      today={today}
      initialOffsets={offsets}
      onSubmit={save}
      onClose={closeDetail}
      onDelete={() => setConfirmDelete(true)}
      errorMessage={error}
    />
  );
  const confirm = confirmDelete ? (
    <ConfirmDialog
      title={t('events.sheet.deleteTitle', { title: event.title })}
      description={t('events.sheet.deleteBody')}
      confirmLabel={t('events.sheet.deleteConfirm')}
      onCancel={() => setConfirmDelete(false)}
      onConfirm={() => {
        setConfirmDelete(false);
        void createEventUseCases(container)
          .remove(id)
          .then((done) => {
            if (done) closeDetail();
          });
      }}
    />
  ) : null;

  if (layout === 'mobile') {
    return (
      <>
        <Sheet open onClose={closeDetail} label={label} className="ct-sheet--tall">
          {form}
        </Sheet>
        {confirm}
      </>
    );
  }
  const panel = (
    <EditorPanel label={label} onClose={closeDetail}>
      {form}
    </EditorPanel>
  );
  return (
    <>
      {slot ? createPortal(panel, slot) : panel}
      {confirm}
    </>
  );
}

/**
 * Fiche d'un événement local (E-01 critère 7) : s'ouvre quand la navigation affiche `{ type: 'event' }` (ligne de la liste Événements,
 * bandeau d'Aujourd'hui, élément de la Semaine). La même feuille que « Nouvel événement », en modification : une modification
 * s'applique à toute la série ; « Supprimer l'événement » demande confirmation puis propose « Annuler » 5 s. Panneau de droite sur PC,
 * feuille sur iPhone.
 */
export function EventEditorHost() {
  const detail = useNavigationStore((s) => s.detail);
  if (detail?.type !== 'event') return null;
  return <EventEditor key={detail.id} id={detail.id} />;
}
