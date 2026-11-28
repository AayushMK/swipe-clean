#!/bin/sh
# Publishes www/ to GitHub Pages, plus SwipeClean.apk (kept out of main so the
# native app bundles don't carry a 5 MB copy of themselves).
set -e
cd "$(dirname "$0")/.."
split=$(git subtree split --prefix www main)
export GIT_INDEX_FILE="$(git rev-parse --git-dir)/deploy-index"
git read-tree "$split"
git rm -r --cached --quiet --ignore-unmatch models   # face models are for the apps only
if [ -f SwipeClean.apk ]; then
  blob=$(git hash-object -w SwipeClean.apk)
  git update-index --add --cacheinfo 100644,"$blob",SwipeClean.apk
fi
commit=$(git commit-tree "$(git write-tree)" -p "$split" -m "Deploy site")
rm -f "$GIT_INDEX_FILE"
git push origin "$commit":refs/heads/gh-pages --force
