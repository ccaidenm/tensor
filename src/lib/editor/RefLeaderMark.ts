import { Mark } from '@tiptap/core';

/**
 * THE LEADER DOTS MARK: presence-only tag on the generator-written dots
 * span — how consumers identify the leader without guessing from text.
 * The adapter splits it out as the LEADER RUN; the user can format it.
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
