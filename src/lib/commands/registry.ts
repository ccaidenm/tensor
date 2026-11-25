import type { LucideIcon } from 'lucide-react';
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Bold,
  CaseSensitive,
  ClipboardPaste,
  Copy,
  FileSearchCorner,
  FileStack,
  FolderOpen,
  Heading1,
  Heading2,
  Heading3,
  IndentDecrease,
  IndentIncrease,
  Info,
  Image as ImageIcon,
  Italic,
  Library,
  Link2,
  List,
  ListOrdered,
  LogOut,
  Maximize,
  Moon,
  Pilcrow,
  Plus,
  Quote,
  Redo2,
  RemoveFormatting,
  Ruler,
  Save,
  SaveAll,
  Scissors,
  SeparatorHorizontal,
  Settings,
  Sigma,
  SpellCheck,
  Strikethrough,
  Underline as UnderlineIcon,
  MessageSquareText,
  TextCursorInput,
  Squircle,
  Table,
  TableProperties,
  PersonStanding,
  Droplet,
  BookmarkMinus,
  BookmarkPlus,
  BookOpen,
  WrapText,
  BringToFront,
  SendToBack,
  Undo2,
  ZoomIn,
  ZoomOut,
  PanelTop,
  PanelBottom,
  Eye,
  Eraser,
  FileDown,
  FileText,
  Printer,
  Proportions,
  Languages,
  ChartColumn,
  MessageSquarePlus,
  SquareDashed,
} from 'lucide-react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { pasteFromSystemClipboard } from '@/lib/editor/clipboard';
import { enableRegion, hasBandContainer, selectionInBand } from '@/lib/editor/headerFooterCommands';
import { findTableUnderSelection } from '@/lib/editor/TableExtensions';
import { cloneHeaderFooterSettings, defaultHeaderFooterSettings } from '@/lib/document/headerFooter';
import { runEditorCommand } from '@/lib/editor/editorCommands';
import { focusedTextControl } from '@/lib/editor/domUtils';
import { useDocumentPropertiesStore } from '@/lib/document/propertiesStore';
import { saveRecoveryCopy } from '@/lib/document/recovery';
import { useCommentStore } from '@/lib/comments/store';
import { useDocumentStore } from '@/lib/document/store';
import { useSidebarStore } from "@/lib/layout/sidebarStore";
import { useFocusStore } from "@/lib/layout/focusStore";
import { useConfigStore } from '@/lib/config/store';
import { useSettingsDialogStore } from '@/lib/settings/store';
import { usePaletteStore } from '@/lib/palette/store';
import { useStyleDialogStore } from '@/lib/styles/dialogStore';
import { useFontBrowserStore } from '@/lib/fonts/browserStore';
import { insertCaptionForImage } from '@/lib/media/caption';
import { insertImageFromPicker } from '@/lib/media/insert';
import { setWrapMode } from '@/lib/media/wrap';
import { useAltTextStore } from '@/components/dialogs/ImageDialogs';
import { useInsertTableStore } from '@/components/dialogs/InsertTableDialog';
import { usePrintPreviewStore } from '@/components/dialogs/PrintPreviewDialog';
import { useInsertReferenceTableStore } from '@/components/dialogs/InsertReferenceTableDialog';
import { insertReferenceTableAtSelection } from '@/lib/editor/ReferenceTableNode';
import { indexEntryActive } from '@/lib/editor/IndexMark';
import { useSpellStore } from '@/lib/editor/spell/store';
import { spellCheckActive } from '@/lib/config/schema';

/**
 * The declarative app command registry — the single source of truth
 * for app actions, consumed by the command palette and the web-side
 * shortcut system. Editor commands dispatch through the shared
 * EDITOR_COMMAND_MAP path (editorCommands.ts), never re-implemented.
 */

export type CommandGroup = 'actions' | 'format' | 'navigate';

export interface CommandAction {
  id: string;
  title: string;
  icon?: LucideIcon;
  group: CommandGroup;
  /** Invocation contexts. 'app' = always available (default);
   *  'editor' = only while the editor surface had focus at palette
   *  open time. */
  contexts?: ('app' | 'editor')[];
  /** SHORTCUTS id whose LIVE binding (user-rebindable) the palette
   *  renders as a hint via getEffectiveKeybinding. */
  shortcutId?: string;
  keywords: string[];
  /** Palette VISIBILITY filter only — run() ignores
   *  it, so a hidden action still fires from its shortcut. */
  hidden?: () => boolean;
  /** Destructive surface (quit, new): run() persists a recovery
   *  snapshot of unsaved work first, via the existing recovery path. */
  requiresSafeQuit?: boolean;
  /** Palette availability filter only — run() ignores it. Must be
   *  cheaply/synchronously readable from store state; if not, omit
   *  (never guess). */
  enablement?: () => boolean;
  run: () => void | Promise<void>;
}

const doc = () => useDocumentStore.getState();
const cfg = () => useConfigStore.getState();

/** The insert trio's shared enablement — editor present and the
 * insertion not refused (bands/cells). */
