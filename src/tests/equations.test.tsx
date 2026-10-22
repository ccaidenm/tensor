import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { act, fireEvent } from '@testing-library/react';
import type { Editor } from '@tiptap/core';
import { createLayoutEngine, EquationTooTallError } from '@tensor-editor/engine';
import { useConfigStore } from '@/lib/config/store';
import { DEFAULT_MARGINS, PAGE_GAP, toLayoutOptions } from '@/lib/document/pageSetup';
import { pmDocToSemantic } from '@/lib/paginated/adapter';
import { saveWpdoc, openWpdoc } from '@/lib/document/wpdoc';
import { SHORTCUTS, findShortcutConflicts, getEffectiveKeybinding } from '@/lib/shortcuts';
import { EDITOR_COMMAND_MAP } from '@/lib/editor/editorCommands';
import { getCommand } from '@/lib/commands/registry';
import { parseEquation, renderEquation, renderInlineMath } from '@/lib/equations/render';
import { MATH_SYMBOLS, MATH_TEMPLATES } from '@/lib/equations/catalogs';
import { FRACTION_SLASH_SHORTCUT, sanitizeMathliveLatex } from '@/lib/equations/wysiwyg';
import { renderTensor, settleLayout } from './harness';
import { FakeEquationMetrics, FakeMetrics } from './fakeMetrics';

/**
 * M-EQ — the equation suite: insert, render, the assisted-input bubble,
 * the paginated projection (placed[] paint), the clipboard marker, the
 * .wpdoc round-trip, and the insert surfaces (ribbon/shortcut/palette).
 * jsdom notes: KaTeX renderToString is pure string generation (works
 * without CSS/fonts); the paginated dims ride the FakeEquationMetrics
 * injection (jsdom measures DOM rects as zeros).
 */

// M-IMAGES-0 container simulator (same wire contract as wpdoc.test —
// the equation rides document.json; NO media involved).
const wpdocFiles = vi.hoisted(() => new Map<string, { kind: 'v2'; document: string; media: { id: string; ext: string; bytesB64: string }[] }>());
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string, args: { path?: string; documentJson?: string; media?: unknown[] }) => {
    if (cmd === 'package_document') {
      wpdocFiles.set(args.path!, {
        kind: 'v2',
        document: args.documentJson!,
        media: (args.media ?? []) as { id: string; ext: string; bytesB64: string }[],
      });
      return null;
    }
    if (cmd === 'unpackage_document') {
      const f = wpdocFiles.get(args.path!);
      if (!f) throw new Error('file not found');
      return { document: f.document, media: f.media };
    }
    throw new Error(`unexpected command: ${cmd}`);
  }),
}));

// M-EQ-2: MathLive cannot run in jsdom (real layout, custom-element
// upgrade, webfonts) — the loader is mocked to FAIL, which drives the
// bubble's graceful fallback to the Source textarea. The WYSIWYG
// surface's own behavior is upstream (MathLive's); what IS tested here
// is the React glue around it: the fallback law, the palette's
// source-splice path, and the commit paths (attrs, color, scale).
// The SANITIZER is the real one (pure string math — the document
// boundary is exactly what must hold in every environment).
vi.mock('@/lib/equations/wysiwyg', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/equations/wysiwyg')>()),
  loadMathLive: () => Promise.reject(new Error('MathLive unavailable in jsdom tests')),
  resetMathLiveLoader: () => {},
}));

const BASE = { fontFamily: 'fake', fontSize: 16 };
const PAGE_SETUP = { pageSize: 'Letter', margins: DEFAULT_MARGINS, pageGap: PAGE_GAP };

function directLayout(editor: Editor) {
  const adapted = pmDocToSemantic(editor.state.doc, BASE);
  const engine = createLayoutEngine({
    metrics: FakeMetrics,
    equationMetrics: FakeEquationMetrics,
  });
  return {
    adapted,
    result: engine.layout({ baseStyle: BASE, blocks: adapted.doc.blocks }, toLayoutOptions(PAGE_SETUP)),
  };
}

function findEquation(editor: Editor): { pos: number; attrs: Record<string, unknown> } | null {
  let found: { pos: number; attrs: Record<string, unknown> } | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'equation') {
      found = { pos, attrs: node.attrs as Record<string, unknown> };
      return false;
    }
    return true;
  });
  return found;
}

/** Sets the equation's latex through the live editor (the bubble's own
 *  attr-write path shape: setNodeMarkup at the node's position). */
function setLatex(editor: Editor, pos: number, latex: string) {
  act(() => {
    editor.chain().command(({ tr }) => {
      tr.setNodeMarkup(pos, undefined, { latex, align: 'center' });
      return true;
    }).run();
  });
}

