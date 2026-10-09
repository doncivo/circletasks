import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
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
 * Roues longues (la roue des jours : 791 éléments), rendues par fenêtre : seuls les éléments proches du centre de la fenêtre existent dans le
 * DOM, deux espaceurs de même hauteur gardent la géométrie de la liste complète (hauteur totale, `scrollTop`, `scroll-snap` inchangés). La
 * fenêtre suit le défilement (elle se recentre dès que le doigt s'éloigne de son centre) et le choix venu de l'extérieur. Rendre 800 éléments
 * coûtait l'essentiel du délai d'ouverture de la feuille « Nouvelle tâche », puis 2 s de mise en page à CPU 4× (Q-05, mesure @perf).
 */
const LONG_WHEEL_MIN_ITEMS = 100;
const LONG_WHEEL_RADIUS = 40;
/** Écart (en éléments) entre le centre de la fenêtre et la position qui déclenche son recentrage. */
const LONG_WHEEL_RECENTER = 12;

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
  const long = items.length >= LONG_WHEEL_MIN_ITEMS;
  const [center, setCenter] = useState(index);
  // Choix qui change (puce, clavier, fin de défilement) hors de la zone sûre de la fenêtre : elle le rejoint dans le même rendu. Seul un
  // changement du choix recentre ainsi : pendant un défilement, le choix reste l'ancien et la fenêtre suit le doigt (handleScroll).
  const [seenIndex, setSeenIndex] = useState(index);
  if (index !== seenIndex) {
    setSeenIndex(index);
    if (long && Math.abs(index - center) > LONG_WHEEL_RECENTER) setCenter(index);
  }
  const settleTimer = useRef<number | null>(null);
  const indexRef = useRef(index);
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    indexRef.current = index;
    onChangeRef.current = onChange;
  });

  // Recale le défilement sur le choix (changement venu de l'extérieur : puce, clavier, valeur initiale).
  // Premier calage reporté à l'image suivante, avant son affichage (donc sans saut visible) : lire puis écrire `scrollTop` force une mise en
  // page par roue, et la feuille « Nouvelle tâche » en porte cinq dans le toucher du bouton + (Q-05, mesure @perf). Les changements
  // suivants se calent aussitôt.
  const positioned = useRef(false);
  const frame = useRef<number | null>(null);
  const userScrolled = useRef(false);
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const position = (): void => {
      const target = indexRef.current * WHEEL_ITEM_HEIGHT;
      if (Math.abs(viewport.scrollTop - target) > 1) viewport.scrollTop = target;
    };
    indexRef.current = index;
    if (!positioned.current) {
      positioned.current = true;
      // L'image qui suit le montage précède son premier affichage ; un défilement du doigt avant elle (impossible sans affichage) l'emporte.
      frame.current = window.requestAnimationFrame(() => {
        frame.current = null;
        if (!userScrolled.current) position();
      });
      return;
    }
    if (frame.current !== null) {
      window.cancelAnimationFrame(frame.current);
      frame.current = null;
    }
    position();
  }, [index, items.length]);

  useEffect(
    () => () => {
      if (frame.current !== null) window.cancelAnimationFrame(frame.current);
      if (settleTimer.current !== null) window.clearTimeout(settleTimer.current);
    },
    [],
  );

  function handleScroll(): void {
    userScrolled.current = true;
    if (disabled) return;
    if (long) {
      const viewport = viewportRef.current;
      const near = viewport ? Math.min(Math.max(Math.round(viewport.scrollTop / WHEEL_ITEM_HEIGHT), 0), items.length - 1) : center;
      if (Math.abs(near - center) > LONG_WHEEL_RECENTER) setCenter(near);
    }
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
  const firstShown = long ? Math.max(0, center - LONG_WHEEL_RADIUS) : 0;
  const lastShown = long ? Math.min(items.length - 1, center + LONG_WHEEL_RADIUS) : items.length - 1;
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
        {firstShown > 0 && <div key="before" aria-hidden="true" style={{ height: firstShown * WHEEL_ITEM_HEIGHT }} />}
        {items.slice(firstShown, lastShown + 1).map((item, offset) => {
          const i = firstShown + offset;
          return (
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
          );
        })}
        {lastShown < items.length - 1 && <div key="after" aria-hidden="true" style={{ height: (items.length - 1 - lastShown) * WHEEL_ITEM_HEIGHT }} />}
      </div>
    </div>
  );
}
