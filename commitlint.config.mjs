export default {
  extends: ['@commitlint/config-conventional'],

  // commits GitHub generates itself — exempt from our rules
  ignores: [
    (m) => /^Merge (branch|pull request|remote-tracking)/.test(m),
    (m) => /^Revert "/.test(m), // GitHub's auto-revert; hand-written `revert:` commits still pass
  ],

  plugins: [
    {
      rules: {
        // Our convention: the `!` marker is only valid WITH the footer
        'breaking-footer-required': (parsed) => {
          if (!/^(?:\w+)(?:\([^)]*\))?!:/.test(parsed.header ?? '')) return [true, ''];
          const ok = /^BREAKING CHANGE:/m.test(parsed.raw ?? '');
          return [ok, 'commits marked with "!" must include a "BREAKING CHANGE:" footer'];
        },
      },
    },
  ],

  rules: {
    // The taxonomy — types
    'type-enum': [2, 'always', ['feat', 'fix', 'perf', 'refactor', 'docs', 'test', 'chore', 'revert']],
    // The taxonomy — scopes (scopeless commits pass: this rule only fires when a scope exists)
    'scope-enum': [2, 'always', ['editor', 'engine', 'ui', 'format', 'i18n', 'a11y', 'deps', 'ci']],
    // Sentence case allowed; ALL-CAPS, Start Case, and PascalCase banned.
    // This override is REQUIRED: config-conventional's default bans sentence-case too.
    'subject-case': [2, 'never', ['start-case', 'pascal-case', 'upper-case']],
    // "under 72 characters" — enforced for real
    'subject-max-length': [2, 'always', 72],
    'header-max-length': [2, 'always', 100],
  },
};