beforeAll(() => {
  Object.defineProperty(globalThis, '__TAURI_INTERNALS__', { value: {}, configurable: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  useConfigStore.setState((state) => ({
    config: {
      ...state.config,
      editor: { ...state.config.editor, zoomLevel: 100, defaultPageLayout: 'Pages' },
    },
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── 1. Insertion: one command, every surface ───────────────────────────

describe('insertion', () => {
  it('insertEquation creates an EMPTY equation, NodeSelections it, mints a blockId', () => {
    const { editor } = renderTensor('<p>before</p>');
    act(() => {
      editor.commands.focus();
      editor.commands.insertEquation();
    });
    const eq = findEquation(editor);
    expect(eq).not.toBeNull();
    // The just-inserted state: empty latex (the placeholder face), the
    // Word display-equation alignment default, an id for the engine.
    expect(eq!.attrs.latex).toBe('');
    expect(eq!.attrs.align).toBe('center');
    expect(typeof eq!.attrs.blockId).toBe('string');
    expect((eq!.attrs.blockId as string).length).toBeGreaterThan(0);
    // The selection is ON the node (the bubble's open trigger).
    const { selection } = editor.state;
    expect(selection.constructor.name).toBe('NodeSelection');
  });

  it('all three insert surfaces share the ONE command: ribbon, Alt+=, palette', async () => {
    // Registry: the shortcut exists, is editor-context, Insert category,
    // Alt+= (Word's convention), and the dev conflict check is clean.
    const def = SHORTCUTS.find((s) => s.id === 'insertEquation');
    expect(def).toBeDefined();
    expect(def!.context).toBe('editor');
    expect(def!.category).toBe('Insert');
    expect(def!.keys).toBe('alt+=');
    expect(getEffectiveKeybinding({}, 'insertEquation')).toBe('alt+=');
    expect(findShortcutConflicts()).toEqual([]);
    // The dispatch map: the shortcut and the palette both land on
    // editor.commands.insertEquation (the one command path).
    expect(EDITOR_COMMAND_MAP.insertEquation).toBeDefined();
    const cmd = getCommand('insertEquation');
    expect(cmd).toBeDefined();
    expect(cmd!.title).toBe('Insert Equation');

    // The REAL keydown pipeline: Alt+= on the editor inserts.
    const { editor } = renderTensor('<p>start</p>');
    await settleLayout();
    act(() => {
      editor.commands.focus();
    });
    const dom = editor.view.dom as HTMLElement;
    await act(async () => {
      dom.dispatchEvent(new KeyboardEvent('keydown', { key: '=', altKey: true, bubbles: true, cancelable: true }));
    });
    expect(findEquation(editor)).not.toBeNull();
  });
});

// ─── 2. Rendering: the projection states ────────────────────────────────

describe('rendering', () => {
  it('EMPTY latex renders the placeholder; LATEX renders KaTeX HTML; INVALID renders the invalid face', async () => {
    const { editor } = renderTensor('<p>x</p>');
    await settleLayout();
    act(() => {
      editor.commands.focus();
      editor.commands.insertEquation();
    });
    await settleLayout();
    let eq = findEquation(editor)!;
    // Empty → the dashed placeholder (never a blank block, never KaTeX
    // error text — the broken-glyph law).
    expect(document.querySelector('[data-testid="equation-placeholder"]')).not.toBeNull();
    expect(document.querySelector('.katex-error')).toBeNull();

    setLatex(editor, eq.pos, 'x=\\frac{1}{2}');
    eq = findEquation(editor)!;
    await settleLayout();
    // Valid → the KaTeX projection (the .katex markup exists).
    expect(document.querySelector('[data-testid="equation-render"] .katex')).not.toBeNull();
    // The KaTeX OUTPUT is a pure function of the source (the issue's
    // law): the fraction renders as nested spans, no raw source text.
    expect(document.querySelector('[data-testid="equation-render"]')!.innerHTML).toContain('katex');

    // Invalid → the styled invalid face with the SOURCE visible.
    setLatex(editor, eq.pos, '\\frac{1}{');
    await settleLayout();
    expect(document.querySelector('[data-testid="equation-invalid"]')).not.toBeNull();
    // ...and the parse validation the bubble surfaces:
    expect(parseEquation('\\frac{1}{')).toMatch(/Expected group|Unexpected end/i);
    expect(parseEquation('x^{2}')).toBeNull();
  });

  it('the a11y mirror: the hidden-input view carries the KaTeX MathML copy', async () => {
    const { editor } = renderTensor('<p>a11y</p>');
    await settleLayout();
    act(() => {
      editor.commands.focus();
      editor.commands.insertEquation();
    });
    const eq = findEquation(editor)!;
    setLatex(editor, eq.pos, 'E=mc^{2}');
    await settleLayout();
    // KaTeX's htmlAndMathml output ships a visually-hidden MathML copy
    // — the hidden PM view renders it (opacity 0, NOT aria-hidden), so
    // screen readers reach the formula (the M5 Orca law's equation arm).
    expect(document.querySelector('.pm-input-only .katex-mathml')).not.toBeNull();
  });
});

// ─── 3. The paginated projection ────────────────────────────────────────

describe('paginated', () => {
  it('projects to an engine EquationBlock: latex only, fontSize = doc default, align honored', () => {
    const { editor } = renderTensor('<p>before</p>');
    act(() => {
      editor.commands.focus();
      editor.commands.insertEquation();
    });
    const eq = findEquation(editor)!;
    setLatex(editor, eq.pos, '\\sum_{i=1}^{n} a_i');
    const adapted = pmDocToSemantic(editor.state.doc, BASE);
    const block = adapted.doc.blocks.find((b) => b.kind === 'equation') as {
      kind: string;
      latex: string;
      fontSize: number;
      align: string;
    };
    expect(block.latex).toBe('\\sum_{i=1}^{n} a_i');
    // THE DIMS RULING: no width/height ride the projection — derived
    // facts come from the EquationMetrics port at layout time.
    expect('width' in block).toBe(false);
    expect('height' in block).toBe(false);
    expect(block.fontSize).toBe(16);
    expect(block.align).toBe('center');
  });

  it('lays out as an atomic PlacedRect, centered on the content box; paints in the EquationLayer', async () => {
    const { editor } = renderTensor('<p>before</p>');
    await settleLayout();
    act(() => {
      editor.commands.focus();
      editor.commands.insertEquation();
    });
    const eq = findEquation(editor)!;
    // 10 chars → 100px wide, 25.6px tall (FakeEquationMetrics).
    setLatex(editor, eq.pos, 'abcdefghij');
    await settleLayout();

    const { result } = directLayout(editor);
    const placed = result.placed.filter((p) => p.kind === 'equation');
    expect(placed).toHaveLength(1);
    expect(placed[0]!.rect.width).toBe(100);
    expect(placed[0]!.rect.height).toBe(25.6);
    // Centered: (624 − 100) / 2 = 262.
    expect(placed[0]!.rect.x).toBe(262);
    // The echo contract: paint data is the shell's to resolve.
    expect(placed[0]!.latex).toBe('abcdefghij');
    expect(placed[0]!.fontSize).toBe(16);
    // In flow: never in lines[].
    expect(result.lines.every((l) => l.blockId !== placed[0]!.blockId)).toBe(true);

    // The live view paints it (the DOM overlay, crisp — not canvas).
    const painted = document.querySelectorAll('[data-testid="equation-painted"]');
    expect(painted.length).toBe(1);
    expect(painted[0]!.querySelector('.katex')).not.toBeNull();
    expect(document.querySelector('[data-testid="equation-layer"]')).not.toBeNull();
  });

  it('the painted layer honors the broken-glyph law: empty → placeholder, invalid → styled face', async () => {
    const { editor } = renderTensor('<p>glyph</p>');
    await settleLayout();
    act(() => {
      editor.commands.focus();
      editor.commands.insertEquation();
    });
    await settleLayout();
    // EMPTY (just inserted) → the dashed placeholder in the layer.
    let painted = document.querySelector('[data-testid="equation-painted"]');
    expect(painted?.getAttribute('data-resolved')).toBe('empty');
    expect(painted?.querySelector('.tensor-equation-placeholder')).not.toBeNull();

    // INVALID → the styled invalid face, never KaTeX's red error text.
    const eq = findEquation(editor)!;
    setLatex(editor, eq.pos, '\\frac{1}{');
    await settleLayout();
    painted = document.querySelector('[data-testid="equation-painted"]');
    expect(painted?.getAttribute('data-resolved')).toBe('invalid');
    expect(painted?.querySelector('.katex-error')).toBeNull();
    expect(painted?.querySelector('.tensor-equation-invalid')).not.toBeNull();
  });

  it('an align edit moves the placed rect (left/center/right, the one alignOffset derivation)', async () => {
    const { editor } = renderTensor('<p>align</p>');
    await settleLayout();
    act(() => {
      editor.commands.focus();
      editor.commands.insertEquation();
    });
    const eq = findEquation(editor)!;
    setLatex(editor, eq.pos, 'abcdefghij');
    act(() => {
      editor.chain().command(({ tr }) => {
        tr.setNodeMarkup(eq.pos, undefined, { latex: 'abcdefghij', align: 'left' });
        return true;
      }).run();
    });
    await settleLayout();
    const { result } = directLayout(editor);
    expect(result.placed.find((p) => p.kind === 'equation')!.rect.x).toBe(0);
  });
});

// ─── 4. The clipboard marker (the M-IMAGES-2.2 law) ────────────────────

describe('clipboard marker', () => {
  it('serializes to its OWN marker and parses back; external math never parses in', () => {
    const { editor } = renderTensor('<p>clip</p>');
    act(() => {
      editor.commands.focus();
      editor.commands.insertEquation();
    });
    const eq = findEquation(editor)!;
    setLatex(editor, eq.pos, 'x^{2}+y^{2}=z^{2}');

    const html = editor.getHTML();
    // The marker + the source (the future PDF/DOCX export hook).
    expect(html).toContain('data-tensor-equation="true"');
    expect(html).toContain('data-latex="x^{2}+y^{2}=z^{2}"');
    // NO rendered math in the serialization — display-only projection.
    expect(html).not.toContain('katex');

    // Round-trip: setContent of its own HTML re-parses the node exactly.
    act(() => {
      editor.commands.setContent(html);
    });
    const reparsed = findEquation(editor)!;
    expect(reparsed.attrs.latex).toBe('x^{2}+y^{2}=z^{2}');
    expect(reparsed.attrs.align).toBe('center');

    // EXTERNAL math is refused by construction: a web page's <math>
    // (MathML) has no marker — it parses in as nothing.
    act(() => {
      editor.commands.setContent('<p>ext</p><math><mi>x</mi></math>');
    });
    expect(findEquation(editor)).toBeNull();
  });
});

// ─── 5. The .wpdoc round-trip ───────────────────────────────────────────

describe('wpdoc round-trip', () => {
  it('insert → save → reopen: the latex source rides document.json intact; NO media involved', async () => {
    const { editor } = renderTensor('<p>rt</p>');
    await settleLayout();
    act(() => {
      editor.commands.focus();
      editor.commands.insertEquation();
    });
    const eq = findEquation(editor)!;
    setLatex(editor, eq.pos, '\\int_{0}^{\\infty} e^{-x^{2}}\\,dx');

    const file = {
      version: 1,
      docJSON: editor.getJSON(),
      metadata: { modifiedAt: '2026-01-01T00:00:00.000Z' },
    } as const;
    await saveWpdoc('/x/eq.wpdoc', file);
    const opened = await openWpdoc('/x/eq.wpdoc');
    // The attrs (the node's ONLY document data) survive byte-identical:
    expect(opened.docJSON).toEqual(file.docJSON);
    const node = (opened.docJSON as { content: { type: string; attrs?: Record<string, unknown> }[] }).content
      ?.find((n) => n.type === 'equation');
    expect(node?.attrs?.latex).toBe('\\int_{0}^{\\infty} e^{-x^{2}}\\,dx');
    // No media — the equation is pure text data in the container:
    expect(wpdocFiles.get('/x/eq.wpdoc')!.media).toEqual([]);

    // Reopened into a live editor: still editable (the acceptance's
    // "intact AND still editable" bar).
    act(() => {
      editor.commands.setContent(opened.docJSON as Parameters<typeof editor.commands.setContent>[0]);
    });
    const reopened = findEquation(editor)!;
    expect(reopened.attrs.latex).toBe('\\int_{0}^{\\infty} e^{-x^{2}}\\,dx');
    act(() => {
      editor.chain().command(({ tr }) => {
        tr.setNodeMarkup(reopened.pos, undefined, { latex: '\\int_{0}^{1} x\\,dx', align: 'center' });
        return true;
      }).run();
    });
    expect(findEquation(editor)!.attrs.latex).toBe('\\int_{0}^{1} x\\,dx');
  });
});

// ─── 6. The assisted-input bubble ───────────────────────────────────────

describe('editor bubble (assisted input)', () => {
  it('insertEquation opens the bubble; typing the source live-applies to the node; Escape closes', async () => {
    const { editor } = renderTensor('<p>bubble</p>');
    await settleLayout();
    act(() => {
      editor.commands.focus();
      editor.commands.insertEquation();
    });
    // The MathLive loader rejects in jsdom — the bubble falls back to
    // the Source textarea (the fallback law). One settle covers the
    // async fallback flip.
    await settleLayout(80);
    // The reactive path opened it (the selection IS the open trigger).
    const bubble = document.querySelector('[data-equation-bubble]');
    expect(bubble).not.toBeNull();
    const source = document.querySelector('[data-testid="equation-bubble-source"]') as HTMLTextAreaElement;
    expect(source).not.toBeNull();

    // Live-apply: typing in the source writes the node's attrs
    // immediately (no Save step to lose work behind).
    await act(async () => {
      fireEvent.change(source, { target: { value: '\\frac{a}{b}' } });
    });
    expect(findEquation(editor)!.attrs.latex).toBe('\\frac{a}{b}');
    // The document is the live preview (no preview pane): the node
    // view re-renders the committed projection.
    expect(document.querySelector('[data-testid="equation-render"] .katex')).not.toBeNull();

    // The palette (the no-LaTeX-knowledge path): a template button
    // splices its skeleton into the source at the cursor.
    const fraction = document.querySelector('[data-testid="equation-template-fraction"]') as HTMLButtonElement;
    expect(fraction).not.toBeNull();
    await act(async () => {
      fireEvent.click(fraction);
    });
    expect(findEquation(editor)!.attrs.latex).toBe('\\frac{a}{b}\\frac{a}{b}');
    // A symbol button (the Symbols tab) inserts its latex source:
    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="equation-bubble-tab-symbols"]')!);
    });
    const alpha = document.querySelector('[data-testid="equation-symbol-alpha"]') as HTMLButtonElement;
    expect(alpha).not.toBeNull();
    await act(async () => {
      fireEvent.click(alpha);
    });
    expect(findEquation(editor)!.attrs.latex).toBe('\\frac{a}{b}\\frac{a}{b}\\alpha');

    // The parse error surfaces in the bubble (never in the document):
    // the ONE in-bubble failure signal — the preview pane is gone, so
    // the line shows ONLY while the source does not parse.
    await act(async () => {
      fireEvent.change(source, { target: { value: '\\sqrt{' } });
    });
    expect(document.querySelector('[data-testid="equation-bubble-error"]')).not.toBeNull();

    // Escape closes; the node keeps the last committed latex.
    await act(async () => {
      fireEvent.keyDown(bubble!, { key: 'Escape' });
    });
    expect(document.querySelector('[data-equation-bubble]')).toBeNull();
    expect(findEquation(editor)!.attrs.latex).toBe('\\sqrt{');
  });

  it('the bubble opens on a PLAIN CLICK into an existing equation (the edit-back path)', async () => {
    const { editor } = renderTensor('<p>click</p>');
    await settleLayout();
    act(() => {
      editor.commands.focus();
      editor.commands.insertEquation();
    });
    const eq = findEquation(editor)!;
    setLatex(editor, eq.pos, 'a^{2}');
    await settleLayout(80);
    // Close the insertion-time bubble first, then re-select the node —
    // the same state a user's click produces (PaginatedView resolves
    // the click to setNodeSelection; the bubble's open arm is HERE).
    await act(async () => {
      fireEvent.keyDown(document.querySelector('[data-equation-bubble]')!, { key: 'Escape' });
    });
    expect(document.querySelector('[data-equation-bubble]')).toBeNull();
    // Move the selection AWAY (the user clicked elsewhere), then click
    // back into the equation — a NodeSelection change is the open arm.
    await act(async () => {
      editor.commands.focus();
      editor.commands.setTextSelection(1);
    });
    expect(document.querySelector('[data-equation-bubble]')).toBeNull();
    await act(async () => {
      editor.commands.setNodeSelection(eq.pos);
    });
    await settleLayout(80);
    expect(document.querySelector('[data-equation-bubble]')).not.toBeNull();
    const source = document.querySelector('[data-testid="equation-bubble-source"]') as HTMLTextAreaElement;
    expect(source.value).toBe('a^{2}');
  });
});

// ─── 7. Catalog + render surface sanity ─────────────────────────────────

describe('catalogs and render surface', () => {
  it('the catalogs are non-empty, named, and every entry parses', () => {
    const symbolCategories = Object.keys(MATH_SYMBOLS);
    expect(symbolCategories.length).toBeGreaterThanOrEqual(6);
    for (const [, symbols] of Object.entries(MATH_SYMBOLS)) {
      expect(symbols.length).toBeGreaterThan(0);
      for (const s of symbols) {
        expect(s.name.length).toBeGreaterThan(0);
        expect(parseEquation(s.latex)).toBeNull();
      }
    }
    for (const group of MATH_TEMPLATES) {
      expect(group.templates.length).toBeGreaterThan(0);
      for (const tpl of group.templates) {
        expect(parseEquation(tpl.latex)).toBeNull();
      }
    }
  });

  it('renderEquation is display-mode and deterministic; renderInlineMath is inline', () => {
    const html = renderEquation('x');
    expect(html).toContain('katex-display');
    expect(html).toBe(renderEquation('x'));
    const inline = renderInlineMath('\\alpha');
    expect(inline).not.toContain('katex-display');
    expect(inline).toContain('katex');
  });
});

// ─── 8. The over-tall sentinel through the projection ───────────────────

describe('sentinel', () => {
  it('an equation taller than the content box throws the SENTINEL (the fallback family)', () => {
    const { editor } = renderTensor('<p>tall</p>');
    act(() => {
      editor.commands.focus();
      editor.commands.insertEquation();
    });
    const eq = findEquation(editor)!;
    // fontSize 16 × 1.6 = 25.6px tall — never over-tall through the
    // fake at doc defaults; drive the port directly to pin the class
    // the shell's catch dispatches on.
    expect(EquationTooTallError).toBeDefined();
    const err = new EquationTooTallError('x');
    expect(err.name).toBe('EquationTooTallError');
    expect(err instanceof Error).toBe(true);
    // (The engine suite pins the throw itself; here the projection-side
    // export is the contract: PaginatedView's catch family.)
    void eq;
  });
});

// ─── 9. Selection → equation (M-EQ-2) ───────────────────────────────────

describe('selection to equation', () => {
  it('selecting plain text and inserting converts it: the selection becomes the equation source', async () => {
    const { editor } = renderTensor('<p>1/2+2=3a</p>');
    await settleLayout();
    act(() => {
      editor.commands.focus();
      // Select the paragraph's text exactly (an 8-char run at [1, 9)).
      editor.commands.setTextSelection({ from: 1, to: 9 });
    });
    act(() => {
      editor.commands.insertEquation();
    });
    const eq = findEquation(editor)!;
    // The captured text IS the starting source — the WYSIWYG surface
    // is where it gets restructured into styled math.
    expect(eq.attrs.latex).toBe('1/2+2=3a');
    // The text was consumed (attrs are not text content — the doc's
    // text carries no trace of the selection).
    expect(editor.state.doc.textContent).not.toContain('1/2+2=3a');
    expect(editor.state.selection.constructor.name).toBe('NodeSelection');
  });

  it('a collapsed caret still inserts an EMPTY equation (the v1 path)', () => {
    const { editor } = renderTensor('<p>keep</p>');
    act(() => {
      editor.commands.focus();
      editor.commands.insertEquation();
    });
    const eq = findEquation(editor)!;
    expect(eq.attrs.latex).toBe('');
    expect(editor.state.doc.content.firstChild!.textContent).toBe('keep');
  });
});

// ─── 10. Style attrs: color (paint-only) + scale (layout) ───────────────

describe('style attrs', () => {
  it('color: paint-only attr — null default, data-color serialization, node-view application', async () => {
    const { editor } = renderTensor('<p>color</p>');
    await settleLayout();
    act(() => {
      editor.commands.focus();
      editor.commands.insertEquation();
    });
    const eq = findEquation(editor)!;
    // The DEFAULT is null = inherit (the document default text color).
    expect(eq.attrs.color).toBeNull();
    expect(editor.getHTML()).not.toContain('data-color');

    // Set a color: the attr rides, the node view paints it explicitly,
    // and the marker serializes it (clipboard + export).
    act(() => {
      editor.chain().command(({ tr }) => {
        tr.setNodeMarkup(eq.pos, undefined, {
          latex: 'x',
          align: 'center',
          color: '#dc2626',
          scale: 1,
        });
        return true;
      }).run();
    });
    await settleLayout(80);
    expect(findEquation(editor)!.attrs.color).toBe('#dc2626');
    expect(editor.getHTML()).toContain('data-color="#dc2626"');
    const nodeView = document.querySelector('[data-equation-node]') as HTMLElement;
    expect(nodeView?.style.color).toBe('rgb(220, 38, 38)');

    // Round-trip through the marker:
    const html = editor.getHTML();
    act(() => {
      editor.commands.setContent(html);
    });
    expect(findEquation(editor)!.attrs.color).toBe('#dc2626');

    // Back to null: no data-color, inherit (no inline color).
    act(() => {
      editor.chain().command(({ tr }) => {
        tr.setNodeMarkup(eq.pos, undefined, {
          latex: 'x',
          align: 'center',
          color: null,
          scale: 1,
        });
        return true;
      }).run();
    });
    await settleLayout(80);
    expect(editor.getHTML()).not.toContain('data-color');
    const viewAfter = document.querySelector('[data-equation-node]') as HTMLElement;
    expect(viewAfter?.style.color).toBe('');
  });

  it('scale: LAYOUT-relevant — the adapter folds it into the metrics fontSize key', async () => {
    const { editor } = renderTensor('<p>scale</p>');
    await settleLayout();
    act(() => {
      editor.commands.focus();
      editor.commands.insertEquation();
    });
    const eq = findEquation(editor)!;
    expect(eq.attrs.scale).toBe(1);
    // 16px doc default × 1.5 = 24px metrics key (a bigger equation).
    act(() => {
      editor.chain().command(({ tr }) => {
        tr.setNodeMarkup(eq.pos, undefined, {
          latex: 'x',
          align: 'center',
          color: null,
          scale: 1.5,
        });
        return true;
      }).run();
    });
    await settleLayout(80);
    const adapted = pmDocToSemantic(editor.state.doc, BASE);
    const block = adapted.doc.blocks.find((b) => b.kind === 'equation') as { fontSize: number };
    expect(block.fontSize).toBe(24);
    // The serialization rides (clipboard + export):
    expect(editor.getHTML()).toContain('data-scale="1.5"');
  });

  it('the paginated overlay paints the node color, else the DOCUMENT default (never chrome)', async () => {
    const { editor } = renderTensor('<p>paint</p>');
    await settleLayout();
    act(() => {
      editor.commands.focus();
      editor.commands.insertEquation();
    });
    const eq = findEquation(editor)!;
    setLatex(editor, eq.pos, 'x');
    await settleLayout();
    // No color attr → the layer paints the DOCUMENT default (#000000 —
    // the canvas text's own default), never chrome --foreground.
    let painted = document.querySelector('[data-testid="equation-painted"]') as HTMLElement;
    expect(painted.style.color).toBe('rgb(0, 0, 0)');

    // An explicit color attr paints through the map (the imageRadii
    // precedent — paint facts derived from the PM doc, not the engine).
    act(() => {
      editor.chain().command(({ tr }) => {
        tr.setNodeMarkup(eq.pos, undefined, {
          latex: 'x',
          align: 'center',
          color: '#2563eb',
          scale: 1,
        });
        return true;
      }).run();
    });
    await settleLayout(80);
    painted = document.querySelector('[data-testid="equation-painted"]') as HTMLElement;
    expect(painted.style.color).toBe('rgb(37, 99, 235)');
  });

  it('the catalogs carry MathLive insertion forms (placeholders) for structures', () => {
    for (const group of MATH_TEMPLATES) {
      for (const tpl of group.templates) {
        if (tpl.mf) {
          // The inline-editing form: a caret placeholder at minimum —
          // the palette's "click, caret lands inside the new slot"
          // contract.
          expect(tpl.mf).toMatch(/#\?|#@/);
        }
      }
    }
    // Spot-pins: the fraction takes the SELECTION as the numerator and
    // lands the caret in the denominator (the "click fraction and edit
    // it inline" ruling); sqrt wraps the selection.
    const fraction = MATH_TEMPLATES[0]!.templates.find((t) => t.name === 'fraction')!;
    expect(fraction.mf).toBe('\\frac{#@}{#?}');
    const sqrt = MATH_TEMPLATES[0]!.templates.find((t) => t.name === 'square root')!;
    expect(sqrt.mf).toBe('\\sqrt{#@}');
  });
});

// ─── 11. The MathLive → document boundary (M-EQ-2) ──────────────────────

describe('mathlive boundary', () => {
  it('sanitizeMathliveLatex: editing tokens never reach the document latex', () => {
    // Empty-argument slots (\placeholder{} — MathLive's serializer
    // spelling) become EMPTY arguments, not parse errors.
    expect(sanitizeMathliveLatex('\\frac{1}{\\placeholder{}}')).toBe('\\frac{1}{}');
    expect(sanitizeMathliveLatex('\\placeholder{}')).toBe('');
    expect(sanitizeMathliveLatex('\\sqrt[\\placeholder{}]{x}')).toBe('\\sqrt[]{x}');
    // The optional-arg spelling and wrapped content.
    expect(sanitizeMathliveLatex('a\\placeholder[#?]{note}b')).toBe('ab');
    // MathLive-only letter spellings (the ii/jj/ee shortcuts) map to
    // plain letters KaTeX knows.
    expect(sanitizeMathliveLatex('\\imaginaryI + \\exponentialE')).toBe('i + e');
    expect(sanitizeMathliveLatex('\\imaginaryJ\\differentialD')).toBe('jd');
    // The diagonal fraction maps to the stacked spelling.
    expect(sanitizeMathliveLatex('\\nicefrac{3}{4}')).toBe('\\frac{3}{4}');
    // Plain latex passes through byte-identical.
    expect(sanitizeMathliveLatex('x^{2} + \\sqrt{y}')).toBe('x^{2} + \\sqrt{y}');
  });

  it('the slash-to-fraction shortcut is pinned: the main-row / has NO default binding (verified against the dist), so Tensor ADDS it over the defaults', () => {
    // The read-extend-write contract: extending, never replacing
    // (assigning inlineShortcuts replaces wholesale — a partial set
    // would silently lose sqrt/pi/sum).
    expect(FRACTION_SLASH_SHORTCUT.value).toBe('\\frac{#@}{#?}');
    // `#@` = the just-typed token (numerator), `#?` = the slot the
    // caret lands in (denominator) — typing "2/3" grows the fraction.
    expect(FRACTION_SLASH_SHORTCUT.after).not.toContain('text');
  });

  it('through the SOURCE box too: placeholder-ful input commits sanitized — the document shows RENDERED math, never the raw-source invalid face', async () => {
    const { editor } = renderTensor('<p>b</p>');
    await settleLayout();
    act(() => {
      editor.commands.focus();
      editor.commands.insertEquation();
    });
    await settleLayout(80);
    // (MathLive is mocked out here — the Source textarea is the
    // surface; the boundary is the SAME one the field rides.)
    const source = document.querySelector('[data-testid="equation-bubble-source"]') as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(source, { target: { value: '\\frac{1}{\\placeholder{}}' } });
    });
    // The node's committed latex is the SANITIZED document latex…
    expect(findEquation(editor)!.attrs.latex).toBe('\\frac{1}{}');
    // …so the document renders math (no raw-source invalid face), the
    // bubble shows NO error line, and there is NO preview pane (the
    // document is the preview).
    expect(document.querySelector('[data-testid="equation-invalid"]')).toBeNull();
    expect(document.querySelector('[data-testid="equation-bubble-error"]')).toBeNull();
    expect(document.querySelector('[data-testid="equation-bubble-preview"]')).toBeNull();
    expect(document.querySelector('[data-testid="equation-render"] .katex')).not.toBeNull();
  });
});

// ─── 12. The style-highlight refresh (the stale-open-state fix) ────────

describe('style highlight refresh', () => {
  it('clicking S moves the highlight off M (attrs refresh while the bubble is pinned)', async () => {
    const { editor } = renderTensor('<p>hl</p>');
    await settleLayout();
    act(() => {
      editor.commands.focus();
      editor.commands.insertEquation();
    });
    await settleLayout(80);

    const scaleS = document.querySelector('[data-testid="equation-scale-S"]')!;
    const scaleM = document.querySelector('[data-testid="equation-scale-M"]')!;
    // M (the default) starts active:
    expect(scaleM.getAttribute('aria-pressed')).toBe('true');
    expect(scaleS.getAttribute('aria-pressed')).toBe('false');

    await act(async () => {
      fireEvent.pointerDown(scaleS, { button: 0, pointerId: 1 });
      fireEvent.pointerUp(scaleS, { pointerId: 1 });
      fireEvent.click(scaleS);
    });
    // The attr commits…
    expect(findEquation(editor)!.attrs.scale).toBe(0.75);
    // …and the HIGHLIGHT MOVES (state refreshes mid-interaction —
    // the stale-open-time-snapshot bug's pin):
    expect(scaleS.getAttribute('aria-pressed')).toBe('true');
    expect(scaleM.getAttribute('aria-pressed')).toBe('false');
  });

  it('the alignment highlight moves the same way', async () => {
    const { editor } = renderTensor('<p>al</p>');
    await settleLayout();
    act(() => {
      editor.commands.focus();
      editor.commands.insertEquation();
    });
    await settleLayout(80);
    const alignRight = document.querySelector('[data-testid="equation-align-right"]')!;
    expect(alignRight.getAttribute('aria-pressed')).toBe('false');
    await act(async () => {
      fireEvent.click(alignRight);
    });
    expect(findEquation(editor)!.attrs.align).toBe('right');
    expect(alignRight.getAttribute('aria-pressed')).toBe('true');
    expect(
      document.querySelector('[data-testid="equation-align-center"]')!.getAttribute('aria-pressed'),
    ).toBe('false');
  });
});

// ─── 13. The bubble's chrome shape (M-EQ-2 polish) ─────────────────────

describe('bubble chrome', () => {
  it('the footer is a REAL footer: edge-to-edge (the DialogFooter negative-margin pattern), no preview pane, no close X', async () => {
    const { editor } = renderTensor('<p>chrome</p>');
    await settleLayout();
    act(() => {
      editor.commands.focus();
      editor.commands.insertEquation();
    });
    await settleLayout(80);

    // NO preview pane (the document is the live preview — the user
    // ruling) and NO header X (Done/Escape/click-away own closing):
    expect(document.querySelector('[data-testid="equation-bubble-preview"]')).toBeNull();
    const header = document.querySelector('[data-testid="equation-bubble-header"]')!;
    expect(header.querySelector('button')).toBeNull();

    // The footer: the app's DialogFooter pattern (ui/dialog.tsx) —
    // negative margins (-mx-3 -mb-3) escaping the root's p-3 so the
    // rule and the muted band run edge-to-edge, rounded to the
    // bubble's bottom corners.
    const footer = document.querySelector('[data-testid="equation-bubble-footer"]') as HTMLElement;
    expect(footer).not.toBeNull();
    expect(footer.className).toContain('-mx-3');
    expect(footer.className).toContain('-mb-3');
    expect(footer.className).toContain('border-t');
    expect(footer.className).toContain('rounded-b-lg');
    // The bubble's own padding is p-3 — the pinned escape values:
    const bubble = document.querySelector('[data-equation-bubble]') as HTMLElement;
    expect(bubble.className).toContain('p-3');

    // THE FLOATING PANEL (the drag-over-the-ribbon fix): the bubble
    // renders through a BODY portal at fixed position + max z — it
    // escapes the editor's scroll container, whose overflow clip (not
    // any z-index) is what put a dragged bubble under the ribbon.
    expect(document.body.contains(bubble)).toBe(true);
    expect(bubble.parentElement).toBe(document.body);
    expect(bubble.className).toContain('fixed');
    expect(bubble.className).toContain('z-[9999]');

    // The input surface (the Source textarea in this fallback
    // environment — the field wrapper carries the same recipe) speaks
    // the shadcn Input treatment: border-input + the --ring accent on
    // focus, never the UA focus ring MathLive's host draws by default.
    const source = document.querySelector('[data-testid="equation-bubble-source"]') as HTMLTextAreaElement;
    expect(source.className).toContain('border-input');
    expect(source.className).toContain('focus-visible:ring-ring/50');
    expect(source.className).toContain('focus-visible:border-ring');
  });
});

// ─── 14. The drag handle (M-EQ-2 polish) ────────────────────────────────

describe('drag handle', () => {  it('dragging the header moves the bubble by the pointer delta; the style toolbar is not a handle', async () => {
    const { editor } = renderTensor('<p>drag</p>');
    await settleLayout();
    act(() => {
      editor.commands.focus();
      editor.commands.insertEquation();
    });
    await settleLayout(80);
    const bubble = document.querySelector('[data-equation-bubble]') as HTMLElement;
    const header = document.querySelector('[data-testid="equation-bubble-header"]')!;
    const leftBefore = parseFloat(bubble.style.left);
    const topBefore = parseFloat(bubble.style.top);

    await act(async () => {
      fireEvent.pointerDown(header, { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
      fireEvent.pointerMove(header, { pointerId: 1, clientX: 125, clientY: 108 });
      fireEvent.pointerUp(header, { pointerId: 1 });
    });
    // The offset rides the anchor: +25px right, +8px down.
    expect(parseFloat(bubble.style.left)).toBeCloseTo(leftBefore + 25, 5);
    expect(parseFloat(bubble.style.top)).toBeCloseTo(topBefore + 8, 5);
    // A second drag ACCUMULATES from the moved position.
    const leftMid = parseFloat(bubble.style.left);
    await act(async () => {
      fireEvent.pointerDown(header, { button: 0, pointerId: 1, clientX: 300, clientY: 200 });
      fireEvent.pointerMove(header, { pointerId: 1, clientX: 290, clientY: 200 });
      fireEvent.pointerUp(header, { pointerId: 1 });
    });
    expect(parseFloat(bubble.style.left)).toBeCloseTo(leftMid - 10, 5);
  });
});