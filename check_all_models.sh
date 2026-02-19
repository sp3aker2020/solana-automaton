#!/bin/bash
API_KEY=$(python3 -c "import json; print(json.load(open('$HOME/.automaton/config.json')).get('conwayApiKey',''))")

MODELS=("gpt-4.1-mini" "gpt-4.1-nano" "gpt-5-mini" "gpt-5-nano" "claude-sonnet-4.5" "o4-mini")

echo "Checking quota for key: ${API_KEY:0:10}..."

for model in "${MODELS[@]}"; do
  status=$(curl -k -s -o /dev/null -w "%{http_code}" \
    https://inference.conway.tech/v1/chat/completions \
    -H "Authorization: $API_KEY" \
    -H "Content-Type: application/json" \
    -d "{
      \"model\": \"$model\",
      \"messages\": [{\"role\": \"user\", \"content\": \"hi\"}],
      \"max_tokens\": 1
    }")
  echo "Model: $model -> Status: $status"
done
