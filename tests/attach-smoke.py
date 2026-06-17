#!/usr/bin/env python3
"""
Smoke test for `llmux session attach <name>`.

Procedure:
  1. Spawn `llmux session attach codex` inside a pty
  2. Stream bytes from the pty for ~3 seconds (proves WS framing + node-pty
     write-back are working — we should see at least the tmux current-pane
     contents)
  3. Send Ctrl+] (0x1d) — the documented detach key
  4. Wait up to 2 more seconds for clean exit
  5. Report: bytes received, exit code, time-to-detach

Pass criteria:
  - Process exits within the detach window (not killed by timeout)
  - Exit code 0
  - Received non-trivial bytes from server (>100 bytes — proves the WS
    actually delivered tmux pane contents)
"""
import os
import pty
import select
import subprocess
import sys
import time

import pathlib
REPO = pathlib.Path(__file__).resolve().parent.parent
LLMUX = ["node", str(REPO / "packages" / "llmux" / "dist" / "index.js")]
SESSION = sys.argv[1] if len(sys.argv) > 1 else "codex"
SERVER = sys.argv[2] if len(sys.argv) > 2 else "http://localhost:3030"

print(f"[test] attaching to '{SESSION}' via WS at {SERVER}")
print(f"[test] will stream for 3s, then send Ctrl+] (0x1d), expect clean exit")

master_fd, slave_fd = pty.openpty()
# Strip TMUX env so the client doesn't go into switch-client mode if remote
# falls back to local for any reason
env = {k: v for k, v in os.environ.items() if not k.startswith("TMUX")}
proc = subprocess.Popen(
    LLMUX + ["session", "attach", SESSION, "--server", SERVER],
    stdin=slave_fd,
    stdout=slave_fd,
    stderr=slave_fd,
    close_fds=True,
    env=env,
)
os.close(slave_fd)

received = bytearray()
start = time.time()
stream_until = start + 3.0
sent_detach = False
detach_at = None

while True:
    now = time.time()
    if not sent_detach and now >= stream_until:
        print(f"[test] streamed for {now - start:.2f}s — sending Ctrl+]")
        try:
            os.write(master_fd, b"\x1d")
        except OSError as e:
            print(f"[test] write Ctrl+] failed: {e}")
        sent_detach = True
        detach_at = now

    timeout = 0.2
    rlist, _, _ = select.select([master_fd], [], [], timeout)
    if master_fd in rlist:
        try:
            chunk = os.read(master_fd, 4096)
        except OSError:
            chunk = b""
        if not chunk:
            break
        received.extend(chunk)

    rc = proc.poll()
    if rc is not None:
        print(f"[test] proc exited rc={rc} at {now - start:.2f}s")
        break

    # absolute kill if we've been hanging more than 8s total
    if now - start > 8.0:
        print(f"[test] HANG — sending SIGKILL after 8s")
        proc.kill()
        break

# drain any final bytes
while True:
    rlist, _, _ = select.select([master_fd], [], [], 0.2)
    if master_fd in rlist:
        try:
            chunk = os.read(master_fd, 4096)
            if not chunk:
                break
            received.extend(chunk)
        except OSError:
            break
    else:
        break

os.close(master_fd)
rc = proc.wait(timeout=2)

elapsed = time.time() - start
detach_lag = (rc is not None and detach_at) and (time.time() - detach_at) or None

print()
print("=" * 60)
print(f"  exit code:      {rc}")
print(f"  total elapsed:  {elapsed:.2f}s")
print(f"  bytes received: {len(received)}")
print(f"  detach lag:     {detach_lag:.2f}s" if detach_lag else "  detach lag:     n/a")
print("=" * 60)
print()
print("=== first 400 bytes of received data (escaped) ===")
preview = received[:400]
print(preview.decode("utf-8", errors="replace"))
print()
print("=== last 200 bytes ===")
print(received[-200:].decode("utf-8", errors="replace"))

# Pass / fail
ok_exit = rc == 0
ok_bytes = len(received) > 100
ok_quick = elapsed < 6.0

print()
print(f"  exit==0:           {'[PASS]' if ok_exit else '[FAIL]'}")
print(f"  bytes > 100:       {'[PASS]' if ok_bytes else '[FAIL]'}")
print(f"  elapsed < 6s:      {'[PASS]' if ok_quick else '[FAIL]'}")
print()
sys.exit(0 if (ok_exit and ok_bytes and ok_quick) else 1)
