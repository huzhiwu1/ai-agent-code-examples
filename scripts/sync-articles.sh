#!/bin/bash
# 同步 articles/<slug>/README.md → 飞书「AI Agent 知识点手册」文章
# 用法：
#   bash scripts/sync-articles.sh            # 列出已关联飞书的文章
#   bash scripts/sync-articles.sh <slug>     # 同步单篇（如 mcp-tools）
#   bash scripts/sync-articles.sh all        # 同步全部已关联文章
# 说明：
#   - README.md 开头 front matter 的 feishu_doc 字段记录飞书 token
#   - 推送时自动剥离 front matter，overwrite 整篇重写 + revision 回读验证
#   - mermaid 代码块自动转白板

set -e
cd ~/workspace/ai-agent-code-examples

sync_one() {
  local slug="$1"
  local file="articles/$slug/README.md"
  [ -f "$file" ] || { echo "❌ 文件不存在: $file"; return 1; }
  local token
  token=$(grep -m1 '^feishu_doc:' "$file" | sed 's/feishu_doc: *//; s/"//g; s/^"//; s/"$//')
  if [ -z "$token" ]; then
    echo "⏭️  $slug：无 feishu_doc（文章未发布），跳过"
    return 0
  fi
  # 剥离 front matter（第一个 --- 到第二个 --- 之间的行）
  awk 'BEGIN{n=0} /^---$/{n++; next} n<2{next} {print}' "$file" > /tmp/push-article.md
  echo "🔄 同步 $slug → 飞书 $token ..."
  lark-cli docs +update --doc "$token" --command overwrite --doc-format markdown --content @/tmp/push-article.md --as user 2>&1 | python3 -c "
import json,sys
d=json.load(sys.stdin)
ok = d.get('data',{}).get('result')
rev = d.get('data',{}).get('document',{}).get('revision_id')
print('✅ %s 同步成功 (revision %s)' % ('$slug', rev) if ok == 'success' else '❌ %s 同步失败: %s' % ('$slug', d.get('error',{}).get('message', d)))
"
}

list_all() {
  echo "已关联飞书的文章："
  for f in articles/*/README.md; do
    slug=$(basename "$(dirname "$f")")
    token=$(grep -m1 '^feishu_doc:' "$f" | sed 's/feishu_doc: *//; s/"//g')
    [ -n "$token" ] && echo "  $slug → $token"
  done
}

if [ -z "$1" ] || [ "$1" = "help" ] || [ "$1" = "-h" ]; then
  list_all
  echo ""
  echo "用法：bash scripts/sync-articles.sh <slug> | all"
  exit 0
fi

if [ "$1" = "all" ]; then
  for f in articles/*/README.md; do
    slug=$(basename "$(dirname "$f")")
    sync_one "$slug" || true
  done
  exit 0
fi

sync_one "$1"
