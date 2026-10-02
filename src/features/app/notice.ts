import { create } from 'zustand';

/**
 * Message bref global (ES-02 « Ajouté dans Perso », « Action impossible à annuler ») affiché 5 s par `UndoToast`, au même endroit
 * que le bandeau « Annuler ». Un nouveau message remplace le précédent.
 */
export interface NoticeState {
  readonly notice: { readonly id: number; readonly text: string } | null;
  show(text: string): void;
  clear(): void;
}

let counter = 0;

export const useNoticeStore = create<NoticeState>()((set) => ({
  notice: null,
  show: (text) => set({ notice: { id: ++counter, text } }),
  clear: () => set({ notice: null }),
}));
