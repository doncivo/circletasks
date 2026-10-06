import { createRoot } from 'react-dom/client';
import '../../../ui/theme/tokens.css';
import { openPairingPlatform } from './pairingPlatform';
import { PairingRoot } from './PairingView';

/**
 * Point d'entrée de la fenêtre dédiée `pairing` (`pairing.html`, Y-06 ; ADR 0011 section 2.1). Bundle minimal, contrôlé par
 * `npm run test:bundle` : React, les textes `sync.pairing`, `qrcode-generator` (à la demande), la plateforme réduite à trois méthodes.
 * Aucun store, aucun repository, aucun SQL, aucun plugin Tauri hors du cœur d'`invoke`, aucun journal.
 *
 * Pas de `StrictMode` ici : son double montage de développement appellerait `pairingPayload` deux fois, et le jeton de consentement
 * de Rust est à usage unique.
 */
const container = document.getElementById('root');
if (!container) throw new Error('Élément #root introuvable dans pairing.html');

// Aucun menu contextuel (Inspecter, Enregistrer sous, Imprimer la page) dans la fenêtre de la clé (audit 1) ; WebView2 le désactive
// aussi côté Rust.
document.addEventListener('contextmenu', (event) => event.preventDefault());

createRoot(container).render(<PairingRoot open={openPairingPlatform} />);
