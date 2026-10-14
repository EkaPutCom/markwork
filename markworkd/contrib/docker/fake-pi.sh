#!/bin/sh
# A stand-in for `pi --mode rpc`: answers get_state and prompt, "works" for a while (long enough to close Markwork
# and open it again), then reports a result and waits for stdin to close, as the real pi does.
read -r _state
echo '{"id":"markwork-state","type":"response","command":"get_state","success":true,"data":{"sessionId":"docker-session"}}'
read -r _prompt
echo '{"type":"response","command":"prompt","success":true,"data":{"disposition":"started"}}'
echo '{"type":"turn_start"}'
echo '{"type":"tool_execution_start","toolCallId":"t1","toolName":"bash","args":{"command":"npm test"}}'
sleep "${FAKE_PI_SECONDS:-60}"
echo '{"type":"tool_execution_end","toolCallId":"t1","toolName":"bash","result":{"content":[{"type":"text","text":"ok"}]},"isError":false}'
echo '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Done on the fake VPS."}],"stopReason":"stop","usage":{"totalTokens":10,"cost":{"total":0}}}}'
echo '{"type":"agent_settled"}'
while read -r _; do :; done
