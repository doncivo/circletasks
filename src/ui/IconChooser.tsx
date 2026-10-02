import type { KeyboardEvent } from 'react';
import { useState } from 'react';
import type { IconRef } from '../domain/model/icon';
import { t } from '../i18n';
import { EmojiPicker } from './EmojiPicker';
import { IconPicker } from './IconPicker';
import './IconChooser.css';

export interface IconChooserProps {
  /** Icône ou emoji déjà choisi, ou `null` (aucun) ; un seul champ `icon` (T-03, critère 2). */
  value: IconRef | null;
  onChange: (icon: IconRef | null) => void;
  className?: string;
}

type Mode = 'icon' | 'emoji';

/**
 * Bascule Icône / Emoji (Ajout.html) et rangée correspondante (`IconPicker` ou
 * `EmojiPicker`) : composant réutilisable, factorisé hors de la saisie rapide et
 * de la fiche détail (T-03) pour servir aussi aux routines (R-01). Bascule au
 * sens radio (un seul choix possible, WAI-ARIA Radio Group Pattern) :
 * `role="radio"` + `aria-checked` plutôt que `aria-pressed`, flèches
 * gauche/droite pour naviguer entre les deux options.
 *
 * @example
 * <IconChooser value={icon} onChange={setIcon} />
 */
export function IconChooser({ value, onChange, className }: IconChooserProps) {
  // Mode initial déduit de la valeur déjà choisie (emoji si la tâche en a un),
  // sinon Icône par défaut (Ajout.html) ; la bascule reste ensuite libre, même si
  // l'utilisateur retire son choix dans le mode affiché.
  const [mode, setMode] = useState<Mode>(value?.kind === 'emoji' ? 'emoji' : 'icon');

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const next: Mode = mode === 'icon' ? 'emoji' : 'icon';
    setMode(next);
    event.currentTarget.querySelector<HTMLElement>(`[data-mode="${next}"]`)?.focus();
  }

  return (
    <div className={['ct-icon-chooser', className].filter(Boolean).join(' ')}>
      <div role="radiogroup" aria-label={t('tasks.iconFieldLabel')} className="ct-icon-chooser__modeRow" onKeyDown={handleKeyDown}>
        <button
          type="button"
          role="radio"
          aria-checked={mode === 'icon'}
          data-mode="icon"
          tabIndex={mode === 'icon' ? 0 : -1}
          onClick={() => setMode('icon')}
          className="ct-icon-chooser__modeButton"
        >
          {t('icons.modeIcon')}
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={mode === 'emoji'}
          data-mode="emoji"
          tabIndex={mode === 'emoji' ? 0 : -1}
          onClick={() => setMode('emoji')}
          className="ct-icon-chooser__modeButton"
        >
          {t('icons.modeEmoji')}
        </button>
      </div>
      {mode === 'icon' ? <IconPicker value={value} onChange={onChange} /> : <EmojiPicker value={value} onChange={onChange} />}
    </div>
  );
}
