import { create } from "zustand";

interface DashboardState {
  selectedPromptId: string | null;
  viewerOpen: boolean;
  sseConnected: boolean;
  lastLogUpdate: Date | null;
  collapsedPhases: Set<number>;

  // ---- Autobuild slice (v4) ----
  /** Currently-focused run id on the autobuild page (if any). */
  selectedRunId: string | null;

  setSelectedPromptId: (id: string | null) => void;
  closeViewer: () => void;
  openViewer: () => void;
  setSseConnected: (connected: boolean) => void;
  setLastLogUpdate: (d: Date) => void;
  togglePhaseCollapsed: (phase: number) => void;
  expandAllPhases: () => void;

  setSelectedRunId: (id: string | null) => void;
}

export const useDashboardStore = create<DashboardState>((set) => ({
  selectedPromptId: null,
  viewerOpen: false,
  sseConnected: false,
  lastLogUpdate: null,
  collapsedPhases: new Set<number>(),

  selectedRunId: null,

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

  setSelectedRunId: (id) => set({ selectedRunId: id }),
}));
