import { forwardRef, useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { applySuggestion, foldName, quickSuggestions, type QuickContext, type QuickSuggestionItem } from '../domain/quickInput';
import { t } from '../i18n';
import { spaceTextColor } from './spaceColor';

import './QuickInputField.css';
import './TextField.css';

export interface QuickInputFieldProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** Libellé accessible du champ (masqué visuellement, comme `TextField`). */
  readonly label: string;
  readonly placeholder?: string;
  readonly maxLength?: number;
  /** Espaces et projets proposés après « # » et « @ » (Q-06). */
  readonly context: QuickContext;
  /** Liste sous le champ (PC, feuille) ou au-dessus (champ collé au bas de l'écran, iPhone). */
  readonly placement?: 'above' | 'below';
  readonly className?: string;
  readonly autoFocus?: boolean;
  /** Champ figé (écriture en cours) : lisible et focalisable, non modifiable. */
  readonly readOnly?: boolean;
  readonly onBlur?: () => void;
  /** Touches propres à l'écran (Échap qui referme le champ…) ; appelée quand les suggestions n'ont pas consommé la touche. */
  readonly onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
  readonly enterKeyHint?: 'done' | 'enter' | 'go' | 'next';
  readonly inputClassName?: string;
  /** `plain` : sans le cadre des champs de formulaire (le champ du jour de la Semaine a son propre style). */
  readonly variant?: 'field' | 'plain';
  /** Identifiant de l'aide qui décrit le champ (`aria-describedby`), ex. l'aide de la dictée (Q-03). */
  readonly describedBy?: string;
}

/**
 * Champ de saisie rapide (Q-06) : le texte tapé reste intact ; « # » propose les espaces, « @ » les projets actifs (liste
 * `listbox`, `aria-activedescendant`). Flèches choisissent, Entrée ou Tab (et le toucher) complètent le mot, Échap ferme la liste
 * sans effacer la saisie. L'aperçu de ce qui sera appliqué est `QuickPreview`, placé par l'appelant sous le champ.
 *
 * @example
 * <QuickInputField value={text} onChange={setText} label={t('tasks.newTask')} context={context} />
 */
export const QuickInputField = forwardRef<HTMLInputElement, QuickInputFieldProps>(function QuickInputField(
  {
  value,
  onChange,
  label,
  placeholder,
  maxLength,
  context,
  placement = 'below',
  className,
  autoFocus,
  readOnly,
  onBlur,
  onKeyDown,
  enterKeyHint,
  inputClassName,
  variant = 'field',
  describedBy,
  },
  ref,
) {
  const id = useId();
  const listId = `${id}-list`;
  const local = useRef<HTMLInputElement | null>(null);
  const [caret, setCaret] = useState(value.length);
  const [active, setActive] = useState(0);
  const [closedFor, setClosedFor] = useState<string | null>(null);
  const pendingCaret = useRef<number | null>(null);

  const signature = `${caret}:${value}`;
  const suggestions = useMemo(() => quickSuggestions(value, caret, context), [value, caret, context]);
  const open = suggestions !== null && closedFor !== signature;
  const items = open ? suggestions.items : [];
  const activeIndex = Math.min(active, Math.max(items.length - 1, 0));
  const optionId = (item: QuickSuggestionItem): string => `${id}-${item.id}`;

  // Texte réécrit par une suggestion : le curseur se place après le mot complété.
  useLayoutEffect(() => {
    if (pendingCaret.current === null) return;
    local.current?.setSelectionRange(pendingCaret.current, pendingCaret.current);
    setCaret(pendingCaret.current);
    pendingCaret.current = null;
  }, [value]);

  // Un nouveau jeu de suggestions repart de la première ligne.
  useEffect(() => setActive(0), [suggestions?.kind, suggestions?.query]);

  function choose(item: QuickSuggestionItem): void {
    if (!suggestions) return;
    const next = applySuggestion(value, suggestions, item);
    pendingCaret.current = next.caret;
    onChange(next.text);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (open && items.length > 0) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        setActive((activeIndex + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        const item = items[activeIndex];
        // Entrée sur un mot déjà complet (« #pro » pour l'espace Pro) n'a rien à compléter : elle valide la saisie (Q-01). Tab complète toujours.
        const complete = event.key === 'Enter' && item !== undefined && suggestions !== null && foldName(suggestions.query) === foldName(item.label);
        if (item && !complete) {
          event.preventDefault();
          choose(item);
          return;
        }
      }
      if (event.key === 'Escape') {
        // Ferme la liste, garde la saisie ; l'écran ne voit pas cet Échap (le champ reste ouvert).
        event.preventDefault();
        event.stopPropagation();
        setClosedFor(signature);
        return;
      }
    }
    onKeyDown?.(event);
  }

  useImperativeHandle(ref, () => local.current as HTMLInputElement);

  return (
    <div className={['ct-quick', className].filter(Boolean).join(' ')}>
      <label htmlFor={id} className={variant === 'field' ? 'ct-text-field' : 'ct-quick__plain'}>
        <span className="ct-visually-hidden">{label}</span>
        <input
          ref={local}
          id={id}
          type="text"
          value={value}
          placeholder={placeholder}
          maxLength={maxLength}
          autoFocus={autoFocus}
          readOnly={readOnly}
          autoComplete="off"
          aria-describedby={describedBy}
          enterKeyHint={enterKeyHint}
          className={[variant === 'field' ? 'ct-text-field__control' : '', inputClassName].filter(Boolean).join(' ')}
          // ARIA 1.2 : combobox permanent, aria-expanded suit la liste.
          role="combobox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={open && items[activeIndex] ? optionId(items[activeIndex]) : undefined}
          onChange={(event) => {
            setCaret(event.target.selectionStart ?? event.target.value.length);
            onChange(event.target.value);
          }}
          onSelect={(event) => setCaret(event.currentTarget.selectionStart ?? event.currentTarget.value.length)}
          onKeyDown={handleKeyDown}
          onBlur={onBlur}
        />
      </label>
      {open && (
        <ul id={listId} role="listbox" aria-label={t('capture.suggestionsLabel')} className="ct-quick__list" data-placement={placement}>
          {items.map((item, index) => (
            <li
              key={item.id}
              id={optionId(item)}
              role="option"
              aria-selected={index === activeIndex}
              aria-label={
                suggestions?.kind === 'space'
                  ? t('capture.spaceOptionLabel', { name: item.label })
                  : item.spaceName
                    ? t('capture.projectOptionLabelIn', { name: item.label, space: item.spaceName })
                    : t('capture.projectOptionLabel', { name: item.label })
              }
              className="ct-quick__option"
              // Garde le focus dans le champ : le toucher complète sans fermer le clavier.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(item)}
            >
              <span className="ct-quick__dot" aria-hidden="true" style={item.color ? { background: spaceTextColor(item.color) } : undefined} />
              <span>{suggestions?.kind === 'space' ? `#${item.label}` : `@${item.label}`}</span>
              {item.spaceName && (
                <span className="ct-quick__optionSpace" aria-hidden="true">
                  {item.spaceName}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
});
