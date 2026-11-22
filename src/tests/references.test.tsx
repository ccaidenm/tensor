import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import type { JSONContent } from '@tiptap/core';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { useDocumentStore } from '@/lib/document/store';
import { useConfigStore } from '@/lib/config/store';
import { renderTensor, settleLayout, GEOMETRY } from './harness';
import { useInsertReferenceTableStore } from '@/components/dialogs/InsertReferenceTableDialog';
import { InsertReferenceTableDialog } from '@/components/dialogs/InsertReferenceTableDialog';
import { CommandPalette } from '@/components/palette/CommandPalette';
import { usePaletteStore } from '@/lib/palette/store';
import { getCommand, COMMANDS } from '@/lib/commands/registry';
import { indexEntryActive } from '@/lib/editor/IndexMark';
import { insertReferenceTableAtSelection } from '@/lib/editor/ReferenceTableNode';
import { enableRegion, selectionInBand } from '@/lib/editor/headerFooterCommands';
import { selectionInReferenceTable } from '@/lib/ribbon/useRibbonContext';
import { ReferenceTableTools } from '@/components/layout/ribbon/contextual/ReferenceTableTools';
import { pmDocToSemantic } from '@/lib/paginated/adapter';
import { blockOffsetToPmPos, pmPosToBlockOffset } from '@/lib/paginated/positionMap';
import { resolveNormalBase } from '@/lib/styles/resolve';
import { useStyleRegistryStore } from '@/lib/styles/registry';
import {
  scanCollections,
  entriesForKind,
} from '@/lib/references/scan';
import { REFERENCE_SCAN_DEBOUNCE_MS } from '@/lib/references/store';
import { DEFAULT_MARGINS, PAGE_GAP } from '@/lib/document/pageSetup';
import * as paintModule from '@/lib/paginated/paint';

/**
 * #31 — the reference-collection shell: the scanner, the node/mark
 * model, the adapter projection + sidecar, NodeView auto-update, click
 * navigation in both view modes, and the command/dialog wiring.
 * Engine-side: engine/tests/referenceTable.test.ts.
 */

function setPageless() {
  const state = useConfigStore.getState();
  useConfigStore.setState({
    config: { ...state.config, editor: { ...state.config.editor, defaultPageLayout: 'Pageless' } },
  });
}

beforeEach(() => {
  useConfigStore.setState({
    config: {
      ...useConfigStore.getState().config,
      editor: { ...useConfigStore.getState().config.editor, defaultPageLayout: 'Pages' },
    },
  });
  useDocumentStore.setState({
    pageSetup: { pageSize: 'Letter', margins: DEFAULT_MARGINS, pageGap: PAGE_GAP },
  });
});

const sleep = (ms: number) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

/** The debounce window + a React flush. */
const settleScan = () => sleep(REFERENCE_SCAN_DEBOUNCE_MS + 60);


/** Row text EXCLUDING the leader-dots span (the generator's own ink —
 *  refLeader-marked; row assertions compare ENTRY text). */
function rowText(paragraph: { forEach: (cb: (n: { isText?: boolean; text?: string; marks?: Array<{ type: { name: string } }> }) => void) => void }): string {
  let out = '';
  paragraph.forEach((inline) => {
    if (!inline.isText) return;
    if (inline.marks?.some((m) => m.type.name === 'refLeader')) return;
    out += inline.text ?? '';
  });
  return out;
}

describe('the scanner (pure model facts)', () => {
  it('collects body headings with levels, in document order', () => {
    const { editor } = renderTensor(
      `<h1>Alpha</h1><p>body</p><h2>Beta</h2><h3>Gamma</h3>`,
    );
    const scan = scanCollections(editor.state.doc);
    expect(scan.toc.map((e) => [e.text, e.level])).toEqual([
      ['Alpha', 1],
      ['Beta', 2],
      ['Gamma', 3],
    ]);
  });

  it('skips band subtrees — a heading in a header is chrome, never a ToC entry', () => {
    const { editor } = renderTensor(`<h1>Body Heading</h1>`);
    enableRegion(editor, 'header');
    act(() => {
      editor.chain().focus().insertContentAt(editor.state.selection.from, {
        type: 'heading',
        attrs: { level: 1 },
        content: [{ type: 'text', text: 'Band Heading' }],
      }).run();
    });
    const scan = scanCollections(editor.state.doc);
    expect(scan.toc.map((e) => e.text)).toEqual(['Body Heading']);
  });

  it('figures: block image + caption-styled sibling; empty captions skipped; inline images are not figures', () => {
    const { editor } = renderTensor('');
    act(() => {
      editor.commands.insertContent([
        { type: 'image', attrs: { src: 'media://x', width: 100, height: 50 } },
        { type: 'paragraph', attrs: { styleId: 'caption' }, content: [{ type: 'text', text: 'A caption' }] },
        { type: 'image', attrs: { src: 'media://y', width: 100, height: 50 } },
        { type: 'paragraph', attrs: { styleId: 'caption' }, content: [{ type: 'text', text: '   ' }] },
        { type: 'paragraph', attrs: { styleId: 'caption' }, content: [{ type: 'text', text: 'No image above' }] },
      ]);
    });
    const scan = scanCollections(editor.state.doc);
    expect(scan.figures.map((e) => e.text)).toEqual(['A caption']);
  });

  it('index: groups by exact trimmed term, case-insensitive sort, one location per occurrence in doc order', () => {
    const { editor } = renderTensor(
      `<p><span data-tensor-index="true">banana</span></p>
       <p><span data-tensor-index="true">Apple</span> and <span data-tensor-index="true">Tensor</span></p>
       <p><span data-tensor-index="true">Tensor</span> again, and <span data-tensor-index="true">cherry</span></p>`,
    );
    const scan = scanCollections(editor.state.doc);
    expect(scan.index.map((e) => e.text)).toEqual(['Apple', 'banana', 'cherry', 'Tensor']);
    expect(scan.index.find((e) => e.text === 'Tensor')!.targets).toHaveLength(2);
    const t1 = scan.index.find((e) => e.text === 'Tensor')!;
    expect(t1.targets[0]!.pos).toBeLessThan(t1.targets[1]!.pos);
  });

  it('index: adjacent marked text nodes across a formatting boundary are ONE span', () => {
    const { editor } = renderTensor(`<p>xxTensor yy</p>`);
    act(() => {
      // Mark "Tens" and "or" separately — adjacent ranges, one term.
      editor.chain().setTextSelection({ from: 3, to: 7 }).setIndexEntry().run();
      editor.chain().setTextSelection({ from: 7, to: 9 }).setIndexEntry().run();
    });
    const scan = scanCollections(editor.state.doc);
    expect(scan.index.map((e) => e.text)).toEqual(['Tensor']);
    expect(scan.index[0]!.targets).toHaveLength(1);
  });

  it('is memoized per doc version — the SAME scan object until the doc changes', () => {
    const { editor } = renderTensor(`<h1>Alpha</h1>`);
    const doc = editor.state.doc;
    expect(scanCollections(doc)).toBe(scanCollections(doc));
    act(() => {
      editor.chain().focus().insertContentAt(editor.state.doc.content.size, {
        type: 'heading',
        attrs: { level: 2 },
        content: [{ type: 'text', text: 'Beta' }],
      }).run();
    });
    expect(scanCollections(editor.state.doc)).not.toBe(scanCollections(doc));
  });

  it('entriesForKind filters a ToC by depth; figures/index ignore depth', () => {
    const { editor } = renderTensor(`<h1>A</h1><h2>B</h2><h3>C</h3><h4>D</h4>`);
    const scan = scanCollections(editor.state.doc);
    expect(entriesForKind(scan, 'toc', 2).map((e) => e.text)).toEqual(['A', 'B']);
    expect(entriesForKind(scan, 'toc', 6).map((e) => e.text)).toEqual(['A', 'B', 'C', 'D']);
    expect(entriesForKind(scan, 'figures', 1)).toEqual(scan.figures);
  });
});

