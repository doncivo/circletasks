import { useEffect, type KeyboardEvent, type ReactNode } from 'react';
import { t } from '../i18n';
import { Sheet } from './Sheet';
import { useFocusTrap } from './useFocusTrap';
import { useLayout } from './useLayout';
import './ActionMenu.css';

export interface ActionMenuItem {
  readonly id: string;
  /** Libellé déjà résolu par l'appelant (t()). */
  readonly label: string;
  readonly icon?: ReactNode;
}

export interface ActionMenuProps {
  open: boolean;
  /** Nom accessible du menu (ex. « Reporter la tâche »). */
  label: string;
  items: readonly ActionMenuItem[];
  onSelect: (id: string) => void;
  /** Échap, clic à l'extérieur, bouton « Fermer » (iPhone). */
  onClose: () => void;
}

/**
 * Menu d'actions (T-05) : sur PC, menu déroulant ancré (à placer dans un parent
 * `position: relative`, aligné sous le déclencheur) ; sur iPhone, feuille d'actions
 * avec bouton « Fermer ». Piège de focus, Échap, flèches haut / bas.
 *
 * @example
 * <ActionMenu open={open} label={t('tasks.postponeMenuLabel')} items={items} onSelect={choose} onClose={close} />
 */
export function ActionMenu({ open, label, items, onSelect, onClose }: ActionMenuProps) {
  const layout = useLayout();
  if (!open) return null;
  if (layout === 'mobile') {
    return (
      <Sheet open onClose={onClose} label={label}>
        <div className="ct-action-menu ct-action-menu--sheet">
          {items.map((item) => (
            <button key={item.id} type="button" className="ct-action-menu__item" onClick={() => onSelect(item.id)}>
              {item.icon}
              {item.label}
            </button>
          ))}
          <button type="button" className="ct-action-menu__item ct-action-menu__item--close" onClick={onClose}>
            {t('common.close')}
          </button>
        </div>
      </Sheet>
    );
  }
  return <MenuPopover label={label} items={items} onSelect={onSelect} onClose={onClose} />;
}

function MenuPopover({ label, items, onSelect, onClose }: Omit<ActionMenuProps, 'open'>) {
  const ref = useFocusTrap<HTMLDivElement>({ active: true, onEscape: onClose });

  // Clic à l'extérieur : ferme sans appliquer d'action.
  useEffect(() => {
    const handle = (event: MouseEvent) => {
      if (ref.current && event.target instanceof Node && !ref.current.contains(event.target)) onClose();
    };
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [ref, onClose]);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Tab') {
      // Un menu ne boucle pas : Tab le ferme (le focus revient au déclencheur).
      onClose();
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const buttons = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const step = event.key === 'ArrowDown' ? 1 : -1;
    buttons[(index + step + buttons.length) % buttons.length]?.focus();
    event.preventDefault();
  }

  return (
    <div ref={ref} role="menu" aria-label={label} tabIndex={-1} className="ct-action-menu ct-action-menu--popover" onKeyDown={handleKeyDown}>
      {items.map((item) => (
        <button key={item.id} type="button" role="menuitem" className="ct-action-menu__item" onClick={() => onSelect(item.id)}>
          {item.icon}
          {item.label}
        </button>
      ))}
    </div>
  );
}
