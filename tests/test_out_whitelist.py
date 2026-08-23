"""AI 赋值 out 白名单校验测试（2026-08-18 用户需求：防 AI 幻觉乱赋值）。

用户原话："要写out的，必须写out。为了防止ai幻觉乱赋值"。
实现：_extract_ai_assignments 加 out_whitelist 参数——赋值变量不在 out 声明范围
→ FEMVariableError → assign_errors（走"不保存+反馈重试"通道，不直接炸）。
"""
import pytest

from femCompiler.FEM_runtime import FEMRunner, FEMVariableError


def make_runner():
    """裸构造 FEMRunner（不跑 __init__）：白名单拦截路径只用到
    _parse_single_assignment，不触 vm / eval_expr / LLM。"""
    return FEMRunner.__new__(FEMRunner)


class TestOutWhitelist:
    def test_rejects_out_of_whitelist(self):
        """赋值变量不在 out 白名单 → assign_errors（含变量名与 out 清单）。"""
        rt = make_runner()
        _, errors = rt._extract_ai_assignments(
            'SET VARIABLE: <<done = true>>', {'agree'})
        assert len(errors) == 1
        assert "'done'" in errors[0] and "不在本节点的 out 声明范围内" in errors[0]
        assert "agree" in errors[0]

    def test_rejects_when_whitelist_empty(self):
        """out 无声明（空白名单）→ 任何赋值都拒绝（严格模式）。"""
        rt = make_runner()
        _, errors = rt._extract_ai_assignments(
            'SET VARIABLE: <<score = 1>>', set())
        assert len(errors) == 1
        assert "out 只声明了: 无" in errors[0]

    def test_accepts_in_whitelist(self):
        """赋值变量在 out 白名单 → 不报错（走正常赋值；此处无 vm 会抛别的错，
        只需确认不是白名单拦截——用 add/remove 触发 eval_expr 前的 apply_assign 报错？）
        改为：在名单内时白名单校验放行，用 mock vm 验证 apply_assign 被调用。"""
        from types import SimpleNamespace
        calls = []
        rt = make_runner()
        rt.vm = SimpleNamespace()
        rt.vm.get = lambda _v: None
        rt.eval_expr = lambda v: v
        # apply_assign 是模块级函数，patch 到模块
        import femCompiler.FEM_runtime as mod
        orig = mod.apply_assign
        mod.apply_assign = lambda vm, name, intent: calls.append((name, intent))
        try:
            _, errors = rt._extract_ai_assignments(
                'SET VARIABLE: <<agree = true>>', {'agree'})
            assert errors == []
            assert calls and calls[0][0] == 'agree'
        finally:
            mod.apply_assign = orig

    def test_no_whitelist_preserves_old_behavior(self):
        """out_whitelist=None（未启用校验）→ 白名单不拦截；
        未声明变量仍由 vm 报 FEMVariableError（原行为，进 assign_errors）。"""
        rt = make_runner()

        class FakeVM:
            def __init__(self):
                self.called = False

            def set(self, path, _value, local=False):
                self.called = True
                raise FEMVariableError(f"变量 '{path}' 未声明，无法赋值。请在 vars: 中预先声明。")

            def get(self, _path):
                return None

        vm = FakeVM()
        rt.vm = vm
        rt.eval_expr = lambda v: v
        _, errors = rt._extract_ai_assignments('SET VARIABLE: <<x = 1>>', None)
        assert vm.called, "无白名单时应走到 apply_assign（vm.set）"
        assert errors and "未声明" in errors[0]
