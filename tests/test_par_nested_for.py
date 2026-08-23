"""par 嵌套 for 支持情况记录（2026-08-18 斯坦福小镇示例设计调研）。

结论：
- 解析支持：_process_nested_control_block 递归处理嵌套控制块（[pf] -> for ... 格式）；
- 运行时【不支持】：_run_par_fork 的 join 查找沿边 BFS 遇到嵌套 for 网关后找不到
  join（L1725-1747），回退普通 fork → 分支变量（place）丢失 → for 空转 0 次执行。
- 替代结构：par 直接遍历角色 + 分支内 if 按条件选 action（见 test_par_if_dispatch.py）。
若引擎修复嵌套支持，本文件第二个测试应更新为断言实际执行次数。
"""
import pytest

NESTED_FEMS = """meta:
  name = nested-par-for
  session = new
actors:
  ai @a = soul:the1stlittlesoul
  ai @b = soul:littlecat
vars:
  g1 = [@a]
  g2 = [@b]
action act @ai(@speaker):
  prompt: hi
mainflow:
  [START] -> par place in [g1, g2]:
    [pf] -> for @speaker in place:
      -> act ->
    ->
  -> [END]
"""


class TestParNestedFor:
    def test_par_nested_for_parses(self):
        """解析层支持嵌套（[节点] -> for 格式）。"""
        from femCompiler.FEM_parser import parse_script
        script = parse_script(NESTED_FEMS, base_dir=".")
        assert "act" in script.actions

    def test_par_nested_for_runtime_noop(self, run_events):
        """运行时限制：嵌套 for 分支空转（join 查找失败 → 普通 fork → 变量丢失）。
        引擎修复前保持此行为；修复后更新此断言。"""
        events = run_events(NESTED_FEMS, timeout=15)
        starts = [e for e in events if e["event"] == "node_start"]
        assert len(starts) == 0, \
            f"当前引擎嵌套 for 不应执行任何节点: {[e['event'] for e in events]}"
