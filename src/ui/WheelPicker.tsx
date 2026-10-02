import { useEffect, useLayoutEffect, useRef, type KeyboardEvent } from 'react';
import './WheelPicker.css';

export interface WheelItem {
  /** Texte affiché dans la roue (ex. « Jeu. 24 sept. », « 10 », « — »). */
  readonly label: string;
  /** Texte annoncé par les lecteurs d'écran (ex. « 10 heures ») ; par défaut `label`. */
  readonly spoken?: string;
}

export interface WheelPickerProps {
  /** Nom accessible de la roue (ex. « Heures »). */
  label: string;
  items: readonly WheelItem[];
  /** Rang de l'élément choisi. */
  index: number;
  onChange: (index: number) => void;
  /** Roue grisée : ni défilement ni choix, annoncée comme désactivée (ex. minutes sans heure, Q9). */
  disabled?: boolean;
  /** Saut des touches Page précédente / suivante (jours : 7). */
  pageStep?: number;
  className?: string;
}

/** Hauteur d'un élément (px), identique au CSS (`.ct-wheel__item`, Ajout.html : 32 px). */
export const WHEEL_ITEM_HEIGHT = 32;
const SETTLE_MS = 90;

/**
 * Roue de choix iPhone (T-14, Ajout.html) : colonne défilante qui se cale sur un élément
 * (CSS scroll-snap) ; l'élément central, encadré, est le choix. Accessible : la roue est un
 * `spinbutton` (valeur annoncée en français, `aria-valuetext`), réglable au clavier et par les
 * gestes d'ajustement de VoiceOver (flèche haut = élément suivant, bas = précédent, Page, Début, Fin).
 * Les éléments visuels sont masqués aux lecteurs d'écran (la valeur est portée par la roue) mais
 * restent cliquables / touchables.
 *
 * @example
 * <WheelPicker label="Minutes" items={minutes} index={i} onChange={setI} disabled={noHour} />
 */
export function WheelPicker({ label, items, index, onChange, disabled = false, pageStep = 5, className }: WheelPickerProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const settleTimer = useRef<number | null>(null);
  const indexRef = useRef(index);
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    indexRef.current = index;
    onChangeRef.current = onChange;
  });

  // Recale le défilement sur le choix (changement venu de l'extérieur : puce, clavier, valeur initiale).
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const target = index * WHEEL_ITEM_HEIGHT;
    if (Math.abs(viewport.scrollTop - target) > 1) viewport.scrollTop = target;
  }, [index, items.length]);

  useEffect(
    () => () => {
      if (settleTimer.current !== null) window.clearTimeout(settleTimer.current);
    },
    [],
  );

  function handleScroll(): void {
    if (disabled) return;
    if (settleTimer.current !== null) window.clearTimeout(settleTimer.current);
    settleTimer.current = window.setTimeout(() => {
      settleTimer.current = null;
      const viewport = viewportRef.current;
      if (!viewport) return;
      const next = Math.min(Math.max(Math.round(viewport.scrollTop / WHEEL_ITEM_HEIGHT), 0), items.length - 1);
      if (next !== indexRef.current) onChangeRef.current(next);
    }, SETTLE_MS);
  }

  function select(next: number): void {
    const clamped = Math.min(Math.max(next, 0), items.length - 1);
    if (clamped !== index) onChange(clamped);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (disabled) return;
    const steps: Record<string, number> = { ArrowUp: 1, ArrowDown: -1, PageUp: pageStep, PageDown: -pageStep };
    const step = steps[event.key];
    if (step !== undefined) select(index + step);
    else if (event.key === 'Home') select(0);
    else if (event.key === 'End') select(items.length - 1);
    else return;
    event.preventDefault();
  }

  const current = items[index];
  return (
    <div
      role="spinbutton"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={items.length - 1}
      aria-valuenow={index}
      aria-valuetext={current?.spoken ?? current?.label ?? ''}
      aria-disabled={disabled || undefined}
      tabIndex={disabled ? -1 : 0}
      onKeyDown={handleKeyDown}
      className={['ct-wheel', disabled ? 'ct-wheel--disabled' : '', className].filter(Boolean).join(' ')}
    >
      <div className="ct-wheel__band" aria-hidden="true" />
      <div ref={viewportRef} className="ct-wheel__viewport" onScroll={handleScroll} aria-hidden="true">
        {items.map((item, i) => (
          <div
            key={i}
            data-selected={i === index ? 'true' : undefined}
            className="ct-wheel__item"
            onClick={() => {
              if (!disabled) select(i);
            }}
          >
            {item.label}
          </div>
        ))}
      </div>
    </div>
  );
}
