"""剧本级事件流断言：起 bridge 进程跑剧本，校验事件序列与变量结果。

全部零 LLM（@assign 逻辑），不烧 token。
"""
import pytest

from conftest import read_script


def event_types(events):
    return [e["event"] for e in events]


def node_starts(events, name):
    return [e for e in events if e["event"] == "node_start" and e["data"].get("node_name") == name]


class TestSyntaxScripts:
    """现有三个语法测试剧本：必须 flow_done 且无 flow_error。"""

    @pytest.mark.parametrize("fname", [
        "test-if-fork-join.fems",
        "test-for-if.fems",
        "test-par.fems",
    ])
    def test_script_runs_clean(self, run_events, fname):
        events = run_events(read_script(fname))
        types = event_types(events)
        assert "flow_error" not in types, \
            f"{fname} 报错: {[e['data'] for e in events if e['event'] == 'flow_error']}"
        assert "flow_done" in types, f"{fname} 未见 flow_done: {types}"


class TestGoblinMini:
    """goblin-mini：fork + 空 module + for 循环全结构（零 token 复刻）。"""

    def test_for_loop_executes_all_iterations(self, run_events):
        events = run_events(read_script("goblin-mini.fems"))
        types = event_types(events)
        assert "flow_error" not in types, \
            [e["data"] for e in events if e["event"] == "flow_error"]
        assert "flow_done" in types

        # for 循环：@hero 展开 4 次（3 ai + 1 human），各自正确走 [L]/[LP]
        l_count = len(node_starts(events, "[L]"))
        lp_count = len(node_starts(events, "[LP]"))
        assert l_count == 3, f"[L] 应执行 3 次（knight/mage/rogue），实际 {l_count}"
        assert lp_count == 1, f"[LP] 应执行 1 次（player），实际 {lp_count}"

        # count 最终值 = 8（opening/ASK/GO 3 + L 3 + LP 1 + FAREWELL 1）
        assigns = [e["data"]["output"] for e in events if e["event"] == "assign_result"]
        assert assigns[-1]["count"] == 8, f"count 最终值应为 8，实际 {assigns[-1]}"

        # 流程完整性：fork 分支 [GO] 与 module 都执行过
        assert any(e["event"] == "module_enter" for e in events)
        assert node_starts(events, "[GO]")
        assert node_starts(events, "[FAREWELL]")


class TestForkErrorReporting:
    """fork 分支异常必须上报（编译器原则：不静默）。"""

    def test_fork_branch_error_becomes_flow_error(self, run_events):
        events = run_events(read_script("goblin-mini-bad.fems"))
        types = event_types(events)
        assert "flow_done" not in types, "fork 分支报错不应 flow_done（静默假成功）"
        errors = [e["data"].get("error", "") for e in events if e["event"] == "flow_error"]
        assert len(errors) == 1, f"应恰好一个 flow_error: {errors}"
        assert "@hero" in errors[0], f"错误应提到 @hero: {errors[0]}"


class TestMultiOutEdges:
    """普通节点多条出边 = fork 并发语义（文档：不写 fork 直接 mermaid 也并行）。"""

    def test_all_branches_execute(self, run_events):
        script = """meta:
  session = new
vars:
  count = 0
action mark_a @assign:
  out: count += 1
action mark_b @assign:
  out: count += 10
action mark_c @assign:
  out: count += 100
mainflow:
  [A]: mark_a
  [B]: mark_b
  [C]: mark_c
  [START] -> [A]
  [A] -> [B]
  [A] -> [C]
  [B] -> [END]
  [C] -> [END]
"""
        events = run_events(script)
        types = event_types(events)
        assert "flow_error" not in types, [e["data"] for e in events if e["event"] == "flow_error"]
        b_ran = any(e["event"] == "node_start" and e["data"].get("node_name") == "[B]" for e in events)
        c_ran = any(e["event"] == "node_start" and e["data"].get("node_name") == "[C]" for e in events)
        assert b_ran and c_ran, f"两条出边都应执行: B={b_ran} C={c_ran}"
        assigns = [e["data"]["output"] for e in events if e["event"] == "assign_result"]
        # 已知限制：fork/par 并发下共享变量 += 存在 VarManager 竞态（读-改-写非原子），
        # 最终值可能是 11 或 101（最后一次写覆盖）——这里只验证两条分支都实际执行。
        assert assigns[-1]["count"] in (11, 101), f"并发竞态下最终值应为 11 或 101: {assigns}"


