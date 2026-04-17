import { useEffect } from 'react';
import { Header } from '@/components/Header';
import { PhaseSidebar } from '@/components/PhaseSidebar';
import { PromptList } from '@/components/PromptList';
import { PromptViewer } from '@/components/PromptViewer';
import AutobuildV4Page from '@/pages/AutobuildV4Page';
import { useSSE } from '@/hooks/useSSE';
import { useRuns } from '@/hooks/useRuns';
import { useHashRoute } from '@/hooks/useHashRoute';
import { useDashboardStore } from '@/store/dashboard';
import { usePrompts } from '@/hooks/usePrompts';
import { cn } from '@/lib/cn';
import '@/styles/autobuild-v3.css';

export default function App() {
  useSSE();
  // Keep the rig snapshot warm at app root so SSE invalidations always hit an
  // already-mounted query. Without this, autobuild-only consumers would
  // remount the query on first open and miss in-flight events.
  useRuns();

  const viewerOpen = useDashboardStore((s) => s.viewerOpen);
  const selectedPromptId = useDashboardStore((s) => s.selectedPromptId);
  const setSelectedPromptId = useDashboardStore((s) => s.setSelectedPromptId);
  const closeViewer = useDashboardStore((s) => s.closeViewer);
  const selectedRunId = useDashboardStore((s) => s.selectedRunId);
  const setSelectedRunId = useDashboardStore((s) => s.setSelectedRunId);

  // Hash routing — v4 is the canonical Autobuild surface. `#/autobuild-v4`,
  // `#/autobuild`, and the empty default route all land on it. `#/phases`
  // (or any other non-empty non-autobuild route) falls back to the legacy
  // phases browser.
  const { route } = useHashRoute();
  const onAutobuildV4 =
    route === 'autobuild-v4' || route === 'autobuild' || route === '';

  const { data: prompts } = usePrompts();

  // Keyboard shortcuts:
  //   j / k : navigate prompts
  //   esc   : close viewer / run-log modal
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }
      if (e.key === 'Escape') {
        if (selectedRunId) {
          setSelectedRunId(null);
          return;
        }
        if (viewerOpen) closeViewer();
        return;
      }
      if (!prompts || prompts.length === 0) return;
      if (e.key === 'j' || e.key === 'k') {
        e.preventDefault();
        const idx = selectedPromptId ? prompts.findIndex((p) => p.id === selectedPromptId) : -1;
        let next = idx;
        if (e.key === 'j') next = idx < 0 ? 0 : Math.min(prompts.length - 1, idx + 1);
        if (e.key === 'k') next = idx < 0 ? 0 : Math.max(0, idx - 1);
        const target = prompts[next];
        if (target) setSelectedPromptId(target.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    prompts,
    selectedPromptId,
    viewerOpen,
    selectedRunId,
    setSelectedPromptId,
    closeViewer,
    setSelectedRunId,
  ]);

  return (
    <div className="flex flex-col h-screen">
      <Header />
      {onAutobuildV4 ? (
        // Canonical autobuild surface — single scroll, no tabs.
        <AutobuildV4Page />
      ) : (
        <div className="flex-1 flex overflow-hidden">
          <aside className="w-[260px] shrink-0 border-r hairline overflow-y-auto">
            <PhaseSidebar />
          </aside>
          <main className="flex-1 overflow-y-auto">
            <PromptList />
          </main>
          <aside
            className={cn(
              'shrink-0 border-l hairline overflow-hidden transition-[width] duration-200 ease-out',
              viewerOpen ? 'w-[520px]' : 'w-0',
            )}
            aria-hidden={!viewerOpen}
          >
            {viewerOpen && <PromptViewer />}
          </aside>
        </div>
      )}
    </div>
  );
}
