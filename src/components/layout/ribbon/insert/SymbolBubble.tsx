import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MoreHorizontal, Omega } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useConfigStore } from '@/lib/config/store';
import {
  GROUP_INDEX,
  commonChars,
  ensureCoreLoaded,
  getGroupChars,
  loadGroup,
  loadedChars,
  type CatalogChar,
} from '@/lib/editor/symbols/catalog';
import { activeFontStack, isGlyphCovered } from '@/lib/editor/symbols/coverage';
import { useSymbolBubbleStore } from '@/lib/editor/symbols/bubbleStore';
import type { Editor } from '@tiptap/core';
import { cn } from 'cn';

/**
 * THE SYMBOL BUBBLE — the character picker as a floating POPUP (the
 * equation-editor-bubble precedent): it pops up near the ribbon button,
 * DRAGS anywhere (tear-off model), and PERSISTS — it mounts in App.tsx
 * through the bubble store, so ribbon tab switches never touch it.
 *
 * THE CLOSE LAW (the user ruling): a menu the user never moved is a
 * transient — clicking away auto-closes it. A menu the user DRAGGED is
 * a parked tool — it persists until closed explicitly (the footer's
 * Done button, or the ribbon toggle). No X: the header is purely the
 * drag handle (the equation bubble's own law — closing belongs to
 * Done/Escape/click-away, never a hit-test inside the drag handle).
 *
 * THE BODY-PORTAL MODEL: fixed position + max z through a
 * document.body portal — it escapes the editor's scroll container.
 *
 * LAZY LAW: nothing loads until the user leaves Common — the core
 * bundle (~271KB gz) loads on the first non-Common browse or deep
 * search, each CJK/Hangul chunk only when its group is opened.
 *
 * COVERAGE LAW: cells are checked against the ACTIVE font (canvas
 * measure, cached); glyphs the font can't render are DISABLED —
 * viewable and browseable, never insertable (no tofu dressed up as a
 * normal result).
 */

const ROW_HEIGHT = 30; // 28px cell + 2px gap
const CELL = 28;
const BUBBLE_WIDTH = 320;

