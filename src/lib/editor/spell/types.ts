/**
 * Spell check — shared types: the LanguageTool wire contract, the
 * checked-span model, and the provider/status surfaces.
 *
 * THE TWO PROVIDERS, ONE PROTOCOL: the local sidecar
 * (org.languagetool.server.HTTPServer, loopback only) and the online
 * API (api.languagetool.org) both speak the same /v2/check form-POST
 * protocol and return the same match shape — one Rust client, one TS
 * parser, two base URLs. The provider is a *routing* concern, never a
 * data-shape concern.
 *
 * PRIVACY POSTURE (the consent law, matching the fonts/privacy
 * precedents): spell check is OFF by default. Nothing downloads and
 * nothing phones home until the user (a) enables it and (b) picks a
 * provider with an informed choice — Online sends text to
 * LanguageTool's servers; Local downloads ≈250MB once and never
 * touches the network again (one-time install download excepted).
 */

/** One replacement candidate for a flagged span (LT's shape, verbatim). */
export interface LTReplacement {
  value: string;
}

/**
 * One LanguageTool match — the verbatim wire subset the app consumes.
 * `offset`/`length` are character offsets into the text WE sent (the
 * joined block texts, '\n\n'-separated), never PM positions: the
 * controller translates through its per-block position index.
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
 * A checked-and-flagged span, already translated into PM positions.
 * `kind` is reserved for M2's grammar work — spelling is the only
 * producer today, and the visual grammar treatment will reuse this
 * shape with a different kind + color instead of a parallel system.
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
  kind: 'spelling';
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

/** Is this LT match a *spelling* error? Grammar/style stay out of scope
 *  (M2): LT's en spell misses ride category TYPOS (its/it's confusions
 *  included — Word treats those as spelling too) or issueType
 *  'misspelling'. The unfiltered stream still crosses the IPC boundary
 *  so grammar needs no new wire later. */
export function isSpellingMatch(m: LTMatch): boolean {
  return m.rule?.category?.id === 'TYPOS' || m.rule?.issueType === 'misspelling';
}
