import { loadAbsoluteDates } from '../../src/features/capture/absoluteDatesLoader';

// PERF-02 : en production l'analyseur des dates écrites (chrono-node) est chargé à la demande ; les tests des features l'ont d'emblée.
// Le domaine reste pur : ses tests passent `chronoAbsoluteParser` eux-mêmes.
await loadAbsoluteDates();
