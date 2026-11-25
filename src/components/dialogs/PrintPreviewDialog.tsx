import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import {
  BookOpen,
  ChevronDown,
  ChevronUp,
  Copy,
  FileText,
  Files,
  FlipVertical,
  Hash,
  Layers,
  ListPlus,
  Printer,
  RectangleVertical,
  Ruler,
  Type,
  UserRoundPen,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { useDocumentStore } from "@/lib/document/store";
import {
  toPdfInfo,
  type DocumentCoreProperties,
} from "@/lib/document/coreProperties";
import { PAGE_SIZES, formatMarginsSummary } from "@/lib/document/pageSetup";
import { useDocumentPropertiesStore } from "@/lib/document/propertiesStore";
import {
  enumeratePrinters,
  printPdfToPrinter,
  type NativePrinter,
} from "@/lib/print/nativePrint";
import { useMediaStore } from "@/lib/media/store";
import { exportPdf } from "@/lib/print/pdfExport";
import { toast } from "@/components/ui/toast";
import { save } from "@tauri-apps/plugin-dialog";
import { exists, writeFile } from "@tauri-apps/plugin-fs";
import { useConfigStore } from "@/lib/config/store";
import { buildPrintDocument, parsePageRange } from "@/lib/print/buildDocument";
import { printFromPreview } from "@/lib/print/PrintContainer";
import { PrintDocumentView } from "@/lib/print/PrintDocumentView";
import { create } from "zustand";

// #43 — the custom print dialog: one modal, destinations as a segmented
// control (Printer | PDF) since both consume the same walk. The PDF commit
// labels the resolved path; the always-ask trigger is the escape hatch.

interface PrintPreviewStore {
  isOpen: boolean;
  open: () => void;
  close: () => void;
}

export const usePrintPreviewStore = create<PrintPreviewStore>((set) => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
}));

const ZOOM_STEPS = [50, 75, 100, 125, 150, 200];
/** The sheet gutter BETWEEN preview pages (px, pre-zoom — scales). */
const PAGE_GAP = 24;

