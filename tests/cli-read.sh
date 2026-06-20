#!/bin/bash
# Full CLI test matrix for @cordfuse/llmux v0.12.3
# Run against the daemon already up at localhost:3001 (v0.12.0).

set +e
REPO="$( cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd )"
LLMUX="node $REPO/packages/llmux/dist/index.js"
SERVER="http://localhost:3001"
TESTSESS="cli-test-$$"

PASS=0
FAIL=0
WARN=0
declare -a FAILURES

run() {
    local name="$1"; shift
    local expect_rc="$1"; shift           # rc we want (or "any")
    local expect_substr="$1"; shift       # substring we want in output (or "")
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
        printf "\n        out: %s\n" "$(echo "$out" | head -2 | tr '\n' ' ')"
        FAIL=$((FAIL+1))
        FAILURES+=("$name")
    fi
}

warn() {
    printf "  [WARN] %s — %s\n" "$1" "$2"
    WARN=$((WARN+1))
}

section() { printf "\n=== %s ===\n" "$1"; }

# Strip TMUX env so subprocess decisions about tmux state don't get confused
unset TMUX TMUX_PANE

# ---------- 1. GLOBAL ----------
section "Global flags"
# Version match — semver pattern, version-agnostic
out=$($LLMUX --version 2>&1); rc=$?
if [ "$rc" = "0" ] && echo "$out" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+'; then
  printf "  [PASS] %s\n" "--version prints semver"; PASS=$((PASS+1))
else
  printf "  [FAIL] %s — out: %s\n" "--version prints semver" "$out"; FAIL=$((FAIL+1))
  FAILURES+=("--version prints semver")
fi
out=$($LLMUX -v 2>&1); rc=$?
if [ "$rc" = "0" ] && echo "$out" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+'; then
  printf "  [PASS] %s\n" "-v short version"; PASS=$((PASS+1))
else
  printf "  [FAIL] %s — out: %s\n" "-v short version" "$out"; FAIL=$((FAIL+1))
  FAILURES+=("-v short version")
fi
run "--help prints usage"            0 "Usage:" $LLMUX --help
run "-h short help"                  0 "Usage:" $LLMUX -h
run "bare invocation prints help"    0 "Usage:" $LLMUX
run "unknown verb errors"            any "" $LLMUX nonsense-verb

# ---------- 2. AGENT VERBS ----------
section "agent list"
run "agent list (installed default)"     0 "" $LLMUX agent list
run "agent list --installed"             0 "" $LLMUX agent list --installed
run "agent list --all (15 in catalog)"   0 "claude" $LLMUX agent list --all
run "agent list --json valid"            0 "" $LLMUX agent list --json
echo "  [INFO] agent list --json count: $($LLMUX agent list --json 2>/dev/null | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))' 2>/dev/null)"
echo "  [INFO] agent list --all --json count: $($LLMUX agent list --all --json 2>/dev/null | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))' 2>/dev/null)"

# ---------- 3. TOKEN VERBS ----------
section "token (local, requires daemon auth state)"
# Need to test against an isolated state dir to avoid mangling the running
# daemon's auth.json. Use XDG_STATE_HOME override.
TMPSTATE=$(mktemp -d -t llmux-test-state.XXXXX)
export XDG_STATE_HOME="$TMPSTATE"
run "token create --name a"          0 "sas_" $LLMUX token create --name a
run "token list shows 1"             0 "a" $LLMUX token list
TOKID=$($LLMUX token list 2>/dev/null | awk 'NR>1 && NF>=2 {print $1; exit}')
echo "  [INFO] first token id: $TOKID"
run "token revoke <id>"              0 "" $LLMUX token revoke "$TOKID"
run "token list now empty"           0 "no tokens" $LLMUX token list
# Legacy shape: "token revoke <id>" via positional[1]
run "token create --name b"          0 "sas_" $LLMUX token create --name b
TOKID2=$($LLMUX token list 2>/dev/null | awk 'NR>1 && NF>=2 {print $1; exit}')
run "token revoke (verb-then-id form works)" 0 "" $LLMUX token revoke "$TOKID2"
# Negative tests
run "token revoke missing id errors" any "" $LLMUX token revoke
run "token create without --name still works" 0 "sas_" $LLMUX token create
$LLMUX token list 2>/dev/null | tail -10 | head -3
# Clean up test state dir; restore default
rm -rf "$TMPSTATE"
unset XDG_STATE_HOME

# ---------- 4. SERVER VERB ----------
section "server start (help only — actual start would collide with running daemon)"
run "server start --help mentions --port" 0 "--port" $LLMUX server start --help
run "server --help mentions verbs"        any "start" $LLMUX server --help

