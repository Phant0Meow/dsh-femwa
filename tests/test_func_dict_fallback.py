#!/usr/bin/env python3
"""本地零 token 验证 @func 字典宽容回退（battle.enemy_phase 返回 hp 字典给 out: hp）。"""
import sys, os
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tests"))
from conftest import run_script

script = """meta:
  session = new
vars:
  alive_party = [@knight, @mage, @player]
  hp = {@knight: 100, @mage: 80, @player: 100}
  enemy_hp = 150
  battle_round = 1
  damage_report = {}
code:
  battle = file:"utils/battle.py"
actors:
  ai @knight = soul:littlecat
  ai @mage = soul:AI助手
  human @player = soul:human, source:0
action ep @func(battle.enemy_phase):
  in: hp, alive_party, battle_round
  out: hp
action sd @func(battle.sum_damage):
  in: damage_report, enemy_hp
  out: enemy_hp
mainflow:
  [START] -> [EP]:ep -> [SD]:sd -> [END]
"""
events = run_script(script)
types = [e["event"] for e in events]
print("事件:", " -> ".join(types))
for e in events:
    if e["event"] in ("func_result", "assign_result", "flow_error"):
        print(" ", e["event"], str(e.get("data", {}))[:200])
errs = [e for e in events if e["event"] == "flow_error"]
print("PASS" if not errs and "flow_done" in types else "FAIL")
