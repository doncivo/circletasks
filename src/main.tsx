import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { startLogJournal } from './features/app/logJournalBoot';
import { FocusWindowRoot } from './features/focus';
import { setCatalogFailureReporter } from './i18n';
import { logFailure } from './platform';
import './ui/theme/tokens.css';

const container = document.getElementById('root');
if (!container) throw new Error('Élément #root introuvable dans index.html');

// Catalogues de langue chargés à la demande (PERF-02) : un échec de chargement est journalisé, le français sert de repli.
setCatalogFailureReporter((locale, error) => logFailure(`catalog-${locale}`, error));

// Mini-fenêtre Focus du PC (F-01) : même application, vue seule, sans base ni conteneur.
const isFocusWindow = new URLSearchParams(window.location.search).get('window') === 'focus';

// I-04 : journal technique persistant (fichier pour la fenêtre principale seulement), chargé à la demande.
void startLogJournal(isFocusWindow ? 'focus' : 'main');

createRoot(container).render(<StrictMode>{isFocusWindow ? <FocusWindowRoot /> : <App />}</StrictMode>);
