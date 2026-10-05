import { chronoAbsoluteParser } from '../../src/domain/chronoAbsolute';
import { registerAbsoluteDateParser } from '../../src/domain/naturalDate';

// PERF-02 : en production l'analyseur des dates écrites est chargé à la demande ; les tests le posent d'emblée, comme avant.
registerAbsoluteDateParser(chronoAbsoluteParser);
