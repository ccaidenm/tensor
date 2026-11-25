import type { LineBox, TextMetrics } from '@tensor-editor/engine';
import type { AdapterBlock } from './adapter';

/**
 * THE LEADER ADOPTION (the "entire leading is selectable"
 * ruling): the gap between a row's seed dots and its page number is
 * filled with PAINT ink (the seam fix) — but ink can't be selected.
 * THE FIX: the generator ADOPTS the resolved dot count into the
 * model — the row's refLeader span is rewritten to exactly the
 * visible count, so the ENTIRE leader is real text (selectable,
 * formattable end-to-end) and the paint fill becomes zero.
 *
 * THE FIXPOINT (no loops, by construction): the count is measured
 * from the LAST layout (the seed's painted end → the number's start,
 * at the span's own measured style). After adoption the span
 * occupies exactly that gap → the next measurement's fill = 0 → the
 * counts recompute EQUAL → no further writes. Convergence per the
 * page-number two-pass precedent; each adoption is a non-undoable
 * generator write (addToHistory:false — the established law).
 *
 * LAG: the count is one layout behind (the same two-pass ruling) —
 * a formatting change responds IMMEDIATELY through the paint fill
 * (the ink recomputes at the span's new style) and the model adopts
 * on the next pass. Stale-ink risk is nil: the fill covers the lag
 * seamlessly (no pads).
 *
 * The store is keyed by the container's stable blockId; values are
 * per-entry counts (undefined = no number this layout — never adopt;
 * the seed stands alone).
 */

export type LeaderCountsMap = ReadonlyMap<string, readonly (number | undefined)[]>;

const countsByBlock = new Map<string, readonly (number | undefined)[]>();

/**
 * Recompute the per-entry dot counts off a FRESH layout: for each
 * reference line, the gap between the seed span's painted end and
 * the number's start (line-frame — the segments' x are relative to
 * the line's rect.x, and the row is left-aligned so alignOffset is
 * 0), divided by the span's own dot advance.
 */
export function computeLeaderCounts(
  blocks: readonly AdapterBlock[],
  lines: readonly LineBox[],
  metrics: TextMetrics
): void {
  countsByBlock.clear();
  for (const block of blocks) {
    const sidecar = block.reference;
    if (!sidecar) continue;
    const counts: (number | undefined)[] = sidecar.entries.map(() => undefined);
    let measured = false;
    for (const line of lines) {
      if (line.blockId !== block.id) continue;
      const eIdx = sidecar.entries.findIndex(
        (e) => line.rangeStart >= e.textStart && line.rangeStart < e.textStart + e.textLen
      );
      if (eIdx < 0 || counts[eIdx] !== undefined) continue; // the leader lives on ONE line
      const segText = (s: { start: number; end: number }) => block.text.slice(s.start, s.end);
      const tabIdx = line.segments.findIndex((s) => segText(s) === '\t');
      if (tabIdx <= 0) continue;
      const numberSeg = line.segments
        .slice(tabIdx + 1)
        .find((s) => segText(s) !== '' && segText(s) !== '\t');
      if (!numberSeg) continue; // unresolved number — never adopt
      const leaderSeg = line.segments[tabIdx - 1]!;
      const leaderRun = block.runs[leaderSeg.runIndex];
      if (!leaderRun || leaderRun.kind === 'inlineImage') continue;
      const style = leaderRun.style;
      const seedW = metrics.measure(segText(leaderSeg), style);
      const dotW = metrics.measure('.', style);
      if (dotW <= 0) continue;
      const seedEnd = leaderSeg.x + seedW;
      const gap = numberSeg.x - seedEnd;
      // THE TOTAL, not the remainder (the fixpoint law): the adopted
      // count = the row's CURRENT span + the remaining gap in dots —
      // after adoption the span occupies the gap, the next pass
      // measures fill = 0, and the count recompute EQUALS the span
      // (stable). A remainder-only count would oscillate 44 ↔ 0
      // forever (caught by the drag test).
      const total = sidecar.entries[eIdx]!.leaderLen + Math.floor(gap / dotW);
      counts[eIdx] = Math.max(0, Math.min(total, 500));
      measured = true;
    }
    if (measured) countsByBlock.set(block.id, counts);
  }
}

/** The adopted count for one entry of one container — undefined when
 *  no measurement exists (pageless, pre-layout, no number): the
 *  caller keeps the current span (never adopts blind). */
export function adoptedLeaderCount(
  blockId: string,
  entryIndex: number
): number | undefined {
  return countsByBlock.get(blockId)?.[entryIndex];
}
