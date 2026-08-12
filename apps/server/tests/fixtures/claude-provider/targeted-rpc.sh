#!/bin/sh
case "$1" in
  --version) printf '%s\n' '2.1.218'; exit 0;;
  --help) printf '%s\n' '--include-hook-events --forward-subagent-text'; exit 0;;
esac

session_id=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --session-id|--resume)
      shift
      session_id="$1"
      ;;
    --settings)
      shift
      printf '%s' "$1" > '__SETTINGS__'
      ;;
  esac
  shift
done
printf '%s' "$BIBCODE_CLAUDE_HOOK_TOKEN" > '__TOKEN__'
printf '%s' "$session_id" > '__SESSION_PATH__'

emit() {
  printf '%s\n' "$1" | sed "s/__SESSION__/$session_id/g"
}

emit '{"type":"stream_event","session_id":"__SESSION__","uuid":"tool-a","parent_tool_use_id":null,"event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tool-agent-a","name":"Agent","input":{"description":"same description","prompt":"same prompt","subagent_type":"same-role"}}}}'
emit '{"type":"system","subtype":"task_started","session_id":"__SESSION__","uuid":"task-a-start","task_id":"task-a","tool_use_id":"tool-agent-a","task_type":"local_agent","description":"same description"}'

emit '{"type":"stream_event","session_id":"__SESSION__","uuid":"tool-b","parent_tool_use_id":null,"event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tool-agent-b","name":"Agent","input":{"description":"same description","prompt":"same prompt","subagent_type":"same-role"}}}}'
emit '{"type":"system","subtype":"task_started","session_id":"__SESSION__","uuid":"task-b-start","task_id":"task-b","tool_use_id":"tool-agent-b","task_type":"local_agent","description":"same description"}'

emit '{"type":"stream_event","session_id":"__SESSION__","uuid":"tool-child","parent_tool_use_id":"tool-agent-a","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tool-agent-child","name":"Agent","input":{"description":"same description","prompt":"same prompt"}}}}'
emit '{"type":"system","subtype":"task_started","session_id":"__SESSION__","uuid":"task-child-start","task_id":"task-child","tool_use_id":"tool-agent-child","task_type":"local_agent"}'

stop_count=0
while IFS= read -r line; do
  printf '%s\n' "$line" >> '__CAPTURE__'
  case "$line" in
    *'"subtype":"stop_task"'*)
      request_id=$(printf '%s\n' "$line" | sed -n 's/.*"request_id":"\([^"]*\)".*/\1/p')
      printf '{"type":"control_response","response":{"subtype":"success","request_id":"%s","response":{}}}\n' "$request_id"
      stop_count=$((stop_count + 1))
      if [ "$stop_count" -eq 2 ]; then
        emit '{"type":"system","subtype":"task_notification","session_id":"__SESSION__","uuid":"task-child-stopped","task_id":"task-child","status":"stopped"}'
        emit '{"type":"system","subtype":"task_notification","session_id":"__SESSION__","uuid":"task-a-stopped","task_id":"task-a","status":"stopped"}'
        emit '{"type":"stream_event","session_id":"__SESSION__","uuid":"root-after-cancel","parent_tool_use_id":null,"event":{"type":"content_block_delta","index":9,"delta":{"type":"text_delta","text":"root-after-cancel"}}}'
      fi
      ;;
  esac
done