/** Count nodes of a kind via a manual walk (PM descendants returns a
 * boolean, not a count — never use its return value). */
function countNodes(editor: ReturnType<typeof renderTensor>['editor'], typeName: string): number {
  let n = 0;
  editor.state.doc.descendants((node) => {
    if (node.type.name === typeName) n += 1;
  });
  return n;
}

describe('the referenceTable node + indexEntry mark (model)', () => {
  it('inserts a container whose generator fills real entry paragraphs; round-trips (the .wpdoc path rides docJSON)', () => {
    const { editor } = renderTensor(`<p>before</p><p>after</p><h1>Head</h1>`);
    act(() => {
      editor.commands.setTextSelection(7); // inside "before"
      editor.commands.insertReferenceTable('toc', 2);
    });
    let containerNode: ReturnType<typeof editor.state.doc.nodeAt> = null;
    editor.state.doc.forEach((n) => {
      if (n.type.name === 'referenceTable' && containerNode == null) containerNode = n;
    });
    expect(containerNode).not.toBeNull();
    expect(containerNode!.attrs.kind).toBe('toc');
    expect(containerNode!.attrs.depth).toBe(2);
    // No title row — rows only; each row ends with the leader-dots
    // span (real text, refLeader-marked).
    expect(containerNode!.childCount).toBe(1);
    expect(rowText(containerNode!.child(0) as unknown as Parameters<typeof rowText>[0])).toBe('Head');
    expect(containerNode!.child(0).textContent.endsWith('....')).toBe(true);
    expect(typeof containerNode!.child(0).attrs.refId).toBe('string');

    // getJSON → setContent: the .wpdoc round-trip — children are
    // REAL content and serialize with the container.
    const json = editor.getJSON();
    act(() => {
      editor.commands.setContent(json as JSONContent);
    });
    expect(editor.state.doc.textContent).toContain('before');
    expect(countNodes(editor, 'referenceTable')).toBe(1);
    expect(
      (() => {
        let text = '';
        editor.state.doc.forEach((n) => {
          if (n.type.name === 'referenceTable') n.forEach((c) => { text += c.textContent; });
        });
        return text;
      })()
    ).toContain('Head');

    // Index mark round-trips through the clipboard-scoped marker.
    act(() => {
      editor.commands.setTextSelection({ from: 1, to: 7 }); // "before"
      editor.commands.setIndexEntry();
    });
    expect(indexEntryActive(editor.state)).toBe(true);
    const json2 = editor.getJSON();
    act(() => {
      editor.commands.setContent(json2 as JSONContent);
    });
    act(() => {
      editor.commands.setTextSelection({ from: 1, to: 7 });
    });
    expect(indexEntryActive(editor.state)).toBe(true);
    act(() => {
      editor.commands.unsetIndexEntry();
    });
    expect(indexEntryActive(editor.state)).toBe(false);
  });

  it('THE GENERATOR: reconciliation, formatting survival, refresh-wins, and the defer rule', () => {
    const { editor } = renderTensor(`<h1>Alpha</h1><h2>Beta</h2>`);
    act(() => {
      editor.commands.setTextSelection(1);
      editor.commands.insertReferenceTable('toc', 3);
    });
    const childrenOf = () => {
      const out: Array<{ refId: string | null; text: string; bold: boolean }> = [];
      editor.state.doc.forEach((n) => {
        if (n.type.name !== 'referenceTable') return;
        n.forEach((c) => {
          const first = c.childCount > 0 ? c.child(0) : null;
          out.push({
            refId: typeof c.attrs.refId === 'string' && c.attrs.refId ? c.attrs.refId : null,
            text: rowText(c as unknown as Parameters<typeof rowText>[0]),
            bold: !!first?.marks.some((m) => m.type.name === 'bold'),
          });
        });
      });
      return out;
    };
    expect(childrenOf().map((c) => [c.text, c.bold])).toEqual([
      ['Alpha', false],
      ['Beta', false],
    ]);
    // THE LEADER SPAN: real text at each row's end, refLeader-marked —
    // the user formats it and the formatting SURVIVES reconciles.
    let dotsText = '';
    let dotsBold = false;
    editor.state.doc.forEach((n) => {
      if (n.type.name !== 'referenceTable') return;
      n.forEach((c) => {
        c.forEach((inline) => {
          if (inline.isText && inline.marks.some((m) => m.type.name === 'refLeader')) {
            dotsText = inline.text ?? '';
            dotsBold = inline.marks.some((m) => m.type.name === 'bold');
          }
        });
      });
    });
    expect(dotsText).toBe('.'.repeat(12));
    expect(dotsBold).toBe(false);

    // FORMATTING SURVIVAL: bold the "Alpha" entry, then retitle the
    // OTHER heading ("Beta" → "Beta!") — the Alpha entry is UNCHANGED
    // (same refId) so its node (and the bold) is reused verbatim; the
    // Beta entry rebuilds (refresh-wins text) and carries its old marks.
    const alphaEntryTextPos = (() => {
      let at: number | null = null;
      editor.state.doc.descendants((n, pos) => {
        if (
          n.type.name === 'paragraph' &&
          n.attrs.refId &&
          n.attrs.refId !== '__title' &&
          at === null
        ) {
          at = pos + 1;
        }
      });
      return at!;
    })();
    act(() => {
      editor.chain().setTextSelection({ from: alphaEntryTextPos, to: alphaEntryTextPos + 5 }).toggleBold().run();
    });
    expect(childrenOf()[0]!.bold).toBe(true);
    let betaPos: number | null = null;
    editor.state.doc.descendants((n, pos) => {
      if (n.type.name === 'heading' && n.attrs.level === 2 && betaPos === null) betaPos = pos + 1;
    });
    act(() => {
      editor.chain().focus().insertContentAt(betaPos!, { type: 'text', text: '!' }).run();
    });
    const after = childrenOf();
    expect(after[0]).toEqual({ refId: after[0]!.refId, text: 'Alpha', bold: true }); // SURVIVED
    expect(after[1]!.text).toBe('!Beta'); // refresh-wins (the "!" was inserted at the h2's start)
    expect(after[1]!.bold).toBe(false);

    // A removed heading removes its entry; ordering follows the doc.
    act(() => {
      const h1 = (() => {
        let at: number | null = null;
        editor.state.doc.descendants((n, pos) => {
          if (n.type.name === 'heading' && n.attrs.level === 1 && at === null) at = pos;
        });
        return at!;
      })();
      editor.commands.deleteRange({ from: h1, to: h1 + 8 });
    });
    expect(childrenOf().map((c) => c.text)).toEqual(['!Beta']);
  });

  it('the insertion helper refuses bands and table cells with a toast, never silently', async () => {
    const { editor } = renderTensor(`<h1>H</h1>`);
    // enableRegion focuses the band's END — the caret is IN the band.
    act(() => {
      enableRegion(editor, 'header');
    });
    expect(selectionInBand(editor)).toBe(true);
    const okBand = insertReferenceTableAtSelection(editor, 'toc');
    expect(okBand).toBe(false);
    expect(countNodes(editor, 'referenceTable')).toBe(0);
  });
});

