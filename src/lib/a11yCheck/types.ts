import type { StyleDefinition } from '@/lib/styles/types';

/**
 * The document-content accessibility checker (alt text, heading
 * structure, contrast) — never the app itself (app-level a11y is
 * lib/accessibility/). Pure: doc + context in, issues out; nothing
 * runs until a surface asks.
 */

export type A11yIssueKind = 'altText' | 'headingHierarchy' | 'contrast';

/** Word's vocabulary: alt failures block a reader (error); structure and contrast degrade (warning). */
export type A11ySeverity = 'error' | 'warning';

export interface A11yIssue {
  kind: A11yIssueKind;
  severity: A11ySeverity;
  /** Human message — the panel renders it verbatim. */
  message: string;
  /** PM offsets, valid until the next edit — recomputed per scan, never persisted. */
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
  /** Runs skipped over unparseable or semi-transparent colors — counted, never guessed. */
  skippedRuns: number;
}
