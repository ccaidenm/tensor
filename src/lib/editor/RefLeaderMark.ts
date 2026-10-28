import { Mark } from '@tiptap/core';

/**
 * M-REFS — THE LEADER DOTS MARK: presence-only, invisible ink that
 * TAGS the generator-written dots span ('.' × 12) at the end of each
 * entry row (leaders on). The tag is how every consumer identifies
 * the leader without guessing from text (a heading may legitimately
 * end in dots): the generator excludes it from entry-text compares,
 * the adapter splits it out as the LEADER RUN (carrying the user's
 * other marks — size/bold/color — for the engine's stretch), and the
 * scan ignores it. The USER can format the span (select the dots,
 * restyle them); the marks ride into the engine and the painted dots
 * respond ("size down the leader ⇒ more dots" — the user's ruling).
 *
 * CLIPBOARD (the indexEntry law): parseHTML matches ONLY Tensor's own
 * marker; nothing foreign parses in, internal copies round-trip.
 */
export const RefLeaderMark = Mark.create({
  name: 'refLeader',
  keepOnSplit: false,

  parseHTML() {
    return [{ tag: 'span[data-tensor-leader]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', { ...HTMLAttributes, 'data-tensor-leader': 'true' }, 0];
  },
});
