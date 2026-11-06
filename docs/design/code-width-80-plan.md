# Plan: 80-character code and comment width

Status: proposed. Repository-wide implementation has not started.

## Goal

Keep every line of maintained source code and comments within 80 Unicode
code points, without changing application behavior.

## 1. Define scope and counting rules

Initial scope:

- `src/**/*.ts`
- `electron/**/*.{ts,tsx}`
- `tests/**/*.{ts,mjs}`
- `scripts/**/*.{js,mjs,cjs}`

Rules:

- Include code, comments, imports, strings, and template literals.
- Count Unicode code points, consistent with `scripts/line-length.mjs`.
- Exclude line endings from the count.
- Keep four-space indentation. Do not use tabs to evade the limit.
- Exclude dependencies, build output, generated files, and fixtures whose
  exact formatting is part of their purpose. Document those exclusions.

Handle CSS, Go, shell, HTML, and prose documentation in later phases, with
appropriate formatters. Do not reformat the entire repository at once.

## 2. Audit existing violations

Extend the checker to:

- Inspect Git-tracked files in the agreed scope.
- Report each violation as `file:line:length`.
- Summarize violations by file and directory.
- Return a nonzero exit status for violations or file-reading failures.

Use the audit to choose manageable batches. Do not introduce a permanent
baseline that exempts existing overlong lines.

## 3. Establish wrapping patterns

- Imports: split imported names across lines.
- Parameters and arguments: use multiline lists.
- Objects and arrays: put members on separate lines when needed.
- Union and intersection types: split at `|` and `&`.
- Conditions: split at logical operators without changing precedence.
- Method chains: put stages on separate lines.
- JSX: split attributes and children across lines.
- Comments: wrap sentences while preserving rationale and design details.
- Strings: split only when values and meaningful whitespace remain intact.

Special cases require deliberate review:

- Do not arbitrarily split URLs, regular expressions, snapshots, or
  template literals.
- Translation strings must retain their keys and remain extractable.
- Prefer line wrapping over algorithm changes or unnecessary extraction
  of functions.
- Resolve unsafe-to-wrap cases explicitly rather than silently excluding
  their files.

## 4. Configure formatting and automated checks

- Choose and pin a formatter compatible with repository conventions.
- Use a target width of 80, four spaces, single quotes, and semicolons.
- Treat formatter width as a preference, not enforcement: comments and
  strings can still exceed it.
- Add an npm command, such as `npm run lint:width`, for the strict checker.
- Test Unicode, CRLF, blank lines, multiple files, missing files, and lines
  exactly 80 characters long.

## 5. Refactor in small batches

Suggested order:

1. Checker, tests, and configuration.
2. `src/markdown/` and `src/base/`.
3. `src/platform/`.
4. `src/app/`, `src/agent/`, and `src/orchestrator/`.
5. Renderer and Electron code.
6. Tests and scripts.

For every batch:

- Keep the change focused on formatting.
- Preserve comments that explain why the code behaves as it does.
- Review string values, operator precedence, and meaningful whitespace.
- Separate any necessary structural refactor from mechanical formatting.

## 6. Validate each batch

- Run the strict width checker.
- Run `npm run typecheck`.
- Run core tests and relevant Electron tests.
- Inspect saved logs, not just pass/fail summaries.
- Check performance impact. For formatting-only changes, compare emitted
  runtime output before and after where practical. For structural or logic
  changes, measure the affected runtime paths as required by `AGENTS.md`.
- If appearance changes, inspect real screenshots in the required themes
  and window sizes and show them to the user.
- Before declaring the overall work finished, run the complete `npm test`
  suite and report its actual results.

## 7. Document and enforce the rule

- Add the agreed rule to `AGENTS.md`.
- Document the checker command in `README.md`.
- Update learning documents when their existing triggers apply, such as
  structural changes or agent improvements. Formatting alone is not an
  architectural improvement.
- Once the agreed scope is clean, make the width check mandatory locally
  and in CI.
- During migration, check individual batches as needed; the final check
  must cover the entire agreed scope without a violation baseline.

## Acceptance criteria

- No line exceeds 80 characters in the agreed scope.
- Behavior, string values, and translation results remain unchanged.
- Typechecking and all tests pass with clean logs.
- Performance impact has been checked and reported.
- CI prevents new width violations.

## Recommended first step

Start with the audit and checker, then migrate one small module batch at
a time so that diffs remain reviewable and failures remain traceable.
