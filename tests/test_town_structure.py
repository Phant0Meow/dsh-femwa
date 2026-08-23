"""斯坦福小镇 mainflow 结构验证（2026-08-18 用户定稿版，hub+锚点结构）。

结构：START 经单边 hub 一次性 fork 各地点线（入口 [START] 本身不 fork，
必须经单边 hub 再分线）；每条线回自己的空节点锚点（不能回多出边节点：
每次回到多出边节点会从一变成多分支，分支数爆炸——编译期报错）。
线内 `if (@speaker.type == "ai")` 分流——AI 先随机等一会儿再闲聊，
human 直接闲聊。验证点：@speaker.type 在 if 条件中可求值（@actor 实体属性）；
par + type 分流 + @func 三件套在运行时结构成立（断言到 node_start 级别，
AI 无 key 会 FEMConfigError 全停，不影响结构断言）。
"""
import pytest

TOWN_STRUCT = """meta:
  name = town-structure
  session = new

code:
  WAIT = file:"random_wait_time.py"

actors:
  ai @a = soul:the1stlittlesoul
  ai @b = soul:littlecat
  human @h = soul:human, source:0

vars:
  在甲的人 = [@a, @h]
  在乙的人 = [@b]
  @speaker = ""
  _wait = 0

action 等 @func(WAIT.random_interval):
  out: _wait

action 甲聊 @mind(@speaker):
  prompt: hi
  scope: 在甲的人

action 乙聊 @mind(@speaker):
  prompt: hi
  scope: 在乙的人

mainflow:
  [START] -> [hub]
  [hub] -> [甲环] -> par @speaker in 在甲的人:
      -> if (@speaker.type == "ai") -> 等 -> 甲聊 ->
      -> if (@speaker.type == "human") -> 甲聊 ->
  -> [甲环]
  [hub] -> [乙环] -> par @speaker in 在乙的人:
      -> if (@speaker.type == "ai") -> 等 -> 乙聊 ->
  -> [乙环]
"""


class TestTownStructure:
    def test_town_structure_parses(self):
        from femCompiler.FEM_parser import parse_script
        script = parse_script(TOWN_STRUCT, base_dir=".")
        assert "甲聊" in script.actions and "乙聊" in script.actions

    def test_town_structure_dispatch_runs(self, run_events):
        """三条 par 线各自分发：AI 走 等→闲聊；human 走 闲聊。
        base_dir 指 examples/（random_wait_time.py 相对剧本目录解析）。
        断言：等 节点执行（@a/@b 两 AI）、甲聊/乙聊 node_start 出现。"""
        events = run_events(TOWN_STRUCT, base_dir='D:/myFiles/dsh/dsh-femwa/examples', timeout=15)
        starts = [e for e in events if e["event"] == "node_start"]
        names = [e["data"].get("node_name", "") for e in starts]
        # 等（@func 节点）应有执行（至少一个 AI 分支触发）
        assert any("等" in n for n in names), f"@func 等 应执行: {names}"
        assert any("甲聊" in n for n in names), f"甲聊 应出现: {names}"
        assert any("乙聊" in n for n in names), f"乙聊 应出现: {names}"
