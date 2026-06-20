#!/bin/bash
# Write-op CLI test matrix for @cordfuse/llmux v0.12.4.
#
# Isolation: spins up a fresh daemon on port 13001 with its own
# XDG_STATE_HOME so the running operator daemon at :3001 is untouched.
# All test tmux sessions are prefixed `llmuxtest-` so cleanup can be
# targeted without nuking the operator's real sessions.
#
# Cost: $0. Test agent is `claude` with --cwd /tmp (idle at empty prompt,
# no project context) and prompts use --no-enter so nothing reaches the LLM.

set +e
REPO="$( cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd )"
LLMUX="node $REPO/packages/llmux/dist/index.js"
TEST_PORT=13001
TEST_STATE=$(mktemp -d -t llmux-wtest.XXXXX)
TEST_CONFIG=$(mktemp -d -t llmux-wcfg.XXXXX)  # serves as cwd to avoid project-local .llmux.yaml pickup
DAEMON_LOG="$TEST_STATE/daemon.log"
DAEMON_PID=""
PREFIX="llmuxtest-$$"

PASS=0
FAIL=0
declare -a FAILURES

cleanup() {
  echo
  echo "[cleanup] killing test tmux sessions matching ^${PREFIX}"
  for s in $(tmux ls 2>/dev/null | awk -F: '/^'"${PREFIX}"'/{print $1}'); do
    echo "  killing $s"
    tmux kill-session -t "$s" 2>/dev/null
  done
  if [ -n "$DAEMON_PID" ] && kill -0 "$DAEMON_PID" 2>/dev/null; then
    echo "[cleanup] stopping test daemon pid=$DAEMON_PID"
    kill -TERM "$DAEMON_PID" 2>/dev/null
    sleep 1
    kill -0 "$DAEMON_PID" 2>/dev/null && kill -KILL "$DAEMON_PID" 2>/dev/null
  fi
  echo "[cleanup] removing $TEST_STATE $TEST_CONFIG"
  rm -rf "$TEST_STATE" "$TEST_CONFIG"
}
trap cleanup EXIT INT TERM

run() {
    local name="$1"; shift
    local expect_rc="$1"; shift
    local expect_substr="$1"; shift
    local out rc
    out=$("$@" 2>&1)
    rc=$?
    local ok_rc=0 ok_sub=0
    if [ "$expect_rc" = "any" ] || [ "$rc" = "$expect_rc" ]; then ok_rc=1; fi
    if [ -z "$expect_substr" ] || echo "$out" | grep -qF -- "$expect_substr"; then ok_sub=1; fi
    if [ "$ok_rc" = "1" ] && [ "$ok_sub" = "1" ]; then
        printf "  [PASS] %s\n" "$name"
        PASS=$((PASS+1))
    else
        printf "  [FAIL] %s — rc=%s (wanted %s)" "$name" "$rc" "$expect_rc"
        [ -n "$expect_substr" ] && [ "$ok_sub" = "0" ] && printf " (missing %q)" "$expect_substr"
        printf "\n        out: %s\n" "$(echo "$out" | head -3 | tr '\n' ' ')"
        FAIL=$((FAIL+1))
        FAILURES+=("$name")
    fi
}

check() {
  local name="$1"; local cond_rc="$2"; local detail="$3"
  if [ "$cond_rc" = "0" ]; then
    printf "  [PASS] %s\n" "$name"
    PASS=$((PASS+1))
  else
    printf "  [FAIL] %s — %s\n" "$name" "$detail"
    FAIL=$((FAIL+1))
    FAILURES+=("$name")
  fi
}

section() { printf "\n=== %s ===\n" "$1"; }

# ---------- isolated daemon ----------
unset TMUX TMUX_PANE
echo "[setup] state dir: $TEST_STATE"
echo "[setup] cwd:       $TEST_CONFIG"
echo "[setup] starting isolated daemon on :$TEST_PORT"
( cd "$TEST_CONFIG" && XDG_STATE_HOME="$TEST_STATE" $LLMUX server start --port $TEST_PORT > "$DAEMON_LOG" 2>&1 ) &
DAEMON_PID=$!
echo "[setup] daemon pid: $DAEMON_PID"
# Wait up to 10s for daemon to start listening
for i in $(seq 1 20); do
  if curl -sS -m 1 -o /dev/null "http://localhost:$TEST_PORT/api/sessions"; then break; fi
  sleep 0.5
done
if ! curl -sS -m 1 -o /dev/null "http://localhost:$TEST_PORT/api/sessions"; then
  echo "[setup] ERROR: daemon never came up — log:"
  cat "$DAEMON_LOG"
  exit 2
fi
echo "[setup] daemon responding"

# helper that always sets the test state dir and cwd
LOCALSH() { ( cd "$TEST_CONFIG" && XDG_STATE_HOME="$TEST_STATE" "$@" ); }

