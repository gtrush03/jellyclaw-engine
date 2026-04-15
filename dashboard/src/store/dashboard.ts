import { create } from 'zustand';

interface DashboardState {
  selectedPromptId: string | null;
  viewerOpen: boolean;
  sseConnected: boolean;
  lastLogUpdate: Date | null;
  collapsedPhases: Set<number>;

  setSelectedPromptId: (id: string | null) => void;
  closeViewer: () => void;
  openViewer: () => void;
  setSseConnected: (connected: boolean) => void;
  setLastLogUpdate: (d: Date) => void;
  togglePhaseCollapsed: (phase: number) => void;
  expandAllPhases: () => void;
}

export const useDashboardStore = create<DashboardState>((set) => ({
  selectedPromptId: null,
  viewerOpen: false,
  sseConnected: false,
  lastLogUpdate: null,
  collapsedPhases: new Set<number>(),

  setSelectedPromptId: (id) =>
    set(() => ({
      selectedPromptId: id,
      viewerOpen: id !== null,
    })),
  closeViewer: () => set({ viewerOpen: false }),
  openViewer: () => set({ viewerOpen: true }),
  setSseConnected: (connected) => set({ sseConnected: connected }),
  setLastLogUpdate: (d) => set({ lastLogUpdate: d }),
  togglePhaseCollapsed: (phase) =>
    set((state) => {
      const next = new Set(state.collapsedPhases);
      if (next.has(phase)) next.delete(phase);
      else next.add(phase);
      return { collapsedPhases: next };
    }),
  expandAllPhases: () => set({ collapsedPhases: new Set<number>() }),
}));
