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
 * The floating, draggable character picker: un-dragged it is a
 * click-away transient; dragged, a parked tool. Group data loads
 * lazily; glyphs the active font can't cover are never insertable.
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
  // The chip row: Common + the user's recently used groups (MRU,
  // capped); every other group lives in the ellipsis dropdown.
  // Recency is config-persisted across sessions.
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

  // Drag: the base is the trigger rect clamped to the viewport; moves
  // apply the delta directly to the base (fixed origin — no batch staleness).
  const [pos, setPos] = useState({ left: 0, top: 0 });
  const posRef = useRef(pos);
  posRef.current = pos;
  const dragStartRef = useRef<{ px: number; py: number; bx: number; by: number } | null>(null);
  /** Torn off its anchor? Governs the click-away vs parked close behavior. */
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

  // Click-away closes only while NOT dragged (a dragged bubble is a
  // parked tool). Guards: the ellipsis dropdown's items portal outside
  // the bubble's DOM; while the dropdown is open, Base UI owns dismissal.
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
      // Any completed drag tears the bubble off — click-away no longer closes it.
      setHasDragged(true);
    }
    dragStartRef.current = null;
  }

  // A failed load is recorded once and surfaced with a retry — the
  // effect must never re-fire on failure (an infinite fetch loop).
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
    // Every browse moves the group to the MRU front (Common is pinned — never tracked).
    if (id !== 'common') {
      setRecentSymbolGroups([id, ...recentsRaw.filter((r) => r !== id)].slice(0, ROW_LIMIT));
    }
  }

  const activeLabel = GROUP_INDEX.find((g) => g.id === activeGroup)?.label ?? 'Common';

  if (!open || !anchor) return null;

  return createPortal(
    <div
      ref={bubbleRef}
      // z-[45]: under the z-50 overlays and z-[100] toasts (dialogs and
      // the bubble's own menus render above it), above panels (z-40) and ruler (z-30).
      className="fixed z-[45] flex flex-col rounded-lg border border-border bg-popover p-3 text-sm shadow-md"
      style={{ left: pos.left, top: pos.top, width: BUBBLE_WIDTH }}
      onMouseDown={(e) => e.stopPropagation()}
      data-testid="symbol-picker"
    >
      {/* The drag header: purely the drag handle — no close affordance
          (closing belongs to Done / click-away). */}
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
                  'flex h-6 items-center justify-center rounded border px-1.5 text-muted-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
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
                  // Uncovered cells are ARIA-disabled (not the native
                  // attribute) so the tooltip still explains why the cell
                  // is dead; insertion is guarded in the handler.
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
                                ? 'border-transparent hover:bg-muted hover:border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
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

      {/* The footer holds only the Done button — the preview already
          lives in the cell tooltips. */}
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
        'rounded border px-1.5 py-0.5 text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        active ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:bg-muted',
      )}
    >
      {label}
    </button>
  );
}
