import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Sheet, useDetailSlot, useFocusTrap, useLayout } from '../../ui';

function EditorPanel({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  const ref = useFocusTrap<HTMLElement>({ active: true, onEscape: onClose });
  return (
    <aside ref={ref} tabIndex={-1} aria-label={label} className="ct-detail-panel ct-checklists__panel" style={{ width: 548 }}>
      {children}
    </aside>
  );
}

/**
 * Emplacement de la feuille « Nouvelle checklist » / « Modifier la checklist » : feuille plein écran sur iPhone, panneau de droite
 * sur PC (même emplacement que le formulaire des routines, PC-Routines.html), sur place hors coquille (tests).
 */
export function ChecklistEditorHost({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  const layout = useLayout();
  const slot = useDetailSlot();
  if (layout === 'mobile') {
    return (
      <Sheet open onClose={onClose} label={label} className="ct-sheet--tall">
        {children}
      </Sheet>
    );
  }
  const panel = (
    <EditorPanel label={label} onClose={onClose}>
      {children}
    </EditorPanel>
  );
  return slot ? createPortal(panel, slot) : panel;
}
