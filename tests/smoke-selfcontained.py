import subprocess, sys, json, time
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
BRIDGE = r"D:\myFiles\dsh\dsh-femwa\python\femwa_bridge.py"
p = subprocess.Popen([sys.executable, BRIDGE, "--fe4m", r"D:\myFiles\dsh\dsh-femwa"],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    text=True, encoding="utf-8", errors="replace", bufsize=1)
def send(obj): p.stdin.write(json.dumps(obj) + "\n"); p.stdin.flush()
fems = open(r"D:\myFiles\dsh\dsh-femwa\python\test-minimal.fems", encoding="utf-8").read()
send({"id": 1, "cmd": "ping", "args": {}})
send({"id": 2, "cmd": "list_scripts", "args": {}})
send({"id": 3, "cmd": "run", "args": {"fems": fems, "base_dir": r"D:\myFiles\dsh\dsh-femwa\python"}})
time.sleep(6)
send({"id": 4, "cmd": "shutdown", "args": {}})
time.sleep(1)
p.stdin.close()
out, err = p.communicate(timeout=25)
print(out)
if err: print("STDERR:", err[:800])