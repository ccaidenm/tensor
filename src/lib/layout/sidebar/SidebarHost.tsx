import { type ReactNode, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowLeftToLine, ArrowRightToLine, GripHorizontal } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from 'cn';
import { useSidebarStore, type SidebarAnchor } from '@/lib/layout/sidebarStore';
import { useImperativeSlide } from '@/lib/layout/useImperativeSlide';
import { useReducedMotion } from '@/lib/accessibility/useReducedMotion';
import { useConfigStore } from '@/lib/config/store';

// #101 — the resize bounds: the min keeps panel content usable, the
// max leaves the document half the desk.
const SIDEBAR_MIN_WIDTH = 280;
const SIDEBAR_MAX_WIDTH = 640;
const SIDEBAR_DEFAULT_WIDTH = 384;
// The BOTTOM anchor is height-based: its own default + clamp band (the
// per-sidebar memory stores the height under the same record).
const SIDEBAR_MIN_BOTTOM_HEIGHT = 160;
const SIDEBAR_MAX_BOTTOM_HEIGHT = 640;
const SIDEBAR_DEFAULT_BOTTOM_HEIGHT = 288;
// The edge band that claims a floating drag (px, per desk edge).
const DOCK_ZONE_BAND = 120;

/**
 * #101 — the pointer's dock target during a floating drag: edge bands of
 * 120px (bottom wins the corner overlap), null = no zone (snap back). A
 * zero-rect (jsdom) yields null.
 */
export function zoneForPointer(
  x: number,
  y: number,
  rect: { left: number; top: number; width: number; height: number },
): SidebarAnchor | null {
  if (rect.width === 0 || rect.height === 0) return null;
  if (y > rect.top + rect.height - DOCK_ZONE_BAND) return 'bottom';
  if (x < rect.left + DOCK_ZONE_BAND) return 'left';
  if (x > rect.left + rect.width - DOCK_ZONE_BAND) return 'right';
  return null;
}

// TODO: re-enable the animated slide once the WebKitGTK reflow-thrash is
// resolved; the initial-value branch must then handle a hidden ancestor's
// offsetWidth 0 (read as -0, docking the panel visibly).
const SIDEBAR_ANIMATION_DISABLED = true;

const ANCHOR_POSITION_CLASS: Record<SidebarAnchor, string> = {
  // #101 — the width is inline (the stored/live value; 384 when unmemoried)
  // so the drag handle can retune it without fighting a Tailwind class.
  left: 'inset-y-0 border-r',
  right: 'inset-y-0 border-l',
  bottom: 'inset-x-0 border-t',
};

interface SidebarHostProps {
  id: string;
  anchor: SidebarAnchor;
  children: ReactNode;
}

/**
 * Generic docked-panel chrome. Must render inside a positioned ancestor
 * bounded to exactly the area it should occupy (the App.tsx wrapper
 * between the Ribbon and StatusBar).
 */
