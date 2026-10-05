import { registerCatalog } from '../../src/i18n';
import { en } from '../../src/i18n/en';

// PERF-02 : en production le catalogue anglais est chargé à la demande (src/i18n) ; les tests l'ont d'emblée.
registerCatalog('en', en);
