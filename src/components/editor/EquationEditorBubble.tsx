import { forwardRef, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlignCenter, AlignLeft, AlignRight, Code2, Sigma } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ColorPickerButton } from '@/components/layout/ribbon/ColorPickerButton';
import { MATH_SYMBOLS, MATH_TEMPLATES } from '@/lib/equations/catalogs';
import { parseEquation, renderInlineMath } from '@/lib/equations/render';
import { sanitizeMathliveLatex } from '@/lib/equations/wysiwyg';
import { MathLiveField, type MathLiveFieldHandle } from './MathLiveField';
import { getScrollParent } from '@/lib/editor/domUtils';
import { equationDomAnchor, type EquationEditorState } from '@/lib/editor/useEquationEditor';
import type { Editor } from '@tiptap/core';

/**
 * The equation editor bubble, VISUAL-FIRST: the MathLive field is the
 * PRIMARY surface (palette inserts land with the caret INSIDE the new
 * slots); the "Source LaTeX" box remains for power users — two views
 * of ONE draft. Every draft change live-applies to the node (coalesced
 * by prosemirror-history), so the DOCUMENT is the live preview; the
 * bubble keeps only the FAILURE signal (a one-line error when the
 * source does not parse). Scale presets are a LAYOUT-relevant attr
 * (folded into the metrics fontSize key). MathLive unavailable
 * (jsdom, exotic webviews) → the Source textarea is the surface.
 */

interface EquationEditorBubbleProps {
  editor: Editor;
  state: EquationEditorState;
  /** Viewport-coordinate anchor resolver (the paginated painted-rect
   *  derivation). Absent → the pageless node-view DOM anchor. Either
   *  way it is re-derived AT RENDER (fresh through scrolls/zoom). */
  coordsFor?: (pos: number) => { left: number; top: number };
  onClose: () => void;
}

const SCALE_PRESETS: { label: string; value: number; title: string }[] = [
  { label: 'S', value: 0.75, title: 'Small' },
  { label: 'M', value: 1, title: 'Normal' },
  { label: 'L', value: 1.25, title: 'Large' },
  { label: 'XL', value: 1.5, title: 'Extra large' },
];

