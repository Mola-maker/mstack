# Commits that landed on default branches without a PR, last 14 days, across the user's active repos.
for r in Mola-maker/mstack Mola-maker/molamaker-site Ephemeral-AI-Lab/LayerFS Mola-maker/deepseek-harness MolaLimitless/deepseek-harness; do
  b=$(gh api repos/$r --jq .default_branch 2>/dev/null) || { echo "skip $r"; continue; }
  echo "== $r ($b)"
  gh api "repos/$r/commits?sha=$b&since=2026-10-25T00:00:00Z&per_page=100" --jq '.[] | [.sha[0:8], .commit.author.date[0:16], .commit.author.name, (.commit.message|split("\n")[0])[0:70]] | @tsv' 2>/dev/null | while IFS=$'\t' read sha d a m; do
    n=$(gh api repos/$r/commits/$sha/pulls --jq length 2>/dev/null)
    [ "$n" = "0" ] && echo "  NO-PR $sha $d $a | $m"
  done
done
