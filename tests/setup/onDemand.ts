import { chronoAbsoluteParser } from '../../src/domain/chronoAbsolute';
import { registerAbsoluteDateParser } from '../../src/domain/naturalDate';
import { registerCatalog } from '../../src/i18n';
import { en } from '../../src/i18n/en';

// PERF-02 : en production l'analyseur des dates écrites et le catalogue anglais sont chargés à la demande ; les tests les posent d'emblée.
registerAbsoluteDateParser(chronoAbsoluteParser);
registerCatalog('en', en);
