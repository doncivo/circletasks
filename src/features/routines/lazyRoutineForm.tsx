import { lazyScreen } from '../app/lazyScreens';
import type { RoutineFormProps } from './RoutineForm';

/** Formulaire de routine chargé à la demande (feuille Ajout, segment Routine) : même règle que `LazyEventForm`. */
export const LazyRoutineForm = lazyScreen<RoutineFormProps>(() => import('./RoutineForm').then((module) => ({ default: module.RoutineForm })));
