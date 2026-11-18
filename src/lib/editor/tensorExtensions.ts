import type { Extensions } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TextStyle, FontSize } from '@tiptap/extension-text-style';
import FontFamily from '@tiptap/extension-font-family';
import { Color } from '@tiptap/extension-color';
import { Highlight } from '@tiptap/extension-highlight';
import Link from '@tiptap/extension-link';
import {
  OrderedListWithStyle,
  UnorderedListWithStyle,
} from '@/lib/lists/listExtensions';
import { HeadingWithExtras, ParagraphExtraCommands, ParagraphWithExtras } from '@/lib/editor/ParagraphExtensions';
import { SearchExtension } from '@/lib/editor/search/SearchExtension';
import { SpellExtension } from '@/lib/editor/spell/SpellExtension';
import { DynamicShortcutsExtension } from '@/lib/editor/ShortcutsExtension';
import {
  BoldNoShortcut,
  ItalicNoShortcut,
  UnderlineNoShortcut,
  StrikeNoShortcut,
  TextAlignNoShortcut,
} from '@/lib/editor/RemoveDefShortcuts';
import { BlockIdExtension } from '@/lib/editor/BlockIdExtension';
import { CharStyleMark, StyleCommandsExtension } from '@/lib/styles/styleExtensions';
import { ScrollGuardExtension } from '@/lib/paginated/ScrollGuardExtension';
import { PageBreakNode } from '@/lib/pagination/PageBreakNode';
import { ColumnBreakNode } from '@/lib/pagination/ColumnBreakNode';
import { SectionBreakNode } from '@/lib/pagination/SectionBreakNode';
// M-HEADER-FOOTER-2: the doc-level header/footer containers — content
// rides the ONE PM doc (L3); the adapter routes them into doc.bands.
import { FooterBlock, HeaderBlock } from '@/lib/editor/HeaderFooterNodes';
// M-MD: the markdown-mapped variants — the SAME nodes extended with
// their markdown handlers. The fields are inert in the production
// editor (nothing there builds a manager); lib/markdown/manager.ts
// builds its standalone MarkdownManager from this very list.
import { MarkdownImageNode, MarkdownInlineImageNode, MarkdownEquationNode } from '@/lib/markdown/specs';
import { PageFieldNode } from '@/lib/editor/PageFieldNode';
import { TensorTableKit } from '@/lib/editor/TableExtensions';
// M-EQ: display equations — a block atom (the ImageNode family);
// latex is the node's only document data, rendering is a
// projection (lib/equations), paginated layout rides the engine's
// EquationBlock + EquationMetrics port.
// (M-MD: the markdown-mapped variant comes from lib/markdown/specs.)
// M-REFS: the reference-table node (ToC/ToF/Index — one generic block
// container; entries are real paragraphs the generator maintains) +
// the invisible indexEntry mark + the debounced rescan seam + THE
// GENERATOR (the container's reconciliation engine).
import { ReferenceTableNode } from '@/lib/editor/ReferenceTableNode';
import { IndexMark } from '@/lib/editor/IndexMark';
import { RefLeaderMark } from '@/lib/editor/RefLeaderMark';
import { ReferenceScanExtension } from '@/lib/references/store';
import { ReferenceGeneratorExtension } from '@/lib/references/generator';
import { PageSetupHistoryExtension } from '@/lib/editor/pageSetupHistoryExtension';

/** The Tensor editor's extension list — one source shared by the app
 * shell (Editor.tsx) and the test harness so tests exercise the exact
 * production editor. */
export function tensorExtensions(): Extensions {
  return [
    StarterKit.configure({
      bulletList: false,
      orderedList: false,
      paragraph: false,
      heading: false,
      link: false,
      bold: false,
      italic: false,
      underline: false,
      strike: false,
    }),
    BoldNoShortcut,
    ItalicNoShortcut,
    UnderlineNoShortcut,
    StrikeNoShortcut,
    OrderedListWithStyle,
    UnorderedListWithStyle,
    TextStyle,
    FontFamily,
    Color,
    Highlight.configure({ multicolor: true }),
    FontSize,
    // M-STYLES: the charStyle mark (registry reference; one per span)
    // + apply/convert commands + the reactive heading-sync plugin.
    CharStyleMark,
    StyleCommandsExtension,
    TextAlignNoShortcut.configure({ types: ['heading', 'paragraph'] }),
    ParagraphWithExtras,
    HeadingWithExtras,
    ParagraphExtraCommands,
    Link.configure({
      openOnClick: false,
      HTMLAttributes: { target: null, rel: 'noopener noreferrer nofollow' },
    }),
    SearchExtension,
    // Spell check state holder: error spans + decorations (the
    // controller/store live app-side; this is the model layer both
    // view modes project).
    SpellExtension,
    DynamicShortcutsExtension,
    // Model node that survives from the legacy pipeline: the pageBreak
    // atom renders its marker, and the adapter translates it into the
    // engine's forced-break spelling (flow.breakBefore: 'page').
    PageBreakNode,
    ColumnBreakNode,
    // #58 SECTIONS: the sectionBreak atom — the adapter translates it
    // into the engine's per-section geometry boundaries (the node is
    // NOT part of the IR; the pageBreak law).
    SectionBreakNode,
        // M-MD: the markdown-mapped image/equation nodes (same schema, same
    // names — the markdown handlers ride along, inert in production).
    MarkdownImageNode,
    MarkdownInlineImageNode,
    // M-PAGEFIELD: the page-number field (bands resolve per page).
    PageFieldNode,
    // M-TABLES: the TipTap table family (schema + commands + the
    // built-in columnResizing plugin via `resizable`) plus Tensor's
    // borderStyle/backgroundColor attrs. Pages mode falls back to the
    // pageless render until the engine grows the TableBlock kind.
    ...TensorTableKit,
    // M-HEADER-FOOTER-2: the header/footer container nodes.
    HeaderBlock,
    FooterBlock,
    // M-EQ: display equations — a block atom (the ImageNode family);
    // latex is the node's only document data, rendering is a
    // projection (lib/equations), paginated layout rides the engine's
    // EquationBlock + EquationMetrics port.
    MarkdownEquationNode,
    // M-REFS: the reference tables (ToC/ToF/Index) — the generic
    // collection container (kind/depth attrs only; entries are real
    // paragraphs the generator keeps in sync) + the invisible index
    // mark + the debounced rescan publisher + the generator itself.
    ReferenceTableNode,
    IndexMark,
    RefLeaderMark,
    ReferenceScanExtension,
    ReferenceGeneratorExtension,
    // #58 — LAST: overrides StarterKit's undo/redo commands with the
    // page-setup co-restore (the store's pageSetup is outside PM —
    // the raw history would half-undo a page-setup action).
    PageSetupHistoryExtension,
    // Stable block ids (engine edit-survival contract) + the
    // paginated-mode scroll guard (L3).
    BlockIdExtension,
    ScrollGuardExtension,
  ];
}