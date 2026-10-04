import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { FocusWindowRoot } from './features/focus';
import './ui/theme/tokens.css';

const container = document.getElementById('root');
if (!container) throw new Error('Élément #root introuvable dans index.html');

// Mini-fenêtre Focus du PC (F-01) : même application, vue seule, sans base ni conteneur.
const isFocusWindow = new URLSearchParams(window.location.search).get('window') === 'focus';

createRoot(container).render(<StrictMode>{isFocusWindow ? <FocusWindowRoot /> : <App />}</StrictMode>);
