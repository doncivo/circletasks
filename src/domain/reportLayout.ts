import type { AggregateState } from './routineReport';

/**
 * Mise en page du rapport du mois exporté en image ou en PDF (H-03 critères 5 et 6, D3) : liste d'opérations de dessin (rectangles et
 * textes) calculée sans canvas ni DOM, dans une grille de 880 unités de large (la maquette PC, tuiles sur une ligne, graphique et carte
 * côte à côte). Le rendu canvas (polices Fraunces et DM Sans, palette claire des maquettes) est dans `src/features/stats/reportImage.ts`.
 */

/** Rôles de couleur : la palette (claire, celle des maquettes) est choisie par le rendu. */
export type ReportColor =
  | 'bg'
  | 'ink'
  | 'secondary'
  | 'tile'
  | 'bar'
  | 'barCurrent'
  | 'barEmpty'
  | 'heatAll'
  | 'heatPartial'
  | 'heatMissed'
  | 'heatOff'
  | 'border';

export type ReportOp =
  | { readonly kind: 'rect'; readonly x: number; readonly y: number; readonly w: number; readonly h: number; readonly radius?: number; readonly topRadius?: number; readonly fill?: ReportColor; readonly stroke?: ReportColor; readonly dashed?: boolean }
  | {
      readonly kind: 'text';
      readonly x: number;
      readonly y: number;
      readonly text: string;
      readonly size: number;
      readonly weight: 400 | 600 | 700;
      readonly font: 'title' | 'text';
      readonly color: ReportColor;
      readonly align: 'left' | 'center' | 'right';
      /** Largeur maximale : le rendu raccourcit le texte avec « … » au-delà. */
      readonly maxWidth?: number;
      /** Espacement des lettres (titres de section en capitales). */
      readonly letterSpacing?: number;
      /** Complément en texte secondaire à la suite du texte (« / 61 »), dessiné après mesure par le rendu. */
      readonly suffix?: string;
    };

export interface ReportLayout {
  /** Largeur de la grille (unités) ; le rendu met à l'échelle. */
  readonly width: number;
  readonly height: number;
  readonly ops: readonly ReportOp[];
}

export interface ReportTile {
  readonly label: string;
  readonly value: string;
  readonly sub?: string;
}

export interface ReportBar {
  readonly label: string;
  readonly valueLabel: string;
  readonly percent: number | null;
  readonly current: boolean;
}

export interface ReportHeatCell {
  readonly day: number;
  readonly state: AggregateState;
}

/** Textes déjà traduits et formatés (le domaine ne dépend pas de src/i18n). */
export interface ReportTexts {
  readonly caption: string;
  readonly title: string;
  readonly filterLabel: string;
  readonly tiles: readonly ReportTile[];
  readonly chartTitle: string;
  readonly monthRate: string;
  readonly bars: readonly ReportBar[];
  readonly routinesTitle: string;
  readonly weekdays: readonly string[];
  readonly heatmap: { readonly leadingBlanks: number; readonly cells: readonly ReportHeatCell[] } | null;
  readonly rates: readonly { readonly title: string; readonly value: string }[];
  readonly footer: string;
}

export const REPORT_WIDTH = 880;
const PAD = 40;
const GAP = 12;
const BAR_MAX = 120;
const CELL_H = 30;
const CELL_GAP = 4;
const MAX_RATE_ROWS = 10;

const HEAT_COLOR: { readonly [S in AggregateState]: ReportColor } = {
  all: 'heatAll',
  partial: 'heatPartial',
  missed: 'heatMissed',
  upcoming: 'heatOff',
  none: 'heatOff',
};

