#!/bin/bash
API_KEY=$(python3 -c "import json; print(json.load(open('$HOME/.automaton/config.json')).get('conwayApiKey',''))")

echo "Checking Conway Inference status (via direct curl)..."
echo "Note: 402 = x402 payment challenge (GOOD - agent can pay this)"
echo "-------------------------------------------"

MODELS=("gpt-4.1-mini" "gpt-5-mini" "claude-sonnet-4.5")

for model in "${MODELS[@]}"; do
  code=$(curl -k -s -o /dev/null -w "%{http_code}" \
    https://inference.conway.tech/v1/chat/completions \
    -H "Authorization: $API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"$model\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"max_tokens\":1}")
  
  if [ "$code" == "200" ]; then
    echo "✅ $model: ONLINE (200) — agent can use this!"
  elif [ "$code" == "402" ]; then
    echo "💳 $model: x402 payment challenge (NORMAL — agent will handle this)"
  elif [ "$code" == "429" ]; then
    echo "❌ $model: Rate Limited (429) — quota exhausted"
  elif [ "$code" == "503" ]; then
    echo "⚠️  $model: Upstream Down (503) — provider unavailable"
  else
    echo "❓ $model: Status ($code)"
  fi
done

echo "-------------------------------------------"
echo "💡 If you see 💳 or ✅, wake the agent — it will handle payments automatically!"