describe('the adapter projection (paginated model facts)', () => {
  const adapt = (editor: ReturnType<typeof renderTensor>['editor']) => {
    const registry = useStyleRegistryStore.getState();
    const base = resolveNormalBase('sans-serif', 16, registry.merged);
    return pmDocToSemantic(editor.state.doc, base, {
      definitions: registry.merged,
      epoch: registry.epoch,
    });
  };

  it('projects one ReferenceTableBlock with entries + the navigation sidecar', () => {
    const { editor } = renderTensor(`<h1>Alpha</h1><h2>Beta</h2>`);
    act(() => {
      editor.commands.setTextSelection(1);
      editor.commands.insertReferenceTable('toc', 3);
    });
    const adapted = adapt(editor);
    const block = adapted.doc.blocks.find((b) => b.kind === 'referenceTable');
    expect(block).toBeDefined();
    if (block?.kind !== 'referenceTable') return;
    // THE CONTAINER MODEL: entries come from the generator's real child
    // rows — [Alpha, Beta], each [text, DOTS, tab, ''] with leaderIndex.
    expect(block.entries.map((e) => e.runs[0])).toEqual([
      { text: 'Alpha', style: expect.objectContaining({ fontSize: 16 }) },
      { text: 'Beta', style: expect.objectContaining({ fontSize: 16 }) },
    ]);
    expect(
      block.entries.map((e) => (e.runs[1] as { text?: string }).text)
    ).toEqual(['.'.repeat(12), '.'.repeat(12)]);
    expect(block.entries[1]!.indentLeft).toBe(32); // Beta is level 2
    expect(block.entries[0]!.runs).toHaveLength(4); // text + dots + tab + number

    // The sidecar: per-entry relStart + the REAL text slice (entry
    // text + the seed dots — PM-mapped; the synthetic tab suffix is
    // NOT part of textLen); targets are PM positions.
    const adapter = adapted.blocks.find((b) => b.reference)!;
    expect(adapter.text).toBe('Alpha' + '.'.repeat(12) + '\tBeta' + '.'.repeat(12) + '\t');
    const entries = adapter.reference!.entries;
    expect(entries).toEqual([
      { relStart: expect.any(Number), leaderLen: 12, textStart: 0, textLen: 5 + 12, targets: [expect.any(Number)] },
      { relStart: expect.any(Number), leaderLen: 12, textStart: 18, textLen: 4 + 12, targets: [expect.any(Number)] },
    ]);
    // The offset→PM bridge: offset 0 lands INSIDE the first row's entry text.
    const pmAtZero = blockOffsetToPmPos(adapter, 0);
    const $zero = editor.state.doc.resolve(pmAtZero);
    expect($zero.parent.attrs.refId).not.toBeNull();
    expect(rowText($zero.parent as unknown as Parameters<typeof rowText>[0])).toBe('Alpha');
    // The reverse: a position inside the Beta row's text maps back into its slice.
    const beta = entries[1]!;
    const betaTextPos = adapter.from + beta.relStart;
    const back = pmPosToBlockOffset(adapted.blocks, betaTextPos + 2);
    expect(back?.block.id).toBe(adapter.id);
    expect(back?.offset).toBe(beta.textStart + 2);
  });

  it('an empty collection projects ONE placeholder entry with ZERO targets', () => {
    const { editor } = renderTensor(`<p>plain</p>`);
    act(() => {
      editor.commands.setTextSelection(1);
      editor.commands.insertReferenceTable('toc', 3);
    });
    const adapted = adapt(editor);
    const block = adapted.doc.blocks.find((b) => b.kind === 'referenceTable');
    if (block?.kind !== 'referenceTable') throw new Error('missing block');
    expect(block.entries).toHaveLength(1);
    const adapter = adapted.blocks.find((b) => b.reference);
    expect(adapter?.reference?.entries[0]!.targets).toEqual([]);
  });

  it('re-uses the cached conversion under the same doc scan; a retitle reconverts', () => {
    const { editor } = renderTensor(`<h1>Alpha</h1>`);
    act(() => {
      editor.commands.setTextSelection(1);
      editor.commands.insertReferenceTable('toc', 3);
    });
    const first = adapt(editor);
    const second = adapt(editor); // same doc object → same scan → reused
    const b1 = first.doc.blocks.find((x) => x.kind === 'referenceTable');
    const b2 = second.doc.blocks.find((x) => x.kind === 'referenceTable');
    expect(b2).toBe(b1); // reference-stable (the identity-cache contract)

    act(() => {
      // Insert "!" at the heading's text start (pos found, not hand-counted).
      let headingTextPos: number | null = null;
      editor.state.doc.descendants((n, pos) => {
        if (n.type.name === 'heading' && headingTextPos === null) headingTextPos = pos + 1;
      });
      editor.chain().focus().insertContentAt(headingTextPos!, { type: 'text', text: '!' }).run();
    });
    const third = adapt(editor);
    const b3 = third.doc.blocks.find((x) => x.kind === 'referenceTable');
    expect(b3).not.toBe(b1); // the scan fact changed → reconverted
    const rows = (b3 as { entries: Array<{ runs: Array<{ text: string }> }> }).entries;
    expect(rows[0]!.runs[0]!.text).toBe('!Alpha');
  });

  it('scan identity: the conversion cache reuses only under the SAME scan object', () => {
    const { editor } = renderTensor(`<h1>Alpha</h1>`);
    act(() => {
      editor.commands.setTextSelection(1);
      editor.commands.insertReferenceTable('toc', 3);
    });
    const s1 = scanCollections(editor.state.doc);
    const s2 = scanCollections(editor.state.doc);
    expect(s2).toBe(s1); // memoized per doc version
  });

  it('a referenceTable doc does NOT fall back to pageless — the stack stays', async () => {
    const { editor } = renderTensor('');
    act(() => {
      editor.commands.setTextSelection(1);
      editor.commands.insertReferenceTable('toc', 3);
    });
    await settleLayout();
    expect(document.querySelector('[data-testid="paginated-stack"]')).not.toBeNull();
    // And the placeholder paints as a real line (never a zero-height ghost).
    const adapted = adapt(editor);
    const refBlock = adapted.blocks.find((b) => b.reference)!;
    expect(refBlock.text.length).toBeGreaterThan(0);
  });
});

