#!/usr/bin/env python3
"""跑 for-repro 两个对照剧本，检查 for 循环迭代行为（零 LLM）。"""
import subprocess, sys, json, time, os, threading

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BRIDGE = os.path.join(ROOT, "python", "femwa_bridge.py")

def run_script(fname):
    p = subprocess.Popen(
        [sys.executable, BRIDGE, "--fe4m", ROOT],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, encoding="utf-8", errors="replace", bufsize=1,
    )
    events = []
    done = threading.Event()
    def drain():
        try:
            for line in p.stdout:
                line = line.strip()
                if not line: continue
                try: obj = json.loads(line)
                except json.JSONDecodeError: continue
                if obj.get("type") == "event": events.append(obj)
        finally:
            done.set()
    t = threading.Thread(target=drain, daemon=True); t.start()
    def send(obj):
        p.stdin.write(json.dumps(obj, ensure_ascii=False) + "\n"); p.stdin.flush()
    fems = open(os.path.join(ROOT, "python", fname), encoding="utf-8").read()
    send({"id": 1, "cmd": "run", "args": {"fems": fems, "base_dir": os.path.join(ROOT, "python")}})
    deadline = time.time() + 20
    while time.time() < deadline:
        if any(e["event"] in ("flow_done", "flow_error", "bridge_run_ended") for e in events):
            break
        time.sleep(0.1)
    send({"id": 2, "cmd": "shutdown", "args": {}})
    time.sleep(0.3); p.stdin.close()
    try: p.wait(timeout=10)
    except subprocess.TimeoutExpired: p.kill()
    return events

for fname in ("for-repro-nodeclare.fems", "for-repro-declare.fems"):
    print(f"\n===== {fname} =====")
    events = run_script(fname)
    types = [e["event"] for e in events]
    print("事件序列:", " -> ".join(types))
    for e in events:
        ev = e["event"]
        if ev in ("flow_error", "node_enter", "assign_result"):
            print(f"  [{ev}] {json.dumps(e.get('data', {}), ensure_ascii=False)[:200]}")