const canInsertReferenceTable = () => {
  const editor = doc().editor;
  return !!editor && !selectionInBand(editor) && !findTableUnderSelection(editor.state);
};

/** enablement: cheap + sync (store reads, editor.can()). */
const canUndo = () => doc().editor?.can().undo() ?? false;
const canRedo = () => doc().editor?.can().redo() ?? false;
const isDirty = () => doc().isDirty;

/** Editor-context formatting entry: dispatches the shared
 *  ShortcutsExtension command path by id — never re-implemented. */
function editorCommand(id: string, def: Omit<CommandAction, 'id' | 'run' | 'contexts'>): CommandAction {
  return { ...def, id, contexts: ['editor'], run: () => { runEditorCommand(id); } };
}

/** Both node kinds qualify (block image + inlineImage); `kind` narrows
 * when a command is shape-specific (align is block-only). */
function selectedImageRef(kind?: 'image' | 'inlineImage'): { pos: number; attrs: Record<string, unknown> } | null {
  const editor = useDocumentStore.getState().editor;
  if (!editor) return null;
  const sel = editor.state.selection as unknown as {
    node?: { type?: { name?: string }; attrs?: Record<string, unknown> };
    from?: number;
  };
  const name = sel.node?.type?.name;
  const isImageKind = name === 'image' || name === 'inlineImage';
  if (!isImageKind || (kind !== undefined && name !== kind) || typeof sel.from !== 'number') return null;
  return { pos: sel.from, attrs: sel.node!.attrs ?? {} };
}

/** Radius law: clamp to [0, half the min dim] — an extreme radius
 *  becomes the circle-ish pill, never a lie. */
function clampRadiusRef(value: number, attrs: Record<string, unknown>): number {
  const w = typeof attrs.width === 'number' ? attrs.width : 0;
  const h = typeof attrs.height === 'number' ? attrs.height : 0;
  const max = Math.floor(Math.min(w, h) / 2);
  return Math.max(0, Math.min(max, value));
}

/** One attr write on the selected image (paint-only attrs splice,
 * geometry attrs relayout); kind must agree with the enablement. */
function writeImageAttrsRef(writes: Record<string, unknown>, kind?: 'image' | 'inlineImage'): void {
  const editor = useDocumentStore.getState().editor;
  const sel = selectedImageRef(kind);
  if (!editor || !sel) return;
  editor
    .chain()
    .command(({ tr, dispatch }) => {
      if (dispatch) {
        for (const [key, value] of Object.entries(writes)) tr.setNodeAttribute(sel.pos, key, value);
      }
      return true;
    })
    .run();
}