# ---------- 1. SESSION START (local mode) ----------
section "1. session start (local) — spawns idle claude in tmux"
TS_START="${PREFIX}-start"
run "session start claude --name $TS_START --cwd /tmp" \
    0 "" \
    bash -c "cd '$TEST_CONFIG' && XDG_STATE_HOME='$TEST_STATE' $LLMUX session start claude --name '$TS_START' --cwd /tmp"

# Verify side effects
tmux has-session -t "$TS_START" 2>/dev/null
check "tmux session '$TS_START' exists post-spawn" $? "tmux has-session failed"
grep -q "\"name\": \"$TS_START\"" "$TEST_STATE/llmuxd/sessions.json" 2>/dev/null
check "state.json contains '$TS_START'" $? "session not recorded in state file"

# Negative: duplicate spawn should error
run "session start with duplicate name errors" \
    any "" \
    bash -c "cd '$TEST_CONFIG' && XDG_STATE_HOME='$TEST_STATE' $LLMUX session start claude --name '$TS_START' --cwd /tmp"
# Negative: unknown agent
run "session start unknown-agent errors" \
    any "unknown agent" \
    bash -c "cd '$TEST_CONFIG' && XDG_STATE_HOME='$TEST_STATE' $LLMUX session start nonexistent-agent --name x --cwd /tmp"

# ---------- 2. SESSION RESTART (local) ----------
section "2. session restart (local) — kill + relaunch"
sleep 1  # give claude a moment to be properly attached in tmux
PID_BEFORE=$(tmux list-panes -t "$TS_START" -F '#{pane_pid}' 2>/dev/null | head -1)
echo "  [INFO] pane pid before restart: $PID_BEFORE"
run "session restart $TS_START" \
    0 "" \
    bash -c "cd '$TEST_CONFIG' && XDG_STATE_HOME='$TEST_STATE' $LLMUX session restart '$TS_START'"
sleep 1
PID_AFTER=$(tmux list-panes -t "$TS_START" -F '#{pane_pid}' 2>/dev/null | head -1)
echo "  [INFO] pane pid after restart:  $PID_AFTER"
tmux has-session -t "$TS_START" 2>/dev/null
check "tmux session still alive post-restart" $? "session vanished"
if [ -n "$PID_BEFORE" ] && [ -n "$PID_AFTER" ] && [ "$PID_BEFORE" != "$PID_AFTER" ]; then
  check "pane pid changed (true restart)" 0 ""
else
  check "pane pid changed (true restart)" 1 "before=$PID_BEFORE after=$PID_AFTER"
fi

# ---------- 3. SESSION PROMPT (local, --no-enter so it's free) ----------
section "3. session prompt --no-enter (local) — types text into pane without submitting"
sleep 1
run "session prompt with --no-enter" \
    0 "" \
    bash -c "cd '$TEST_CONFIG' && XDG_STATE_HOME='$TEST_STATE' $LLMUX session prompt '$TS_START' 'XYZTESTMARKER' --no-enter"
sleep 0.5
tmux capture-pane -t "$TS_START" -p 2>/dev/null | grep -q "XYZTESTMARKER"
check "marker visible in pane after prompt (text was injected)" $? "tmux capture-pane did not show injected text"

# ---------- 4. SESSION STOP (local) ----------
section "4. session stop (local)"
run "session stop $TS_START" \
    0 "" \
    bash -c "cd '$TEST_CONFIG' && XDG_STATE_HOME='$TEST_STATE' $LLMUX session stop '$TS_START'"
sleep 0.5
tmux has-session -t "$TS_START" 2>/dev/null
HAS_RC=$?
if [ "$HAS_RC" != "0" ]; then
  check "tmux session removed post-stop" 0 ""
else
  check "tmux session removed post-stop" 1 "still alive"
fi

# ---------- 5. SESSION BROADCAST (local, --no-enter) ----------
section "5. session broadcast (local) — spawn 2 claudes, broadcast to type='claude'"
TS_BA="${PREFIX}-bcast-a"
TS_BB="${PREFIX}-bcast-b"
LOCALSH $LLMUX session start claude --name "$TS_BA" --cwd /tmp > /dev/null
LOCALSH $LLMUX session start claude --name "$TS_BB" --cwd /tmp > /dev/null
sleep 1
run "session broadcast claude --no-enter" \
    0 "" \
    bash -c "cd '$TEST_CONFIG' && XDG_STATE_HOME='$TEST_STATE' $LLMUX session broadcast claude 'BROADCASTMARKER' --no-enter"
sleep 0.5
tmux capture-pane -t "$TS_BA" -p 2>/dev/null | grep -q "BROADCASTMARKER"
check "marker visible in pane A after broadcast" $? "BROADCASTMARKER missing in $TS_BA"
tmux capture-pane -t "$TS_BB" -p 2>/dev/null | grep -q "BROADCASTMARKER"
check "marker visible in pane B after broadcast" $? "BROADCASTMARKER missing in $TS_BB"

