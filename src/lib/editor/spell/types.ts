/**
 * Shared types: the LT wire contract, the checked-span model, the
 * provider/status surfaces. One /v2/check protocol — the provider routes,
 * never reshapes. Spell check is OFF by default (Online sends text out).
 */

/** One replacement candidate for a flagged span (LT's shape, verbatim). */
export interface LTReplacement {
  value: string;
}

/**
 * One LanguageTool match — the verbatim wire subset consumed here.
 * `offset`/`length` index the text WE sent (joined block texts), never
 * PM positions; the controller translates via its position index.
 */
export interface LTMatch {
  message: string;
  shortMessage?: string;
  offset: number;
  length: number;
  replacements?: LTReplacement[];
  rule: {
    id: string;
    description: string;
    issueType?: string;
    category: { id: string; name: string };
  };
}

/** Where checking happens. 'online' = LT cloud (text leaves the
 *  device — consented); 'local' = the sidecar (loopback only). */
export type SpellProvider = 'online' | 'local';

/**
 * A checked-and-flagged span, already in PM positions. `kind` selects
 * the feature — one span model, one pipeline, two features.
 */
export interface SpellError {
  from: number;
  to: number;
  /** The flagged text, exactly as it sits in the doc — the drop-on-edit
   * guard compares against this. */
  word: string;
  /** Ordered replacement candidates (LT's order, capped by the caller). */
  suggestions: string[];
  message: string;
  ruleId: string;
  kind: 'spelling' | 'grammar';
  /** LT's category id (bubble labels + the ignore-rule key). */
  category: string;
}

/** Sidecar/server lifecycle state surfaced to the UI (local provider
 *  only; online is stateless from the app's perspective). */
export type SpellServerStatus = 'stopped' | 'starting' | 'ready' | 'unavailable';

/** Progress payloads for the local-runtime installer (Rust-emitted
 *  events; the setup dialog renders them). */
export interface SpellInstallProgress {
  stage: 'download-languagetool' | 'download-jre' | 'extract' | 'verify' | 'done';
  /** Bytes received so far in the current stage. */
  received: number;
  /** Total bytes for the current stage (0 = unknown). */
  total: number;
}