export const COMMANDS: CommandAction[] = [
  // ── Actions (the old native menu's items, now palette/shortcut-only) ──
  {
    id: 'new',
    title: 'New Document',
    icon: FileStack,
    group: 'navigate',
    keywords: ['new', 'document', 'window', 'blank'],
    // #103 — a dirty current doc is recovery-snapshotted first
    // (requiresSafeQuit); view mode follows the config default.
    requiresSafeQuit: true,
    run: () => {
      const layout = useConfigStore.getState().config.editor.defaultPageLayout;
      void useDocumentStore
        .getState()
        .newDocument(layout === 'Pageless' ? 'pageless' : 'pages');
    },
  },
  {
    id: 'open',
    title: 'Open Document',
    icon: FolderOpen,
    group: 'actions',
    keywords: ['open', 'file', 'load', 'document'],
    run: () => void doc().openFile(),
  },
  {
    // The same pipeline as the ribbon's Illustrations button.
    id: 'insertImage',
    title: 'Insert Image',
    icon: ImageIcon,
    group: 'actions',
    contexts: ['editor'] as ('app' | 'editor')[],
    keywords: ['insert', 'image', 'picture', 'photo', 'upload', 'media'],
    enablement: () => !!doc().editor,
    run: () => {
      const editor = doc().editor;
      if (editor) void insertImageFromPicker(editor);
    },
  },
  {
    // Opens the same exact-dimension dialog the ribbon picker's
    // "Insert Table…" opens.
    id: 'insertTable',
    title: 'Insert Table…',
    icon: Table,
    group: 'actions',
    contexts: ['editor'] as ('app' | 'editor')[],
    keywords: ['insert', 'table', 'grid', 'rows', 'columns', 'cells'],
    enablement: () => !!doc().editor,
    run: () => {
      useInsertTableStore.getState().open();
    },
  },
  {
    id: 'save',
    title: 'Save',
    icon: Save,
    group: 'actions',
    shortcutId: 'save',
    keywords: ['save', 'store', 'write', 'disk'],
    enablement: isDirty,
    run: () => void doc().save(),
  },
  {
    id: 'saveAs',
    title: 'Save As',
    icon: SaveAll,
    group: 'actions',
    keywords: ['save', 'save as', 'export', 'rename', 'file'],
    run: () => void doc().saveAs(),
  },
  {
    id: 'exportMarkdown',
    title: 'Export Markdown',
    icon: FileDown,
    group: 'actions',
    // Palette-only for now; the lossy confirm lives inside
    // exportMarkdownFile.
    keywords: ['export', 'markdown', 'md', 'convert', 'save as'],
    enablement: () => !!doc().editor,
    run: () => void doc().exportMarkdown(),
  },
  {
    id: 'printPreview',
    title: 'Print Preview',
    icon: Printer,
    group: 'actions',
    shortcutId: 'printPreview',
    // #43 — the preview modal.
    keywords: ['print', 'preview', 'printer', 'pdf'],
    enablement: () => !!doc().editor,
    run: () => usePrintPreviewStore.getState().open(),
  },
  {
    id: 'exportDocx',
    title: 'Export Word Document',
    icon: FileText,
    group: 'actions',
    // #37 — the gate lives in exportDocxFile.
    keywords: ['export', 'word', 'docx', 'microsoft', 'convert', 'save as'],
    enablement: () => !!doc().editor,
    run: () => void doc().exportDocx(),
  },
  {
    id: 'undo',
    title: 'Undo',
    icon: Undo2,
    group: 'actions',
    shortcutId: 'undo',
    keywords: ['undo', 'revert', 'history'],
    enablement: canUndo,
    run: () => {
      // A focused text control owns undo: execCommand replays it on
      // that control's own history (the same stance as cut/copy).
      if (focusedTextControl()) {
        document.execCommand('undo');
        return;
      }
      doc().editor?.commands.undo();
    },
  },
  {
    id: 'redo',
    title: 'Redo',
    icon: Redo2,
    group: 'actions',
    shortcutId: 'redo',
    keywords: ['redo', 'repeat', 'history'],
    enablement: canRedo,
    run: () => {
      // Focused-text-control routing — see undo.
      if (focusedTextControl()) {
        document.execCommand('redo');
        return;
      }
      doc().editor?.commands.redo();
    },
  },
  {
    id: 'cut',
    title: 'Cut',
    icon: Scissors,
    group: 'actions',
    keywords: ['cut', 'clipboard', 'selection'],
    // execCommand, not the async Clipboard API: cut must act on the
    // focused surface's own selection, synchronously.
    run: () => {
      document.execCommand('cut');
    },
  },
  {
    id: 'copy',
    title: 'Copy',
    icon: Copy,
    group: 'actions',
    keywords: ['copy', 'clipboard', 'duplicate'],
    // execCommand per the cut rationale.
    run: () => {
      document.execCommand('copy');
    },
  },
  {
    id: 'paste',
    title: 'Paste',
    icon: ClipboardPaste,
    group: 'actions',
    keywords: ['paste', 'clipboard'],
    // Enablement omitted by law: clipboard emptiness is not cheaply/
    // synchronously readable (async + permission-gated) — never guess.
    run: () => {
      const editor = doc().editor;
      if (editor) void pasteFromSystemClipboard(editor);
    },
  },
  {
    id: 'toggleDarkMode',
    title: 'Toggle Dark Mode',
    icon: Moon,
    group: 'actions',
    keywords: ['dark', 'light', 'theme', 'mode', 'night'],
    run: () => {
      const { config, setTheme } = cfg();
      setTheme(config.theme === 'dark' ? 'light' : 'dark');
    },
  },
  {
    id: 'toggleRulers',
    title: 'Toggle Rulers',
    icon: Ruler,
    group: 'actions',
    keywords: ['ruler', 'rulers', 'show', 'hide', 'toggle', 'margins', 'tabs'],
    run: () => {
      const c = cfg().config.editor;
      cfg().setBothRulers(!(c.showHorizontalRuler || c.showVerticalRuler));
    },
  },
  {
    id: 'quit',
    title: 'Quit',
    icon: LogOut,
    group: 'actions',
    keywords: ['quit', 'exit', 'close', 'shutdown'],
    requiresSafeQuit: true,
    run: async () => {
      const { editor, filePath, isDirty, pageSetup, lineNumbers, coreProperties, headerFooter } = doc();
      // Safe-quit: a dirty doc snapshots via the existing recovery
      // path — same format, same restore flow.
      if (editor && isDirty) {
        await saveRecoveryCopy(editor, filePath, {
          pageSetup,
          lineNumbers,
          coreProperties,
          headerFooter,
          commentThreads: useCommentStore.getState().threadsForSave(),
        });
      }
      getCurrentWindow().close();
    },
  },

  // ── Actions (non-menu) ───────────────────────────────────────────
  {
    id: 'openSettings',
    title: 'Open Settings',
    icon: Settings,
    group: 'actions',
    shortcutId: 'openSettings',
    keywords: ['settings', 'preferences', 'options', 'config', 'configure'],
    run: () => useSettingsDialogStore.getState().open(),
  },
  {
    id: 'browseFonts',
    title: 'Browse Fonts',
    icon: Library,
    group: 'actions',
    keywords: ['fonts', 'font family', 'install', 'upload', 'typeface', 'browse'],
    run: () => useFontBrowserStore.getState().open(),
  },
  {
    id: 'createStyle',
    title: 'Create Style',
    icon: Plus,
    group: 'format',
    keywords: ['style', 'create', 'new', 'define', 'format'],
    run: () => useStyleDialogStore.getState().openDialog(null, 'paragraph'),
  },
  {
    id: 'palette',
    title: 'Command Palette',
    group: 'actions',
    shortcutId: 'palette',
    keywords: ['palette', 'command', 'search', 'actions', 'run'],
    run: () => usePaletteStore.getState().toggle(),
  },

  // ── Navigate (docs: view/document navigation & window) ───────────
  {
    id: 'documentProperties',
    title: 'Document Properties',
    icon: Info,
    group: 'navigate',
    keywords: ['properties', 'metadata', 'title', 'author', 'subject', 'keywords', 'comments', 'document', 'info'],
    run: () => useDocumentPropertiesStore.getState().open(),
  },
  // #58 — the one page-setup surface, palette-reachable.
  {
    id: 'pageSetup',
    title: 'Page Setup',
    icon: Proportions,
    group: 'navigate',
    keywords: ['page', 'setup', 'paper', 'size', 'orientation', 'margins', 'section', 'landscape', 'portrait'],
    run: () => useDocumentPropertiesStore.getState().openPageSetup(),
  },
  {
    id: 'findSidebar',
    title: 'Find & Replace (Sidebar)',
    icon: FileSearchCorner,
    group: 'navigate',
    shortcutId: 'find',
    keywords: ['find', 'search', 'replace', 'sidebar', 'advanced'],
    run: () => useSidebarStore.getState().open('search', 'right'),
  },
  {
    // The table side panel: fine-tuning + the alternate route when
    // the floating toolbar is off.
    id: 'tableSidebar',
    title: 'Table Properties (Sidebar)',
    icon: TableProperties,
    group: 'navigate',
    contexts: ['editor'] as ('app' | 'editor')[],
    keywords: ['table', 'properties', 'sidebar', 'panel', 'dimensions', 'columns', 'rows', 'width', 'height', 'merge', 'shading'],
    enablement: () => !!doc().editor,
    run: () => useSidebarStore.getState().open('table', 'right'),
  },
  {
    // The document-content checker (alt text, headings, contrast),
    // on-demand.
    id: 'accessibilityCheck',
    title: 'Check Accessibility',
    icon: PersonStanding,
    group: 'navigate',
    contexts: ['editor'] as ('app' | 'editor')[],
    keywords: ['accessibility', 'a11y', 'check', 'checker', 'issues', 'alt text', 'headings', 'contrast', 'review'],
    enablement: () => !!doc().editor,
    run: () => useSidebarStore.getState().open('accessibilityCheck', 'right'),
  },
  {
    // The watermark editor panel — text/image, whole document or one
    // section.
    id: 'watermarkPanel',
    title: 'Watermark',
    icon: Droplet,
    group: 'navigate',
    contexts: ['editor'] as ('app' | 'editor')[],
    keywords: ['watermark', 'draft', 'confidential', 'background', 'overlay', 'insert'],
    enablement: () => !!doc().editor,
    run: () => useSidebarStore.getState().open('watermark', 'right'),
  },
  {
    // The Review tab's on-demand translate panel.
    id: 'translateSidebar',
    title: 'Translate',
    icon: Languages,
    group: 'navigate',
    contexts: ['editor'] as ('app' | 'editor')[],
    keywords: ['translate', 'translation', 'language', 'libretranslate', 'bilingual', 'review'],
    enablement: () => !!doc().editor,
    run: () => useSidebarStore.getState().open('translate', 'right'),
  },
  {
    // The statistics dashboard sidebar, live while open.
    id: 'statisticsSidebar',
    title: 'Document Statistics (Sidebar)',
    icon: ChartColumn,
    group: 'navigate',
    contexts: ['editor'] as ('app' | 'editor')[],
    keywords: ['statistics', 'stats', 'words', 'characters', 'count', 'reading time', 'readability', 'flesch', 'sections', 'review'],
    enablement: () => !!doc().editor,
    run: () => useSidebarStore.getState().open('statistics', 'right'),
  },

  // Header/footer commands: enablement rides band-container presence.
  {
    id: 'insertHeader',
    title: 'Insert Header',
    icon: PanelTop,
    group: 'actions',
    contexts: ['editor'] as ('app' | 'editor')[],
    keywords: ['header', 'insert', 'band', 'top', 'margin'],
    enablement: () => !!doc().editor,
    run: () => enableRegion(doc().editor, 'header'),
  },
  {
    id: 'insertFooter',
    title: 'Insert Footer',
    icon: PanelBottom,
    group: 'actions',
    contexts: ['editor'] as ('app' | 'editor')[],
    keywords: ['footer', 'insert', 'band', 'bottom', 'margin'],
    enablement: () => !!doc().editor,
    run: () => enableRegion(doc().editor, 'footer'),
  },
  {
    id: 'toggleShowHeadersFooters',
    title: 'Toggle Headers & Footers',
    icon: Eye,
    group: 'navigate',
    keywords: ['header', 'footer', 'show', 'hide', 'display', 'toggle', 'band'],
    // Display-only toggle; the model round-trips regardless.
    run: () => {
      const { config, setShowHeadersFooters } = cfg();
      setShowHeadersFooters(!config.editor.showHeadersFooters);
    },
  },
  {
    id: 'removeAllHeadersFooters',
    title: 'Remove All Headers & Footers',
    icon: Eraser,
    group: 'actions',
    contexts: ['editor'] as ('app' | 'editor')[],
    keywords: ['header', 'footer', 'remove', 'delete', 'clear', 'band', 'all'],
    // Honest enablement: nothing to remove → hidden. Deletes every
    // band + resets differentFirstPage; undoable.
    enablement: () => {
      const editor = doc().editor;
      return (
        !!editor &&
        (hasBandContainer(editor, 'header') ||
          hasBandContainer(editor, 'footer') ||
          (doc().headerFooter?.differentFirstPage ?? false))
      );
    },
    run: () => {
      const editor = doc().editor;
      if (!editor) return;
      // Collect then delete in REVERSE order — deleting while walking
      // invalidates later positions. One PM step.
      const targets: Array<{ pos: number; size: number }> = [];
      editor.state.doc.descendants((node, pos) => {
        if (node.type.name !== 'headerBlock' && node.type.name !== 'footerBlock') return true;
        targets.push({ pos, size: node.nodeSize });
        return false; // children die with the container
      });
      if (targets.length > 0) {
        const tr = editor.state.tr;
        for (const { pos, size } of targets.reverse()) tr.delete(pos, pos + size);
        editor.view.dispatch(tr);
      }
      const store = doc();
      const current = store.headerFooter ?? defaultHeaderFooterSettings();
      if (current.differentFirstPage) {
        store.setHeaderFooter({
          ...cloneHeaderFooterSettings(current),
          differentFirstPage: false,
        });
      }
    },
  },
  // Reference-table commands: the insert trio routes through the one
  // insertion helper (refusal checks + toast); enablement is honest
  // and cheap.
  {
    id: 'insertTableOfContents',
    title: 'Insert Table of Contents',
    icon: List,
    group: 'actions',
    contexts: ['editor'] as ('app' | 'editor')[],
    keywords: ['insert', 'table of contents', 'toc', 'contents', 'headings', 'reference'],
    enablement: () => canInsertReferenceTable(),
    run: () => useInsertReferenceTableStore.getState().open(),
  },
  {
    id: 'insertTableOfFigures',
    title: 'Insert Table of Figures',
    icon: ImageIcon,
    group: 'actions',
    contexts: ['editor'] as ('app' | 'editor')[],
    keywords: ['insert', 'table of figures', 'figures', 'captions', 'images', 'reference'],
    enablement: () => canInsertReferenceTable(),
    run: () => {
      const editor = doc().editor;
      if (editor) insertReferenceTableAtSelection(editor, 'figures');
    },
  },
  {
    id: 'insertIndex',
    title: 'Insert Index',
    icon: BookOpen,
    group: 'actions',
    contexts: ['editor'] as ('app' | 'editor')[],
    keywords: ['insert', 'index', 'terms', 'marked', 'reference', 'alphabetical'],
    enablement: () => canInsertReferenceTable(),
    run: () => {
      const editor = doc().editor;
      if (editor) insertReferenceTableAtSelection(editor, 'index');
    },
  },
  {
    id: 'markIndexEntry',
    title: 'Mark as Index Entry',
    icon: BookmarkPlus,
    group: 'format',
    contexts: ['editor'] as ('app' | 'editor')[],
    keywords: ['index', 'mark', 'entry', 'term', 'keyword', 'reference'],
    // The mark's whole contract: a non-empty selection.
    enablement: () => !!doc().editor && !doc().editor!.state.selection.empty,
    run: () => doc().editor?.chain().focus().setIndexEntry().run(),
  },
  {
    id: 'removeIndexEntry',
    title: 'Remove Index Entry Mark',
    icon: BookmarkMinus,
    group: 'format',
    contexts: ['editor'] as ('app' | 'editor')[],
    keywords: ['index', 'remove', 'unmark', 'entry', 'term', 'mark'],
    enablement: () => !!doc().editor && indexEntryActive(doc().editor!.state),
    run: () => doc().editor?.chain().focus().unsetIndexEntry().run(),
  },

  {
    id: 'toggleNPC',
    title: 'Toggle Non-Printing Characters',
    icon: Pilcrow,
    group: 'navigate',
    keywords: ['non-printing', 'nonprinting', 'pilcrow', 'paragraph marks', 'npc', 'formatting marks'],
    run: () => {
      const { config, setShowNonPrintingChars } = cfg();
      setShowNonPrintingChars(!config.editor.showNonPrintingChars);
    },
  },
  {
    id: 'toggleLineNumbers',
    title: 'Toggle Line Numbers',
    icon: List,
    group: 'navigate',
    keywords: ['line numbers', 'gutter', 'numbering', 'count', 'lines'],
    // No enablement predicate by design: toggling is always offered —
    // it writes the DOCUMENT's setting (marks dirty), not app config.
    run: () => {
      const store = useDocumentStore.getState();
      const current = store.lineNumbers;
      store.setLineNumbers({
        enabled: !(current?.enabled ?? false),
        mode: current?.mode ?? 'per-page',
        countBy: current?.countBy,
      });
    },
  },
  {
    id: 'toggleSpellCheck',
    title: 'Toggle Spelling & Grammar',
    icon: SpellCheck,
    group: 'navigate',
    keywords: ['spell', 'spelling', 'grammar', 'check', 'proof', 'proofing', 'languagetool'],
    // First enable opens the setup dialog (provider never defaulted);
    // the master switch flips both features together.
    run: () => {
      const { config, setSpellCheckEnabled } = cfg();
      if (!config.spellCheck.configured) {
        useSpellStore.getState().openSetup();
        return;
      }
      setSpellCheckEnabled(!spellCheckActive(config.spellCheck));
    },
  },
  // Image commands: enablement = an image NodeSelection.
  ...(() => {
    const imageSelected = () => selectedImageRef() !== null;
    // Align is a block-image fact; enablement is block-selection only.
    const blockImageSelected = () => selectedImageRef('image') !== null;
    const RADIUS_STEP = 4;
    const alignCommand = (align: 'left' | 'center' | 'right') => ({
      id: `imageAlign${align === 'left' ? 'Left' : align === 'center' ? 'Center' : 'Right'}`,
      title: `Align Image ${align === 'left' ? 'Left' : align === 'center' ? 'Center' : 'Right'}`,
      icon: align === 'left' ? AlignLeft : align === 'center' ? AlignCenter : AlignRight,
      group: 'format' as const,
      contexts: ['editor'] as ('app' | 'editor')[],
      keywords: ['image', 'align', align],
      enablement: blockImageSelected,
      run: () => writeImageAttrsRef({ align }, 'image'),
    });
    return [
      alignCommand('left'),
      alignCommand('center'),
      alignCommand('right'),
      {
        id: 'imageAddCaption',
        title: 'Add Caption to Image',
        icon: MessageSquareText,
        group: 'format' as const,
        contexts: ['editor'] as ('app' | 'editor')[],
        keywords: ['image', 'caption', 'figure', 'label'],
        enablement: imageSelected,
        run: () => {
          const editor = useDocumentStore.getState().editor;
          if (editor) insertCaptionForImage(editor);
        },
      },
      {
        id: 'imageAltText',
        title: 'Edit Image Alt Text',
        icon: TextCursorInput,
        group: 'format' as const,
        contexts: ['editor'] as ('app' | 'editor')[],
        keywords: ['image', 'alt', 'accessibility', 'description'],
        enablement: imageSelected,
        run: () => {
          const sel = selectedImageRef();
          if (sel) {
            useAltTextStore
              .getState()
              .open(
                sel.pos,
                String(sel.attrs.alt ?? ''),
                (sel.attrs.src as string | null) ?? null,
                sel.attrs.decorative === true,
              );
          }
        },
      },
      {
        id: 'imageRadiusUp',
        title: 'Increase Image Corner Radius',
        icon: Squircle,
        group: 'format' as const,
        contexts: ['editor'] as ('app' | 'editor')[],
        keywords: ['image', 'radius', 'corner', 'round'],
        enablement: imageSelected,
        run: () => {
          const sel = selectedImageRef();
          if (!sel) return;
          const next = clampRadiusRef(Number(sel.attrs.radius ?? 0) + RADIUS_STEP, sel.attrs);
          writeImageAttrsRef({ radius: next });
        },
      },
      {
        id: 'imageRadiusDown',
        title: 'Decrease Image Corner Radius',
        icon: Squircle,
        group: 'format' as const,
        contexts: ['editor'] as ('app' | 'editor')[],
        keywords: ['image', 'radius', 'corner', 'round'],
        enablement: imageSelected,
        run: () => {
          const sel = selectedImageRef();
          if (!sel) return;
          const next = clampRadiusRef(Number(sel.attrs.radius ?? 0) - RADIUS_STEP, sel.attrs);
          writeImageAttrsRef({ radius: next });
        },
      },
      {
        id: 'imageWrapInline',
        title: 'Image: In Line with Text',
        icon: WrapText,
        group: 'format' as const,
        contexts: ['editor'] as ('app' | 'editor')[],
        keywords: ['image', 'wrap', 'inline', 'text', 'convert'],
        enablement: imageSelected,
        run: () => {
          const editor = useDocumentStore.getState().editor;
          if (editor) setWrapMode(editor, 'inline');
        },
      },
      {
        id: 'imageWrapFront',
        title: 'Image: In Front of Text',
        icon: BringToFront,
        group: 'format' as const,
        contexts: ['editor'] as ('app' | 'editor')[],
        keywords: ['image', 'wrap', 'float', 'front', 'anchor'],
        enablement: imageSelected,
        run: () => {
          const editor = useDocumentStore.getState().editor;
          if (editor) setWrapMode(editor, 'front');
        },
      },
      {
        id: 'imageWrapBehind',
        title: 'Image: Behind Text',
        icon: SendToBack,
        group: 'format' as const,
        contexts: ['editor'] as ('app' | 'editor')[],
        keywords: ['image', 'wrap', 'float', 'behind', 'background'],
        enablement: imageSelected,
        run: () => {
          const editor = useDocumentStore.getState().editor;
          if (editor) setWrapMode(editor, 'behind');
        },
      },
    ];
  })(),

  // Mode flavors: invoking the command while already in that mode
  // turns the gutter off (toggle semantics).
  ...(['per-page', 'continuous', 'per-paragraph'] as const).map((mode) => ({
    id: `lineNumbers:${mode}`,
    title: `Line Numbers: ${mode === 'per-page' ? 'Per Page' : mode === 'per-paragraph' ? 'Per Paragraph' : 'Continuous'}`,
    icon: ListOrdered,
    group: 'navigate' as const,
    keywords: ['line numbers', 'gutter', 'numbering', mode.replace('-', ' '), 'count', 'lines'],
    run: () => {
      const store = useDocumentStore.getState();
      const current = store.lineNumbers;
      const alreadyActive = current?.enabled === true && current.mode === mode;
      store.setLineNumbers({
        enabled: !alreadyActive,
        mode,
        countBy: current?.countBy,
      });
    },
  })),
  {
    id: 'zoomIn',
    title: 'Zoom In',
    icon: ZoomIn,
    group: 'navigate',
    keywords: ['zoom', 'in', 'magnify', 'bigger', 'larger'],
    run: () => cfg().setZoomLevel(cfg().config.editor.zoomLevel + 10),
  },
  {
    id: 'zoomOut',
    title: 'Zoom Out',
    icon: ZoomOut,
    group: 'navigate',
    keywords: ['zoom', 'out', 'shrink', 'smaller'],
    run: () => cfg().setZoomLevel(cfg().config.editor.zoomLevel - 10),
  },
  {
    id: 'zoomReset',
    title: 'Reset Zoom to 100%',
    icon: Maximize,
    group: 'navigate',
    keywords: ['zoom', 'reset', '100', 'normal', 'default'],
    run: () => cfg().setZoomLevel(100),
  },
  {
    // One body for the View tab, F11, and the palette. On exit,
    // re-focus the editor: the button unmounts under the caret, and
    // PM's selection survives — focus just needs the nudge.
    id: 'toggleFocusMode',
    title: 'Toggle Focus Mode',
    icon: Maximize,
    group: 'navigate',
    keywords: ['focus', 'distraction', 'free', 'zen', 'hide', 'chrome', 'immersive'],
    shortcutId: 'toggleFocusMode',
    run: () => {
      useFocusStore.getState().toggle();
      if (!useFocusStore.getState().active) {
        useDocumentStore.getState().editor?.commands.focus();
      }
    },
  },
  {
    // The outside-space toggle — the comments gutter today. Hiding
    // never reflows the document.
    id: 'toggleBoundaryContent',
    title: 'Show Boundary Content',
    icon: SquareDashed,
    group: 'navigate',
    keywords: ['boundary', 'margin', 'margins', 'outside', 'comments', 'gutter', 'annotations'],
    run: () => {
      cfg().setShowBoundaryContent(!cfg().config.editor.showBoundaryContent);
    },
  },

  // ── Format (editor-context commands — shared ShortcutsExtension
  //    dispatch path; the palette never re-implements one) ──────────
  editorCommand('bold', {
    title: 'Bold',
    icon: Bold,
    group: 'format',
    shortcutId: 'bold',
    keywords: ['bold', 'b', 'format', 'strong'],
  }),
  editorCommand('italic', {
    title: 'Italic',
    icon: Italic,
    group: 'format',
    shortcutId: 'italic',
    keywords: ['italic', 'i', 'format', 'emphasis'],
  }),
  editorCommand('underline', {
    title: 'Underline',
    icon: UnderlineIcon,
    group: 'format',
    shortcutId: 'underline',
    keywords: ['underline', 'u', 'format'],
  }),
  editorCommand('strike', {
    title: 'Strikethrough',
    icon: Strikethrough,
    group: 'format',
    shortcutId: 'strike',
    keywords: ['strikethrough', 'strike', 'cross out', 'format'],
  }),
  editorCommand('clearFormatting', {
    title: 'Clear Formatting',
    icon: RemoveFormatting,
    group: 'format',
    shortcutId: 'clearFormatting',
    keywords: ['clear', 'remove', 'formatting', 'plain', 'reset'],
  }),
  editorCommand('fontSizeUp', {
    title: 'Increase Font Size',
    icon: CaseSensitive,
    group: 'format',
    shortcutId: 'fontSizeUp',
    keywords: ['font', 'size', 'grow', 'bigger', 'larger'],
  }),
  editorCommand('fontSizeDown', {
    title: 'Decrease Font Size',
    icon: CaseSensitive,
    group: 'format',
    shortcutId: 'fontSizeDown',
    keywords: ['font', 'size', 'shrink', 'smaller'],
  }),
  editorCommand('insertPageBreak', {
    title: 'Insert Page Break',
    icon: SeparatorHorizontal,
    group: 'format',
    shortcutId: 'insertPageBreak',
    keywords: ['page', 'break', 'insert', 'new page'],
  }),
  editorCommand('insertSectionBreak', {
    title: 'Insert Section Break',
    icon: SeparatorHorizontal,
    group: 'format',
    shortcutId: 'insertSectionBreak',
    keywords: ['section', 'break', 'insert', 'new section'],
  }),
  // #74 — the manual column break (the page break's twin).
  editorCommand('insertColumnBreak', {
    title: 'Insert Column Break',
    icon: SeparatorHorizontal,
    group: 'format',
    shortcutId: 'insertColumnBreak',
    keywords: ['column', 'break', 'insert', 'columns'],
  }),
  editorCommand('insertLink', {
    title: 'Insert Hyperlink',
    icon: Link2,
    group: 'format',
    shortcutId: 'insertLink',
    keywords: ['link', 'hyperlink', 'url', 'insert'],
  }),
  // The one comment body lives in EDITOR_COMMAND_MAP; always enabled —
  // the body's guards are loud fallbacks, not disabled states.
  editorCommand('addComment', {
    title: 'Add Comment',
    icon: MessageSquarePlus,
    group: 'actions',
    shortcutId: 'addComment',
    enablement: () => !!doc().editor,
    keywords: ['comment', 'note', 'annotate', 'remark', 'feedback', 'review', 'margin'],
  }),
  editorCommand('insertEquation', {
    title: 'Insert Equation',
    icon: Sigma,
    group: 'format',
    shortcutId: 'insertEquation',
    keywords: ['equation', 'formula', 'math', 'latex', 'insert', 'sigma'],
  }),
  editorCommand('alignLeft', {
    title: 'Align Left',
    icon: AlignLeft,
    group: 'format',
    shortcutId: 'alignLeft',
    keywords: ['align', 'left', 'justify'],
  }),
  editorCommand('alignCenter', {
    title: 'Align Center',
    icon: AlignCenter,
    group: 'format',
    shortcutId: 'alignCenter',
    keywords: ['align', 'center', 'middle'],
  }),
  editorCommand('alignRight', {
    title: 'Align Right',
    icon: AlignRight,
    group: 'format',
    shortcutId: 'alignRight',
    keywords: ['align', 'right'],
  }),
  editorCommand('alignJustify', {
    title: 'Justify',
    icon: AlignJustify,
    group: 'format',
    shortcutId: 'alignJustify',
    keywords: ['align', 'justify', 'full'],
  }),
  editorCommand('unorderedList', {
    title: 'Bullet List',
    icon: List,
    group: 'format',
    shortcutId: 'unorderedList',
    keywords: ['bullet', 'list', 'unordered', 'ul'],
  }),
  editorCommand('orderedList', {
    title: 'Numbered List',
    icon: ListOrdered,
    group: 'format',
    shortcutId: 'orderedList',
    keywords: ['numbered', 'list', 'ordered', 'ol'],
  }),
  editorCommand('increaseIndent', {
    title: 'Increase Indent',
    icon: IndentIncrease,
    group: 'format',
    shortcutId: 'increaseIndent',
    keywords: ['indent', 'increase', 'more', 'tab'],
  }),
  editorCommand('decreaseIndent', {
    title: 'Decrease Indent',
    icon: IndentDecrease,
    group: 'format',
    shortcutId: 'decreaseIndent',
    keywords: ['indent', 'decrease', 'less', 'outdent'],
  }),
  editorCommand('applyStyleNormal', {
    title: 'Apply Normal Text Style',
    icon: Pilcrow,
    group: 'format',
    keywords: ['style', 'normal', 'body', 'apply'],
  }),
  editorCommand('applyStyleHeading1', {
    title: 'Apply Heading 1 Style',
    icon: Heading1,
    group: 'format',
    keywords: ['style', 'heading', 'title', 'h1', 'apply'],
  }),
  editorCommand('applyStyleHeading2', {
    title: 'Apply Heading 2 Style',
    icon: Heading2,
    group: 'format',
    keywords: ['style', 'heading', 'h2', 'apply'],
  }),
  editorCommand('applyStyleHeading3', {
    title: 'Apply Heading 3 Style',
    icon: Heading3,
    group: 'format',
    keywords: ['style', 'heading', 'h3', 'apply'],
  }),
  editorCommand('applyStyleQuote', {
    title: 'Apply Quote Style',
    icon: Quote,
    group: 'format',
    keywords: ['style', 'quote', 'blockquote', 'apply'],
  }),
];

/** Direct radius entry (the toolbar input): the same clamp law;
 * returns the clamped value actually written, or null with no selection. */
export function setImageRadiusOnSelection(value: number): number | null {
  const sel = selectedImageRef();
  if (!sel) return null;
  const clamped = clampRadiusRef(Number.isFinite(value) ? Math.round(value) : 0, sel.attrs);
  writeImageAttrsRef({ radius: clamped });
  return clamped;
}

export function getCommand(id: string): CommandAction | undefined {
  return COMMANDS.find((c) => c.id === id);
}