/** A Windows/POSIX-safe file-stem from any string. */
function safeName(raw: string): string {
  const trimmed = raw.trim().replace(/\.(pdf)$/i, "");
  return (trimmed || "Untitled").replace(/[\\/:*?"<>|]/g, "_");
}

const DUPLEX_OPTIONS = [
  { value: "one-sided", label: "One-sided", icon: RectangleVertical },
  {
    value: "two-sided-long-edge",
    label: "Two-sided · long edge",
    icon: BookOpen,
  },
  {
    value: "two-sided-short-edge",
    label: "Two-sided · short edge",
    icon: FlipVertical,
  },
] as const;

export function PrintPreviewDialog() {
  const isOpen = usePrintPreviewStore((s) => s.isOpen);
  const close = usePrintPreviewStore((s) => s.close);
  const editor = useDocumentStore((s) => s.editor);
  const pageSetup = useDocumentStore((s) => s.pageSetup);
  const coreProperties = useDocumentStore((s) => s.coreProperties);
  const setCoreProperties = useDocumentStore((s) => s.setCoreProperties);

  // The last destination rides config; the control is its editor.
  const destination = useConfigStore((s) => s.config.print.lastDestination);
  const setPrintLastDestination = useConfigStore(
    (s) => s.setPrintLastDestination,
  );
  const downloadsDir = useConfigStore((s) => s.config.downloadsDir);
  // The Kbd hints map to the configured trigger (Shift default).
  const triggerConf = useConfigStore((s) => s.config.pdfAlwaysAskTrigger);
  const triggerLabel = triggerConf === "ctrl" ? "Ctrl" : "Shift";
  // Margins display in the user's measurement unit.
  const unit = useConfigStore((s) => s.config.editor.measurementUnit);

  // Snapshot: build once per open — the walk + layout are heavy.
  const build = useMemo(
    () => (isOpen && editor ? buildPrintDocument(editor) : null),
    // pageSetup changes while CLOSED re-build on the next open (isOpen
    // in the deps re-runs this on open); while OPEN the snapshot stands.
    [isOpen, editor],
  );

  const [rangeRaw, setRangeRaw] = useState("");
  const [zoom, setZoom] = useState<number | "fit">("fit");
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const rangeInputRef = useRef<HTMLInputElement | null>(null);
  const [fitScale, setFitScale] = useState(1);
  // The per-open filename, seeded from the doc's title or file name.
  const [fileNameRaw, setFileNameRaw] = useState("");

  // Enumerated once per open. [] outside Tauri → an empty picker, commit
  // disabled — the system dialog lives behind the trigger.
  const [printers, setPrinters] = useState<NativePrinter[]>([]);
  const [printerSel, setPrinterSel] = useState<string>("");
  const [copies, setCopies] = useState(1);
  // Seeded from print.lastDuplex — a concrete choice, remembered.
  const setPrintLastDuplex = useConfigStore((s) => s.setPrintLastDuplex);
  const [duplex, setDuplex] = useState<
    "one-sided" | "two-sided-long-edge" | "two-sided-short-edge"
  >("one-sided");
  const [isPrinting, setIsPrinting] = useState(false);

  useEffect(() => {
    if (!isOpen) {
      setCopies(1);
      setDuplex(useConfigStore.getState().config.print.lastDuplex);
      return;
    }
    setDuplex(useConfigStore.getState().config.print.lastDuplex);
    void (async () => {
      const list = await enumeratePrinters();
      setPrinters(list);
      const fallback = list.find((p) => p.isDefault) ?? list[0];
      setPrinterSel(fallback ? fallback.name : "");
    })();
  }, [isOpen]);

  // Hover-ellipsis: holding the configured trigger over the commit button
  // grows the label's "…" (that click opens a dialog). Modifier state also
  // syncs from pointer events — a swallowed keyup must not leave modHeld stale.
  const [commitHover, setCommitHover] = useState(false);
  const [modHeld, setModHeld] = useState(false);
  const syncModifiers = (e: {
    shiftKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
  }) => {
    const held =
      useConfigStore.getState().config.pdfAlwaysAskTrigger === "ctrl"
        ? e.ctrlKey || e.metaKey
        : e.shiftKey;
    setModHeld(held);
  };
  useEffect(() => {
    if (!isOpen) {
      setCommitHover(false);
      setModHeld(false);
      return;
    }
    window.addEventListener("keydown", syncModifiers);
    window.addEventListener("keyup", syncModifiers);
    return () => {
      window.removeEventListener("keydown", syncModifiers);
      window.removeEventListener("keyup", syncModifiers);
    };
  }, [isOpen]);
  const triggerEllipsis = commitHover && modHeld ? "…" : "";

  // Fit-width scale. The observer watches the CONTENT box — a scrollbar
  // steals width after the first compute (border-box never fires).
  // #58 — fit against the WIDEST page; pages[0] would clip a wider sheet.
  const widestPage = build ? build.pages.reduce((m, p) => Math.max(m, p.width), 0) : 0;
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || widestPage <= 0) return;
    const compute = () => {
      const avail = el.clientWidth - 48; // the sheet side gutters
      setFitScale(Math.min(1, avail / widestPage));
    };
    compute();
    // Post-animation settle (the dialog's zoom-in): one deferred pass.
    const raf = requestAnimationFrame(compute);
    const ro = new ResizeObserver(compute);
    ro.observe(el, { box: "content-box" });
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [widestPage, isOpen]);

  useEffect(() => {
    if (!isOpen) {
      setRangeRaw("");
      setZoom("fit");
      return;
    }
    // Seed the filename (title → file name → Untitled) and focus the range input.
    const doc = useDocumentStore.getState();
    setFileNameRaw(
      doc.coreProperties.title?.trim() ||
        (doc.filePath
          ? doc.filePath
              .split(/[\\/]/)
              .pop()
              ?.replace(/\.[^.]+$/, "")
          : "") ||
        "Untitled",
    );
    const raf = requestAnimationFrame(() => rangeInputRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [isOpen]);

  if (!isOpen || !build || !editor) return null;

  const scale = zoom === "fit" ? fitScale : zoom / 100;
  const visiblePages = parsePageRange(rangeRaw, build.total);

  // #58 — the wrapper spans the widest page (mixed sections).
  const pageW = widestPage;
  // #58 — per-section setups make pages differ; a single size name would lie.
  const sizesUniform =
    build.pages.every((p) => p.width === build.pages[0]!.width && p.height === build.pages[0]!.height);
  const paperLabel = sizesUniform
    ? `${pageSetup.pageSize}${pageSetup.orientation === "landscape" ? " (landscape)" : ""}`
    : "Mixed (per section)";
  // Margins display in the user's unit, never raw "72/72/72/72 pt".
  const marginsLabel = formatMarginsSummary(pageSetup.margins, unit);
  // The inches suffix only means something under ONE paper size.
  const paperSizeLabel = sizesUniform ? PAGE_SIZES[pageSetup.pageSize]?.inches : undefined;

  const nameBase = safeName(fileNameRaw);

  /** The configured modifier held on this event (Ctrl honors ⌘)?
   *  Shared by the click and Enter keyboard paths. */
  const triggerHeld = (e: {
    shiftKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
  }) => {
    const trigger = useConfigStore.getState().config.pdfAlwaysAskTrigger;
    return trigger === "ctrl" ? e.ctrlKey || e.metaKey : e.shiftKey;
  };

  const selectedPages = visiblePages
    ? build.pages.filter((p) => visiblePages.has(p.index))
    : build.pages;

  /** The commit. PDF: synthesize from this preview's own walk (what
   *  previews is what exports) — the resolved folder with an
   *  exists-suffix (never a silent overwrite), or the save prompt.
   *  Printer: the same filtered walk. */
  const commitPdf = async (forcePrompt: boolean): Promise<void> => {
    const pages = selectedPages;
    if (pages.length === 0) return;
    const doc = useDocumentStore.getState();
    try {
      const result = await exportPdf({
        pages,
        info: toPdfInfo(doc.coreProperties),
        mediaBytes: (sha) => {
          const entry = useMediaStore.getState().entries.get(sha);
          return entry ? { bytes: entry.bytes, ext: entry.ext } : undefined;
        },
      });
      let path: string | null = null;
      if (!forcePrompt && downloadsDir) {
        const sep = downloadsDir.includes("/") ? "/" : "\\";
        const base =
          downloadsDir.endsWith("/") || downloadsDir.endsWith("\\")
            ? downloadsDir
            : downloadsDir + sep;
        let candidate = `${base}${nameBase}.pdf`;
        for (let i = 2; await exists(candidate); i++) {
          candidate = `${base}${nameBase} (${i}).pdf`;
          if (i > 99) break;
        }
        path = candidate;
      } else {
        path = await save({
          filters: [{ name: "PDF Document", extensions: ["pdf"] }],
          defaultPath: `${nameBase}.pdf`,
        });
      }
      if (!path) return;
      await writeFile(path, result.bytes);
      const notes: string[] = [
        `${pages.length} page${pages.length === 1 ? "" : "s"}`,
        `saved to ${path}`,
      ];
      if (result.substitutedFonts.length > 0) {
        notes.push(`fonts substituted: ${result.substitutedFonts.join(", ")}`);
      }
      if (result.skippedImages > 0) {
        notes.push(
          `${result.skippedImages} image${result.skippedImages === 1 ? "" : "s"} skipped`,
        );
      }
      if (result.fallbackEquations > 0) {
        notes.push(
          `${result.fallbackEquations} equation${result.fallbackEquations === 1 ? "" : "s"} as source text`,
        );
      }
      toast.add({ title: "PDF exported", description: notes.join(" — ") });
      // Success closes (both destinations); an error toasts and the
      // modal stays — fix the destination, retry.
      usePrintPreviewStore.getState().close();
    } catch (err) {
      toast.add({
        title: "PDF export failed",
        description:
          err instanceof Error
            ? err.message
            : "The export could not be written.",
      });
    }
  };

  const commitPrinter = (forcePrompt: boolean): void => {
    // The OS dialog (window.print) lives behind the configured modifier —
    // for the broken-printer case and driver features CUPS doesn't cover.
    if (forcePrompt || !printerSel) {
      void printFromPreview(selectedPages, pageSetup);
      return;
    }
    // Native path: walk → PDF → temp file → CUPS job; the PDF carries
    // the page dims. The duplex choice persists as last-used.
    setPrintLastDuplex(duplex);
    setIsPrinting(true);
    const doc = useDocumentStore.getState();
    void (async () => {
      try {
        const result = await exportPdf({
          pages: selectedPages,
          info: toPdfInfo(doc.coreProperties),
          mediaBytes: (sha) => {
            const entry = useMediaStore.getState().entries.get(sha);
            return entry ? { bytes: entry.bytes, ext: entry.ext } : undefined;
          },
        });
        const jobId = await printPdfToPrinter({
          printer: printerSel,
          bytes: result.bytes,
          copies,
          duplex,
          jobBase: nameBase,
        });
        const notes: string[] = [
          `job #${jobId}`,
          `${selectedPages.length} page${selectedPages.length === 1 ? "" : "s"}`,
        ];
        if (copies > 1) notes.push(`${copies} copies`);
        toast.add({ title: "Sent to printer", description: notes.join(" — ") });
        usePrintPreviewStore.getState().close();
      } catch (err) {
        toast.add({
          title: "Print failed",
          description:
            err instanceof Error
              ? err.message
              : "The print job could not be submitted.",
        });
      } finally {
        setIsPrinting(false);
      }
    })();
  };

  const commit = (forcePrompt: boolean): void => {
    if (build.pages.length === 0) return;
    if (destination === "pdf") void commitPdf(forcePrompt);
    else commitPrinter(forcePrompt);
  };

  /** Enter commits the active destination; the configured trigger
   *  held force-prompts. Esc is the Dialog's own. */
  const onKeyDown = (e: KeyboardEvent<HTMLElement>): void => {
    if (e.key !== "Enter") return;
    // A button's Enter is its own click — let it run, don't double.
    const target = e.target as HTMLElement;
    if (target.tagName === "BUTTON") return;
    e.preventDefault();
    commit(triggerHeld(e));
  };

  const zoomPct = Math.round(scale * 100);
  const zoomIn = () => {
    const idx = ZOOM_STEPS.findIndex((z) => z > zoomPct);
    setZoom(ZOOM_STEPS[idx === -1 ? ZOOM_STEPS.length - 1 : idx]);
  };
  const zoomOut = () => {
    const idx = ZOOM_STEPS.findIndex((z) => z >= zoomPct);
    setZoom(
      ZOOM_STEPS[Math.max(0, (idx === -1 ? ZOOM_STEPS.length : idx) - 1)],
    );
  };

  /** Metadata write-through: these inputs edit coreProperties
   *  directly (marked dirty); the PDF's info reads the same object
   *  on commit. Never a forked copy. */
  const writeMeta = (key: "title" | "author", value: string): void => {
    const next: DocumentCoreProperties = { ...coreProperties };
    if (value.trim()) next[key] = value;
    else delete next[key];
    setCoreProperties(next);
  };

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent
        showCloseButton
        data-testid="print-preview"
        // Larger than Settings — a preview wants the room.
        style={{ width: "min(90vw, 80rem)", maxWidth: "min(90vw, 80rem)" }}
      >
        <DialogDescription className="sr-only">
          Print preview — what previews is exactly what prints
        </DialogDescription>

        <div
          className="-m-4 flex flex-col overflow-hidden rounded-xl"
          style={{ height: "min(85vh, 50rem)" }}
          onKeyDown={onKeyDown}
        >
          <div className="flex-none border-b border-border px-4 py-3 pr-10">
            <DialogTitle className="font-heading text-base font-semibold">
              Print Preview
            </DialogTitle>
          </div>

          <div className="flex flex-1 overflow-hidden">
            {/* LEFT — the document; the zoom controls float bottom-right. */}
            <div className="relative flex-1 overflow-hidden">
              <div
                ref={scrollRef}
                className="absolute inset-0 overflow-auto bg-neutral-200 p-6 dark:bg-neutral-800"
              >
                <div
                  style={{
                    width: pageW * scale > 0 ? pageW * scale : undefined,
                    margin: "0 auto",
                    position: "relative",
                  }}
                >
                  <div
                    style={{
                      transform: `scale(${scale})`,
                      transformOrigin: "top left",
                      position: "absolute",
                      top: 0,
                      left: 0,
                    }}
                  >
                    {/* The view's column + --print-page-gap sets the sheet
                        gutter; the print container overrides it to 0
                        (@page breaks separate sheets). */}
                    <div
                      style={{
                        ["--print-page-gap" as string]: `${PAGE_GAP}px`,
                      }}
                    >
                      <PrintDocumentView
                        pages={build.pages}
                        visiblePages={visiblePages}
                        // #58 — mixed page widths center in the preview;
                        // the print container keeps flex-start (ink at the
                        // paper origin).
                        align="center"
                      />
                    </div>
                  </div>
                </div>
              </div>

              {/* The zoom overlay — floating bottom-right, never stealing
                  layout from the sheets. */}
              <div
                data-testid="print-preview-zoom"
                className="absolute bottom-4 right-4 z-10 flex items-center gap-0.5 rounded-full border border-border bg-background/95 p-1 shadow-lg backdrop-blur"
              >
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 rounded-full px-2"
                  aria-label="Zoom out"
                  onClick={zoomOut}
                >
                  <ZoomOut className="h-4 w-4" />
                </Button>
                <button
                  type="button"
                  className={`rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
                    zoom === "fit"
                      ? "bg-accent text-accent-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                  onClick={() => setZoom("fit")}
                >
                  Fit
                </button>
                <span className="w-11 text-center text-xs tabular-nums text-muted-foreground">
                  {zoomPct}%
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 rounded-full px-2"
                  aria-label="Zoom in"
                  onClick={zoomIn}
                >
                  <ZoomIn className="h-4 w-4" />
                </Button>
              </div>
            </div>

            {/* RIGHT — destination + options (the icon cards) */}
            <div className="flex w-80 flex-none flex-col gap-3 overflow-auto border-l border-border p-3">
              {/* Destination — one segmented control; both destinations
                  consume the same walk, differing in body + commit. */}
              <section
                className="rounded-xl border border-border bg-card p-3"
                data-testid="print-preview-destination-card"
              >
                <div className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
                  <Printer className="h-3.5 w-3.5" />
                  Destination
                </div>
                <div
                  className="grid grid-cols-2 gap-1 rounded-lg border border-border bg-muted p-1"
                  data-testid="print-preview-destination"
                  role="radiogroup"
                  aria-label="Destination"
                >
                  {(
                    [
                      ["printer", Printer, "Printer"],
                      ["pdf", FileText, "PDF"],
                    ] as const
                  ).map(([dest, Icon, label]) => (
                    <button
                      key={dest}
                      type="button"
                      role="radio"
                      aria-checked={destination === dest}
                      data-testid={`print-preview-dest-${dest}`}
                      className={`flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                        destination === dest
                          ? "bg-background text-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                      onClick={() => setPrintLastDestination(dest)}
                    >
                      <Icon className="h-4 w-4" />
                      {label}
                    </button>
                  ))}
                </div>
              </section>

              {/* The destination body. */}
              {destination === "pdf" ? (
                <section
                  className="rounded-xl border border-border bg-card p-3"
                  data-testid="print-preview-pdf-body"
                >
                  <div className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
                    <FileText className="h-3.5 w-3.5" />
                    PDF file
                  </div>
                  <div className="flex flex-col gap-2">
                    {/* The inline filename — the commit's target. */}
                    <div className="flex items-center gap-1">
                      <Input
                        aria-label="File name"
                        data-testid="print-preview-filename"
                        className="h-8 font-mono text-xs"
                        placeholder="Filename"
                        value={fileNameRaw}
                        onChange={(e) => setFileNameRaw(e.target.value)}
                      />
                      <span className="flex-none font-mono text-xs text-muted-foreground">
                        .pdf
                      </span>
                    </div>
                    {/* Metadata write-through into coreProperties. */}
                    <div className="flex items-center gap-1.5 text-xs">
                      <Type className="h-3.5 w-3.5 flex-none text-muted-foreground" />
                      <Input
                        aria-label="Title"
                        data-testid="print-preview-title"
                        className="h-7 text-xs"
                        placeholder="Title"
                        value={coreProperties.title ?? ""}
                        onChange={(e) => writeMeta("title", e.target.value)}
                      />
                    </div>
                    <div className="flex items-center gap-1.5 text-xs">
                      <UserRoundPen className="h-3.5 w-3.5 flex-none text-muted-foreground" />
                      <Input
                        aria-label="Author"
                        data-testid="print-preview-author"
                        className="h-7 text-xs"
                        placeholder="Author"
                        value={coreProperties.author ?? ""}
                        onChange={(e) => writeMeta("author", e.target.value)}
                      />
                    </div>
                    {/* The full properties dialog — edits land in the same
                        coreProperties. */}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-full justify-start gap-1.5 px-2 text-xs text-muted-foreground"
                      data-testid="print-preview-all-properties"
                      onClick={() =>
                        useDocumentPropertiesStore.getState().open()
                      }
                    >
                      <ListPlus className="h-3.5 w-3.5" />
                      All document properties…
                    </Button>
                  </div>
                </section>
              ) : (
                <section
                  className="flex flex-col gap-3 rounded-xl border border-border bg-card p-3"
                  data-testid="print-preview-printer-body"
                >
                  <div className="mb-0 flex items-center gap-2 text-xs font-medium text-muted-foreground">
                    <Printer className="h-3.5 w-3.5" />
                    Printer
                  </div>
                  <Select
                    value={printerSel || undefined}
                    onValueChange={(v) => {
                      if (v != null) setPrinterSel(v);
                    }}
                  >
                    <SelectTrigger
                      className="h-8 w-full text-xs"
                      data-testid="print-preview-printer-select"
                      aria-label="Printer"
                    >
                      {/* Own label — base-ui's Value never re-resolves a
                          value arriving after mount; the async enumerate
                          lands late. */}
                      <span className="flex flex-1 truncate text-left">
                        {(() => {
                          const p = printers.find((x) => x.name === printerSel);
                          if (!p) return printers.length ? 'Select a printer' : 'No printers found';
                          return `${p.name}${p.isDefault ? ' (default)' : ''}${p.state && p.state !== 'ready' ? ` — ${p.state}` : ''}`;
                        })()}
                      </span>
                    </SelectTrigger>
                    <SelectContent>
                      {printers.map((p) => (
                        <SelectItem key={p.systemName} value={p.name}>
                          {p.name}
                          {p.isDefault ? " (default)" : ""}
                          {p.state && p.state !== "ready"
                            ? ` — ${p.state}`
                            : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {(() => {
                    const p = printers.find((x) => x.name === printerSel);
                    if (!p) return null;
                    const meta = [p.description, p.location]
                      .filter(Boolean)
                      .join(" · ");
                    return (
                      <p
                        className="text-[11px] leading-relaxed text-muted-foreground"
                        data-testid="print-preview-printer-meta"
                      >
                        {meta || "No description"}
                      </p>
                    );
                  })()}
                  {/* COPIES — a ticker. */}
                  <div className="flex items-center gap-2 text-xs">
                    <Copy className="h-3.5 w-3.5 flex-none text-muted-foreground" />
                    <span className="text-muted-foreground">Copies</span>
                    <div className="relative ml-auto w-20">
                      <Input
                        type="number"
                        min={1}
                        max={99}
                        aria-label="Copies"
                        data-testid="print-preview-copies"
                        className="h-7 w-full pl-7 pr-5 text-xs tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                        value={copies}
                        onChange={(e) => {
                          const n = Math.max(
                            1,
                            Math.min(
                              99,
                              Math.floor(Number(e.target.value) || 1),
                            ),
                          );
                          setCopies(n);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "ArrowUp") {
                            e.preventDefault();
                            setCopies((c) => Math.min(99, c + 1));
                          } else if (e.key === "ArrowDown") {
                            e.preventDefault();
                            setCopies((c) => Math.max(1, c - 1));
                          }
                        }}
                      />
                      <div className="absolute right-0 top-0 z-10 flex h-full w-5 flex-col">
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          className="h-1/2 w-full flex-none items-end justify-center rounded-none p-0"
                          aria-label="More copies"
                          tabIndex={-1}
                          onClick={() => setCopies((c) => Math.min(99, c + 1))}
                        >
                          <ChevronUp size={10} className="translate-y-px" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          className="h-1/2 w-full flex-none items-start justify-center rounded-none p-0"
                          aria-label="Fewer copies"
                          tabIndex={-1}
                          onClick={() => setCopies((c) => Math.max(1, c - 1))}
                        >
                          <ChevronDown size={10} className="-translate-y-px" />
                        </Button>
                      </div>
                    </div>
                  </div>
                  {/* DUPLEX — seeded from the last-used setting. */}
                  <div className="flex items-center gap-2 text-xs">
                    <Layers className="h-3.5 w-3.5 flex-none text-muted-foreground" />
                    <span className="text-muted-foreground">Duplex</span>
                    <Select
                      value={duplex}
                      onValueChange={(v) => {
                        if (v != null) setDuplex(v as typeof duplex);
                      }}
                    >
                      <SelectTrigger
                        className="ml-auto h-7 w-44 text-xs"
                        data-testid="print-preview-duplex-select"
                        aria-label="Duplex"
                      >
                        {/* Own label — same base-ui late-value quirk as the
                            printer trigger. */}
                        <span className="flex flex-1 truncate text-left">
                          {DUPLEX_OPTIONS.find((o) => o.value === duplex)?.label ?? ''}
                        </span>
                      </SelectTrigger>
                      <SelectContent>
                        {DUPLEX_OPTIONS.map((o) => (
                          <SelectItem key={o.value} value={o.value}>
                            <o.icon className="h-3.5 w-3.5" />
                            {o.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    Prints via CUPS — page size and {pageSetup.orientation}{" "}
                    orientation carry over natively.
                  </p>
                </section>
              )}

              {/* The paper card — the document's own geometry, never a
                  preview-local override. */}
              <section className="rounded-xl border border-border bg-card p-3">
                <div className="flex flex-col gap-1.5 text-xs">
                  <div className="flex items-center gap-2">
                    <Files className="h-3.5 w-3.5 flex-none text-muted-foreground" />
                    <span className="text-muted-foreground">Pages</span>
                    <span
                      className="ml-auto font-medium tabular-nums"
                      data-testid="print-preview-total"
                    >
                      {build.total}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <RectangleVertical className="h-3.5 w-3.5 flex-none text-muted-foreground" />
                    <span className="text-muted-foreground">Size</span>
                    <span className="ml-auto font-medium">
                      {paperLabel}
                      {paperSizeLabel ? (
                        <span className="text-muted-foreground">
                          {" "}
                          · {paperSizeLabel}
                        </span>
                      ) : null}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Ruler className="h-3.5 w-3.5 flex-none text-muted-foreground" />
                    <span className="text-muted-foreground">Margins</span>
                    <span className="ml-auto font-medium tabular-nums">
                      {marginsLabel}
                    </span>
                  </div>
                  {visiblePages && (
                    <div className="flex items-center gap-2">
                      <Files className="h-3.5 w-3.5 flex-none text-muted-foreground" />
                      <span className="text-muted-foreground">Previewing</span>
                      <span
                        className="ml-auto font-medium tabular-nums"
                        data-testid="print-preview-range"
                      >
                        {visiblePages.size} of {build.total}
                      </span>
                    </div>
                  )}
                </div>
              </section>

              {/* The pages card — the range filter previews and commits. */}
              <section className="rounded-xl border border-border bg-card p-3">
                <div className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
                  <Hash className="h-3.5 w-3.5" />
                  Pages
                </div>
                <Input
                  ref={rangeInputRef}
                  aria-label="Page range"
                  data-testid="print-preview-range-input"
                  className="h-8 text-xs"
                  placeholder={`All (e.g. 1-${build.total})`}
                  value={rangeRaw}
                  onChange={(e) => setRangeRaw(e.target.value)}
                />
                <p className="mt-1.5 text-[11px] text-muted-foreground">
                  e.g. &ldquo;1-3, {build.total}&rdquo; — the range previews and
                  commits.
                </p>
              </section>

              {/* The commit — one button, labeled with the resolved outcome;
                  Enter commits; the trigger held force-prompts. */}
              <div className="mt-auto flex flex-col gap-2 pt-2">
                {destination === "pdf" ? (
                  <Button
                    data-testid="print-preview-commit"
                    className="w-full"
                    disabled={build.pages.length === 0}
                    onClick={(e: MouseEvent<HTMLButtonElement>) =>
                      commit(triggerHeld(e))
                    }
                    onPointerEnter={(e) => {
                      setCommitHover(true);
                      syncModifiers(e);
                    }}
                    onPointerMove={syncModifiers}
                    onPointerLeave={() => setCommitHover(false)}
                  >
                    <FileText className="h-4 w-4 flex-none" />
                    <span className="block max-w-full truncate">
                      Save as PDF{triggerEllipsis}
                    </span>
                  </Button>
                ) : (
                  <Button
                    data-testid="print-preview-commit"
                    className="w-full"
                    disabled={build.pages.length === 0 || isPrinting}
                    onClick={(e: MouseEvent<HTMLButtonElement>) =>
                      commit(triggerHeld(e))
                    }
                    onPointerEnter={(e) => {
                      setCommitHover(true);
                      syncModifiers(e);
                    }}
                    onPointerMove={syncModifiers}
                    onPointerLeave={() => setCommitHover(false)}
                  >
                    <Printer className="h-4 w-4 flex-none" />
                    {isPrinting ? "Sending…" : `Print${triggerEllipsis}`}
                  </Button>
                )}
                {/* Hints mapped to the configured trigger, per destination. */}
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                  {destination === "pdf" ? (
                    <span className="inline-flex items-center gap-1">
                      <KbdGroup>
                        <Kbd>{triggerLabel}</Kbd>
                        <Kbd>Click</Kbd>
                      </KbdGroup>
                      to modify destination
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1">
                      <KbdGroup>
                        <Kbd>{triggerLabel}</Kbd>
                        <Kbd>Click</Kbd>
                      </KbdGroup>
                      for the system dialog
                    </span>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
