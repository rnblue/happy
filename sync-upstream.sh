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
    # 우리 변경사항(bundle ID 등) 보존을 위해 충돌은 수동 해결 권장.
    # -X ours는 큰 머지에서 upstream 변경을 통째로 덮어쓰는 위험이 있어 제거.
    git merge upstream/main --no-edit
    echo ""
    echo "✓ Merged! Review changes and rebuild."
    echo "  export PATH=\"/Volumes/MoonBase/.pnpm-tools/bin:\$PATH\""
    echo "  pnpm install"
    echo "  pnpm --filter happy-app prebuild   # 새 native 디렉터리 생성 (~2분)"
    echo "  pnpm --filter happy-app typecheck"
else
    echo "Cancelled."
fi