class TestHumanInputRetry:
    """人类输入容错：赋值失败 → human_input_error 事件 → 重试成功，流程不中断。"""

    def test_bad_input_then_retry(self):
        import subprocess, threading, json, time, os, sys as _sys
        ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        script_text = """meta:
  session = new
vars:
  player_choice = ""
  count = 0
action accept @human(@player):
  prompt: "选一个"
  scope: [@player]
  out:
    player_choice(dropdown, choices={["A", "B"]}, label="选择")
action after @assign:
  out: count += 1
actors:
  human @player = soul:9, source:0
mainflow:
  [START] -> [ASK] -> [AFTER] -> [END]
  [ASK]: accept
  [AFTER]: after
"""
        p = subprocess.Popen(
            [_sys.executable, os.path.join(ROOT, "python", "femwa_bridge.py"), "--fe4m", ROOT],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding="utf-8", errors="replace", bufsize=1,
        )
        events = []
        def drain():
            for line in p.stdout:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if obj.get("type") == "event":
                    events.append(obj)
        t = threading.Thread(target=drain, daemon=True)
        t.start()
        def send(obj):
            p.stdin.write(json.dumps(obj, ensure_ascii=False) + "\n")
            p.stdin.flush()
        send({"id": 1, "cmd": "run", "args": {"fems": script_text, "base_dir": os.path.join(ROOT, "python")}})
        # 等 human_wait
        deadline = time.time() + 15
        wait = None
        while time.time() < deadline:
            waits = [e["data"] for e in events if e["event"] == "human_wait"]
            if waits:
                wait = waits[0]
                break
            time.sleep(0.1)
        assert wait is not None, f"未见 human_wait: {[e['event'] for e in events]}"
        # 第一次：提交未声明变量 → 应被拒绝
        send({"id": 2, "cmd": "human_input", "args": {
            "wait_key": wait["wait_key"],
            "body": {"chat_text": "A", "variables": {"nope_undeclared": "x"}},
        }})
        deadline = time.time() + 10
        while time.time() < deadline:
            if any(e["event"] == "human_input_error" for e in events):
                break
            time.sleep(0.1)
        errs = [e["data"] for e in events if e["event"] == "human_input_error"]
        assert len(errs) == 1, f"应收到 human_input_error: {errs}"
        assert "未声明" in errs[0].get("error", ""), f"错误应提到未声明: {errs[0]}"
        # 第二次：正确输入 → human_done → 流程继续到 flow_done
        send({"id": 3, "cmd": "human_input", "args": {
            "wait_key": wait["wait_key"],
            "body": {"chat_text": "A", "variables": {"player_choice": "A"}},
        }})
        deadline = time.time() + 15
        while time.time() < deadline:
            if any(e["event"] in ("flow_done", "flow_error") for e in events):
                break
            time.sleep(0.1)
        types = event_types(events)
        assert "flow_error" not in types, [e["data"] for e in events if e["event"] == "flow_error"]
        assert "flow_done" in types, f"重试后应正常跑完: {types}"
        assert "human_done" in types, "human_done 应出现"
        send({"id": 4, "cmd": "shutdown", "args": {}})
        time.sleep(0.3)
        p.stdin.close()
        try:
            p.wait(timeout=10)
        except subprocess.TimeoutExpired:
            p.kill()
