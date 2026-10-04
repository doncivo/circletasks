import { describe, expect, it } from 'vitest';
import { REPORT_WIDTH, reportLayout, type ReportOp, type ReportTexts } from './reportLayout';

function texts(overrides: Partial<ReportTexts> = {}): ReportTexts {
  return {
    caption: 'Rapport du mois',
    title: 'Septembre',
    filterLabel: 'Espace : Tout',
    tiles: [
      { label: 'TÂCHES FAITES', value: '48', sub: '/ 61' },
      { label: 'ROUTINES', value: '76 %' },
      { label: 'FOCUS', value: '14 h 20' },
      { label: 'OBJECTIFS', value: '2', sub: '/ 3 atteints' },
    ],
    chartTitle: 'TAUX DE COMPLÉTION PAR SEMAINE',
    monthRate: 'Mois : 79 %',
    bars: [
      { label: 'S36', valueLabel: '71 %', percent: 71, current: false },
      { label: 'S37', valueLabel: '84 %', percent: 84, current: false },
      { label: 'S38', valueLabel: '—', percent: null, current: false },
      { label: 'S39', valueLabel: '62 %', percent: 62, current: true },
    ],
    routinesTitle: 'ROUTINES — JOURS COMPLÉTÉS',
    weekdays: ['L', 'M', 'M', 'J', 'V', 'S', 'D'],
    heatmap: { leadingBlanks: 1, cells: Array.from({ length: 30 }, (_, i) => ({ day: i + 1, state: i % 3 === 0 ? ('all' as const) : ('none' as const) })) },
    rates: [
      { title: 'Faire mon lit', value: '93 %' },
      { title: 'Sport', value: '70 %' },
    ],
    footer: 'CircleTasks',
    ...overrides,
  };
}

const textsOf = (ops: readonly ReportOp[]): string[] => ops.flatMap((op) => (op.kind === 'text' ? [op.text] : []));

describe('reportLayout (H-03 critères 5 et 6)', () => {
  const layout = reportLayout(texts());

  it('reprend titre, tuiles, graphique, carte de chaleur et taux des routines', () => {
    const all = textsOf(layout.ops);
    for (const expected of ['Rapport du mois', 'Septembre', 'TÂCHES FAITES', '48', '14 h 20', 'TAUX DE COMPLÉTION PAR SEMAINE', 'Mois : 79 %', 'S39', 'ROUTINES — JOURS COMPLÉTÉS', 'Sport', '70 %']) {
      expect(all).toContain(expected);
    }
    expect(layout.ops.filter((op) => op.kind === 'text' && /^\d+$/.test(op.text) && op.size === 11)).toHaveLength(30);
  });

  it('les barres sont proportionnelles (120 au plus), la courante en couleur d’accent, la vide en pointillé', () => {
    const rects = layout.ops.filter((op) => op.kind === 'rect' && (op.topRadius !== undefined || op.dashed === true && op.stroke === 'barEmpty'));
    const heights = rects.map((op) => (op.kind === 'rect' ? Math.round(op.h) : 0));
    expect(heights).toEqual([85, 101, 24, 74]);
    expect(heights.every((h) => h <= 120)).toBe(true);
    const fills = layout.ops.filter((op) => op.kind === 'rect' && op.topRadius !== undefined).map((op) => (op.kind === 'rect' ? op.fill : undefined));
    expect(fills).toEqual(['bar', 'bar', 'barCurrent']);
  });

  it('tout reste dans la grille de 880 unités et sous la hauteur calculée', () => {
    expect(layout.width).toBe(REPORT_WIDTH);
    for (const op of layout.ops) {
      if (op.kind === 'rect') {
        expect(op.x).toBeGreaterThanOrEqual(0);
        expect(op.x + op.w).toBeLessThanOrEqual(REPORT_WIDTH + 0.01);
        expect(op.y + op.h).toBeLessThanOrEqual(layout.height);
      } else {
        expect(op.y).toBeLessThanOrEqual(layout.height);
      }
    }
  });

  it('sans routine (filtre de projet) : pas de carte, graphique seul', () => {
    const noRoutines = reportLayout(texts({ heatmap: null, rates: [] }));
    expect(textsOf(noRoutines.ops)).not.toContain('ROUTINES — JOURS COMPLÉTÉS');
    expect(noRoutines.height).toBeLessThan(layout.height);
  });

  it('au plus dix taux de routine', () => {
    const many = reportLayout(texts({ rates: Array.from({ length: 25 }, (_, i) => ({ title: `Routine ${String(i)}`, value: '50 %' })) }));
    expect(textsOf(many.ops).filter((text) => text.startsWith('Routine '))).toHaveLength(10);
  });
});
