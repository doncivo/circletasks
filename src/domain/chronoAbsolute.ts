import * as chrono from 'chrono-node/fr';
import type { AbsoluteDateMatch, AbsoluteDateParser } from './naturalDate';

/**
 * Enveloppe de chrono-node (locale fr, MIT) pour les dates écrites (Q-02). Seul fichier qui importe la bibliothèque : si elle change,
 * il est le seul à bouger. Pur. Il est chargé à la demande par `src/features/capture/absoluteDatesLoader.ts (état, sans React) et useAbsoluteDateParser.ts (hook)` (PERF-02) et jamais importé
 * statiquement par le code du démarrage ; les tests du domaine le passent à `naturalDate` (option `absoluteDates`).
 */
const parts = (c: { get(component: 'year' | 'month' | 'day'): number | null }): { year: number | null; month: number | null; day: number | null } => ({
  year: c.get('year'),
  month: c.get('month'),
  day: c.get('day'),
});

export const chronoAbsoluteParser: AbsoluteDateParser = (text, reference) =>
  chrono.parse(text, reference, { forwardDate: true }).map(
    (result): AbsoluteDateMatch => ({
      index: result.index,
      text: result.text,
      certain: result.start.isCertain('day') && result.start.isCertain('month'),
      start: parts(result.start),
      end: result.end ? parts(result.end) : null,
    }),
  );