# clean up broadcast sessions
LOCALSH $LLMUX session stop "$TS_BA" > /dev/null
LOCALSH $LLMUX session stop "$TS_BB" > /dev/null

# ---------- 6. SESSION RESUME (local) — relaunch with --resume <id> ----------
section "6. session resume (local) — relaunch claude with --resume <real conv id>"
CONV_FILE=$(ls -t ~/.claude/projects/*/*.jsonl 2>/dev/null | head -1)
if [ -z "$CONV_FILE" ]; then
  echo "  [SKIP] no Claude history files found — cannot test resume"
else
  CONV_ID=$(basename "$CONV_FILE" .jsonl)
  CONV_CWD=$(basename "$(dirname "$CONV_FILE")" | tr '-' '/' | sed 's|^/||')
  echo "  [INFO] using conv id $CONV_ID from cwd /$CONV_CWD"
  TS_RES="${PREFIX}-resume"
  # First spawn a fresh session whose cwd matches the conversation's cwd
  LOCALSH $LLMUX session start claude --name "$TS_RES" --cwd "/$CONV_CWD" > /dev/null
  sleep 1
  run "session resume --conversation <id>" \
      0 "" \
      bash -c "cd '$TEST_CONFIG' && XDG_STATE_HOME='$TEST_STATE' $LLMUX session resume '$TS_RES' --conversation '$CONV_ID'"
  sleep 1
  tmux has-session -t "$TS_RES" 2>/dev/null
  check "tmux session alive post-resume" $? "session vanished after resume"
  # State file should record resumeFrom
  grep -q "\"resumeFrom\": \"$CONV_ID\"" "$TEST_STATE/llmuxd/sessions.json" 2>/dev/null
  check "state.json records resumeFrom=$CONV_ID" $? "resumeFrom not persisted"
  # Negative: resume without --conv or --latest
  run "session resume without --conv or --latest errors" \
      any "requires --conversation" \
      bash -c "cd '$TEST_CONFIG' && XDG_STATE_HOME='$TEST_STATE' $LLMUX session resume '$TS_RES'"
  # Test --latest
  run "session resume --latest" \
      0 "" \
      bash -c "cd '$TEST_CONFIG' && XDG_STATE_HOME='$TEST_STATE' $LLMUX session resume '$TS_RES' --latest"
  LOCALSH $LLMUX session stop "$TS_RES" > /dev/null
fi

# ---------- 7. REMOTE-MODE EQUIVALENTS via --server ----------
section "7. remote-mode write ops via --server http://localhost:$TEST_PORT"
TS_R_START="${PREFIX}-rstart"
run "remote: session start" \
    0 "" \
    $LLMUX session start claude --name "$TS_R_START" --cwd /tmp --server "http://localhost:$TEST_PORT"
sleep 1
tmux has-session -t "$TS_R_START" 2>/dev/null
check "remote start created tmux session" $? "tmux session missing after remote start"

run "remote: session prompt --no-enter" \
    0 "" \
    $LLMUX session prompt "$TS_R_START" "REMOTEMARKER" --no-enter --server "http://localhost:$TEST_PORT"
sleep 0.5
tmux capture-pane -t "$TS_R_START" -p 2>/dev/null | grep -q "REMOTEMARKER"
check "REMOTEMARKER injected via remote prompt" $? "marker missing"

PID_R_BEFORE=$(tmux list-panes -t "$TS_R_START" -F '#{pane_pid}' 2>/dev/null | head -1)
run "remote: session restart" \
    0 "" \
    $LLMUX session restart "$TS_R_START" --server "http://localhost:$TEST_PORT"
sleep 1
PID_R_AFTER=$(tmux list-panes -t "$TS_R_START" -F '#{pane_pid}' 2>/dev/null | head -1)
if [ -n "$PID_R_BEFORE" ] && [ -n "$PID_R_AFTER" ] && [ "$PID_R_BEFORE" != "$PID_R_AFTER" ]; then
  check "remote restart changed pane pid" 0 ""
else
  check "remote restart changed pane pid" 1 "before=$PID_R_BEFORE after=$PID_R_AFTER"
fi

run "remote: session stop" \
    0 "" \
    $LLMUX session stop "$TS_R_START" --server "http://localhost:$TEST_PORT"
sleep 0.5
tmux has-session -t "$TS_R_START" 2>/dev/null
HAS_RC=$?
if [ "$HAS_RC" != "0" ]; then
  check "remote stop removed tmux session" 0 ""
else
  check "remote stop removed tmux session" 1 "still alive"
fi

# ---------- SUMMARY ----------
echo
printf "==================================================\n"
printf "  PASS: %d   FAIL: %d\n" "$PASS" "$FAIL"
printf "==================================================\n"
if [ "$FAIL" -gt 0 ]; then
  echo "Failures:"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
fi
exit $FAIL
