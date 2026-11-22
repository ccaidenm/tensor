import { create } from 'zustand';

interface FontBrowserStore {
  isOpen: boolean;
  selectedId: string | null;
  open: () => void;
  close: () => void;
  select: (id: string) => void;
}

/** Shared home of the Font Browser dialog: both the Font group's
 *  Browse action and the palette command open it. */
export const useFontBrowserStore = create<FontBrowserStore>((set) => ({
  isOpen: false,
  selectedId: null,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
  select: (id) => set({ selectedId: id }),
}));
