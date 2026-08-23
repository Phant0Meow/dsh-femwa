"""todo #2：code/memory/context 的 file: 地址解析规则测试。

规则（用户拍板）：
- 绝对路径 → 直接支持（无脑）
- 相对路径 → 相对剧本文件所在目录（base_dir）解析
- 未保存（base_dir 为空）→ 相对路径报错
- func_code 默认位置已取消
"""
import os

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PYTHON_DIR = os.path.join(ROOT, "python")
if ROOT not in __import__("sys").path:
    __import__("sys").path.insert(0, ROOT)

from femCompiler.FEM_runtime import PythonBridge  # noqa: E402
from femCompiler.block_collector import _load_file_or_text  # noqa: E402


# ── PythonBridge（code: 区 file: 解析） ────────────────────────────────────

def test_bridge_absolute_path_works():
    """绝对路径：直接加载，与 base_dir 无关。"""
    helper = os.path.join(PYTHON_DIR, "mt_test", "file_a.py")
    bridge = PythonBridge(base_dir="")  # 未保存态
    mod = bridge.load("helper", helper)
    assert mod is not None
    assert bridge.has("helper.add")


def test_bridge_relative_resolves_against_script_dir():
    """相对路径：相对剧本文件所在目录（base_dir）。"""
    bridge = PythonBridge(base_dir=os.path.join(PYTHON_DIR, "mt_test"))
    mod = bridge.load("helper", "file_a.py")
    assert bridge.has("helper.add")


def test_bridge_relative_unsaved_raises():
    """未保存（base_dir 空）：相对路径报错，提示导出/绝对路径。"""
    bridge = PythonBridge(base_dir="")
    with pytest.raises(FileNotFoundError, match="剧本未保存"):
        bridge.load("helper", "file_a.py")


def test_bridge_no_func_code_fallback():
    """func_code 默认位置已取消：相对路径不再回退 func_code 目录。"""
    bridge = PythonBridge(base_dir=os.path.join(PYTHON_DIR, "mt_test"))
    with pytest.raises(FileNotFoundError, match="文件不存在"):
        bridge.load("nope", "definitely_missing_module.py")


# ── _load_file_or_text（meta 区 file: 解析） ───────────────────────────────

def test_load_file_absolute():
    """绝对路径直接读。"""
    helper = os.path.join(PYTHON_DIR, "mt_test", "file_a.py")
    content = _load_file_or_text(f'file:"{helper}"', base_dir="")
    assert "file_a" in content


def test_load_file_relative_script_dir():
    """相对路径基于剧本目录。"""
    content = _load_file_or_text('file:"file_a.py"', base_dir=os.path.join(PYTHON_DIR, "mt_test"))
    assert "file_a" in content


def test_load_file_relative_unsaved_raises():
    """未保存（base_dir 空）：相对路径报错。"""
    with pytest.raises(FileNotFoundError, match="剧本未保存"):
        _load_file_or_text('file:"file_a.py"', base_dir="")


def test_load_file_literal_untouched():
    """纯文本/字面量不受影响。"""
    assert _load_file_or_text("hello world", base_dir="") == "hello world"
    assert _load_file_or_text('"quoted"', base_dir="") == "quoted"


# ── 端到端：bridge run 传空 base_dir（未保存态） → flow_error ─────────────

def test_unsaved_relative_script_fails_via_bridge(run_events):
    """未保存态（base_dir=""）跑含相对 file: 的剧本 → flow_error 且提示。"""
    fems = (
        'meta:\n  name = rel-unsaved\n'
        'code:\n  helper = file:"mt_test/file_a.py"\n'
        'mainflow:\n  [START] -> [END]\n'
    )
    events = run_events(fems, base_dir="")
    errs = [e["data"].get("error", "") for e in events if e["event"] == "flow_error"]
    assert errs, "应产生 flow_error"
    assert "剧本未保存" in errs[0], errs[0]


def test_saved_relative_script_runs_via_bridge(run_events):
    """已保存态（base_dir=python 目录）跑相对 file: 剧本 → 正常跑完。"""
    fems = (
        'meta:\n  name = rel-saved\n'
        'code:\n  helper = file:"mt_test/file_a.py"\n'
        'mainflow:\n  [START] -> [END]\n'
    )
    events = run_events(fems, base_dir=PYTHON_DIR)
    assert any(e["event"] == "flow_done" for e in events), [e["event"] for e in events]
