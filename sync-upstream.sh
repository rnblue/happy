#!/bin/bash
# Happy Work — upstream(slopus/happy) 업데이트 가져오기
# 사용법: ./sync-upstream.sh

set -e

echo "=== Fetching upstream ==="
git fetch upstream

echo ""
echo "=== Upstream changes since last sync ==="
git log --oneline HEAD..upstream/main | head -20

AHEAD=$(git rev-list --count HEAD..upstream/main)
if [ "$AHEAD" -eq 0 ]; then
    echo ""
    echo "✓ Already up to date!"
    exit 0
fi

echo ""
echo "$AHEAD commits behind upstream."
echo ""
read -p "Merge upstream/main? (y/n) " -n 1 -r
echo ""

if [[ $REPLY =~ ^[Yy]$ ]]; then
    # 우리 변경사항(bundle ID 등)을 유지하면서 merge
    git merge upstream/main --no-edit -X ours
    echo ""
    echo "✓ Merged! Review changes and rebuild."
    echo "  cd packages/happy-app && yarn prebuild && yarn ios:production"
else
    echo "Cancelled."
fi
