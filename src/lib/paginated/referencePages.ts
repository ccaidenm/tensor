import type { AdapterBlock } from './adapter';
import type { LineBox } from '@tensor-editor/engine';
import { pmPosToBlockOffset } from './positionMap';

/**
 * M-REFS — THE PAGE RESOLVER (the two-pass fixpoint, shell-side): a
 * reference entry's page number is a fact about a LATER block's
 * placement, and the engine's walk is strictly forward — so the SHELL
 * resolves numbers between layout passes (the ruled design):
 *
 *   pass 1: layout with the WARM numbers (the previous relayout's map)
 *   resolve: each entry's target PM pos → its block → the block's
 *            FIRST LineBox's page (+1, 1-based) — multi-location index
 *            entries join unique pages "3, 7"
 *   pass 2: re-layout iff any number CHANGED (identity-stable: the
 *           same Map object returns when nothing moved, so pass 2 and
 *           every conversion cache stay warm in steady state)
 *
 * Numbers are LAYOUT facts: they live in the engine entries' synthetic
 * runs (never in the PM document, never saved, never stale on load).
 * Oscillation is bounded by construction (two passes max): a number
 * edit re-breaks exactly the ToC block; the next relayout re-resolves.
 */

/** The per-container numbers map: referenceTable blockId → one string
 *  per ENTRY (aligned with the container's children order). */
export type ReferencePagesMap = ReadonlyMap<string, readonly string[]>;

/** First-line page (0-based) per blockId — the placement fact. */
function firstLinePageOf(lines: readonly LineBox[]): Map<string, number> {
  const byBlock = new Map<string, number>();
  for (const line of lines) {
    if (!byBlock.has(line.blockId)) byBlock.set(line.blockId, line.pageIndex);
  }
  return byBlock;
}

/**
 * Resolve every reference entry's page string off a FRESH layout.
 * Returns:
 *  - `null` when the doc has no reference blocks (no containers → no
 *    numbers → the caller never stores a map);
 *  - the SAME map object it was handed when every number matches
 *    (identity-stable: pass 2 is skipped, conversion caches stay warm);
 *  - a NEW map when any number moved (the caller re-lays-out with it).
 */
export function resolveReferencePages(
  blocks: readonly AdapterBlock[],
  lines: readonly LineBox[],
  current: ReferencePagesMap | null
): ReferencePagesMap | null {
  const refBlocks = blocks.filter((b) => b.reference);
  if (refBlocks.length === 0) return null;

  const firstPage = firstLinePageOf(lines);
  let changed = false;
  const next = new Map<string, readonly string[]>();

  for (const block of refBlocks) {
    const sidecar = block.reference!;
    const resolved: string[] = [];
    for (const entry of sidecar.entries) {
      if (entry.targets.length === 0) {
        resolved.push(''); // the placeholder row: no number
        continue;
      }
      const pages: number[] = [];
      for (const pos of entry.targets) {
        const bo = pmPosToBlockOffset(blocks, pos);
        if (!bo) continue; // target block not placed (band edge) — blank
        const page = firstPage.get(bo.block.id);
        if (page === undefined) continue;
        if (!pages.includes(page)) pages.push(page);
      }
      pages.sort((a, b) => a - b); // doc order, unique
      resolved.push(pages.map((p) => String(p + 1)).join(', '));
    }
    const prev = current?.get(block.id);
    const same =
      prev !== undefined &&
      prev.length === resolved.length &&
      prev.every((p, i) => p === resolved[i]);
    if (!same) changed = true;
    next.set(block.id, same && prev ? prev : resolved);
  }

  if (current && !changed) return current; // identity-stable: pass 2 skipped
  return next;
}