describe('the pageless NodeView (restored, per the user ruling)', () => {
  beforeEach(() => setPageless());

  /** The container's row paragraphs — NATIVE PM DOM (no NodeView). */
  const rowEls = () =>
    [...document.querySelectorAll('[data-tensor-ref-table-view] .tensor-ref-table-entries p')] as HTMLElement[];

  it('renders real row paragraphs natively and updates synchronously', async () => {
    const { editor } = renderTensor(`<h1>Alpha</h1>`);
    act(() => {
      editor.commands.setTextSelection(1);
      editor.commands.insertReferenceTable('toc', 3);
    });
    await settleScan();
    const container = document.querySelector('[data-tensor-ref-table-view]') as HTMLElement;
    expect(container).not.toBeNull();
    // Rows are REAL <p> elements in the editable (selectable text,
    // the dots span included); NO chrome title paragraph exists.
    let rows = rowEls();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent!.startsWith('Alpha')).toBe(true);
    expect(rows[0]!.textContent!.includes('.'.repeat(12))).toBe(true); // the leader dots

    // RETITLE → the generator rewrites the row SAME-TICK; PM's own
    // DOM sync shows it immediately.
    act(() => {
      let headTextPos: number | null = null;
      editor.state.doc.descendants((n, pos) => {
        if (n.type.name === 'heading' && headTextPos === null) headTextPos = pos + 1;
      });
      editor.chain().focus().insertContentAt(headTextPos!, { type: 'text', text: 'Renamed ' }).run();
    });
    rows = rowEls();
    expect(rows[0]!.textContent!.startsWith('Renamed Alpha')).toBe(true);
  });

  it('shows the placeholder for an empty collection, then grows when a heading is added', async () => {
    const { editor } = renderTensor(`<p>plain text</p>`);
    act(() => {
      editor.commands.setTextSelection(1);
      editor.commands.insertReferenceTable('index', 3);
    });
    await settleScan();
    let rows = rowEls();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain('No index entries yet');

    act(() => {
      editor.chain().focus().insertContentAt(editor.state.doc.content.size, {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'hello ' },
          { type: 'text', marks: [{ type: 'indexEntry' }], text: 'world' },
        ],
      }).run();
    });
    await settleScan();
    rows = rowEls();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent!.startsWith('world')).toBe(true);
  });

  it('THE FIELD BORDER: data-bordered appears while the caret is inside, gone when it leaves', async () => {
    const { editor } = renderTensor(`<h1>Target</h1><p>tail</p>`);
    act(() => {
      editor.commands.setTextSelection(1);
      editor.commands.insertReferenceTable('toc', 3);
    });
    await settleScan();
    const container = document.querySelector('[data-tensor-ref-table-view]') as HTMLElement;
    // The caret sits outside (post-insert selection lands in the heading).
    expect(container.getAttribute('data-bordered')).toBe('false');

    // Click into the row: the caret drives data-bordered.
    const rowPos = (() => {
      let at: number | null = null;
      editor.state.doc.descendants((n, pos) => {
        if (
          n.type.name === 'paragraph' &&
          n.attrs.refId &&
          n.attrs.refId !== '__title' &&
          at === null
        ) {
          at = pos + 1;
        }
      });
      return at!;
    })();
    act(() => {
      editor.commands.setTextSelection(rowPos);
    });
    expect(container.getAttribute('data-bordered')).toBe('true');
    const headingTextPos2 = (() => {
      let at: number | null = null;
      editor.state.doc.descendants((n, pos) => {
        if (n.type.name === 'heading' && at === null) at = pos + 1;
      });
      return at!;
    })();
    act(() => {
      editor.commands.setTextSelection(headingTextPos2); // the heading's text — genuinely OUTSIDE
    });
    expect(container.getAttribute('data-bordered')).toBe('false');
  });

  it('entry text is REAL: positions inside it are valid caret targets', async () => {
    const { editor } = renderTensor(`<h1>Target</h1>`);
    act(() => {
      editor.commands.setTextSelection(1);
      editor.commands.insertReferenceTable('toc', 3);
    });
    await settleScan();
    const entryTextPos = (() => {
      let at: number | null = null;
      editor.state.doc.descendants((n, pos) => {
        if (
          n.type.name === 'paragraph' &&
          n.attrs.refId &&
          at === null
        ) {
          at = pos + 1;
        }
      });
      return at!;
    })();
    act(() => {
      editor.commands.setTextSelection(entryTextPos + 3);
    });
    const $from = editor.state.selection.$from;
    expect($from.parent.attrs.refId).not.toBeNull();
    expect(rowText($from.parent as unknown as Parameters<typeof rowText>[0])).toBe('Target');
    const row = rowEls()[0]!;
    expect(row.textContent!.startsWith('Target')).toBe(true);
    expect(editor.view.dom.contains(row)).toBe(true);
  });

  it('Ctrl+click navigates the clicked row to its target (the PM click prop)', async () => {
    const { editor } = renderTensor(
      `<h1>Target</h1><p>a <span data-tensor-index="true">term</span> here</p>`,
    );
    act(() => {
      editor.commands.setTextSelection(1);
      editor.commands.insertReferenceTable('toc', 3);
    });
    await settleScan();
    const headingTextPos = (() => {
      let at: number | null = null;
      editor.state.doc.descendants((n, pos) => {
        if (n.type.name === 'heading' && at === null) at = pos + 1;
      });
      return at!;
    })();
    const row = rowEls()[0]!;
    // Plain Ctrl+click routes through the scan (no PM click pipeline).
    fireEvent.click(row, { ctrlKey: true });
    expect(editor.state.selection instanceof TextSelection).toBe(true);
    expect(editor.state.selection.from).toBe(headingTextPos);
  });
});