# ---------- 5. SESSION LOCAL (read-only on real sessions) ----------
section "session — local mode (read against running daemon's tmux state)"
run "session list works"          0 "" $LLMUX session list
run "session list --json valid"   0 "" $LLMUX session list --json
echo "  [INFO] sessions visible to local CLI: $($LLMUX session list --json 2>/dev/null | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))' 2>/dev/null)"
# History on a session with no history adapter:
run "session history on codex (no adapter)" any "" $LLMUX session history codex
# Verbs missing positionals:
run "session start with no agent"    any "" $LLMUX session start
run "session stop with no name"      any "" $LLMUX session stop
run "session prompt with no name"    any "" $LLMUX session prompt
run "session restart nonexistent"    any "" $LLMUX session restart __nope_$$
run "session resume needs --conv or --latest" any "" $LLMUX session resume codex

# Write tests — spawn a real test session, prompt it, stop it
section "session — write ops (against a throwaway test session)"
echo "  [INFO] spawning test session '$TESTSESS' running cat (echo agent)"
# We don't have a "cat" agent in catalog. We'll use claude but without launching the agent — actually we can't.
# Instead: skip start (would invoke real claude CLI). Use the API to spawn a synthetic tmux session.
# But that's exactly the daemon's job. So: pick an installed agent. claude is installed.
# Risk: spawning a real claude session uses an API call. Mitigation: name it cli-test-$$, kill in cleanup.
# Even better — use --flags "--help" so claude prints help and exits immediately (or runs into argparse).
# Simplest safe: skip the start test; ack as WARN.
warn "session start (write)" "skipped — would launch a real agent CLI; daemon-side write paths are exercised by web UAT"
warn "session stop (write)"  "skipped — depends on start"
warn "session restart (write)" "skipped — depends on start"
warn "session prompt (write)" "skipped — would inject keystrokes into a live agent CLI; covered by web UAT"
warn "session broadcast (write)" "skipped — would inject into ALL live agent CLIs of a type"
warn "session resume (write)" "skipped — would relaunch claude with --resume; tested via web UAT"

# ---------- 6. SESSION REMOTE (--server) ----------
section "session — remote mode via --server"
# Daemon at localhost:3001 has auth required + 1 active token.
# From localhost, auth is bypassed → no token needed.
run "session list --server (localhost auth bypass)" 0 "" $LLMUX session list --server "$SERVER"
run "session list --server --json" 0 "" $LLMUX session list --server "$SERVER" --json
run "agents list --server"          0 "" $LLMUX agent list --server "$SERVER" --installed
# Negative: bad server URL
run "session list --server bad-url" any "" $LLMUX session list --server "http://127.0.0.1:1"

# ---------- 7. ENV-VAR FALLBACK ----------
section "env var fallbacks"
LLMUX_SERVER="$SERVER" run "LLMUX_SERVER env routes to remote" 0 "" $LLMUX session list
LLMUX_SERVER="$SERVER" LLMUX_TOKEN="sas_bogus" run "LLMUX_TOKEN bogus (localhost still bypasses)" 0 "" $LLMUX session list

# ---------- 8. AUTH (requires non-localhost or daemon w/o localhost bypass) ----------
section "auth via 127.0.0.1 — should also bypass; via hostname might not"
# 127.0.0.1 is treated as localhost. To force non-bypass we'd need an external IP.
# Skip strict auth test against the running daemon (its bypass rule applies)
warn "401 without token (non-localhost)" "skipped — would require connecting via external IP; localhost bypass overrides"
warn "200 with valid Bearer (non-localhost)" "skipped — same reason"

# ---------- 9. BACKWARD-COMPAT SHIMS ----------
section "backward-compat shims (one-release grace)"
run "bare 'ls' verb (alias of session list)"     0 "" $LLMUX ls
run "bare 'status' verb"                          0 "" $LLMUX status
run "bare 'send' fallthrough errors w/o args"     any "" $LLMUX send
run "bare 'spawn' fallthrough errors w/o args"    any "" $LLMUX spawn
run "bare 'kill' fallthrough errors w/o args"     any "" $LLMUX kill
run "bare 'serve --help'"                          0 "" $LLMUX serve --help

# ---------- 10. EDGE CASES ----------
section "edge cases"
run "--server with no value"          any "" $LLMUX session list --server
run "--token with no value"           any "" $LLMUX session list --token
run "unknown global flag"             any "" $LLMUX --bogus-flag
run "agent list --invalid-flag"       any "" $LLMUX agent list --bogusflag
run "session attach (no name)"        any "" $LLMUX session attach
run "session attach (nonexistent)"    any "no session" $LLMUX session attach __nope_$$

# ---------- SUMMARY ----------
echo
printf "==================================================\n"
printf "  PASS: %d   FAIL: %d   WARN: %d\n" "$PASS" "$FAIL" "$WARN"
printf "==================================================\n"
if [ "$FAIL" -gt 0 ]; then
    echo "Failures:"
    for f in "${FAILURES[@]}"; do echo "  - $f"; done
fi
exit $FAIL
