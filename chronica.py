# -*- coding: utf-8 -*-
"""
chronica.py — 直查活体 Chronica.wor（femwa 运行台账 SQLite）。与 fem-chat.mjs 同族的剧场应急工具。

设计理念（2026-08-26 用户口述）：prompt 是教 AI 怎么说话，不属于对话流；
showprompt 属于剧本正经旁白，属于正经对话流的一部分。
因此本工具把台账拆成两幕呈现：
  【对话流】= showprompt 旁白 + AI 发言 + 人类输入（按时间线交织）；
  【幕后指令】= 节点 prompt（附录，非对话流）。
判别依据（dialog.user_id JSON）：femshow-* = 旁白；fems-* = 指令；其余 = 真人输入。

用法：
  python chronica.py                 # 最新场次的对话流 + 幕后指令附录
  python chronica.py 869             # 指定场次
  python chronica.py --list 5        # 最近 5 个场次一览（标题+调用数）
  python chronica.py 869 --scope     # 每行附带可见性信息（排查视野问题用）

WAL 只读连接（mode=ro），与运行中的引擎互不干扰；
无需复制副本（复制法是旧文件沙箱时代的绕路，已废弃）。
"""
import sqlite3, sys, json

DB = r"D:\myFiles\dsh\dsh-femwa\user_data\memory\Chronica.wor"
URI = f"file:{DB.replace(chr(92), '/')}?mode=ro"

def _scopes(raw):
    if not raw:
        return ""
    try:
        arr = json.loads(raw)
        return ",".join(str(x) for x in arr) if isinstance(arr, list) else str(raw)
    except Exception:
        return str(raw)

def _classify(user_id_raw):
    """dialog.user_id 判别行性质：femshow-*=旁白 / fems-*=指令 / 其余=真人输入。"""
    try:
        arr = json.loads(user_id_raw)
        first = str(arr[0]) if isinstance(arr, list) and arr else ""
    except Exception:
        first = str(user_id_raw)
    if first.startswith("femshow"):
        return "narration"
    if first.startswith("fems"):
        return "directive"
    return "human"

def _clip(text, n):
    return str(text).replace("\n", " ")[:n]

def main():
    args = sys.argv[1:]
    show_scope = "--scope" in args
    args = [a for a in args if a != "--scope"]

    conn = sqlite3.connect(URI, uri=True, timeout=3)
    cur = conn.cursor()

    if "--list" in args:
        n = int(args[args.index("--list") + 1]) if len(args) > args.index("--list") + 1 else 8
        rows = cur.execute(
            "SELECT s.session_id, s.title, "
            "(SELECT COUNT(*) FROM react_steps r WHERE r.session_id = s.session_id), "
            "(SELECT COUNT(*) FROM dialog d WHERE d.session_id = s.session_id) "
            "FROM sessions s ORDER BY s.session_id DESC LIMIT ?", (n,)
        ).fetchall()
        print(f"最近 {len(rows)} 场：")
        for sid, title, ai_n, dia_n in reversed(rows):
            print(f"  [{sid}] 《{title}》 AI发言={ai_n} 台账行={dia_n}")
        return

    sid = int(args[0]) if args and args[0].isdigit() else cur.execute("SELECT MAX(session_id) FROM sessions").fetchone()[0]
    row = cur.execute("SELECT title FROM sessions WHERE session_id=?", (sid,)).fetchone()
    if row is None:
        print(f"场次 {sid} 不存在"); return
    tag = "（含 scope）" if show_scope else ""
    print(f"=== 场次 {sid}《{row[0]}》{tag} ===")

    # ── 收集两表事件，统一按时间排序 ──
    events = []  # (timestamp, kind, turn_id, text, user_scope, soul_scope)
    for ts, tid, uid, p, us, ss in cur.execute(
        "SELECT timestamp, turn_id, user_id, user_prompt, user_scope, soul_scope "
        "FROM dialog WHERE session_id=? ORDER BY id", (sid,)
    ):
        events.append((ts or 0, _classify(uid), tid, str(p), us, ss))
    for ts, tid, soul, resp, us, ss in cur.execute(
        "SELECT timestamp, turn_id, soul_id, response, user_scope, soul_scope "
        "FROM react_steps WHERE session_id=? ORDER BY id", (sid,)
    ):
        events.append((ts or 0, "ai", tid, f"{soul}: {resp}", us, ss))
    events.sort(key=lambda e: e[0])

    # ── 第一幕：对话流（旁白 / AI / 人类）──
    print("\n─── 对话流 ───")
    for ts, kind, tid, text, us, ss in events:
        if kind == "directive":
            continue
        who = {"narration": "旁白", "ai": "AI", "human": "人类"}[kind]
        line = f"  [{who}] {_clip(text, 110)}"
        if show_scope:
            line += f"\n        可见用户={_scopes(us)} 可见角色={_scopes(ss)}"
        print(line)

    # ── 第二幕：幕后指令（prompt，非对话流）──
    directives = [e for e in events if e[1] == "directive"]
    print(f"\n─── 幕后指令（prompt × {len(directives)}，不属对话流）───")
    for ts, kind, tid, text, us, ss in directives:
        line = f"  t{tid}: {_clip(text, 90)}"
        if show_scope:
            line += f"\n        可见用户={_scopes(us)} 可见角色={_scopes(ss)}"
        print(line)
    conn.close()

if __name__ == "__main__":
    main()
