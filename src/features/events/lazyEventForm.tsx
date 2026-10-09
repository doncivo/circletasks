import { lazyScreen } from '../app/lazyScreens';
import type { EventFormProps } from './EventForm';

/**
 * Formulaire d'événement chargé à la demande (budget du bundle de départ, 350 Ko) : la feuille Ajout (segment Événement) et le panneau
 * de modification ne l'ouvrent qu'après un geste. `preloadScreens` le charge en arrière-plan après le premier rendu ; arrivé, il se rend
 * directement (sans repli), donc le focus du champ est posé dans le geste (Q-05).
 */
export const LazyEventForm = lazyScreen<EventFormProps>(() => import('./EventForm').then((module) => ({ default: module.EventForm })));
