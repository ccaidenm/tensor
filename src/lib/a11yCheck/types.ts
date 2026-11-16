import type { StyleDefinition } from '@/lib/styles/types';

/**
 * M-A11Y — the document-content accessibility checker. THE SPLIT (the
 * issue's own framing, kept sharp in code): this module checks the
 * DOCUMENT'S CONTENT (alt text, heading structure, color contrast) —
 * never the editor application itself (app-level a11y lives in
 * settings/panels/AccessibilityPanel.tsx + lib/accessibility/, a
 * different namespace on purpose).
 *
 * Pure: reads the PM doc + a small context, allocates issues. No
 * editor, no store, no DOM (the references-scan contract — L1's shape
 * at the scan layer). The panel derives everything reactively; nothing
 * runs anywhere until a surface asks.
 */

export type A11yIssueKind = 'altText' | 'headingHierarchy' | 'contrast';

/**
 * Word's checker vocabulary: alt text failures block a screen reader
 * outright (error); structure and contrast degrade but don't block
 * (warning).
 */
export type A11ySeverity = 'error' | 'warning';

export interface A11yIssue {
  kind: A11yIssueKind;
  severity: A11ySeverity;
  /** Human message — the panel renders it verbatim. */
  message: string;
  /**
   * The flagged node's start / the flagged span's `from`. Edit
   * survival: plain PM offsets, valid until the next edit — issues
   * are recomputed per scan, never persisted.
   */
  pos: number;
  /** The span's `to` — contrast issues only; node issues leave it unset. */
  to?: number;
  /** Context snippet (span text, heading text) for the panel row. */
  detail?: string;
  /** The image node's src — altText issues only (the fix dialog reads it). */
  src?: string;
}

/** Everything the scan needs beyond the doc itself. */
export interface A11yScanContext {
  /** The merged style registry (resolveRun's definitions). */
  definitions: Record<string, StyleDefinition>;
  /** The config-derived defaults (resolveNormalBase's inputs). */
  baseFontFamily: string;
  baseFontSize: number;
  /** The document's store pageSetup — the FINAL section's pageColor
   * (per-section colors ride the sectionBreak attrs, read from the doc). */
  pageColor?: string;
}

export interface A11yScanResult {
  /** Document order within each kind; kinds in the fixed order
   * altText, headingHierarchy, contrast (the panel groups by kind). */
  issues: A11yIssue[];
  /**
   * Text runs skipped because a color in the foreground/background
   * chain was unparseable or semi-transparent — counted, never
   * guessed (a checker that can't see the color says so, it doesn't
   * pass or fail by assumption). Surfaced in the panel footer.
   */
  skippedRuns: number;
}