export function SidebarHost({ id, anchor: anchorProp, children }: SidebarHostProps) {
  const active = useSidebarStore((s) => s.active);
  // #101 — the anchor is per-sidebar state (the store's memory, seeded by
  // this prop): a redocked panel renders on its new edge, no re-mount.
  const anchor = useSidebarStore((s) => s.anchors[id]) ?? anchorProp;
  const dock = useSidebarStore((s) => s.dock);
  const isOpen = active?.id === id;
  const ref = useRef<HTMLDivElement>(null);

  const prefersReducedMotion = useReducedMotion();

  // #101 — the stored size (per-sidebar memory) seeds the panel; a drag
  // live-resizes via local state and commits to the config on release.
  // Width for left/right docks, height for bottom (the same record).
  const storedWidth = useConfigStore((s) => s.config.sidebarWidths[id]);
  const setSidebarWidth = useConfigStore((s) => s.setSidebarWidth);
  const [liveSize, setLiveSize] = useState<number | null>(null);
  const [resizing, setResizing] = useState(false);
  const horizontal = anchor === 'left' || anchor === 'right';
  const size = horizontal
    ? (liveSize ?? storedWidth ?? SIDEBAR_DEFAULT_WIDTH)
    : (liveSize ?? storedWidth ?? SIDEBAR_DEFAULT_BOTTOM_HEIGHT);

  const resizeStateRef = useRef<{ startA: number; startSize: number } | null>(null);

  function onHandleDown(e: React.PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    resizeStateRef.current = {
      startA: horizontal ? e.clientX : e.clientY,
      startSize: size,
    };
    setResizing(true);
  }

  function onHandleMove(e: React.PointerEvent) {
    const drag = resizeStateRef.current;
    if (!drag) return;
    // The dock edge is the resize edge: right-anchored — the handle is
    // on the LEFT edge (dragging left widens); left-anchored — mirrored;
    // bottom-anchored — the handle is on the TOP edge (dragging up grows).
    const delta = horizontal
      ? (anchor === 'right' ? drag.startA - e.clientX : e.clientX - drag.startA)
      : drag.startA - e.clientY;
    const bounds = horizontal
      ? { min: SIDEBAR_MIN_WIDTH, max: SIDEBAR_MAX_WIDTH }
      : { min: SIDEBAR_MIN_BOTTOM_HEIGHT, max: SIDEBAR_MAX_BOTTOM_HEIGHT };
    setLiveSize(Math.min(bounds.max, Math.max(bounds.min, drag.startSize + delta)));
  }

  function onHandleUp() {
    resizeStateRef.current = null;
    setResizing(false);
    setLiveSize((s) => {
      if (s != null) setSidebarWidth(id, s);
      return null; // fall back to the (just-committed) stored size
    });
  }

  // #101 — the grip strip floats the panel (pointer-following); the
  // release docks into the hovered zone (no zone = snap back).
  const [float, setFloat] = useState<{ x: number; y: number } | null>(null);
  const [dockHint, setDockHint] = useState<SidebarAnchor | null>(null);
  const floatRef = useRef<{ dx: number; dy: number } | null>(null);
  const deskRectRef = useRef<DOMRect | null>(null);
  const panelRectRef = useRef<{ w: number; h: number } | null>(null);

  function onGripDown(e: React.PointerEvent) {
    if (e.button !== 0 || !ref.current) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    const panelRect = ref.current.getBoundingClientRect();
    const desk = ref.current.parentElement?.getBoundingClientRect() ?? null;
    deskRectRef.current = desk;
    panelRectRef.current = { w: panelRect.width, h: panelRect.height };
    floatRef.current = {
      dx: e.clientX - panelRect.left,
      dy: e.clientY - panelRect.top,
    };
    setFloat({ x: panelRect.left, y: panelRect.top });
  }

  function onGripMove(e: React.PointerEvent) {
    const grab = floatRef.current;
    if (!grab) return;
    setFloat({ x: e.clientX - grab.dx, y: e.clientY - grab.dy });
    const desk = deskRectRef.current;
    if (desk) setDockHint(zoneForPointer(e.clientX, e.clientY, desk));
  }

  function onGripUp(e: React.PointerEvent) {
    floatRef.current = null;
    const desk = deskRectRef.current;
    const zone = desk ? zoneForPointer(e.clientX, e.clientY, desk) : null;
    setFloat(null);
    setDockHint(null);
    deskRectRef.current = null;
    panelRectRef.current = null;
    // No zone = the snap back (the panel redocks where it came from).
    dock(id, zone ?? anchor);
  }

  useImperativeSlide({
    ref,
    isOpen,
    anchor,
    reduceMotion: prefersReducedMotion || SIDEBAR_ANIMATION_DISABLED,
  });

  return (
    <div
      ref={ref}
      className={cn(
        // z-40: docked panels must clear the ruler bar (a z-30 portal
        // that mounts after the SidebarHosts — DOM order made the ruler
        // paint over the panels). Panel-internal dropdowns nest beneath.
        float
          ? // #101 — the float: pointer-following fixed chrome, off the
            // dock grid (anchor classes and slide offsets bypassed; the
            // dock zones below own the next position).
            'fixed z-50 flex flex-col bg-background border shadow-xl rounded-lg overflow-hidden'
          : 'absolute z-40 flex flex-col bg-background border-border',
        float ? null : ANCHOR_POSITION_CLASS[anchor],
        // #103 — a closed panel is invisible: the host mounts while the
        // desk is display:none (offsetWidth 0 parks the panel visibly);
        // visibility (not display) keeps the element laid out for the slide.
        !isOpen && !float && 'invisible pointer-events-none',
      )}
      style={
        float
          ? {
              left: `${float.x}px`,
              top: `${float.y}px`,
              width: `${horizontal ? size : panelRectRef.current?.w ?? size}px`,
              height: `${panelRectRef.current?.h ?? SIDEBAR_DEFAULT_BOTTOM_HEIGHT}px`,
            }
          : horizontal
            ? { width: `${size}px` }
            : { height: `${size}px` }
      }
      aria-hidden={!isOpen && !float}
    >
      {/* #101 — the grip strip: the redock handle. Pointer users grab it
          (the panel floats; release docks into the hovered zone);
          reduced-motion users click it (a tiny redock menu instead). */}
      {isOpen &&
        (prefersReducedMotion ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <div
                  data-testid={`sidebar-grip-${id}`}
                  aria-label={`Move ${id} panel`}
                  className="flex h-6 flex-none cursor-pointer items-center justify-center text-muted-foreground/50 select-none hover:bg-muted/50"
                >
                  <GripHorizontal size={14} />
                </div>
              }
            />
            <DropdownMenuContent align="start" className="w-40">
              {(
                [
                  { anchor: 'left', label: 'Dock left', icon: ArrowLeftToLine },
                  { anchor: 'bottom', label: 'Dock bottom', icon: ArrowDownToLine },
                  { anchor: 'right', label: 'Dock right', icon: ArrowRightToLine },
                ] as const
              ).map((option) => (
                <DropdownMenuItem
                  key={option.anchor}
                  disabled={option.anchor === anchor}
                  onClick={() => dock(id, option.anchor)}
                >
                  <option.icon size={14} className="text-muted-foreground" />
                  {option.label}
                  {option.anchor === anchor && (
                    <span className="ml-auto text-xs text-muted-foreground">current</span>
                  )}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <div
            data-testid={`sidebar-grip-${id}`}
            aria-label={`Move ${id} panel`}
            className={cn(
              'flex h-6 flex-none items-center justify-center text-muted-foreground/50 select-none touch-none',
              float ? 'cursor-grabbing bg-muted/50 text-muted-foreground' : 'cursor-grab hover:bg-muted/50',
            )}
            onPointerDown={onGripDown}
            onPointerMove={onGripMove}
            onPointerUp={onGripUp}
            onPointerCancel={onGripUp}
          >
            <GripHorizontal size={14} />
          </div>
        ))}
      {children}
      {/* #101 — the resize handle: a strip on the dock edge; pointer
          capture keeps the drag alive outside it. Not while floating
          (the dock position is undecided mid-drag). */}
      {horizontal && isOpen && !float && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={`Resize ${id} panel`}
          data-testid={`sidebar-resize-${id}`}
          className={cn(
            'absolute inset-y-0 z-10 w-1.5 cursor-ew-resize select-none',
            anchor === 'right' ? 'left-0' : 'right-0',
            resizing ? 'bg-primary/60' : 'bg-transparent hover:bg-primary/30',
          )}
          onPointerDown={onHandleDown}
          onPointerMove={onHandleMove}
          onPointerUp={onHandleUp}
          onPointerCancel={onHandleUp}
          onDoubleClick={() => {
            // Word's posture: double-click returns the panel to its
            // default size (the memory clears).
            setSidebarWidth(id, SIDEBAR_DEFAULT_WIDTH);
          }}
        />
      )}
      {/* #101 — the bottom variant: the handle rides the top edge (a
          horizontal strip, ns-resize — dragging up grows the panel). */}
      {anchor === 'bottom' && isOpen && !float && (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label={`Resize ${id} panel`}
          data-testid={`sidebar-resize-${id}`}
          className={cn(
            'absolute inset-x-0 top-0 z-10 h-1.5 cursor-ns-resize select-none',
            resizing ? 'bg-primary/60' : 'bg-transparent hover:bg-primary/30',
          )}
          onPointerDown={onHandleDown}
          onPointerMove={onHandleMove}
          onPointerUp={onHandleUp}
          onPointerCancel={onHandleUp}
          onDoubleClick={() => setSidebarWidth(id, SIDEBAR_DEFAULT_BOTTOM_HEIGHT)}
        />
      )}
      {/* #101 — the dock zones: fixed overlays over the desk's edge
          bands, lit while floating (the release target's preview). */}
      {float &&
        (
          [
            { zone: 'left', class: 'left-0 inset-y-0 w-[120px]' },
            { zone: 'right', class: 'right-0 inset-y-0 w-[120px]' },
            { zone: 'bottom', class: 'bottom-0 inset-x-0 h-[120px]' },
          ] as const
        ).map(({ zone, class: zoneClass }) => (
          <div
            key={zone}
            aria-hidden="true"
            className={cn(
              'pointer-events-none fixed z-40',
              zoneClass,
              dockHint === zone ? 'bg-primary/10 border-2 border-dashed border-primary/40' : 'bg-transparent',
            )}
          />
        ))}
    </div>
  );
}
