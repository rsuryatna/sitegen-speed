# sitegen-speed

[![make.fun](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/rsuryatna/sitegen-speed/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/rsuryatna/sitegen-speed/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

A fast, dependency-free static site generator entry for the
[make.fun bounty "Build a static site faster"](https://make.fun/bounty/site-generator-speed-01-run-20261122)
(slug `site-generator-speed-01-run-20261122`).

`solve.js` exports `run(input)`, which returns exactly what makefun-site 1.0.0's
`build(input)` returns for every case — byte-identical output (same output tree:
each page's `index.html`, index/tag pages, `build-report.txt`, and each static
file). `main.ts` is the standard harness driver (copied verbatim from the kit's
baseline): it reads `/input/cases.json`, answers each case with `run()`, and
writes `/output/answers.json`.

## How it is fast

- **Template pre-compilation:** templates are parsed once and compiled to
  JavaScript functions via `new Function` (with a tree-walking interpreter
  fallback). `{% for %}` loops mutate the environment in place (save/restore)
  instead of allocating a fresh environment object per iteration, and the
  `loop` helper object is reused across iterations.
- **Single-pass fused Markdown renderer:** lines go straight to HTML with no
  token objects. Block dispatch is a first-character switch (no per-line
  function-call chain), and the inline renderer scans character by character
  with bulk plain runs, plus fast paths for plain text and escape-only text.
- **Fast front matter:** the closing `---` is found by an index scan and the
  body is a single slice (no whole-body split/join); the `key: value` grammar
  is replicated by hand.
- **ASCII fast paths:** `slugify` skips NFKD on pure-ASCII input (NFKD is the
  identity there) and falls back to the reference algorithm for non-ASCII;
  `wordsOf` counts words in a single pass with no regex and no allocation;
  `escapeHtml` scans for the first special character before building anything.
- **String concatenation** (not array-push + join) for template output.

All of it is written fresh from the spec (the makefun-site README) and the
reference implementation's observable behaviour; no vendor code is copied.

## How to run

Requires Node 22+ (the grader runs Node 22; local testing used Node 24).
No dependencies, nothing to install.

```sh
# practice set (from the kit)
MAKEFUN_INPUT_DIR=<kit>/practice/input MAKEFUN_OUTPUT_DIR=/tmp/out node main.ts
```

`main.ts` reads `cases.json` from the input directory and writes
`answers.json` to the output directory.

## Correctness

Verified against the kit's practice set (`kit/practice/input/cases.json`,
3 cases, 200–600 sources each) and its reference answers
(`kit/practice/reference/expected.json`): **3/3 cases identical** (canonical
JSON comparison, the same rule the scorer uses).

Local speed (same machine, same method, median of several runs):

| entry | build only (3 cases) | full `node main.ts` wall |
| --- | --- | --- |
| makefun-site baseline | ~454 ms | ~902 ms |
| this entry | ~154–186 ms | ~647 ms |

So the build itself runs about 2.4–3× faster than the reference; the full
entry is about 1.4× faster on wall time (the rest is fixed driver/JSON cost
every entry pays).
