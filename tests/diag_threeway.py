#!/usr/bin/env python3
"""三向对照实测：验证文档 vs 引擎实现的关键疑点（零 LLM）。"""
import sys, os, json
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.chdir(ROOT)

from femCompiler.FEM_parser import parse_script
from femCompiler.FEM_normalizer import FEMNormalizer

PY = os.path.join(ROOT, "python")

def parse(text, name="<inline>"):
    return parse_script(text, base_dir=PY)

def section(title):
    print(f"\n{'='*60}\n{title}\n{'='*60}")

# ── 1. 中文 action 名 / actor 名 ──
section("1. 中文 action 名 / @actor 名")
try:
    s = parse("""meta:
  session = new
actors:
  ai @队长 = soul:1
action 开场白 @ai(@队长):
  prompt: "你好"
mainflow:
  [START] -> [开场] -> [END]
  [开场]: 开场白
""")
    print("✅ 中文 action 名解析成功")
except Exception as e:
    print(f"❌ 中文 action 名报错: {type(e).__name__}: {e}")

# ── 2. 中文节点定义（normalizer 提取）──
section("2. 中文节点定义绑定")
text = """meta:
  session = new
actors:
  ai @队长 = soul:1
action 开场白 @ai(@队长):
  prompt: "你好"
mainflow:
  [开场]: 开场白
  [START] -> [开场] -> [END]
"""
try:
    norm = FEMNormalizer().normalize(text)
    print("normalizer 输出:")
    print(norm)
    s = parse(text)
    opening = s.flow.nodes.get("[开场]")
    print(f"[开场] 节点: action_name={getattr(opening, 'action_name', None)}")
    if getattr(opening, 'action_name', None) is None:
        print("❌ 中文节点绑定丢失（normalizer 未提取 [开场]: 开场白）")
    else:
        print("✅ 中文节点绑定保留")
except Exception as e:
    print(f"❌ 解析报错: {type(e).__name__}: {e}")

# ── 3. 普通节点多出边（文档：mermaid 直接多分支=并行）──
section("3. 普通节点多出边（文档 776-787：不写 fork 也全通并行）")
multi = """meta:
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
s = parse(multi)
a_edges = [(e.target, e.condition) for e in s.flow.edges if e.source == "[A]"]
print(f"[A] 的出边: {a_edges}（解析层保留 2 条 ✓）")
# runtime 行为：跑一遍看 count
import subprocess, threading
sys.path.insert(0, os.path.join(ROOT, "tests"))
from conftest import run_script
events = run_script(multi)
types = [e["event"] for e in events]
assigns = [e["data"]["output"] for e in events if e["event"] == "assign_result"]
print(f"事件: {' -> '.join(types)}")
print(f"assign 结果: {assigns}")
b_ran = any(e["event"] == "node_start" and e["data"].get("node_name") == "[B]" for e in events)
c_ran = any(e["event"] == "node_start" and e["data"].get("node_name") == "[C]" for e in events)
if b_ran and c_ran:
    print("✅ 两条出边都执行了（并行/全通）")
elif b_ran and not c_ran:
    print("❌ 只走了第一条出边 [B]，第二条 [C] 未执行（文档说全通并行）")
else:
    print(f"❓ 结果意外: b={b_ran} c={c_ran}")

# ── 4. 顶层 flow: 块（文档 1005 行示例用 flow:）──
section("4. 顶层 flow: 块")
try:
    s = parse("""meta:
  session = new
vars:
  reply = ""
action speak @assign:
  out: reply = "hi"
flow:
  [START] -> speak -> [END]
""")
    print(f"✅ 顶层 flow: 解析成功，入口={s.flow.entry}，节点数={len(s.flow.nodes)}")
except Exception as e:
    print(f"❌ 顶层 flow: 报错: {type(e).__name__}: {e}")

# ── 5. test-if-fork-join 的 to 链 ──
section("5. join 的 to [DONE]:finish -> [END] 链")
s = parse(open(os.path.join(PY, "test-if-fork-join.fems"), encoding="utf-8").read())
done = s.flow.nodes.get("[DONE]")
print(f"[DONE] 节点: action_name={getattr(done, 'action_name', None)}")
print(f"[DONE] 出边: {[(e.target, e.condition) for e in s.flow.edges if e.source == '[DONE]']}")
print(f"END 入边: {[(e.source, e.condition) for e in s.flow.edges if e.target == '[END]']}")
if getattr(done, 'action_name', None) is None:
    print("❌ [DONE]:finish 绑定丢失（to 链只取了 [DONE]）")
else:
    print("✅ [DONE] 绑定保留")
end_in = [e.source for e in s.flow.edges if e.target == "[END]"]
if "[DONE]" in end_in:
    print("✅ [DONE] -> [END] 边存在")
else:
    print(f"❌ [DONE] -> [END] 边丢失（END 入边: {end_in}）")

# ── 6. prompt 内 # 剥离（用户规则：prompt 内豁免）──
section("6. prompt 多行文本内 #（用户拍板：应豁免）")
s = parse("""meta:
  session = new
vars:
  reply = ""
action speak @assign:
  out: reply = "x"
action talk @ai(@e):
  prompt: |
    这是 # 内容
    斜杠 // 也是内容
  scope: [@e]
actors:
  ai @e = soul:1
mainflow:
  [START] -> [T] -> [END]
  [T]: talk
""")
p = s.actions["talk"].prompt
print(f"prompt 实际: {p!r}")
if "#" in p and "//" in p:
    print("✅ prompt 内 # 和 // 保留")
else:
    print(f"❌ prompt 内注释被剥离: {p!r}")

# ── 7. vars 值里的 -- 替换 ──
section("7. vars 字符串值里的 --（文档 52：仅 flow 区替换）")
s = parse("""meta:
  session = new
vars:
  note = "a--b"
mainflow:
  [START] -> [END]
""")
print(f"note 值: {s.vars['note']!r}")
if s.vars["note"] == "a--b":
    print("✅ -- 未被替换")
else:
    print(f"❌ -- 被替换成 ->: {s.vars['note']!r}")

# ── 8. 中文模块名 ──
section("8. 中文模块名")
try:
    s = parse("""meta:
  session = new
module 战斗:
  flow:
    [IN] -> [OUT]
mainflow:
  [START] -> [M] -> [END]
  [M]: &战斗
""")
    print(f"✅ 中文模块名解析成功: {list(s.modules.keys())}")
except Exception as e:
    print(f"❌ 中文模块名报错: {type(e).__name__}: {e}")

# ── 9. 魔法注释 # for loop（特性已废弃：统一按普通注释剥离）──
section("9. 魔法注释 # for loop（已废弃，按普通注释剥离）")
text9 = """meta:
  session = new
vars:
  @m = ""
  members = [@a, @b]
  count = 0
actors:
  ai @a = soul:1
  ai @b = soul:2
action mark @assign:
  out: count += 1
mainflow:
  [START] -> [B] -> for @m in members:
    -> [C]:mark ->
  # for loop -> [C] while count < 2
  -> [END]
"""
norm9 = FEMNormalizer().normalize(text9)
if "# for loop" in norm9:
    print("❌ 魔法注释仍被保留（应剥掉）")
else:
    print("✅ 魔法注释已按普通注释剥离（引擎/femGen 行为一致）")
