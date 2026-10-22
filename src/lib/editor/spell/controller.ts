import type { Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { invoke } from '@tauri-apps/api/core';
import { useConfigStore } from '@/lib/config/store';
import { spellCheckActive } from '@/lib/config/schema';
import { dictionarySet, useSpellStore } from './store';
import { classifyMatch, disabledCategoriesFor } from './categories';
import type { LTMatch, SpellError } from './types';
import type { SpellBlockRange } from './SpellExtension';

/**
 * The CHECKING PIPELINE — everything between "the doc changed" and
 * "the plugin state holds fresh flags".
 *
 * DEBOUNCE (the live-update law): checks run after typing goes idle
 * — 600ms local (a fast, private loopback) / 2000ms online (the
 * public API is rate-limited; be a polite citizen). While a check is
 * in flight, a newer schedule coalesces into one rerun (latest-wins).
 *
 * BLOCK-DIFFED RECHECKS: PM's persistent doc tree + BlockIdExtension's
 * node identity mean an unchanged top-level node is the SAME OBJECT
 * across edits — the adapter's own WeakMap trick. Checked blocks never
 * re-send text; only edited/new blocks ride the wire. (A deleted
 * block's flags die in the plugin's mapping/guard, not here.)
 *
 * STALENESS GUARDS: the doc captured before the async call must still
 * be current when results land, or the whole batch is dropped (the
 * edit that invalidated it already rescheduled a fresh one). Same for
 * destroyed editors and mid-flight disable.
 */

/** Idle window before a check fires (local sidecar). */
const DEBOUNCE_LOCAL_MS = 600;
/** Idle window before a check fires (online API — gentler + the
 *  rate-limit posture; a fast typist stays under 20 req/min). */
const DEBOUNCE_ONLINE_MS = 2000;
/** One request's text budget (the public API caps request size;
 *  10k chars is safe for both providers). Batches are whole blocks. */
const CHUNK_CHARS = 10_000;
/** Cap suggestions retained per error (menu height sanity; LT can
 *  return dozens). */
const MAX_SUGGESTIONS = 5;
/** Retry a failed check once after this delay (server boot races,
 *  transient network) — not a loop; config changes still re-check. */
const RETRY_MS = 15_000;

/** One checkable top-level block: its flattened text plus the PM
 *  position of every character in it (the search index's rules:
 *  textblock boundaries become '\n' so matches never span cells). */
interface Piece {
  node: PMNode;
  text: string;
  /** posMap[i] = the PM position of text[i]; posMap.length === text.length. */
  posMap: number[];
  from: number;
  to: number;
}

function buildPiece(node: PMNode, offset: number): Piece | null {
  let text = '';
  const posMap: number[] = [];
  // NOTE: node.descendants positions are CONTENT-relative (the first
  // child of a node at doc offset X is at pos 0 = absolute X + 1) —
  // the doc-level walk in search's buildDocIndex needs no shift, a
  // per-node walk does. Pinned by spell-controller tests.
  node.descendants((child, pos) => {
    if (child.isText) {
      const t = child.text ?? '';
      for (let i = 0; i < t.length; i++) posMap.push(offset + 1 + pos + i);
      text += t;
      return false;
    }
    if (child.isTextblock && text.length > 0) {
      text += '\n';
      posMap.push(offset + 1 + pos);
    }
    return true;
  });
  if (!text) return null;
  return { node, text, posMap, from: offset, to: offset + node.nodeSize };
}

export class SpellController {
  private readonly editor: Editor;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private rerun = false;
  /** The identity cache: top-level PM nodes already checked (the
   *  adapter's WeakMap trick — structural sharing keeps unchanged
   *  blocks reference-stable across edits). */
  private checked = new WeakMap<PMNode, true>();
  private detachFns: Array<() => void> = [];

  constructor(editor: Editor) {
    this.editor = editor;
  }

  attach(): void {
    const onUpdate = () => this.schedule();
    this.editor.on('update', onUpdate);
    this.detachFns.push(() => this.editor.off('update', onUpdate));

    const unsubConfig = useConfigStore.subscribe((state, prev) => {
      const now = state.config.spellCheck;
      const was = prev.config.spellCheck;
      // ANY change to the active feature set (a flag flip, provider, or
      // language) is a fresh classification problem: recheck
      // everything, one request, correct results.
      const featureChanged =
        now.spelling !== was.spelling ||
        now.grammar !== was.grammar ||
        now.language !== was.language ||
        now.provider !== was.provider;
      if (!spellCheckActive(now)) {
        if (spellCheckActive(was)) this.clearAll();
        return;
      }
      if (!spellCheckActive(was) || featureChanged) this.recheckAll();
    });
    this.detachFns.push(unsubConfig);

    // Boot with checking active (persisted config): full check.
    if (spellCheckActive(useConfigStore.getState().config.spellCheck)) this.recheckAll();
  }

  detach(): void {
    for (const fn of this.detachFns) fn();
    this.detachFns = [];
    if (this.timer) clearTimeout(this.timer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.timer = null;
    this.retryTimer = null;
  }

  /** Reset the identity cache and check everything now (enable,
   *  language/provider change, boot). */
  recheckAll(): void {
    this.checked = new WeakMap();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    void this.run();
  }

  clearAll(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.editor.isDestroyed) return;
    this.editor.commands.clearSpellErrors();
    useSpellStore.getState().setLastError(null);
  }

  /** Debounced entry point (every doc update). */
  schedule(): void {
    const cfg = useConfigStore.getState().config.spellCheck;
    if (!spellCheckActive(cfg)) return;
    if (this.timer) clearTimeout(this.timer);
    const delay = cfg.provider === 'online' ? DEBOUNCE_ONLINE_MS : DEBOUNCE_LOCAL_MS;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, delay);
  }

  private async run(): Promise<void> {
    if (this.running) {
      this.rerun = true;
      return;
    }
    this.running = true;
    try {
      const cfg = useConfigStore.getState().config.spellCheck;
      if (!spellCheckActive(cfg) || this.editor.isDestroyed) return;

      // The identity cache marks textless blocks too (no re-scan churn
      // on image/rule blocks); textful ones get a Piece.
      const pieces: Piece[] = [];
      const blocks: SpellBlockRange[] = [];
      const doc = this.editor.state.doc;
      doc.forEach((node, offset) => {
        if (this.checked.has(node)) return;
        const piece = buildPiece(node, offset);
        if (piece) {
          pieces.push(piece);
          blocks.push({
            blockId: (node.attrs?.blockId as string | undefined) ?? `pos-${offset}`,
            from: offset,
            to: offset + node.nodeSize,
          });
        } else {
          this.checked.set(node, true);
        }
      });
      if (pieces.length === 0) return;

      // Batch whole blocks under CHUNK_CHARS; '\n\n' joins the pieces
      // of one request (spelling matches never cross it).
      const batchOpts = {
        language: cfg.language,
        provider: cfg.provider,
        spellingOn: cfg.spelling,
        grammarOn: cfg.grammar,
        // Style categories are excluded SERVER-SIDE every request;
        // a disabled feature excludes its categories too (leaner work
        // for the engine — and a grammar-only request never runs spell).
        disabledCategories: disabledCategoriesFor(cfg.spelling, cfg.grammar),
      };
      let batch: Piece[] = [];
      let batchLen = 0;
      let batchStart = 0;
      for (const piece of pieces) {
        const addition = piece.text.length + (batch.length > 0 ? 2 : 0);
        if (batch.length > 0 && batchLen + addition > CHUNK_CHARS) {
          await this.checkBatch(batch, blocks.slice(batchStart), batchOpts, doc);
          batchStart += batch.length;
          batch = [];
          batchLen = 0;
        }
        batch.push(piece);
        batchLen += addition;
      }
      if (batch.length > 0) {
        await this.checkBatch(batch, blocks.slice(batchStart), batchOpts, doc);
      }

      useSpellStore.getState().setLastError(null);
      if (this.rerun) {
        this.rerun = false;
        this.schedule();
      }
    } catch (err) {
      // One retry after a beat, then surface (never a loop, never a
      // silent swallow — the store feeds Settings/setup surfaces).
      const message = err instanceof Error ? err.message : String(err);
      useSpellStore.getState().setLastError(message);
      if (!this.editor.isDestroyed && spellCheckActive(useConfigStore.getState().config.spellCheck)) {
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          void this.run();
        }, RETRY_MS);
      }
    } finally {
      this.running = false;
    }
  }

  private async checkBatch(
    pieces: Piece[],
    blocks: SpellBlockRange[],
    opts: {
      language: string;
      provider: 'online' | 'local';
      spellingOn: boolean;
      grammarOn: boolean;
      disabledCategories?: string;
    },
    capturedDoc: PMNode,
  ): Promise<void> {
    // Build the request text + per-piece starts in it.
    let text = '';
    const starts: number[] = [];
    for (const p of pieces) {
      if (text) text += '\n\n';
      starts.push(text.length);
      text += p.text;
    }

    const matches = await invoke<LTMatch[]>('spell_check', {
      text,
      language: opts.language,
      provider: opts.provider,
      disabledCategories: opts.disabledCategories ?? null,
    });

    // Stale doc (the invalidating edit already scheduled a fresh run)
    // or shutdown mid-flight: drop the batch wholesale.
    if (this.editor.isDestroyed || this.editor.state.doc !== capturedDoc) return;

    const dict = dictionarySet();
    const spellStore = useSpellStore.getState();
    const sessionIgnored = spellStore.sessionIgnored;
    const sessionIgnoredRules = spellStore.sessionIgnoredRules;
    const errors: SpellError[] = [];
    for (const m of matches) {
      // THE SCOPE LINE: classify (spelling / grammar / dropped), then
      // the feature toggles have the final word — a disabled feature's
      // matches never render even if the engine sent them anyway.
      const kind = classifyMatch(m);
      if (kind === 'dropped') continue;
      if (kind === 'spelling' && !opts.spellingOn) continue;
      if (kind === 'grammar' && !opts.grammarOn) continue;
      if (m.offset < 0 || m.length <= 0 || m.offset + m.length > text.length) continue;
      const word = text.slice(m.offset, m.offset + m.length);
      const key = word.toLowerCase();
      // Dictionary + session ignores are WORD-shaped (spelling);
      // grammar false positives are RULE-shaped — ignore by ruleId.
      if (kind === 'spelling' && (dict.has(key) || sessionIgnored.has(key))) continue;
      const ruleId = m.rule?.id ?? '';
      if (ruleId && sessionIgnoredRules.has(ruleId)) continue;

      // Which piece does the match start in? (Word matches never cross
      // the '\n\n' separators; a straddler is dropped.)
      let idx = -1;
      for (let i = starts.length - 1; i >= 0; i--) {
        if (starts[i]! <= m.offset) {
          idx = i;
          break;
        }
      }
      if (idx < 0) continue;
      const piece = pieces[idx]!;
      const local = m.offset - starts[idx]!;
      if (local + m.length > piece.posMap.length) continue; // spans a separator — not a word

      const from = piece.posMap[local]!;
      // `to`: the next char's position when the match ends mid-text;
      // else lastCharPos + 1 (NEVER piece.to — the node-end position
      // would swallow the block separator in textBetween and the
      // drop-guard would kill the error at once).
      const to = piece.posMap[local + m.length] ?? piece.posMap[piece.posMap.length - 1]! + 1;
      errors.push({
        from,
        to,
        word,
        suggestions: (m.replacements ?? []).slice(0, MAX_SUGGESTIONS).map((r) => r.value),
        message: m.shortMessage || m.message,
        ruleId,
        kind,
        category: m.rule?.category?.id ?? '',
      });
    }
    errors.sort((a, b) => a.from - b.from);

    // Mark nodes checked only on successful dispatch — a failed batch
    // stays dirty for the retry.
    for (const p of pieces) this.checked.set(p.node, true);
    this.editor.commands.setSpellErrors(errors, blocks);
  }
}

/** Test seam: build one checkable Piece for a node (exposed for unit
 *  tests of the offset mapping). */
export function __buildPieceForTest(node: PMNode, offset: number): Piece | null {
  return buildPiece(node, offset);
}
