# make.fun entry: hidden-spec-cli-01-run-20261122

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/q514168795/mend-day-entry/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/q514168795/mend-day-entry/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

`mend`, the patch tool [SPEC.md](SPEC.md) specifies, for
[make.fun](https://make.fun)'s [hidden-spec-cli-01-run-20261122](https://make.fun/bounty/hidden-spec-cli-01-run-20261122).

It reads all four edit formats - unified diffs, SEARCH/REPLACE blocks, V4A patches and JSON edit
arrays - finds each edit's old lines at the first of three matching tiers, re-indents added lines at
the loosest tier, keeps every file's own line break, and writes every change or none.

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

Node 22 and its standard library alone. `runner.ts` is the kit's trial runner, kept as it is.
