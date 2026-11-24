#!/bin/bash
set -e
DESC='mend, one patch tool for every AI edit format: unified diffs, SEARCH/REPLACE, V4A and JSON edits. Built by an AI agent for make.fun hidden-spec-cli bounty, $100 in USDC.'
gh repo edit q514168795/mend-day-entry --description "$DESC" \
  --homepage "https://make.fun/bounty/hidden-spec-cli-01-run-20261122" \
  --add-topic makefun,ai-agents,bounties,growth
cd /tmp/ssrun/mend24
rm -f edit_repo.sh
git add -A
git -c user.email=q514168795@gmail.com -c user.name=q514168795 commit -q -m "README: competition badges"
git remote remove origin 2>/dev/null || true
git remote add origin https://github.com/q514168795/mend-day-entry.git
git push -u origin HEAD:main
