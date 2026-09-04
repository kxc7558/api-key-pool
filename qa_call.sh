#!/bin/bash
# QA 辅助脚本：调用代理池并记录 provider / key / attempt / http / content 长度
# 用法: POOL_KEY=sk-pool-xxx qa_call.sh <model> <timeoutSec> [seq]
M="$1"; T="${2:-60}"; SEQ="${3:-}"
: "${POOL_KEY:?需要 POOL_KEY 环境变量（config.json 的 accessKeys 里的分发 Key）}"
D="C:/Users/32492/WorkBuddy/2026-09-01-11-19-50/api-key-pool"
H="$D/qa_h.txt"; B="$D/qa_b.txt"
CODE=$(curl -s -m "$T" -D "$H" -o "$B" -w "%{http_code}" http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $POOL_KEY" \
  -d "{\"model\":\"$M\",\"messages\":[{\"role\":\"user\",\"content\":\"用一个词回答：1+1等于几\"}],\"max_tokens\":500,\"stream\":false}")
PROV=$(grep -i '^x-pool-provider:' "$H" | tr -d '\r' | awk '{print $2}')
KEY=$(grep -i '^x-pool-key:' "$H" | tr -d '\r' | awk '{print $2}')
ATT=$(grep -i '^x-pool-attempt:' "$H" | tr -d '\r' | awk '{print $2}')
PMOD=$(grep -i '^x-pool-model:' "$H" | tr -d '\r' | awk '{print $2}')
CLEN=$(python -c "
import json
try:
    d=json.load(open(r'$B',encoding='utf-8'))
    c=(d['choices'][0]['message'].get('content') or '')
    print(len(c))
except Exception:
    print('-1')
")
echo "seq=$SEQ model=$M http=$CODE provider=$PROV key=$KEY attempt=$ATT poolmodel=$PMOD contentLen=$CLEN"
