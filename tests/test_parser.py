"""解析器单元测试：FEM_parser 直接 import，零进程、零 token。"""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from femCompiler.FEM_parser import parse_script, _parse_out_multi, OutType
from femCompiler.FEM_parser import OutDef

PY = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "python")


def load(name):
    with open(os.path.join(PY, name), encoding="utf-8") as f:
        return parse_script(f.read(), base_dir=PY)


# ── out 语法解析 ───────────────────────────────────────────

class TestParseOutMulti:
    def test_dropdown_form(self):
        outs = _parse_out_multi(
            'player_choice(dropdown, choices={["接受", "拒绝"]}, label="是否接受委托")'
        )
        assert len(outs) == 1
        od = outs[0]
        assert od.var_name == "player_choice"
        assert od.out_type == OutType.DROPDOWN
        assert od.choices is not None and "接受" in od.choices
        assert od.label == "是否接受委托"

    def test_assign_form(self):
        outs = _parse_out_multi("refuse_count += 1")
        assert len(outs) == 1
        assert outs[0].out_type == OutType.ASSIGN
        assert outs[0].var_name == "refuse_count += 1"

    def test_plain_var(self):
        outs = _parse_out_multi("reply")
        assert len(outs) == 1
        assert outs[0].var_name == "reply"
        assert outs[0].out_type == OutType.STRING


# ── vars 解析：循环变量保留 @ 前缀 ──────────────────────────

class TestParseVars:
    def test_at_prefixed_loop_var_kept(self):
        script = load("for-repro-declare.fems")
        assert "@hero" in script.vars

    def test_plain_vars(self):
        script = load("goblin-mini.fems")
        assert script.vars["player_choice"] == "接受"
        assert "alive_party" in script.vars


# ── goblin 图结构 ──────────────────────────────────────────