/** Dispose le rapport : en-tête, quatre tuiles, puis graphique (gauche) et carte des routines avec leurs taux (droite). */
export function reportLayout(texts: ReportTexts): ReportLayout {
  const ops: ReportOp[] = [];
  const inner = REPORT_WIDTH - 2 * PAD;
  const column = (inner - 40) / 2;
  const rightX = PAD + column + 40;

  // Fond
  ops.push({ kind: 'rect', x: 0, y: 0, w: REPORT_WIDTH, h: 0, fill: 'bg' }); // hauteur fixée en fin de calcul

  // En-tête
  ops.push({ kind: 'text', x: PAD, y: 56, text: texts.caption, size: 15, weight: 600, font: 'text', color: 'secondary', align: 'left' });
  ops.push({ kind: 'text', x: PAD, y: 104, text: texts.title, size: 44, weight: 700, font: 'title', color: 'ink', align: 'left', maxWidth: inner - 160 });
  ops.push({ kind: 'text', x: REPORT_WIDTH - PAD, y: 104, text: texts.filterLabel, size: 15, weight: 600, font: 'text', color: 'secondary', align: 'right', maxWidth: 200 });
  ops.push({ kind: 'rect', x: PAD, y: 122, w: 80, h: 3, fill: 'ink' });
  ops.push({ kind: 'rect', x: PAD + 80, y: 123, w: inner - 80, h: 1, fill: 'ink' });

  // Tuiles
  const tileTop = 148;
  const tileH = 84;
  const tileW = (inner - GAP * (texts.tiles.length - 1)) / Math.max(texts.tiles.length, 1);
  texts.tiles.forEach((tile, index) => {
    const x = PAD + index * (tileW + GAP);
    ops.push({ kind: 'rect', x, y: tileTop, w: tileW, h: tileH, radius: 14, fill: 'tile' });
    ops.push({ kind: 'text', x: x + 14, y: tileTop + 26, text: tile.label, size: 12, weight: 700, font: 'text', color: 'secondary', align: 'left', letterSpacing: 0.6, maxWidth: tileW - 28 });
    ops.push({ kind: 'text', x: x + 14, y: tileTop + 62, text: tile.value, size: 28, weight: 700, font: 'title', color: 'ink', align: 'left', maxWidth: tileW - 28, ...(tile.sub ? { suffix: tile.sub } : {}) });
  });

  // Graphique (colonne de gauche)
  const sectionTop = tileTop + tileH + 44;
  ops.push({ kind: 'text', x: PAD, y: sectionTop, text: texts.chartTitle, size: 13, weight: 700, font: 'text', color: 'secondary', align: 'left', letterSpacing: 1, maxWidth: column - 90 });
  ops.push({ kind: 'text', x: PAD + column, y: sectionTop, text: texts.monthRate, size: 13, weight: 700, font: 'text', color: 'ink', align: 'right' });
  const baseline = sectionTop + 34 + BAR_MAX;
  const barCount = Math.max(texts.bars.length, 1);
  const barGap = 14;
  const barW = (column - barGap * (barCount - 1)) / barCount;
  texts.bars.forEach((bar, index) => {
    const x = PAD + index * (barW + barGap);
    if (bar.percent === null) {
      ops.push({ kind: 'rect', x, y: baseline - 24, w: barW, h: 24, radius: 6, stroke: 'barEmpty', dashed: true });
      ops.push({ kind: 'text', x: x + barW / 2, y: baseline - 24 - 8, text: bar.valueLabel, size: 12, weight: 700, font: 'text', color: 'ink', align: 'center' });
    } else {
      const h = Math.max(2, Math.round((BAR_MAX * bar.percent) / 100));
      ops.push({ kind: 'rect', x, y: baseline - h, w: barW, h, topRadius: 6, fill: bar.current ? 'barCurrent' : 'bar' });
      ops.push({ kind: 'text', x: x + barW / 2, y: baseline - h - 8, text: bar.valueLabel, size: 12, weight: 700, font: 'text', color: 'ink', align: 'center' });
    }
    ops.push({ kind: 'text', x: x + barW / 2, y: baseline + 20, text: bar.label, size: 12, weight: bar.current ? 700 : 400, font: 'text', color: 'secondary', align: 'center' });
  });
  const leftEnd = baseline + 28;

  // Routines (colonne de droite)
  let rightEnd = sectionTop;
  if (texts.heatmap) {
    ops.push({ kind: 'text', x: rightX, y: sectionTop, text: texts.routinesTitle, size: 13, weight: 700, font: 'text', color: 'secondary', align: 'left', letterSpacing: 1, maxWidth: column });
    const cellW = (column - CELL_GAP * 6) / 7;
    const gridTop = sectionTop + 26;
    texts.weekdays.forEach((letter, index) => {
      ops.push({ kind: 'text', x: rightX + index * (cellW + CELL_GAP) + cellW / 2, y: gridTop, text: letter, size: 11, weight: 700, font: 'text', color: 'secondary', align: 'center' });
    });
    const cellsTop = gridTop + 8;
    texts.heatmap.cells.forEach((cell, index) => {
      const slot = texts.heatmap ? texts.heatmap.leadingBlanks + index : index;
      const x = rightX + (slot % 7) * (cellW + CELL_GAP);
      const y = cellsTop + Math.floor(slot / 7) * (CELL_H + CELL_GAP);
      const dashed = cell.state === 'upcoming';
      ops.push(
        cell.state === 'none' || dashed
          ? { kind: 'rect', x, y, w: cellW, h: CELL_H, radius: 6, stroke: 'border', dashed: true }
          : { kind: 'rect', x, y, w: cellW, h: CELL_H, radius: 6, fill: HEAT_COLOR[cell.state] },
      );
      ops.push({ kind: 'text', x: x + cellW / 2, y: y + 20, text: String(cell.day), size: 11, weight: 600, font: 'text', color: cell.state === 'none' || dashed ? 'secondary' : 'ink', align: 'center' });
    });
    const rows = Math.ceil((texts.heatmap.leadingBlanks + texts.heatmap.cells.length) / 7);
    let y = cellsTop + rows * (CELL_H + CELL_GAP) + 22;
    texts.rates.slice(0, MAX_RATE_ROWS).forEach((rate) => {
      ops.push({ kind: 'text', x: rightX, y, text: rate.title, size: 14, weight: 600, font: 'text', color: 'ink', align: 'left', maxWidth: column - 70 });
      ops.push({ kind: 'text', x: rightX + column, y, text: rate.value, size: 14, weight: 600, font: 'text', color: 'ink', align: 'right' });
      ops.push({ kind: 'rect', x: rightX, y: y + 10, w: column, h: 1, fill: 'border' });
      y += 30;
    });
    rightEnd = y;
  }

  const height = Math.ceil(Math.max(leftEnd, rightEnd) + 56);
  ops.push({ kind: 'text', x: PAD, y: height - 24, text: texts.footer, size: 11, weight: 400, font: 'text', color: 'secondary', align: 'left' });
  const first = ops[0];
  if (first?.kind === 'rect') ops[0] = { ...first, h: height };
  return { width: REPORT_WIDTH, height, ops };
}