export function SymbolBubble({ editor }: { editor: Editor }) {
  const open = useSymbolBubbleStore((s) => s.open);
  const anchor = useSymbolBubbleStore((s) => s.anchor);
  const close = useSymbolBubbleStore((s) => s.close);

  const [query, setQuery] = useState('');
  const [activeGroup, setActiveGroup] = useState<string>('common');
  /** Bumped after each async chunk load — the render reads the cache. */
  const [loadedTick, setLoadedTick] = useState<Record<string, number>>({});
  const [loadErrors, setLoadErrors] = useState<Record<string, string>>({});
  const [scrollTop, setScrollTop] = useState(0);
  const gridRef = useRef<HTMLDivElement>(null);
  const [gridWidth, setGridWidth] = useState(BUBBLE_WIDTH - 16);

  const defaultFamily = useConfigStore((s) => s.config.editor.defaultFontFamily);
  const selectionFont = editor.getAttributes('textStyle')?.fontFamily as string | undefined;
  const fontStack = activeFontStack(selectionFont, defaultFamily);
  // THE CHIP ROW (the collapse law): Common + the user's recently used
  // groups (MRU, capped) in the row; every other group lives in the
  // ellipsis dropdown. Recency is config-persisted — your row keeps
  // YOUR groups across sessions. FIRST LOAD: with no history, the row
  // fills with the most common categories (display-only — the user's
  // own usage replaces it from the first pick; nothing is written).
  const ROW_LIMIT = 4;
  const recentsRaw = useConfigStore((s) => s.config.editor.recentSymbolGroups);
  const setRecentSymbolGroups = useConfigStore((s) => s.setRecentSymbolGroups);
  const recentGroups = useMemo(() => {
    // FIRST LOAD: with no history, the row seeds with the most common
    // categories (display-only — the user's own usage replaces it).
    const known = new Set(GROUP_INDEX.map((g) => g.id));
    const defaults = ['math', 'punctuation', 'arrows', 'currency'];
    const source = recentsRaw.length > 0 ? recentsRaw : defaults;
    return source.filter((id) => id !== 'common' && known.has(id)).slice(0, ROW_LIMIT);
  }, [recentsRaw]);
  const restGroups = useMemo(
    () => GROUP_INDEX.filter((g) => g.id !== 'common' && !recentGroups.includes(g.id)),
    [recentGroups],
  );
  const groupLabel = (id: string) => GROUP_INDEX.find((g) => g.id === id)?.label ?? id;

  const searching = query.trim().length > 0;

  // ─── DRAG (the tear-off model, simplified: always floating) ────────
  // The initial base is the trigger rect, clamped to the viewport;
  // pointer moves apply the delta DIRECTLY to the base (no cumulative
  // offset — origin is fixed for the whole drag, so no batch staleness).
  const [pos, setPos] = useState({ left: 0, top: 0 });
  const posRef = useRef(pos);
  posRef.current = pos;
  const dragStartRef = useRef<{ px: number; py: number; bx: number; by: number } | null>(null);
  /** Has the user torn the bubble off its anchor? Governs the close law
   *  (no visual badge — the chrome stays quiet; the law is behavior). */
  const [hasDragged, setHasDragged] = useState(false);
  const bubbleRef = useRef<HTMLDivElement>(null);

  // Fresh anchor per open (the store re-opens with a new rect).
  useEffect(() => {
    if (!open || !anchor) return;
    const left = Math.min(anchor.left, window.innerWidth - BUBBLE_WIDTH - 8);
    const top = Math.min(anchor.bottom + 6, window.innerHeight - 120);
    setPos({ left: Math.max(8, left), top: Math.max(8, top) });
    setHasDragged(false);
    setQuery('');
    setActiveGroup('common');
    setLoadErrors({});
  }, [open, anchor]);

  // THE CLICK-AWAY LAW: while NOT dragged, any pointerdown outside the
  // bubble (and off the trigger) auto-closes. A dragged bubble is a
  // parked tool — the listener stands down. TWO MORE GUARDS: the
  // ellipsis dropdown's items portal OUTSIDE the bubble's DOM (they
  // must reach their onClick, not die in a click-away), and while the
  // dropdown is OPEN the bubble never closes from click-away (Base UI
  // owns the menu's dismissal).
  const [moreOpen, setMoreOpen] = useState(false);
  useEffect(() => {
    if (!open || hasDragged) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (bubbleRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest('[data-testid="symbol-button-trigger"]')) return;
      if (target instanceof Element && target.closest('[role="menu"]')) return;
      if (moreOpen) return;
      close();
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open, hasDragged, close, moreOpen]);

  function handleHeaderPointerDown(e: React.PointerEvent) {
    if (e.button !== 0) return;
    dragStartRef.current = { px: e.clientX, py: e.clientY, bx: posRef.current.left, by: posRef.current.top };
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId);
    } catch {
      /* capture unavailable — drag stays header-local */
    }
    e.preventDefault();
  }
  function handleHeaderPointerMove(e: React.PointerEvent) {
    const s = dragStartRef.current;
    if (!s) return;
    setPos({
      left: Math.max(-BUBBLE_WIDTH + 60, s.bx + (e.clientX - s.px)),
      top: Math.max(0, s.by + (e.clientY - s.py)),
    });
  }
  function endDrag() {
    if (dragStartRef.current && !hasDragged) {
      // Any completed drag tears the bubble off — the close law flips.
      setHasDragged(true);
    }
    dragStartRef.current = null;
  }

  // ─── LAZY LOADS ─────────────────────────────────────────────────────
  // FAILURE LAW: a failed load is recorded once and surfaced with a
  // retry — the effect must never re-fire on failure (that would loop
  // the fetch forever; the loadedTick keyed-record pattern bumps only
  // on success).
  useEffect(() => {
    if (!open) return;
    if (activeGroup !== 'common' && !getGroupChars(activeGroup) && !loadErrors[activeGroup]) {
      void loadGroup(activeGroup)
        .then(() => setLoadedTick((t) => ({ ...t, [activeGroup]: (t[activeGroup] ?? 0) + 1 })))
        .catch((err: unknown) => setLoadErrors((e) => ({ ...e, [activeGroup]: err instanceof Error ? err.message : String(err) })));
    }
  }, [open, activeGroup, loadedTick, loadErrors]);

  useEffect(() => {
    if (!open || !searching || getGroupChars('core') || loadErrors.core) return;
    void ensureCoreLoaded()
      .then(() => setLoadedTick((t) => ({ ...t, core: (t.core ?? 0) + 1 })))
      .catch((err: unknown) => setLoadErrors((e) => ({ ...e, core: err instanceof Error ? err.message : String(err) })));
  }, [open, searching, loadedTick, loadErrors]);

  // Measure the grid width for the column count (mount + resize safe).
  useEffect(() => {
    if (!open) return;
    const el = gridRef.current;
    if (el) setGridWidth(el.clientWidth || BUBBLE_WIDTH - 16);
  }, [open]);

  /** The visible character list — browsing or searching. */
  const chars = useMemo(() => {
    if (searching) {
      const q = query.trim().toLowerCase();
      const hexQ = q.replace(/^u\+|^0x/, '');
      const hexish = /^[0-9a-f]{2,6}$/.test(hexQ);
      return loadedChars().filter((c) => {
        if (c.name.toLowerCase().includes(q)) return true;
        return hexish && c.cp.toString(16).includes(hexQ);
      });
    }
    if (activeGroup === 'common') return commonChars();
    return getGroupChars(activeGroup) ?? [];
    // loadedTick keeps search results fresh after async chunk loads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searching, query, activeGroup, loadedTick]);

  const loading = !searching && activeGroup !== 'common' && chars.length === 0 && GROUP_INDEX.some((g) => g.id === activeGroup);

  // WINDOWING: fixed-height rows of COLS cells; only the visible band
  // (+ overscan) renders — full-Unicode scale at DOM-cost of ~100 cells.
  const cols = Math.max(6, Math.floor((gridWidth - 8) / (CELL + 2)));
  const rows = useMemo(() => {
    const out: Array<{ chars: CatalogChar[]; index: number }> = [];
    for (let i = 0; i < chars.length; i += cols) out.push({ chars: chars.slice(i, i + cols), index: i });
    return out;
  }, [chars, cols]);

  const ROWS_VISIBLE = Math.ceil(256 / ROW_HEIGHT);
  const firstRow = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - 3);
  const lastRow = Math.min(rows.length, firstRow + ROWS_VISIBLE + 6);

  function insertSymbol(symbol: string) {
    editor.chain().focus().insertContent(symbol).run();
    // The bubble stays open for multi-insert (Done / the ribbon button closes).
  }

  function pickGroup(id: string) {
    setActiveGroup(id);
    setQuery('');
    if (gridRef.current) gridRef.current.scrollTop = 0;
    setScrollTop(0);
    // THE RECENCY WRITE: every browse moves the group to the MRU front
    // (Common is always pinned in the row — never tracked).
    if (id !== 'common') {
      setRecentSymbolGroups([id, ...recentsRaw.filter((r) => r !== id)].slice(0, ROW_LIMIT));
    }
  }

  const activeLabel = GROUP_INDEX.find((g) => g.id === activeGroup)?.label ?? 'Common';

  if (!open || !anchor) return null;

  return createPortal(
    <div
      ref={bubbleRef}
      // THE Z-LAW (toast.tsx): dialogs/popovers/menus/tooltips cap at
      // z-50 and toasts sit at z-[100] topmost — a floating bubble
      // must sit UNDER that layer (its own menus/tooltips, and every
      // dialog, render above it) while staying above the docked
      // panels (z-40) and the ruler (z-30).
      className="fixed z-[45] flex flex-col rounded-lg border border-border bg-popover p-3 text-sm shadow-md"
      style={{ left: pos.left, top: pos.top, width: BUBBLE_WIDTH }}
      onMouseDown={(e) => e.stopPropagation()}
      data-testid="symbol-picker"
    >
      {/* THE DRAG HEADER (the equation bubble's exact pattern): icon +
          title, purely the drag handle — no close affordance lives
          here (closing belongs to Done / click-away, never the drag
          strip), and no state badges — the chrome stays quiet. */}
      <div
        className="mb-2 flex cursor-grab select-none items-center gap-1.5 active:cursor-grabbing"
        style={{ touchAction: 'none' }}
        onPointerDown={handleHeaderPointerDown}
        onPointerMove={handleHeaderPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        data-testid="symbol-bubble-header"
      >
        <Omega size={13} className="shrink-0 text-muted-foreground" />
        <span className="font-medium">Characters</span>
      </div>

      <Input
        placeholder="Search by name or code (e.g. arrow, U+2192)…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="mb-2 h-8 text-sm"
        data-testid="symbol-search"
      />

      {/* Group chips — THE COLLAPSE LAW: one row of Common + the
          user's last-used groups; everything else lives in the
          ellipsis dropdown (picking from it moves the group into the
          row — config-persisted recency). */}
      <div className="mb-2 flex flex-wrap items-center gap-1" data-testid="symbol-groups">
        <GroupChip id="common" label="Common" active={activeGroup === 'common'} onClick={() => pickGroup('common')} />
        {recentGroups.map((id) => (
          <GroupChip key={id} id={id} label={groupLabel(id)} active={activeGroup === id} onClick={() => pickGroup(id)} />
        ))}
        <DropdownMenu onOpenChange={setMoreOpen}>
          <DropdownMenuTrigger
            render={
              <button
                type="button"
                data-testid="symbol-group-more"
                aria-label="More character groups"
                className={cn(
                  'flex h-6 items-center justify-center rounded border px-1.5 text-muted-foreground transition-colors hover:bg-muted',
                  restGroups.some((g) => g.id === activeGroup) && 'border-primary text-primary',
                )}
              >
                <MoreHorizontal size={14} />
              </button>
            }
          />
          <DropdownMenuContent align="start" className="max-h-72 w-52 overflow-y-auto">
            {restGroups.map((g) => (
              <DropdownMenuItem
                key={g.id}
                data-testid={`symbol-menu-${g.id}`}
                onClick={() => pickGroup(g.id)}
              >
                {g.label}
                <span className="ml-auto text-xs text-muted-foreground">
                  {g.lazy ? `~${Math.round(g.count / 1000)}k` : g.count}
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* The windowed grid. */}
      <div
        ref={gridRef}
        className="h-64 overflow-y-auto rounded border border-border"
        onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
        data-testid="symbol-grid"
      >
        {loadErrors[activeGroup] || (searching && loadErrors.core) ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-xs text-muted-foreground" data-testid="symbol-load-error">
            <span className="text-destructive">{loadErrors[activeGroup] ?? loadErrors.core}</span>
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2 text-xs"
              onClick={() => {
                const failedId = loadErrors[activeGroup] ? activeGroup : 'core';
                setLoadErrors((e) => {
                  const next = { ...e };
                  delete next[failedId];
                  return next;
                });
                setLoadedTick((t) => ({ ...t, [failedId]: (t[failedId] ?? 0) + 1 }));
              }}
              data-testid="symbol-retry"
            >
              Retry
            </Button>
          </div>
        ) : loading ? (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground" data-testid="symbol-loading">
            Loading {activeLabel}…
          </div>
        ) : chars.length === 0 ? (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground" data-testid="symbol-empty">
            {searching && !getGroupChars('core') ? 'Loading the full character set…' : 'No symbols found'}
          </div>
        ) : (
          <div style={{ height: rows.length * ROW_HEIGHT, position: 'relative' }}>
            {rows.slice(firstRow, lastRow).map((row, idx) => (
              <div
                key={row.index}
                className="absolute left-0 right-0 flex gap-0.5 px-1"
                style={{ top: (firstRow + idx) * ROW_HEIGHT, height: ROW_HEIGHT }}
              >
                {row.chars.map((s) => {
                  const covered = isGlyphCovered(fontStack, s.char);
                  // THE TOOLTIP LAW (shadcn native): name + codepoint +
                  // coverage ride the app's Tooltip, not a title attr.
                  // Uncovered cells are ARIA-disabled (not the native
                  // attribute) so hover — and the explanation of WHY
                  // the cell is dead — still reaches them; insertion
                  // is guarded in the handler instead.
                  return (
                    <Tooltip key={s.cp}>
                      <TooltipTrigger
                        render={
                          <button
                            type="button"
                            aria-disabled={!covered}
                            onClick={() => {
                              if (covered) insertSymbol(s.char);
                            }}
                            data-covered={covered}
                            className={cn(
                              'flex items-center justify-center rounded border text-base',
                              covered
                                ? 'border-transparent hover:bg-muted hover:border-border'
                                : 'cursor-not-allowed border-transparent opacity-40',
                            )}
                            style={{ width: CELL, height: CELL }}
                            data-testid="symbol-cell"
                          >
                            {s.char}
                          </button>
                        }
                      />
                      <TooltipContent>
                        <span className="font-medium">{s.name}</span>
                        <span className="ml-1 text-muted-foreground">U+{s.cp.toString(16).toUpperCase()}</span>
                        {!covered && <span className="text-destructive"> — not in {fontStack}</span>}
                      </TooltipContent>
                    </Tooltip>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* THE FOOTER — the equation bubble's band (edge-to-edge rule,
          muted, py-2) holding ONLY the Done button (the user ruling:
          the character preview lived in the cell tooltips already —
          the footer is chrome, not information). */}
      <div
        data-testid="symbol-preview"
        className="-mx-3 -mb-3 mt-2 flex items-center justify-end rounded-b-lg border-t bg-muted/50 px-3 py-2"
      >
        <Button size="sm" className="h-7 shrink-0 px-2 text-xs" onClick={close} data-testid="symbol-done">
          <Omega size={12} className="mr-1" />
          Done
        </Button>
      </div>
    </div>,
    document.body,
  );
}

function GroupChip({ id, label, active, onClick }: { id: string; label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={`symbol-group-${id}`}
      className={cn(
        'rounded border px-1.5 py-0.5 text-[11px] transition-colors',
        active ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:bg-muted',
      )}
    >
      {label}
    </button>
  );
}
