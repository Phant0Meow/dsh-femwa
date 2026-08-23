"""par + 分支 if 分发验证（斯坦福小镇 mainflow 结构）。

结论记录（2026-08-18）：par 嵌套 for 解析通过但运行时分支空转
（_run_par_fork join 查找沿边 BFS 遇到嵌套 for 网关后找不到 join →
走普通 fork → 分支变量丢失）。替代结构 = par 直接遍历角色 +
分支内 if 按条件选 action（狼人杀 par @voter in alive 同款）。
"""
import pytest

PAR_IF_FEMS = """meta:
  name = par-if-dispatch
  session = new
actors:
  ai @a = soul:the1stlittlesoul
  ai @b = soul:littlecat
vars:
  location = {@a: "酒馆", @b: "公园"}
  居民 = [@a, @b]
action 酒馆闲聊 @ai(@speaker):
  prompt: hi
action 公园闲聊 @ai(@speaker):
  prompt: hi
mainflow:
  [START] -> par @speaker in 居民:
    -> if (location.@speaker == "酒馆") -> 酒馆闲聊 ->
    -> if (location.@speaker == "公园") -> 公园闲聊 ->
  -> [END]
"""


class TestParIfDispatch:
    def test_par_if_dispatch_parses(self):
        from femCompiler.FEM_parser import parse_script
        script = parse_script(PAR_IF_FEMS, base_dir=".")
        assert "酒馆闲聊" in script.actions and "公园闲聊" in script.actions

    def test_par_if_dispatch_runs_each_branch(self, run_events):
        """两个居民各自一条 par 分支，按 location 分发到对应闲聊 → 共 2 次 node_start。"""
        events = run_events(PAR_IF_FEMS, timeout=15)
        starts = [e for e in events if e["event"] == "node_start"]
        names = sorted((e["data"].get("node_name") or "").strip("[]") for e in starts)
        assert names == ["公园闲聊", "酒馆闲聊"], \
            f"par+if 应分发到两个闲聊: {[e['event'] for e in events]}"
        assert any(e["event"] == "flow_done" for e in events), \
            f"应正常跑完: {[e['event'] for e in events]}"
