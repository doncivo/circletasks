import { memo, useCallback, useMemo, useState } from 'react';
import { Bar, BarChart, ResponsiveContainer, XAxis, YAxis } from 'recharts';
import type { BarShapeProps } from 'recharts';

/** Une barre du graphique : une semaine du mois (H-02). */
export interface ChartBar {
  readonly key: string;
  /** « S37 », sous la barre. */
  readonly label: string;
  /** Taux entier ; null sans tâche (« — », barre vide en pointillé). */
  readonly percent: number | null;
  readonly valueLabel: string;
  readonly current: boolean;
  /** Texte de la bulle et nom accessible de la barre : « S37 · 31 août – 6 sept. · 21 sur 25 ». */
  readonly bubble: string;
}

/** Hauteur maximale d'une barre (Rapport.html : 120 px), étiquette de pourcentage au-dessus, étiquette de semaine dessous. */
export const BAR_MAX_HEIGHT = 120;
const LABEL_ABOVE = 22;
const AXIS_HEIGHT = 24;
const EMPTY_BAR_HEIGHT = 24;
const MIN_BAR_HEIGHT = 2;
const RADIUS = 6;

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Barre aux deux coins du haut arrondis (6 px). */
function barPath(x: number, y: number, width: number, height: number): string {
  const r = Math.min(RADIUS, width / 2, height);
  return `M${String(x)},${String(y + height)} V${String(y + r)} Q${String(x)},${String(y)} ${String(x + r)},${String(y)} H${String(x + width - r)} Q${String(x + width)},${String(y)} ${String(x + width)},${String(y + r)} V${String(y + height)} Z`;
}

interface WeekBarProps {
  readonly shape: BarShapeProps;
  readonly bar: ChartBar | undefined;
  readonly onActivate: (index: number | null) => void;
}

/**
 * Forme d'une barre (Rapport.html) : étiquette de pourcentage au-dessus, barre #C9BEE6 arrondie en haut, semaine courante #3A2A66 ; une
 * semaine sans tâche : « — » et barre vide en pointillé. Chaque barre prend le focus au clavier et ouvre la bulle (survol, focus, toucher).
 */
function WeekBar({ shape, bar, onActivate }: WeekBarProps) {
  if (!bar) return null;
  const index = shape.originalDataIndex;
  const baseline = shape.y + shape.height;
  const empty = bar.percent === null;
  const height = empty ? EMPTY_BAR_HEIGHT : Math.max(shape.height, MIN_BAR_HEIGHT);
  const top = baseline - height;
  return (
    <g
      className="ct-stats__bar"
      role="img"
      tabIndex={0}
      aria-label={bar.bubble}
      data-week={bar.key}
      data-current={bar.current}
      data-empty={empty}
      onPointerEnter={(event) => event.pointerType !== 'touch' && onActivate(index)}
      onPointerLeave={(event) => event.pointerType !== 'touch' && onActivate(null)}
      onFocus={() => onActivate(index)}
      onBlur={() => onActivate(null)}
      onClick={() => onActivate(index)}
    >
      <rect x={shape.x} y={baseline - BAR_MAX_HEIGHT} width={shape.width} height={BAR_MAX_HEIGHT} className="ct-stats__barHit" />
      {empty ? (
        <rect x={shape.x} y={top} width={shape.width} height={height} rx={RADIUS} className="ct-stats__barEmpty" />
      ) : (
        <path d={barPath(shape.x, top, shape.width, height)} className="ct-stats__barFill" />
      )}
      <text x={shape.x + shape.width / 2} y={top - 6} textAnchor="middle" className="ct-stats__barValue">
        {bar.valueLabel}
      </text>
    </g>
  );
}

function WeekTick({ x, y, payload, bars }: { x?: number; y?: number; payload?: { value: string }; bars: readonly ChartBar[] }) {
  const bar = bars.find((candidate) => candidate.label === payload?.value);
  return (
    <text x={x} y={(y ?? 0) + 12} textAnchor="middle" className="ct-stats__barWeek" data-current={bar?.current === true}>
      {payload?.value}
    </text>
  );
}

const CHART_HEIGHT = BAR_MAX_HEIGHT + LABEL_ABOVE + AXIS_HEIGHT;
const CHART_MARGIN = { top: LABEL_ABOVE, right: 6, bottom: 0, left: 6 };

interface PlotProps {
  readonly bars: readonly ChartBar[];
  readonly onActivate: (index: number | null) => void;
}

/**
 * Le tracé lui-même. Mémorisé : activer une barre (bulle) ne le redessine pas, sinon Recharts remonte les barres et le focus clavier se
 * perdrait à chaque déplacement.
 */
const Plot = memo(function Plot({ bars, onActivate }: PlotProps) {
  const data = useMemo(() => bars.map((bar) => ({ key: bar.key, label: bar.label, value: bar.percent ?? 0 })), [bars]);
  const renderShape = useCallback((shape: BarShapeProps) => <WeekBar shape={shape} bar={bars[shape.originalDataIndex]} onActivate={onActivate} />, [bars, onActivate]);
  return (
    <ResponsiveContainer width="100%" height={CHART_HEIGHT} initialDimension={{ width: 320, height: CHART_HEIGHT }}>
      <BarChart data={data} margin={CHART_MARGIN} barCategoryGap={14} accessibilityLayer={false}>
        <XAxis dataKey="label" axisLine={false} tickLine={false} interval={0} height={AXIS_HEIGHT} tick={<WeekTick bars={bars} />} />
        <YAxis hide domain={[0, 100]} />
        <Bar dataKey="value" isAnimationActive={!prefersReducedMotion()} shape={renderShape} />
      </BarChart>
    </ResponsiveContainer>
  );
});

/**
 * Graphique « TAUX DE COMPLÉTION PAR SEMAINE » (H-02) : `BarChart` Recharts, chargé en import dynamique avec le rapport. Pas d'animation
 * sous « Réduire les animations ». La bulle (« S37 · 31 août – 6 sept. · 21 sur 25 ») suit la barre survolée, focalisée ou touchée.
 */
export default function CompletionChart({ bars, label }: { bars: readonly ChartBar[]; label: string }) {
  const [active, setActive] = useState<number | null>(null);
  const activeBar = active === null ? undefined : bars[active];
  const total = Math.max(bars.length, 1);

  return (
    <div className="ct-stats__chart" role="group" aria-label={label}>
      {activeBar && (
        <div className="ct-stats__bubble" role="tooltip" style={{ left: `${String(((active ?? 0) + 0.5) * (100 / total))}%` }}>
          {activeBar.bubble}
        </div>
      )}
      <Plot bars={bars} onActivate={setActive} />
    </div>
  );
}

