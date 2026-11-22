import { useEffect, useRef, useState } from 'react';
import { Minimize } from 'lucide-react';
import { IconButton } from '@/components/layout/IconButton';
import { getCommand } from '@/lib/commands/registry';
import { useFocusStore } from '@/lib/layout/focusStore';

/** How long the exit button stays visible after entering Focus Mode
 *  before fading out ("disappears after a few seconds"). */
const EXIT_REVEAL_MS = 3000;
/** The corner hover zone (right × top, px): moving the pointer in here
 *  brings the exit button back after it faded. */
const CORNER_WIDTH = 200;
const CORNER_HEIGHT = 80;

/**
 * Focus Mode's floating exit button: reveals on entry, fades after a few
 * seconds, returns on top-right corner hover. Stays mounted so the fade
 * animates without a remount; the a11y tree only sees the revealed one.
 */
export function ExitFocusButton() {
  const focusActive = useFocusStore((s) => s.active);
  const [revealed, setRevealed] = useState(false);
  // Plain setTimeout, not window.setTimeout — in jsdom only the global is fake-timer-patched.
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!focusActive) {
      setRevealed(false);
      return;
    }
    setRevealed(true);
    hideTimer.current = setTimeout(() => setRevealed(false), EXIT_REVEAL_MS);
    // Corner tracking via mousemove — an overlay div would swallow document clicks.
    const onMove = (e: MouseEvent) => {
      const inCorner =
        e.clientX > window.innerWidth - CORNER_WIDTH && e.clientY < CORNER_HEIGHT;
      if (inCorner) {
        if (hideTimer.current !== null) {
          clearTimeout(hideTimer.current);
          hideTimer.current = null;
        }
        setRevealed(true);
      } else {
        setRevealed(false);
      }
    };
    window.addEventListener('mousemove', onMove);
    return () => {
      window.removeEventListener('mousemove', onMove);
      if (hideTimer.current !== null) clearTimeout(hideTimer.current);
    };  }, [focusActive]);

  if (!focusActive) return null;

  return (
    <IconButton
      label="Exit focus mode"
      icon={<Minimize size={16} />}
      shortcutId="toggleFocusMode"
      onClick={() => void getCommand('toggleFocusMode')?.run()}
      data-testid="focus-exit-button"
      aria-hidden={!revealed}
      tabIndex={revealed ? 0 : -1}
      // z-[100] — the toast tier, the top of the scale: the exit must never be covered.
      className={`fixed top-2 right-3 z-[100] transition-opacity duration-300 ${
        revealed ? 'opacity-100' : 'pointer-events-none opacity-0'
      }`}
    />
  );
}