export const EquationEditorBubble = forwardRef<HTMLDivElement, EquationEditorBubbleProps>(
  function EquationEditorBubble(
    { editor, state, coordsFor, onClose },
    ref,
  ) {
  const [draft, setDraft] = useState(state.latex);
  const [query, setQuery] = useState('');
  // VISUAL-FIRST: the math field is the primary surface; MathLive's
  // unavailability (jsdom, exotic webviews) forces source mode.
  const [mode, setMode] = useState<'visual' | 'source'>('visual');
  const [fieldAvailable, setFieldAvailable] = useState(true);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fieldRef = useRef<MathLiveFieldHandle | null>(null);
  // Cursor restoration after a source-surface insert: the insertion
  // point is computed against the OLD draft, so it lands AFTER the
  // DOM re-render.
  const pendingCursorRef = useRef<number | null>(null);
  // DRAG (tear-off): while ANCHORED the bubble re-derives its base at
  // every render; the first completed drag BAKES the position as the
  // new base — from then on it is a floating panel that ignores
  // re-anchors.
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [hasDragged, setHasDragged] = useState(false);
  const frozenBaseRef = useRef<{ left: number; top: number } | null>(null);
  const dragStartRef = useRef<{ px: number; py: number; ox: number; oy: number } | null>(null);
  // The in-flight offset's SOURCE OF TRUTH: endDrag must read the final
  // delta SYNCHRONOUSLY — the state twin is still the pre-batch closure
  // value when React batches pointerMove+pointerUp into one flush.
  const dragOffsetRef = useRef({ x: 0, y: 0 });
  // Scroll-follow (anchored state): the body portal is fixed-position
  // (viewport coords), so content scrolls must re-derive the anchor —
  // a tick re-renders and the render-time anchor recomputes.
  const [, setScrollTick] = useState(0);

  function handleHeaderPointerDown(e: React.PointerEvent) {
    if (e.button !== 0) return;
    dragStartRef.current = {
      px: e.clientX,
      py: e.clientY,
      ox: dragOffsetRef.current.x,
      oy: dragOffsetRef.current.y,
    };
    // Pointer capture keeps the drag alive outside the header's box;
    // where the API is missing/throws (jsdom), the handlers on the
    // header still cover the common in-strip path.
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
    const next = { x: s.ox + (e.clientX - s.px), y: s.oy + (e.clientY - s.py) };
    dragOffsetRef.current = next;
    setDragOffset(next);
  }
  function endDrag() {
    if (dragStartRef.current) {
      // Bake: the dropped viewport position becomes the panel's base
      // (read through the REF — the state twin is batch-stale here).
      const base = hasDragged ? frozenBaseRef.current : currentAnchorRef.current;
      if (base) {
        frozenBaseRef.current = {
          left: base.left + dragOffsetRef.current.x,
          top: base.top + dragOffsetRef.current.y,
        };
      }
      setHasDragged(true);
      setDragOffset({ x: 0, y: 0 });
      dragOffsetRef.current = { x: 0, y: 0 };
    }
    dragStartRef.current = null;
  }

  useLayoutEffect(() => {
    if (pendingCursorRef.current == null) return;
    const el = textareaRef.current;
    if (el) {
      el.setSelectionRange(pendingCursorRef.current, pendingCursorRef.current);
      el.focus();
    }
    pendingCursorRef.current = null;
  }, [draft]);

  // POSITION (body-portal): the bubble renders through a document.body
  // portal at fixed position — it ESCAPES the editor's scroll
  // container, whose overflow clip no ancestor z-index can beat. Fixed
  // positioning takes VIEWPORT coordinates directly, so the anchor
  // resolvers need no container subtraction; while anchored, the base
  // re-derives at every render (the scroll listener keeps it fresh).
  const currentAnchorRef = useRef<{ left: number; top: number }>({ left: 0, top: 0 });
  const anchor = hasDragged
    ? (frozenBaseRef.current ?? state.coords)
    : (() => {
        try {
          return coordsFor ? coordsFor(state.pos) : equationDomAnchor(editor, state.pos);
        } catch {
          return state.coords;
        }
      })();
  currentAnchorRef.current = anchor;

  useEffect(() => {
    if (hasDragged) return; // torn off: a floating panel does not chase
    const scrollParent = getScrollParent(editor.view.dom);
    if (!scrollParent) return;
    const onScroll = () => setScrollTick((t) => t + 1);
    scrollParent.addEventListener('scroll', onScroll);
    return () => scrollParent.removeEventListener('scroll', onScroll);
  }, [editor, hasDragged]);

  /** The ONE attr-write path (raw tr at the captured pos — positionally
   *  exact even if the PM selection drifted; attrs are merged from the
   *  live node, setNodeMarkup replaces wholesale). */
  function commit(next: {
    latex?: string;
    align?: 'left' | 'center' | 'right';
    color?: string | null;
    scale?: number;
  }) {
    const { view } = editor;
    const node = view.state.doc.nodeAt(state.pos);
    if (!node || node.type.name !== 'equation') {
      onClose();
      return;
    }
    view.dispatch(
      view.state.tr.setNodeMarkup(state.pos, undefined, {
        latex: next.latex ?? (node.attrs.latex as string),
        align: next.align ?? (node.attrs.align as 'left' | 'center' | 'right'),
        color: next.color !== undefined ? next.color : (node.attrs.color as string | null),
        scale: next.scale ?? (node.attrs.scale as number),
      }),
    );
  }

  function applyDraft(next: string) {
    setDraft(next);
    // MathLive's editing tokens (\placeholder{}, \imaginaryI, …) never
    // reach the document — KaTeX can't parse them. The DRAFT stays raw
    // (the field's slots survive re-fires); only the committed latex
    // is normalized.
    commit({ latex: sanitizeMathliveLatex(next) });
  }

  /** Source-surface palette insert: splice at the textarea's cursor
   *  (end when unselected), caret right after the inserted source. */
  function insertAtCursor(latex: string) {
    const el = textareaRef.current;
    const start = el ? el.selectionStart ?? draft.length : draft.length;
    const end = el ? el.selectionEnd ?? start : start;
    const next = draft.slice(0, start) + latex + draft.slice(end);
    pendingCursorRef.current = start + latex.length;
    applyDraft(next);
  }

  /** The palette's ONE insert path: the math field takes the
   *  structural form (#@/#? — inline editing with the caret in the
   *  slot); the Source textarea takes the plain form at the cursor. */
  function insertFromPalette(tpl: { latex: string; mf?: string }) {
    if (mode === 'visual' && fieldRef.current) {
      fieldRef.current.insert(tpl.mf ?? tpl.latex);
    } else {
      insertAtCursor(tpl.latex);
    }
  }

  // The VALIDATION surface (the preview pane is gone — live-apply makes
  // the document the preview): the sanitized projection is what parses;
  // placeholders are empty slots, never errors.
  const parseError = useMemo(() => {
    const documentLatex = sanitizeMathliveLatex(draft);
    return documentLatex.trim() === '' ? null : parseEquation(documentLatex);
  }, [draft]);

  const filteredSymbols = useMemo(() => {
    if (!query.trim()) return MATH_SYMBOLS;
    const q = query.trim().toLowerCase();
    const result: typeof MATH_SYMBOLS = {};
    for (const [category, symbols] of Object.entries(MATH_SYMBOLS)) {
      const matches = symbols.filter((s) => s.name.includes(q));
      if (matches.length > 0) result[category] = matches;
    }
    return result;
  }, [query]);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }

  /** One style toggle: the ACTIVE state rides aria-pressed (AT + the
   *  highlight test) AND the secondary variant; state refreshes live
   *  through useEquationEditor's mid-interaction merge. */
  const toolbarButton = (
    testid: string,
    active: boolean,
    icon: React.ReactNode,
    label: string,
    onPick: () => void,
  ) => (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant={active ? 'secondary' : 'ghost'}
            size="icon-xs"
            aria-pressed={active}
            data-testid={testid}
            onClick={onPick}
          >
            {icon}
          </Button>
        }
      />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );

  return createPortal(
    <div
      ref={ref}
      data-equation-bubble
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={handleKeyDown}
      // FIXED at body level, z-[45]: escapes the scroll container's
      // overflow clip (no z-index can beat a clip). z-[45] sits under
      // dialogs/popovers/menus/tooltips (z-50 cap) and toasts (z-[100])
      // so they render above the bubble, and above the docked panels
      // (z-40) and ruler (z-30). Viewport coords — no container math.
      className="fixed z-[45] w-80 rounded-lg border border-border bg-popover p-3 text-sm shadow-md"
      style={{
        left: anchor.left + dragOffset.x,
        top: anchor.top + dragOffset.y,
      }}
    >
      {/* THE HEADER IS THE DRAG HANDLE (no close button — Done, Escape,
          and click-away own closing) and carries the equation mark. */}
      <div
        data-testid="equation-bubble-header"
        className="mb-2 flex cursor-grab select-none items-center gap-1.5 active:cursor-grabbing"
        style={{ touchAction: 'none' }}
        onPointerDown={handleHeaderPointerDown}
        onPointerMove={handleHeaderPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <Sigma size={13} className="text-muted-foreground" />
        <span className="font-medium">Equation</span>
      </div>

      {/* Style toolbar: alignment (the engine's align attr), the SHARED
          color picker (null = inherit), scale presets, Visual/Source. */}
      <div className="mb-2 flex items-center gap-1">
        {toolbarButton(
          'equation-align-left',
          state.align === 'left',
          <AlignLeft size={12} />,
          'Align left',
          () => commit({ align: 'left' }),
        )}
        {toolbarButton(
          'equation-align-center',
          state.align === 'center',
          <AlignCenter size={12} />,
          'Align center',
          () => commit({ align: 'center' }),
        )}
        {toolbarButton(
          'equation-align-right',
          state.align === 'right',
          <AlignRight size={12} />,
          'Align right',
          () => commit({ align: 'right' }),
        )}
        <div className="mx-1 h-5 w-px bg-border" />
        <ColorPickerButton
          label="Equation color"
          defaultColor={state.color ?? '#000000'}
          resetLabel="Default (document color)"
          solidSwatch
          onChange={(color) => commit({ color })}
        />
        <div className="mx-1 h-5 w-px bg-border" />
        {SCALE_PRESETS.map((preset) =>
          toolbarButton(
            `equation-scale-${preset.label}`,
            state.scale === preset.value,
            <span className="text-[10px] leading-none">{preset.label}</span>,
            `Font size — ${preset.title}`,
            () => commit({ scale: preset.value }),
          ),
        )}
        <div className="ml-auto">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant={mode === 'source' ? 'secondary' : 'ghost'}
                  size="icon-xs"
                  aria-pressed={mode === 'source'}
                  data-testid="equation-bubble-toggle-source"
                  onClick={() => setMode((m) => (m === 'visual' ? 'source' : 'visual'))}
                >
                  <Code2 size={12} />
                </Button>
              }
            />
            <TooltipContent>{mode === 'visual' ? 'Show LaTeX source' : 'Visual editing'}</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* The editing surface — visual (MathLive) or source (textarea); visual is primary. */}
      {mode === 'visual' && fieldAvailable ? (
        <MathLiveField
          ref={fieldRef}
          latex={draft}
          // The shadcn input recipe (ui/input.tsx verbatim, :focus-within
          // standing in for :focus-visible — the custom element owns
          // focus); index.css neutralizes MathLive's :host chrome. No
          // min-height: the wrapper hugs the field's content.
          className="tensor-equation-editor mb-2 rounded-lg border border-input bg-transparent transition-colors focus-within:border-ring focus-within:ring-1 focus-within:ring-ring/50 dark:bg-input/30"
          style={{ fontSize: '16px' }}
          onChange={applyDraft}
          onUnavailable={() => setFieldAvailable(false)}
        />
      ) : (
        <textarea
          ref={textareaRef}
          data-testid="equation-bubble-source"
          autoFocus
          value={draft}
          onChange={(e) => applyDraft(e.target.value)}
          rows={2}
          spellCheck={false}
          placeholder="e.g. \frac{a}{b} \cdot x^{2}"
          className="mb-2 w-full rounded-lg border border-input bg-transparent px-2 py-1.5 font-mono text-xs outline-none transition-colors focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 dark:bg-input/30"
        />
      )}

      {/* No preview pane: live-apply makes the DOCUMENT the preview.
          Only the FAILURE signal stays — a one-line error, shown only
          when the sanitized source does not parse. */}
      {parseError && (
        <div
          data-testid="equation-bubble-error"
          className="mb-2 rounded border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive"
        >
          {parseError}
        </div>
      )}

      <Tabs defaultValue="structures">
        <TabsList className="mb-2 h-7 w-full">
          <TabsTrigger value="structures" className="h-6 flex-1 text-xs" data-testid="equation-bubble-tab-structures">Structures</TabsTrigger>
          <TabsTrigger value="symbols" className="h-6 flex-1 text-xs" data-testid="equation-bubble-tab-symbols">Symbols</TabsTrigger>
        </TabsList>

        <TabsContent value="structures" className="mt-0">
          <div className="max-h-44 overflow-y-auto pr-1">
            {MATH_TEMPLATES.map((group) => (
              <div key={group.category} className="mb-1.5">
                <div className="mb-1 text-[11px] text-muted-foreground">{group.category}</div>
                <div className="flex flex-wrap gap-1">
                  {group.templates.map((tpl) => (
                    <Tooltip key={tpl.name}>
                      <TooltipTrigger
                        render={
                          <button
                            type="button"
                            data-testid={`equation-template-${tpl.name}`}
                            onClick={() => insertFromPalette(tpl)}
                            className="flex h-9 min-w-12 items-center justify-center rounded border border-border bg-background px-1.5 text-[11px] hover:bg-muted"
                            style={{ fontSize: '12px' }}
                          >
                            <span
                              className="tensor-equation-math pointer-events-none max-h-9 overflow-hidden"
                              dangerouslySetInnerHTML={{ __html: renderInlineMath(tpl.latex) }}
                            />
                          </button>
                        }
                      />
                      <TooltipContent>{tpl.label}</TooltipContent>
                    </Tooltip>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </TabsContent>

        <TabsContent value="symbols" className="mt-0">
          <Input
            placeholder="Search symbols…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="mb-2 h-7 text-sm"
          />
          <div className="max-h-36 overflow-y-auto pr-1">
            {Object.keys(filteredSymbols).length === 0 && (
              <div className="py-3 text-center text-xs text-muted-foreground">No symbols found</div>
            )}
            {Object.entries(filteredSymbols).map(([category, symbols]) => (
              <div key={category} className="mb-1.5">
                <div className="mb-1 text-[11px] text-muted-foreground">{category}</div>
                <div className="grid grid-cols-9 gap-0.5">
                  {symbols.map((s) => (
                    <Tooltip key={s.name + s.latex}>
                      <TooltipTrigger
                        render={
                          <button
                            type="button"
                            data-testid={`equation-symbol-${s.name}`}
                            onClick={() =>
                              mode === 'visual' && fieldRef.current
                                ? fieldRef.current.insert(s.latex)
                                : insertAtCursor(s.latex)
                            }
                            className="flex h-7 items-center justify-center rounded hover:bg-muted"
                            style={{ fontSize: '12px' }}
                          >
                            <span
                              className="tensor-equation-math pointer-events-none"
                              dangerouslySetInnerHTML={{ __html: renderInlineMath(s.latex) }}
                            />
                          </button>
                        }
                      />
                      <TooltipContent>{s.name}</TooltipContent>
                    </Tooltip>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </TabsContent>
      </Tabs>

      {/* THE FOOTER — DialogFooter pattern: negative margins escape the
          root's padding so the rule and muted band run EDGE-TO-EDGE,
          rounded to the bubble's bottom corners. */}
      <div
        data-testid="equation-bubble-footer"
        className="-mx-3 -mb-3 mt-2 flex items-center justify-between rounded-b-lg border-t bg-muted/50 px-3 py-2"
      >
        <span className="text-[11px] text-muted-foreground">Changes apply as you type</span>
        <Button size="sm" className="h-7 px-2 text-xs" onClick={onClose}>
          <Sigma size={12} className="mr-1" />
          Done
        </Button>
      </div>
    </div>,
    document.body,
  );
  },
);