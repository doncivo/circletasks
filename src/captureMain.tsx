import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MiniCapture } from './features/capture/MiniCapture';
import { setCatalogFailureReporter } from './i18n';
import { logFailure } from './platform';
import { openCaptureWindowBridge } from './platform/capture';
import './ui/theme/tokens.css';

/**
 * Point d'entrée de la mini-fenêtre de capture rapide (Q-01, `capture.html`). Aucune base de données ici : le texte part vers la fenêtre
 * principale, seule à écrire (src/platform/capture).
 */
// Catalogues de langue chargés à la demande (PERF-02) : un échec est journalisé, le français sert de repli.
setCatalogFailureReporter((locale, error) => logFailure(`catalog-${locale}`, error));

const container = document.getElementById('root');
if (!container) throw new Error('Élément #root introuvable dans capture.html');

createRoot(container).render(
  <StrictMode>
    <MiniCapture bridge={openCaptureWindowBridge()} />
  </StrictMode>,
);
