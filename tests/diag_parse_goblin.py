#!/usr/bin/env python3
"""解析 goblin-demo.fems，打印节点/边/网关结构（零 LLM 调用）。"""
import sys, os
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.chdir(ROOT)  # parse_script 会写 debug_normalized_output.fems 到 CWD

from femCompiler.FEM_parser import parse_script

fems = open(os.path.join(ROOT, "python", "goblin-demo.fems"), encoding="utf-8").read()
script = parse_script(fems, base_dir=os.path.join(ROOT, "python"))

print("=== 节点 ===")
for nid, n in script.flow.nodes.items():
    meta = getattr(n, 'meta', None)
    extra = f" meta={meta}" if meta else ""
    print(f"  {nid!r} type={n.type} action={n.action_name}{extra}")

print("\n=== 边 ===")
for e in script.flow.edges:
    cond = f" cond={e.condition!r}" if getattr(e, 'condition', None) else ""
    print(f"  {e.source!r} -> {e.target!r}{cond}")

print("\n=== 动作 ===")
for name, ad in script.actions.items():
    print(f"  {name}: outs={[(o.var_name, o.out_type.name) for o in getattr(ad, 'outs', [])]}")

print("\n=== 模块 ===")
for name, mod in script.modules.items():
    if getattr(mod, 'flow', None) and mod.flow.nodes:
        print(f"  {name}: nodes={list(mod.flow.nodes.keys())} edges={len(mod.flow.edges)}")
    else:
        print(f"  {name}: NO FLOW")