class TestGoblinStructure:
    @pytest.fixture(scope="class")
    def goblin(self):
        return load("goblin-demo.fems")

    def test_nodes(self, goblin):
        ids = set(goblin.flow.nodes)
        for nid in ("[START]", "[opening]", "[ASK]", "[B1]", "[GO]", "[WIN]",
                    "[FAREWELL]", "[END]", "[L]", "[LP]", "[NO]", "[NO2]"):
            assert nid in ids, f"缺少节点 {nid}"

    def test_fork_gateway(self, goblin):
        fork = goblin.flow.nodes["__fork_1__"]
        assert fork.type == "gateway"
        assert fork.meta.get("gw_kind") == "fork"

    def test_fork_conditional_edges(self, goblin):
        edges = {(e.source, e.target): e.condition
                 for e in goblin.flow.edges if e.source == "__fork_1__"}
        assert edges["__fork_1__", "[GO]"] == 'player_choice == "接受"'
        assert "refuse_count < 2" in edges["__fork_1__", "[NO]"]
        assert "refuse_count >= 2" in edges["__fork_1__", "[NO2]"]

    def test_for_gateway_meta(self, goblin):
        for_gw = goblin.flow.nodes["__for_2__"]
        assert for_gw.type == "gateway"
        assert for_gw.meta["gw_kind"] == "for"
        assert for_gw.meta["var_name"] == "@hero"
        assert for_gw.meta["iterable"] == "alive_party"

    def test_for_back_edges_and_exit(self, goblin):
        back = {(e.source, e.target) for e in goblin.flow.edges
                if e.target == "__for_2__"}
        assert ("[L]", "__for_2__") in back
        assert ("[LP]", "__for_2__") in back
        # 出口：无条件边到 [FAREWELL]
        exit_edges = [e for e in goblin.flow.edges
                      if e.source == "__for_2__" and not e.condition]
        assert [e.target for e in exit_edges] == ["[FAREWELL]"]

    def test_module_empty_flow_ok(self, goblin):
        mod = goblin.modules["BattleRound"]
        assert mod.flow is not None
        assert len(mod.flow.nodes) == 0  # 空 module 不崩

    def test_actions(self, goblin):
        assert goblin.actions["accept_quest"].outs[0].var_name == "player_choice"
        # loot_share 是 @ai(@hero)：执行器参数为循环变量 @hero
        assert goblin.actions["loot_share"].executor_param == "@hero"
        assert goblin.actions["count_refuse"].outs[0].out_type == OutType.ASSIGN

    def test_out_continuation_lines(self):
        """单行 out 后的缩进续行必须合并（out: x += 1 后接 y = {} 两行都生效）。"""
        script = load("goblin-v2.fems")
        ru = script.modules["BattleRound"].actions["round_up"]
        assert len(ru.outs) == 2, f"round_up 应有 2 个 out（含续行），实际 {len(ru.outs)}"
        names = [o.var_name for o in ru.outs]
        assert any("battle_round" in n for n in names), f"缺少 battle_round: {names}"
        assert any("damage_report" in n for n in names), f"续行 damage_report 未合并: {names}"

    def test_join_to_chain(self):
        """join 的 to [X]:ref -> [Y] 链：绑定保留 + 尾边存在。"""
        script = load("test-if-fork-join.fems")
        done = script.flow.nodes.get("[DONE]")
        assert done is not None
        assert done.action_name == "finish", f"[DONE] 绑定应保留 finish: {getattr(done, 'action_name', None)}"
        assert any(e.source == "[DONE]" and e.target == "[END]" for e in script.flow.edges), \
            "[DONE] -> [END] 边应存在"

    def test_prompt_comment_exempt(self):
        """prompt 多行块内 # 和 // 是内容，注释剥离必须豁免。"""
        script = load("goblin-v2.fems")
        p = script.actions["opening"].prompt
        assert "哥布林" in p  # 正常内容
        # 构造一个 prompt 内含 # // 的剧本验证豁免
        from femCompiler.FEM_parser import parse_script
        text = """meta:
  session = new
vars:
  reply = ""
action talk @assign:
  out: reply = "x"
action speak @ai(@e):
  prompt: |
    这是 # 内容
    斜杠 // 也是内容
  scope: [@e]
actors:
  ai @e = soul:1
mainflow:
  [START] -> [T] -> [END]
  [T]: speak
"""
        s = parse_script(text, base_dir=PY)
        p2 = s.actions["speak"].prompt
        assert "#" in p2 and "//" in p2, f"prompt 内注释被剥离: {p2!r}"

    def test_double_dash_only_in_flow(self):
        """-- 只在 flow/mainflow 区等价 ->；vars 字符串值里必须保留。"""
        script = load("for-repro-declare.fems") if False else None
        from femCompiler.FEM_parser import parse_script
        text = """meta:
  session = new
vars:
  note = "a--b"
mainflow:
  [START] -- [END]
"""
        s = parse_script(text, base_dir=PY)
        assert s.vars["note"] == "a--b", f"-- 被替换: {s.vars['note']!r}"
        # flow 区 -- 应等价 ->（[START] -> [END] 连通）
        assert any(e.source == "[START]" and e.target == "[END]" for e in s.flow.edges)

    def test_goblin_v2_engine_parse(self):
        """goblin-v2（4 空格缩进 + 裸 &module + for 出口链）引擎解析完整性。
        回归保护：normalizer min_indent 初始值 bug（4 空格缩进剧本流程行全丢）
        与 &module 裸引用 bug（\b 边界不覆盖 &）。"""
        script = load("goblin-v2.fems")
        # 主流程完整
        assert "[START]" in script.flow.nodes, "[START] 丢失（min_indent bug）"
        assert "[END]" in script.flow.nodes
        fw = script.flow.nodes.get("[FAREWELL]")
        assert fw is not None and fw.action_name == "farewell"
        assert any(e.source == "[FAREWELL]" and e.target == "[END]" for e in script.flow.edges), \
            "for 出口链 [FAREWELL] -> [END] 边丢失"
        # 裸 &module 引用
        br = script.flow.nodes.get("[BattleRound]")
        assert br is not None and br.module_ref == "BattleRound", \
            f"&BattleRound 引用错误: {getattr(br, 'module_ref', None)}"
        # module flow 完整
        mod = script.modules.get("BattleRound")
        assert mod is not None and mod.flow is not None
        assert len(mod.flow.nodes) >= 10, f"module flow 节点缺失: {len(mod.flow.nodes)}"
        # 模块内 par + fork 网关
        gw = [n for n in mod.flow.nodes.values() if n.type == "gateway"]
        assert any(n.meta.get("is_par_fork") for n in gw), "module 内 par 网关缺失"
        assert any(n.meta.get("gw_kind") == "fork" and not n.meta.get("is_par_fork") for n in gw), \
            "module 内 fork 网关缺失"


# ── 语法测试剧本（引擎真实语法）──────────────────────────────

class TestSyntaxScripts:
    def test_if_fork_join(self):
        script = load("test-if-fork-join.fems")
        # join 网关存在
        join_nodes = [n for n in script.flow.nodes.values()
                      if n.type == "gateway" and n.meta.get("gw_kind") == "join"]
        assert len(join_nodes) >= 1

    def test_for_if(self):
        script = load("test-for-if.fems")
        for_gws = [n for n in script.flow.nodes.values()
                   if n.type == "gateway" and n.meta.get("gw_kind") == "for"]
        assert len(for_gws) == 1
        assert for_gws[0].meta["var_name"] == "@m"

    def test_par(self):
        script = load("test-par.fems")
        # par 展开为 par_fork 网关（gw_kind=fork + is_par_fork + par_var）
        par_forks = [n for n in script.flow.nodes.values()
                     if n.type == "gateway" and n.meta.get("is_par_fork")]
        assert len(par_forks) == 1
        assert par_forks[0].meta["par_var"] == "@w"
        assert par_forks[0].meta["par_iterable"] == "workers"
