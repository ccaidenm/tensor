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

// #101 — DRAGGABLE SIDEBARS: the dock-edge handle's resize bounds.
// The min keeps every panel's content usable (the narrowest consumer
// is the statistics dashboard); the max leaves the document half the
// desk (Word's task-pane posture — the page must stay the star).
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
 * #101 — THE ZONE LAW (pure, exported for the unit tests): the
 * pointer's dock target during a floating drag — edge bands of 120px
 * (bottom wins the corner overlap), null = no zone (snap back). A
 * zero-rect (jsdom's getBoundingClientRect) yields null — the grip's
 * release keeps the panel where it came from.
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

// TODO(#NN): re-enable the animated slide once the WebKitGTK
// layout-thrash issue is resolved. Animating a real box-offset property
// (right/left/bottom, required to avoid an earlier, worse transform-based
// race — see useImperativeSlide's doc comment for the full history)
// forces a real reflow every frame, which was observed to visibly jostle
// the document's own page-centering mid-animation — a symptom of this
// project's already-known pagination layout fragility (see #45), not a
// new bug in the sidebar itself. Shipping instant open/close for now
// makes that entire bug family structurally impossible rather than
// chasing a fifth timing fix. Revisit once smooth animation can be
// tested against a less reflow-sensitive layout, and/or on
// non-WebKitGTK platforms. WHEN ANIMATION RETURNS: the closed panel
// must keep hiding via visibility (see the ghost fix below) — and the
// slide's initial-value branch must handle a NOT-YET-LAID-OUT element
// (offsetWidth 0 under a hidden ancestor read as -0 and docked the
// panel visibly — the same bug through the animation path).
const SIDEBAR_ANIMATION_DISABLED = true;

const ANCHOR_POSITION_CLASS: Record<SidebarAnchor, string> = {
  // #101 — the WIDTH is no longer a class: it is inline (the stored/
  // live-resized value; 384 when unmemoried) so the drag handle can
  // retune it without fighting a Tailwind class.
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
 * Generic docked-panel chrome. Must be rendered inside a `relative`
 * (or otherwise positioned) ancestor bounded to exactly the area it
 * should occupy — in practice, the wrapper in App.tsx spanning the space
 * between the Ribbon and StatusBar.
 */
export function SidebarHost({ id, anchor: anchorProp, children }: SidebarHostProps) {
  const active = useSidebarStore((s) => s.active);
  // #101 — DRAG-TO-REDOCK: the anchor is PER-SIDEBAR STATE (the store's
  // memory, seeded by this prop) — a redocked panel renders on its NEW
  // edge without the App re-mounting anything.
  const anchor = useSidebarStore((s) => s.anchors[id]) ?? anchorProp;
  const dock = useSidebarStore((s) => s.dock);
  const isOpen = active?.id === id;
  const ref = useRef<HTMLDivElement>(null);

  const prefersReducedMotion = useReducedMotion();

  // #101 — DRAGGABLE SIDEBARS: the stored width (per-sidebar memory)
  // seeds the panel; a drag live-resizes via local state and COMMITS
  // to the config on release (the persistence debounce writes it).
  // #101 — the per-sidebar size memory: WIDTH for left/right docks,
  // HEIGHT for the bottom dock (the same record, the anchor decides
  // which axis it drives).
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

  // #101 — DRAG-TO-REDOCK: the grip strip floats the panel (fixed,
  // pointer-following); dock zones light up at the desk's edges; the
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
        // M-T4 — z-40: docked panels are FLOATING chrome and must clear
        // the M-RULER bar (a portal that mounts AFTER the SidebarHosts
        // in the same stacking context at z-30 — DOM order made the
        // ruler win, painting over the Find/Replace and Table panels).
        // Panel-internal dropdowns (z-40) nest fine beneath this.
        float
          ? // #101 — THE FLOAT: the panel is pointer-following fixed
            // chrome, off the dock grid entirely (the anchor classes and
            // the slide's offsets are bypassed; the dock zones below
            // own the next position).
            'fixed z-50 flex flex-col bg-background border shadow-xl rounded-lg overflow-hidden'
          : 'absolute z-40 flex flex-col bg-background border-border',
        float ? null : ANCHOR_POSITION_CLASS[anchor],
        // #103 — THE GHOST FIX: a closed panel is INVISIBLE. The host
        // mounts while the start screen owns the window (the desk is
        // display:none), so the slide's initial offset read offsetWidth
        // as 0 and parked the panel at its DOCK position (-0 === 0) —
        // fully visible the moment the desk showed, aria-hidden and
        // pointer-events-none: an uncloseable ghost. visibility (not
        // display) keeps the element laid out for the slide machinery.
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
      {/* #101 — THE GRIP STRIP: the redock handle (host chrome on every
          panel). Pointer users GRAB it — the panel floats, the desk's
          edges light up as dock zones, and the release docks into the
          hovered zone. REDUCED-MOTION users CLICK it — the drag gesture
          is replaced by a tiny redock menu (left/down/right — the
          a11y alternative to the float, no motion required). */}
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
      {/* #101 — THE RESIZE HANDLE: a strip on the dock edge (the left
          edge of a right-anchored panel). The grip line highlights on
          hover/drag (the ruler's margin-handle treatment); the pointer
          capture keeps the drag alive outside the strip. Not while
          FLOATING (the dock position is undecided mid-drag). */}
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
      {/* #101 — the BOTTOM variant: the handle rides the TOP edge (a
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
      {/* #101 — THE DOCK ZONES: fixed overlays over the desk's edge
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
