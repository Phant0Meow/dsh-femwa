"""flow 引用校验测试（2026-08-18）。

用户指出：`已知action -> 不认识`（裸名引用未声明 action）应编译报错；
`已知action -> [不认识]`（方括号空节点）合法。
根因：标准化器把任意裸 token 无条件替换成 [节点] 绑定（不校验声明），
解析器原先的裸名报错永远没机会触发——本测试覆盖解析器兜底校验。
"""
import pytest

from femCompiler.FEM_parser import parse_script


BASE = """meta:
  name = ref-check
  session = new
actors:
  ai @a = soul:1
action act @ai(@a):
  prompt: hi
"""


class TestFlowRefValidation:
    def test_bare_unknown_action_rejected(self):
        """裸名引用未声明 action → 编译报错（带节点名与提示）。"""
        fems = BASE + """mainflow:
  [START] -> act -> no_such_action -> [END]
"""
        with pytest.raises(SyntaxError) as ei:
            parse_script(fems, base_dir=".")
        assert "no_such_action" in str(ei.value)
        assert "未声明的动作" in str(ei.value)

    def test_bracket_empty_node_allowed(self):
        """方括号空节点（[不认识]）合法——不绑定动作。"""
        fems = BASE + """mainflow:
  [START] -> act -> [不认识] -> [END]
"""
        script = parse_script(fems, base_dir=".")
        assert "act" in script.actions

    def test_bare_known_action_ok(self):
        """裸名引用已声明 action → 正常。"""
        fems = BASE + """mainflow:
  [START] -> act -> [END]
"""
        script = parse_script(fems, base_dir=".")
        assert "act" in script.actions

    def test_unknown_module_ref_rejected(self):
        """裸名引用未声明 module → 编译报错。"""
        fems = BASE + """mainflow:
  [START] -> &no_such_module -> [END]
"""
        with pytest.raises(SyntaxError) as ei:
            parse_script(fems, base_dir=".")
        assert "no_such_module" in str(ei.value)

    def test_module_flow_unknown_action_rejected(self):
        """模块 flow 内裸名引用未声明 action → 编译报错（尾部统一校验）。"""
        fems = BASE + """module M:
  action inner @ai(@a):
    prompt: hi
  flow:
    [IN] -> inner -> ghost_action -> [OUT]

mainflow:
  [START] -> &M -> [END]
"""
        with pytest.raises(SyntaxError) as ei:
            parse_script(fems, base_dir=".")
        assert "ghost_action" in str(ei.value)

    def test_module_flow_valid_ok(self):
        """模块 flow 引用模块内 action + 嵌套 module → 正常。"""
        fems = BASE + """module Sub:
  action sub_act @ai(@a):
    prompt: hi
  flow:
    [IN] -> sub_act -> [OUT]

module M:
  action inner @ai(@a):
    prompt: hi
  flow:
    [IN] -> inner -> &Sub -> [OUT]

mainflow:
  [START] -> &M -> [END]
"""
        script = parse_script(fems, base_dir=".")
        assert "M" in script.modules and "Sub" in script.modules