describe('commands + dialog wiring (the palette gate)', () => {
  it('every reference-table action is a registry command with keywords and editor context', () => {
    for (const id of [
      'insertTableOfContents',
      'insertTableOfFigures',
      'insertIndex',
      'markIndexEntry',
      'removeIndexEntry',
    ]) {
      const cmd = getCommand(id);
      expect(cmd, id).toBeDefined();
      expect(cmd!.keywords.length).toBeGreaterThan(0);
      expect(cmd!.contexts).toContain('editor');
    }
  });

  it('insertTableOfContents opens the depth dialog; the dialog inserts a depth-2 ToC', async () => {
    const { editor } = renderTensor(`<h1>A</h1><h2>B</h2><h3>C</h3>`);
    render(<InsertReferenceTableDialog />);
    act(() => {
      getCommand('insertTableOfContents')!.run();
    });
    expect(useInsertReferenceTableStore.getState().isOpen).toBe(true);
    const input = document.getElementById('insert-toc-depth') as HTMLInputElement;
    expect(input).not.toBeNull();
    fireEvent.change(input, { target: { value: '2' } });
    act(() => {
      fireEvent.click(document.querySelector('[data-testid="insert-toc-confirm"]')!);
    });
    expect(useInsertReferenceTableStore.getState().isOpen).toBe(false);
    expect(countNodes(editor, 'referenceTable')).toBe(1);
    let inserted: { depth: number; kind: string } | null = null;
    editor.state.doc.forEach((n) => {
      if (n.type.name === 'referenceTable' && inserted == null) {
        inserted = n.attrs as { depth: number; kind: string };
      }
    });
    expect(inserted!.depth).toBe(2);
    expect(inserted!.kind).toBe('toc');
  });

  it('markIndexEntry marks the selection; enablement tracks the selection shape', () => {
    const { editor } = renderTensor(`<p>hello world</p>`);
    const mark = getCommand('markIndexEntry')!;
    act(() => {
      editor.commands.setTextSelection({ from: 1, to: 6 }); // "hello"
    });
    expect(mark.enablement!()).toBe(true);
    act(() => {
      mark.run();
    });
    expect(indexEntryActive(editor.state)).toBe(true);
    act(() => {
      editor.commands.setTextSelection(8); // caret in "world" — no mark
    });
    expect(mark.enablement!()).toBe(false);
    const remove = getCommand('removeIndexEntry')!;
    expect(remove.enablement!()).toBe(false); // caret outside any mark
    act(() => {
      editor.commands.setTextSelection(3); // caret inside the marked block
    });
    expect(remove.enablement!()).toBe(true); // the block-clears shape
    act(() => {
      remove.run();
    });
    expect(indexEntryActive(editor.state)).toBe(false);
  });

  it('the palette surfaces the reference-table actions (the coverage gate)', async () => {
    const { editor } = renderTensor(`<p>hello</p>`);
    // A non-empty selection + an active mark let all three actions show.
    act(() => {
      editor.commands.setTextSelection({ from: 1, to: 6 });
      editor.commands.setIndexEntry();
    });
    render(<CommandPalette />);
    act(() => {
      usePaletteStore.setState({ isOpen: true, editorContext: true });
    });
    const input = document.querySelector('[data-testid="palette-input"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    fireEvent.change(input, { target: { value: 'index' } });
    const item = (id: string) =>
      document.querySelector(`[data-testid="palette-item-${id}"]`) as HTMLElement | null;
    expect(item('insertIndex')).not.toBeNull();
    expect(item('markIndexEntry')).not.toBeNull();
    expect(item('removeIndexEntry')).not.toBeNull();
  });
});

describe('paginated interaction (the default mode)', () => {
  it('a plain click on an entry line places the caret INSIDE the entry text; Ctrl+click navigates', async () => {
    // Doc: [toc][h1 Target] — the ToC FIRST so its entry lines sit at
    // the content top under FakeMetrics (deterministic geometry).
    const { editor } = renderTensor(`<h1>Target</h1>`);
    act(() => {
      editor.commands.setTextSelection(1); // inside the heading's start
      editor.commands.insertReferenceTable('toc', 3);
    });
    await settleLayout();
    // The span grows to the measured count ~300ms in — the sleep
    // makes the positions deterministic.
    await new Promise((r) => setTimeout(r, 400));
    await settleLayout();
    const headingPos = (() => {
      let at: number | null = null;
      editor.state.doc.descendants((n, pos) => {
        if (n.type.name === 'heading' && at === null) at = pos;
      });
      return at!;
    })();

    // Entry line 0 sits at the content top (96, 96): click inside it.
    const CB = GEOMETRY.contentX;
    const CY = GEOMETRY.contentY;
    const zoomWrap = document.querySelector('[data-testid="paginated-zoom-wrapper"]') as HTMLElement;

    // Plain click: the sidecar maps the hit offset into the entry's
    // real text. The title row owns the first line (17.6px), so the
    // entry row starts below it.
    const ROW_Y = CY + 18 + 8;
    fireEvent.mouseDown(zoomWrap, { clientX: CB + 8, clientY: ROW_Y });
    expect(editor.state.selection instanceof TextSelection).toBe(true);
    const $from = editor.state.selection.$from;
    expect($from.parent.attrs.refId).not.toBeNull();
    expect($from.parent.textContent).toBe('Target');

    fireEvent.mouseDown(zoomWrap, { clientX: CB + 8, clientY: ROW_Y, ctrlKey: true });
    expect(editor.state.selection instanceof TextSelection).toBe(true);
    expect(editor.state.selection.from).toBe(headingPos + 1);
  });
});

describe('registry integrity', () => {
  it('no duplicate command ids after the reference-table additions', () => {
    const ids = COMMANDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('the GDocs affordances (border, badges, bookmarks, selection)', () => {
  const adapt2 = (editor: ReturnType<typeof renderTensor>['editor']) => {
    const registry = useStyleRegistryStore.getState();
    const base = resolveNormalBase('sans-serif', 16, registry.merged);
    return pmDocToSemantic(editor.state.doc, base, {
      definitions: registry.merged,
      epoch: registry.epoch,
    });
  };

  it('the adapter flags reference blocks with the field-border paint hint', () => {
    const { editor } = renderTensor(`<h1>Alpha</h1>`);
    act(() => {
      editor.commands.setTextSelection(1);
      editor.commands.insertReferenceTable('toc', 3);
    });
    const block = adapt2(editor).blocks.find((b) => b.reference)!;
    expect(block.paint?.reference).toBe(true);
  });

  it('the pageless container carries the border CSS classes (the decoration drives data-bordered)', async () => {
    setPageless();
    const { editor } = renderTensor(`<h1>Alpha</h1>`);
    act(() => {
      editor.commands.setTextSelection(1);
      editor.commands.insertReferenceTable('toc', 3);
    });
    await settleScan();
    const container = document.querySelector('[data-tensor-ref-table-view]') as HTMLElement;
    expect(container.className).toContain('tensor-ref-table');
    // Transparent border at rest (no layout shift); data-bordered rides
    // the selection state.
    expect(container.getAttribute('data-bordered')).not.toBeNull();
  });

  it('paginated: the gutter type badge names the kind; clicking it selects the block', async () => {
    const { editor } = renderTensor(`<h1>Alpha</h1>`);
    act(() => {
      editor.commands.setTextSelection(1);
      editor.commands.insertReferenceTable('figures', 3);
    });
    await settleLayout();
    const badge = document.querySelector('[data-testid="ref-table-badge"]') as HTMLElement;
    expect(badge).not.toBeNull();
    expect(badge.getAttribute('data-kind')).toBe('figures');
    expect(badge.getAttribute('aria-label')).toBe('Select Table of Figures');
    fireEvent.click(badge);
    expect(editor.state.selection instanceof NodeSelection).toBe(true);
    expect((editor.state.selection as NodeSelection).node.type.name).toBe('referenceTable');
  });

  it('paginated: index bookmarks mark the lines carrying indexEntry spans (aria names the terms)', async () => {
    renderTensor(
      `<p>hello <span data-tensor-index="true">world</span> end</p>`,
    );
    await settleLayout();
    const marks = [...document.querySelectorAll('[data-testid="index-line-mark"]')] as HTMLElement[];
    expect(marks).toHaveLength(1);
    expect(marks[0]!.getAttribute('aria-label')).toContain('world');
  });

  it('paginated: with line numbers on, a gutter icon REPLACES its line number (the contextual-replacement law)', async () => {
    const { editor } = renderTensor(`<h1>Alpha</h1>`);
    act(() => {
      editor.commands.setTextSelection(1);
      editor.commands.insertReferenceTable('toc', 3);
      useDocumentStore.getState().setLineNumbers({ enabled: true, mode: 'continuous' });
    });
    await settleLayout();
    // Line 1 is the ToC's entry (the badge owns the slot); line 2 is the heading.
    const hidden = document.querySelector('[data-testid="line-number-1"]') as HTMLElement;
    expect(hidden).not.toBeNull();
    expect(hidden.style.visibility).toBe('hidden');
    expect(document.querySelector('[data-testid="ref-table-badge"]')).not.toBeNull();
    const shown = document.querySelector('[data-testid="line-number-2"]') as HTMLElement;
    expect(shown).not.toBeNull();
    expect(shown.style.visibility).not.toBe('hidden');
  });

  it('paginated: dragging from an entry line selects REAL text across the boundary (native semantics)', async () => {
    const { editor } = renderTensor(`<h1>Target</h1>`);
    act(() => {
      editor.commands.setTextSelection(1);
      editor.commands.insertReferenceTable('toc', 3);
    });
    await settleLayout();
    // The measured dot count rewrites the span ~300ms after the first
    // layout — the sleep pins the drag positions against the settled doc.
    await new Promise((r) => setTimeout(r, 400));
    await settleLayout();
    const CB = GEOMETRY.contentX;
    const CY = GEOMETRY.contentY;
    const zoomWrap = document.querySelector('[data-testid="paginated-zoom-wrapper"]') as HTMLElement;

    // The generic path arms a drag from the hit position (inside the
    // entry's real text).
    fireEvent.mouseDown(zoomWrap, { clientX: CB + 8, clientY: CY + 8 });
    expect(editor.state.selection instanceof TextSelection).toBe(true);
    const anchor = editor.state.selection.from;
    expect(editor.state.doc.resolve(anchor).parent.attrs.refId).not.toBeNull();

    // Drag into the heading's line: a REAL text selection across the
    // boundary. (settleLayout's poll lets the rAF-scheduled extend fire.)
    act(() => {
      window.dispatchEvent(
        new MouseEvent('mousemove', { clientX: CB + 8, clientY: CY + 24 }),
      );
    });
    await settleLayout();
    act(() => {
      window.dispatchEvent(new MouseEvent('mouseup'));
    });
    await settleLayout();
    const sel = editor.state.selection;
    expect(sel instanceof TextSelection).toBe(true);
    expect(sel.from).toBe(anchor);
    expect(sel.to).toBeGreaterThan(anchor); // extends into the heading
  });

  it('copy: NO schema toText override — entries are real paragraphs, native copy carries them (and the old leak stays dead)', () => {
    const { editor } = renderTensor(`<h1>Alpha</h1><h2>Beta</h2>`);
    act(() => {
      editor.commands.setTextSelection(1);
      editor.commands.insertReferenceTable('toc', 3);
    });
    // No toText override — entry text is real and copies natively; no
    // node carries a stray schema text serializer (the old leak).
    expect(editor.schema.nodes.referenceTable.spec.toText).toBeUndefined();
    expect(editor.schema.nodes.paragraph.spec.toText).toBeUndefined();
    expect(editor.schema.nodes.heading.spec.toText).toBeUndefined();
  });
});

describe('the app flows (regression: the reported insert/auto-update issues)', () => {
  const tocChildren = (editor: ReturnType<typeof renderTensor>['editor']) => {
    const out: string[] = [];
    editor.state.doc.forEach((n) => {
      if (n.type.name !== 'referenceTable') return;
      // The TITLE row (refId '__title') is real content, not an entry.
      n.forEach((c) => {
        out.push(rowText(c as unknown as Parameters<typeof rowText>[0]));
      });
    });
    return out;
  };

  it('insert via the DIALOG path works and auto-updates as headings change (paginated default)', async () => {
    const { editor } = renderTensor(`<h1>Alpha</h1>`);
    render(<InsertReferenceTableDialog />);
    // The user path: palette/ribbon command → dialog → Insert.
    act(() => {
      getCommand('insertTableOfContents')!.run();
    });
    act(() => {
      fireEvent.click(document.querySelector('[data-testid="insert-toc-confirm"]')!);
    });
    await settleLayout();
    expect(tocChildren(editor)).toEqual(['Alpha']);

    let alphaPos: number | null = null;
    editor.state.doc.descendants((n, pos) => {
      if (n.type.name === 'heading' && alphaPos === null) alphaPos = pos + 1;
    });
    act(() => {
      editor.chain().focus().insertContentAt(alphaPos!, { type: 'text', text: 'Hi ' }).run();
    });
    expect(tocChildren(editor)).toEqual(['Hi Alpha']);

    act(() => {
      editor.chain().focus().insertContentAt(editor.state.doc.content.size, {
        type: 'heading',
        attrs: { level: 2 },
        content: [{ type: 'text', text: 'New Section' }],
      }).run();
    });
    expect(tocChildren(editor)).toEqual(['Hi Alpha', 'New Section']);

    // Backspace-through's end state: the heading deleted → its entry disappears.
    let newSectionPos: number | null = null;
    editor.state.doc.descendants((n, pos) => {
      if (n.type.name === 'heading' && n.textContent === 'New Section') newSectionPos = pos;
    });
    act(() => {
      editor.commands.deleteRange({ from: newSectionPos!, to: newSectionPos! + 14 });
    });
    expect(tocChildren(editor)).toEqual(['Hi Alpha']);

    expect(document.querySelector('[data-testid="paginated-stack"]')).not.toBeNull();
  });

  it('direct inserts (ToF/Index ribbon path) populate and auto-update', async () => {
    const { editor } = renderTensor(
      `<p><span data-tensor-index="true">term</span> here</p>`,
    );
    act(() => {
      editor.commands.setTextSelection(1);
      editor.commands.insertReferenceTable('index', 3);
    });
    await settleLayout();
    expect(tocChildren(editor)).toEqual(['term']);
    act(() => {
      editor.chain().focus().insertContentAt(editor.state.doc.content.size, {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'and ' },
          { type: 'text', marks: [{ type: 'indexEntry' }], text: 'another' },
        ],
      }).run();
    });
    expect(tocChildren(editor)).toEqual(['another', 'term']);
    expect(document.querySelector('[data-testid="paginated-stack"]')).not.toBeNull();
  });

  it('backspacing through a heading keeps the model + view in lockstep (no ghosts)', async () => {
    const { editor } = renderTensor(`<h1>Hello World</h1><p>tail</p>`);
    act(() => {
      editor.commands.setTextSelection(1);
      editor.commands.insertReferenceTable('toc', 3);
    });
    await settleLayout();
    expect(tocChildren(editor)).toEqual(['Hello World']);

    // Delete chars one by one from the END (backspace semantics);
    // positions are found on the LIVE doc (hand-counted ones would
    // hit the container's own entry text).
    const headingRange = () => {
      let at: { pos: number; text: string } | null = null;
      editor.state.doc.descendants((n, pos) => {
        if (n.type.name === 'heading' && at === null) at = { pos, text: n.textContent };
      });
      return at!;
    };
    const adaptHeadingText = () => {
      const registry = useStyleRegistryStore.getState();
      const base = resolveNormalBase('sans-serif', 16, registry.merged);
      const adapted = pmDocToSemantic(editor.state.doc, base, {
        definitions: registry.merged,
        epoch: registry.epoch,
      });
      const heading = adapted.doc.blocks.find((b) => b.kind === 'heading');
      return (heading as { runs: Array<{ text?: string }> } | undefined)?.runs
        .map((r) => r.text ?? '')
        .join('');
    };

    for (let len = 11; len >= 1; len--) {
      const { pos, text } = headingRange();
      expect(text).toBe('Hello World'.slice(0, len));
      act(() => {
        // Delete the heading's LAST character.
        editor.commands.deleteRange({ from: pos + 1 + text.length - 1, to: pos + 1 + text.length });
      });
      // MODEL lockstep: the entry text matches the heading's new text.
      expect(tocChildren(editor)).toEqual(['Hello World'.slice(0, len - 1)]);
      // VIEW lockstep: the adapter's heading projection (what the canvas
      // paints derives from) — a mismatch here IS the ghost.
      expect(adaptHeadingText()).toBe('Hello World'.slice(0, len - 1));
    }
    expect(document.querySelector('[data-testid="paginated-stack"]')).not.toBeNull();
  });
});

describe('the contextual tab (the GDocs refresh affordance)', () => {
  it('inside a table: the context is active; Refresh reverts stale entry text (refresh-wins); Select Table selects the block', async () => {
    const { editor } = renderTensor(`<h1>Alpha</h1>`);
    act(() => {
      editor.commands.setTextSelection(1);
      editor.commands.insertReferenceTable('toc', 3);
    });
    await settleLayout();

    const entryTexts = () => {
      const out: string[] = [];
      editor.state.doc.forEach((n) => {
        if (n.type.name !== 'referenceTable') return;
        n.forEach((c) => {
          out.push(rowText(c as unknown as Parameters<typeof rowText>[0]));
        });
      });
      return out;
    };

    // Click into an entry: the caret inside an entry paragraph
    // announces the context (the tab strip renders from the same signal).
    const entryPos = (() => {
      let at: number | null = null;
      editor.state.doc.descendants((n, pos) => {
        if (
          n.type.name === 'paragraph' &&
          n.attrs.refId &&
          n.attrs.refId !== '__title' &&
          at === null
        ) {
          at = pos + 1;
        }
      });
      return at!;
    })();
    act(() => {
      editor.commands.setTextSelection(entryPos);
    });
    expect(selectionInReferenceTable(editor)).toBe(true);

    // Caret inside — the generator defers; the live edit stays visible.
    act(() => {
      editor.chain().focus().insertContentAt(entryPos, { type: 'text', text: 'X' }).run();
    });
    expect(entryTexts()).toEqual(['XAlpha']); // deferred, live

    // Caret out (into the heading's text — pos 1 is still INSIDE the
    // first entry) + REFRESH: refresh-wins reverts the stale text;
    // reuse keeps formatting.
    const headingTextPos = (() => {
      let at: number | null = null;
      editor.state.doc.descendants((n, pos) => {
        if (n.type.name === 'heading' && at === null) at = pos + 1;
      });
      return at!;
    })();
    act(() => {
      editor.commands.setTextSelection(headingTextPos);
      editor.view.dispatch(editor.state.tr.setMeta('refRefresh', true));
    });
    expect(entryTexts()).toEqual(['Alpha']);
    expect(selectionInReferenceTable(editor)).toBe(false); // caret is outside now

    // SELECT TABLE: NodeSelection on the container (from the ancestry walk).
    act(() => {
      editor.commands.setTextSelection(entryPos);
    });
    const { $from } = editor.state.selection;
    for (let d = $from.depth; d > 0; d--) {
      if ($from.node(d).type.name === 'referenceTable') {
        act(() => {
          editor.commands.setNodeSelection($from.before(d));
        });
        break;
      }
    }
    expect(editor.state.selection instanceof NodeSelection).toBe(true);
    expect((editor.state.selection as NodeSelection).node.type.name).toBe('referenceTable');
  });
});

describe('the join/ghost fix (dead entries never linger)', () => {
  it('backspacing a heading BARE and joining INTO the table removes the dead entry at once — typing lands in the placeholder, not a trap', async () => {
    const { editor } = renderTensor(`<h1>Hello World</h1><p>tail</p>`);
    act(() => {
      editor.commands.setTextSelection(1);
      editor.commands.insertReferenceTable('toc', 3);
    });
    const entryTexts = () => {
      const out: Array<{ text: string; refId: string | null }> = [];
      editor.state.doc.forEach((n) => {
        if (n.type.name !== 'referenceTable') return;
        n.forEach((c) => {
          out.push({
            text: rowText(c as unknown as Parameters<typeof rowText>[0]),
            refId: typeof c.attrs.refId === 'string' && c.attrs.refId ? c.attrs.refId : null,
          });
        });
      });
      return out;
    };
    expect(entryTexts()).toEqual([{ text: 'Hello World', refId: expect.any(String) }]);

    // Backspace through the heading's text (char by char from the end).
    for (let len = 11; len >= 1; len--) {
      act(() => {
        let at: { pos: number; text: string } | null = null;
        editor.state.doc.descendants((n, pos) => {
          if (n.type.name === 'heading' && at === null) at = { pos, text: n.textContent };
        });
        const { pos, text } = at!;
        editor.commands.deleteRange({ from: pos + 1 + text.length - 1, to: pos + 1 + text.length });
      });
    }
    // The bare heading's entry synced to '' (the heading still exists).
    expect(entryTexts()).toEqual([{ text: '', refId: expect.any(String) }]);

    // The final backspace joins the bare heading into the container;
    // the dead entry (its heading GONE) must be removed IMMEDIATELY —
    // never deferred into a ghost row that swallows the next keystroke.
    act(() => {
      editor.commands.joinBackward();
    });
    expect(entryTexts()).toEqual([
      // The placeholder: no headings → the hint row (refId null).
      { text: 'No headings yet — entries appear as you add them.', refId: null },
    ]);

    // The INVARIANT: no dead entry lingers to swallow the caret —
    // rows are the placeholder (refId null) or live entries, never stale.
    act(() => {
      editor.commands.insertContent('X');
    });
    const rows = entryTexts();
    expect(rows.every((r) => r.refId === null || r.text !== undefined)).toBe(true);
    expect(rows.some((r) => r.refId !== null)).toBe(false); // no dead entry came back
    await settleLayout();
    expect(document.querySelector('[data-testid="paginated-stack"]')).not.toBeNull();
  });
});

describe('page numbers + leaders (the two-pass fixpoint)', () => {
  it('entries carry resolved page numbers (paint-visible), and update when targets move across pages', async () => {
    const spy = vi.spyOn(paintModule, 'paintLines');
    const { editor } = renderTensor(`<h1>Alpha</h1>`);
    await settleLayout();
    spy.mockClear();

    act(() => {
      editor.commands.setTextSelection(1);
      editor.commands.insertReferenceTable('toc', 3);
    });
    await settleLayout();
    await settleLayout();

    // The painted text carries the RESOLVED number: 'Alpha' + DOTS +
    // '\t' + '1' (both blocks land on page 1; the leader is a real run
    // between text and tab).
    const tocPaints = () =>
      spy.mock.calls
        .map((c) => c[3] as string)
        .filter((t) => t.startsWith('Alpha') && t.includes('\t'));
    expect(tocPaints().length).toBeGreaterThan(0);
    expect(tocPaints().every((t) => /Alpha\.*\t1$/.test(t))).toBe(true);

    // Force the heading onto page 2: a break between the ToC and the
    // heading (a break at doc start would be a no-op).
    spy.mockClear();
    act(() => {
      let headingPos: number | null = null;
      editor.state.doc.descendants((n, pos) => {
        if (n.type.name === 'heading' && headingPos === null) headingPos = pos;
      });
      editor.commands.insertContentAt(headingPos!, { type: 'pageBreak' });
    });
    await settleLayout();
    await settleLayout();
    const after = spy.mock.calls
      .map((c) => c[3] as string)
      .filter((t) => t.startsWith('Alpha') && t.includes('\t'));
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((t) => /Alpha\.*\t2$/.test(t))).toBe(true);
    spy.mockRestore();
  });
});

describe('round-5: no title; the leaders span is real, toggleable text', () => {
  it('NO title row exists — rows only (the user types their own title if wanted)', () => {
    const { editor } = renderTensor(`<h1>Alpha</h1>`);
    act(() => {
      editor.commands.setTextSelection(1);
      editor.commands.insertReferenceTable('toc', 3);
    });
    let sawTitle = false;
    let rows = 0;
    editor.state.doc.forEach((n) => {
      if (n.type.name !== 'referenceTable') return;
      n.forEach((c) => {
        rows += 1;
        if (c.attrs.refId === '__title') sawTitle = true;
      });
    });
    expect(sawTitle).toBe(false);
    expect(rows).toBe(1); // just the Alpha row
  });

  it('THE LEADERS TOGGLE: off removes the dots spans; on re-seeds them (marks survive)', () => {
    const { editor } = renderTensor(`<h1>Alpha</h1>`);
    act(() => {
      editor.commands.setTextSelection(1);
      editor.commands.insertReferenceTable('toc', 3);
    });
    const dotsOf = () => {
      let n = 0;
      editor.state.doc.forEach((c0) => {
        if (c0.type.name !== 'referenceTable') return;
        c0.forEach((c) => {
          c.forEach((inline) => {
            if (inline.isText && inline.marks.some((m) => m.type.name === 'refLeader')) n += 1;
          });
        });
      });
      return n;
    };
    expect(dotsOf()).toBe(1);
    const containerPos = (() => {
      let at: number | null = null;
      editor.state.doc.forEach((n, offset) => {
        if (n.type.name === 'referenceTable' && at === null) at = offset;
      });
      return at!;
    })();
    act(() => {
      editor
        .chain()
        .focus()
        .command(({ tr, dispatch }) => {
          if (dispatch) tr.setNodeAttribute(containerPos, 'leaders', false);
          return true;
        })
        .run();
    });
    expect(dotsOf()).toBe(0); // the span is GONE
    act(() => {
      editor
        .chain()
        .focus()
        .command(({ tr, dispatch }) => {
          if (dispatch) tr.setNodeAttribute(containerPos, 'leaders', true);
          return true;
        })
        .run();
    });
    expect(dotsOf()).toBe(1); // re-seeded
  });

  it('the adapter: leader rows carry leaderLen + the dots in the runs (painter-stretchable)', () => {
    const { editor } = renderTensor(`<h1>Alpha</h1>`);
    act(() => {
      editor.commands.setTextSelection(1);
      editor.commands.insertReferenceTable('toc', 3);
    });
    const registry = useStyleRegistryStore.getState();
    const base = resolveNormalBase('sans-serif', 16, registry.merged);
    const adapted = pmDocToSemantic(editor.state.doc, base, {
      definitions: registry.merged,
      epoch: registry.epoch,
    });
    const block = adapted.doc.blocks.find((b) => b.kind === 'referenceTable');
    if (block?.kind !== 'referenceTable') throw new Error('missing');
    // [text, dots, tab, ''] — the dots are a REAL run in the entry.
    expect(
      block.entries[0]!.runs.map((r) => (r as { kind?: string; text?: string }).text)
    ).toEqual(['Alpha', '.'.repeat(12), '\t', '']);
    // The sidecar's slice covers the text + seed dots and carries
    // leaderLen (the painter's gap-fill tag).
    const adapter = adapted.blocks.find((b) => b.reference)!;
    expect(adapter.text).toBe('Alpha' + '.'.repeat(12) + '\t');
    expect(adapter.reference!.entries[0]!.leaderLen).toBe(12);
    expect(adapter.reference!.entries[0]!.textLen).toBe(5 + 12);
  });
});

describe('the reactive toggle fix + the layout presets', () => {
  /** The tools mounted for real — the stale-getState bug's repro surface. */
  function mountTools() {
    const utils = render(<ReferenceTableTools />);
    return utils;
  }
  const dotsOf = (editor: ReturnType<typeof renderTensor>['editor']) => {
    let n = 0;
    editor.state.doc.forEach((c0) => {
      if (c0.type.name !== 'referenceTable') return;
      c0.forEach((c) => {
        c.forEach((inline) => {
          if (inline.isText && inline.marks.some((m) => m.type.name === 'refLeader')) n += 1;
        });
      });
    });
    return n;
  };
  const attrsOf = (editor: ReturnType<typeof renderTensor>['editor']) => {
    let a: { leaders?: boolean; numberDisplay?: string } | null = null;
    editor.state.doc.forEach((n) => {
      if (n.type.name === 'referenceTable' && !a) {
        a = {
          leaders: n.attrs.leaders !== false,
          numberDisplay: n.attrs.numberDisplay ?? 'plain',
        };
      }
    });
    return a!;
  };

  it('REGRESSION (the no-op toggle): the REAL mounted button removes the dots', () => {
    const { editor } = renderTensor(`<h1>Alpha</h1>`);
    act(() => {
      editor.commands.setTextSelection(1);
      editor.commands.insertReferenceTable('toc', 3);
    });
    let rowPos: number | null = null;
    editor.state.doc.descendants((n, pos) => {
      if (n.type.name === 'paragraph' && n.attrs.refId && rowPos === null) rowPos = pos + 1;
    });
    act(() => {
      editor.commands.setTextSelection(rowPos!);
    });
    mountTools();
    expect(dotsOf(editor)).toBe(1);
    // The FACE button applies the current preset through the REAL React
    // handler (the popover's portal-mounted rows are out of jsdom scope;
    // the FACE is the always-mounted interactive surface).
    const faceButton = [...document.querySelectorAll('button')].find((b) =>
      (b.textContent ?? '').includes('Numbers and leading'),
    ) as HTMLButtonElement | null;
    expect(faceButton).not.toBeNull();
    act(() => {
      fireEvent.click(faceButton!);
    });
    // Re-applying the preset is a no-op on the dots, but the handler ran
    // and wrote attrs.
    expect(attrsOf(editor).leaders).toBe(true);
    expect(attrsOf(editor).numberDisplay).toBe('plain');
  });

  it('the presets write both attrs; "no numbers" empties the numbers; hyperlink decor rides', () => {
    const { editor } = renderTensor(`<h1>Alpha</h1>`);
    act(() => {
      editor.commands.setTextSelection(1);
      editor.commands.insertReferenceTable('toc', 3);
    });
    const containerPos = (() => {
      let at: number | null = null;
      editor.state.doc.forEach((n, offset) => {
        if (n.type.name === 'referenceTable' && at === null) at = offset;
      });
      return at!;
    })();
    const setAttr = (attr: string, value: unknown) => {
      act(() => {
        editor
          .chain()
          .focus()
          .command(({ tr, dispatch }) => {
            if (dispatch) tr.setNodeAttribute(containerPos, attr, value);
            return true;
          })
          .run();
      });
    };

    // The bare adapter has no resolver map — the number TEXT is ''
    // throughout; the DECOR carries the preset's effect (the two-pass
    // supplies the text in the app).
    const adapt = () => {
      const registry = useStyleRegistryStore.getState();
      const base = resolveNormalBase('sans-serif', 16, registry.merged);
      return pmDocToSemantic(editor.state.doc, base, {
        definitions: registry.merged,
        epoch: registry.epoch,
      });
    };
    const lastDecor = () => {
      const a = adapt().blocks.find((b) => b.reference)!;
      return a.runDecor[a.runDecor.length - 1]!;
    };

    // The number presets have no hyperlink arm — hyperlinking rides the
    // rows' semantic link marks (tensor-ref: hrefs); the presets only
    // shape the visible layout.
    setAttr('numberDisplay', 'none');
    setAttr('numberDisplay', 'plain');
    const decorKeys = Object.keys(lastDecor());
    expect(decorKeys).not.toContain('hyperlink'); // the option is gone

    // The row's entry text carries the link mark with the tensor-ref:
    // href to the target's stable blockId — the data the exporters map.
    let linkHref: string | null = null;
    editor.state.doc.forEach((n) => {
      if (n.type.name !== 'referenceTable' || linkHref) return;
      n.forEach((c) => {
        c.forEach((inline) => {
          if (inline.isText && !linkHref) {
            const link = inline.marks.find((m) => m.type.name === 'link');
            if (link) linkHref = String(link.attrs.href);
          }
        });
      });
    });
    expect(linkHref).toMatch(/^tensor-ref:.+/);

    // The SPAN (the leaders arm) is untouched by the number presets.
    expect(dotsOf(editor)).toBe(1);
  });
});
