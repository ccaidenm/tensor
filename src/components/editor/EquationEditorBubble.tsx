import { forwardRef, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AlignCenter, AlignLeft, AlignRight, Code2, Sigma, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ColorPickerButton } from '@/components/layout/ribbon/ColorPickerButton';
import { MATH_SYMBOLS, MATH_TEMPLATES } from '@/lib/equations/catalogs';
import { parseEquation, renderEquation, renderInlineMath } from '@/lib/equations/render';
import { MathLiveField, type MathLiveFieldHandle } from './MathLiveField';
import type { Editor } from '@tiptap/core';
import type { EquationEditorState } from '@/lib/editor/useEquationEditor';

/**
 * M-EQ-2 — the equation editor bubble, VISUAL-FIRST. The WYSIWYG math
 * field (MathLive) is the PRIMARY editing surface: typing `1/2` grows
 * a live fraction, the palette drops structures in with the caret
 * INSIDE the new slots (inline editing, never a LaTeX round trip),
 * and the "Source LaTeX" box remains for power users (the issue's
 * power-user path) — the two surfaces are two views of ONE draft.
 *
 * ONE DRAFT, TWO SURFACES: `draft` is the single source of truth; the
 * math field emits it via input events, the Source textarea edits it
 * directly, and the KaTeX preview shows the DOCUMENT-truth rendering
 * (what the page will paint — MathLive's rendering is close, KaTeX is
 * what ships). Every draft change live-applies to the node (the M-EQ
 * live-apply law, coalesced by prosemirror-history).
 *
 * STYLE CONTROLS (the M-EQ-2 ruling): color via the SHARED
 * ColorPickerButton (the font-color tool's own component — same
 * palette, same custom-color store; null = inherit the document
 * default), scale presets (S/M/L/XL → 0.75/1/1.25/1.5 — a
 * LAYOUT-relevant attr folded into the metrics fontSize key).
 *
 * FALLBACK: MathLive needs real layout — when it can't run (jsdom
 * tests, exotic webviews) the field calls onUnavailable once and the
 * bubble falls back to the Source textarea as the editing surface
 * (graceful, the broken-glyph law's editor arm).
 */

interface EquationEditorBubbleProps {
  editor: Editor;
  state: EquationEditorState;
  containerTop: number;
  containerLeft: number;
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
    { editor, state, containerTop, containerLeft, onClose },
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

  useLayoutEffect(() => {
    if (pendingCursorRef.current == null) return;
    const el = textareaRef.current;
    if (el) {
      el.setSelectionRange(pendingCursorRef.current, pendingCursorRef.current);
      el.focus();
    }
    pendingCursorRef.current = null;
  }, [draft]);

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
    commit({ latex: next });
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

  const parseError = useMemo(
    () => (draft.trim() === '' ? null : parseEquation(draft)),
    [draft],
  );

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

  const toolbarButton = (
    value: 'left' | 'center' | 'right' | number,
    icon: React.ReactNode,
    label: string,
  ) => (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant={
              (typeof value === 'number' ? state.scale : state.align) === value
                ? 'secondary'
                : 'ghost'
            }
            size="icon-xs"
            onClick={() =>
              commit(typeof value === 'number' ? { scale: value } : { align: value })
            }
          >
            {icon}
          </Button>
        }
      />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );

  return (
    <div
      ref={ref}
      data-equation-bubble
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={handleKeyDown}
      className="absolute z-30 w-80 rounded-lg border border-border bg-popover p-3 text-sm shadow-md"
      style={{ left: state.coords.left - containerLeft, top: state.coords.top - containerTop }}
    >
      <div className="mb-2 flex items-center justify-between">
        <span className="font-medium">Equation</span>
        <Button variant="ghost" size="icon-xs" onClick={onClose}>
          <X size={12} />
        </Button>
      </div>

      {/* The style toolbar: alignment (the engine's align attr), the
          SHARED color picker (null = inherit), scale presets, and the
          Visual/Source surface toggle. */}
      <div className="mb-2 flex items-center gap-1">
        {toolbarButton('left', <AlignLeft size={12} />, 'Align left')}
        {toolbarButton('center', <AlignCenter size={12} />, 'Align center')}
        {toolbarButton('right', <AlignRight size={12} />, 'Align right')}
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
            preset.value,
            <span className="text-[10px] leading-none">{preset.label}</span>,
            `Font size — ${preset.title}`,
          ),
        )}
        <div className="ml-auto">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant={mode === 'source' ? 'secondary' : 'ghost'}
                  size="icon-xs"
                  onClick={() => setMode((m) => (m === 'visual' ? 'source' : 'visual'))}
                >
                  <Code2 size={12} />
                </Button>
              }
            />
            <TooltipContent>{mode === 'visual' ? 'Edit LaTeX source' : 'Visual editing'}</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* THE EDITING SURFACE — visual (MathLive) or source (textarea).
          Visual is primary; the Source path remains (the issue's
          power-user ruling). */}
      {mode === 'visual' && fieldAvailable ? (
        <MathLiveField
          ref={fieldRef}
          latex={draft}
          className="tensor-equation-editor mb-2 rounded border border-border bg-background"
          style={{ minHeight: '52px', fontSize: '16px' }}
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
          className="mb-2 w-full rounded border border-border bg-background px-2 py-1.5 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-ring"
        />
      )}

      {/* Live preview — the DOCUMENT-truth rendering (KaTeX, the one
          render surface; MathLive's is close but KaTeX ships). */}
      <div
        data-testid="equation-bubble-preview"
        className="tensor-equation mb-2 min-h-9 items-center overflow-x-auto rounded border border-border bg-background px-3 py-1.5"
        style={{ justifyContent: 'center', fontSize: '16px', color: state.color ?? undefined }}
      >
        {draft.trim() === '' ? (
          <span className="text-xs text-muted-foreground">
            {fieldAvailable ? 'Type, press / for a fraction, or pick below' : 'Type LaTeX or pick from the palette below'}
          </span>
        ) : parseError ? (
          <span data-testid="equation-bubble-error" className="text-xs text-destructive">
            {parseError}
          </span>
        ) : (
          <div
            data-testid="equation-bubble-math"
            className="tensor-equation-math"
            dangerouslySetInnerHTML={{ __html: renderEquation(draft) }}
          />
        )}
      </div>

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

      <div className="mt-2 flex items-center justify-between">
        <span className="text-[11px] text-muted-foreground">Changes apply as you type</span>
        <Button size="sm" className="h-7 px-2 text-xs" onClick={onClose}>
          <Sigma size={12} className="mr-1" />
          Done
        </Button>
      </div>
    </div>
  );
  },
);