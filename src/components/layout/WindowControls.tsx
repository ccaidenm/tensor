import { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Copy, Minus, Square, X } from 'lucide-react';
import { inTauriWindow } from '@/lib/window/tauriEnv';

/**
 * #100 — the custom window controls: the far-right lane of the merged
 * titlebar row (the Ribbon's h-10 strip). macOS NEVER mounts these —
 * its native traffic lights overlay the row's left lane instead
 * (titleBarStyle: Overlay; the layout branch lives in Ribbon).
 *
 * The MAXIMIZE/RESTORE glyph tracks the live window state (onResized →
 * isMaximized) so the icon always tells the truth — including the
 * double-click-to-maximize on the drag regions and the OS's own
 * keyboard shortcuts. All calls gate on inTauriWindow (a plain-browser
 * dev session renders inert buttons instead of throwing).
 */

export function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!inTauriWindow()) return;
    const win = getCurrentWindow();
    let unlisten: (() => void) | null = null;
    let disposed = false;
    const readMaximized = () => {
      void win.isMaximized().then((m) => {
        if (!disposed) setMaximized(m);
      });
    };
    readMaximized();
    void win
      .onResized(() => readMaximized())
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const minimize = () => {
    if (inTauriWindow()) void getCurrentWindow().minimize();
  };
  const toggleMaximize = () => {
    if (inTauriWindow()) void getCurrentWindow().toggleMaximize();
  };
  const close = () => {
    if (inTauriWindow()) void getCurrentWindow().close();
  };

  const buttonClass =
    'flex h-10 w-11 flex-none items-center justify-center text-muted-foreground transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset hover:bg-muted hover:text-foreground';

  return (
    <div className="flex h-10 flex-none items-stretch" role="group" aria-label="Window controls">
      <button
        type="button"
        aria-label="Minimize"
        data-testid="window-minimize"
        className={buttonClass}
        onClick={minimize}
      >
        <Minus size={14} />
      </button>
      <button
        type="button"
        aria-label={maximized ? 'Restore' : 'Maximize'}
        data-testid="window-maximize"
        className={buttonClass}
        onClick={toggleMaximize}
      >
        {/* Maximized: the two overlapping squares (restore); else one. */}
        {maximized ? <Copy size={12} /> : <Square size={12} />}
      </button>
      <button
        type="button"
        aria-label="Close"
        data-testid="window-close"
        // The close hover: the universal destructive red with WHITE ink
        // (the muted ink on red read as black-on-red — the user's call).
        className="flex h-10 w-11 flex-none items-center justify-center text-muted-foreground transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset hover:bg-destructive hover:text-white"
        onClick={close}
      >
        <X size={14} />
      </button>
    </div>
  );
}
