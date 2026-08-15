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
