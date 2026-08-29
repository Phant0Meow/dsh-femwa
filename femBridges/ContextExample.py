"""
bridges/ContextExample.py — 默认上下文提取实现
===============================================
从数据库提取当前 session 的对话上下文，排除当前 prompt。
代码原则：所有代码不许写try静默兜底不报错，有错必须报错。
"""

import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from femCompiler.db_utils import _get_conn
from femCompiler.FEM_scope_resolver import parse_scope_field, ids_match_scope
from typing import List, Optional, Dict, Any

# ── 上下文可见性开关（2026-08-29 转写分离配套）────────────────────────
# 拼接上下文时各类内容的可见性：self=发言者本人（行 soul_id == 提问者），
# other=同房间其他角色。改这里的 0/1 即全局生效，无需动拼装逻辑。
# 配套：react_steps 按 step 分行存储（cot/tool_call/tool_result 各归各位），
# 上游节点的思考不再混在 response 里泄漏给下游。
VISIBILITY = {
    "self":  {"cot": 1, "response": 1, "tool": 1},
    "other": {"cot": 0, "response": 1, "tool": 0},
}


def _get_records_visible_to(
    user_ids: List[str] = None,
    soul_ids: List[str] = None,
    session_id: int = None,
    include_ai: bool = True,
    max_turns: int = 20,
    offset: int = 0,
) -> List[Dict[str, Any]]:
    """获取指定 user 或 soul 可见的对话记录（仅当前 session）"""
    user_ids = user_ids or []
    soul_ids = soul_ids or []
    conn = _get_conn()
    results = []

    query = """
        SELECT session_id, turn_id, oratio_idx, user_prompt AS content,
               timestamp, user_id, soul_id, user_scope, soul_scope,
               'human' AS source
        FROM dialog
    """
    conditions = []
    params = []

    if session_id is not None:
        conditions.append("session_id = ?")
        params.append(session_id)

    if conditions:
        query += " WHERE " + " AND ".join(conditions)
    query += " ORDER BY session_id, turn_id, oratio_idx DESC"

    cursor = conn.execute(query, params)
    for row in cursor:
        user_scope = parse_scope_field(row["user_scope"] or "[]")
        soul_scope = parse_scope_field(row["soul_scope"] or "[]")
        # 无 user 无 soul（裸 actor）：不过滤——本 session 全部记录可见
        # （无角色设定 = 无隔离；有 user/soul 时行为不变）。
        no_filter = not user_ids and not soul_ids
        match_user = user_ids and ids_match_scope(user_scope, user_ids)
        match_soul = soul_ids and ids_match_scope(soul_scope, soul_ids)
        print(f"[ctx-dbg] dialog turn={row['turn_id']} src={row['source']} "
              f"u_scope={user_scope} s_scope={soul_scope} "
              f"ask_u={user_ids} ask_s={soul_ids} no_filter={no_filter} "
              f"match_user={match_user} match_soul={match_soul}")
        if no_filter or match_user or match_soul:
            results.append(dict(row))

    if include_ai:
        query2 = """
            SELECT session_id, turn_id, step_idx, response AS content,
                   timestamp, soul_id, user_scope, soul_scope,
                   cot, tool_call, tool_result,
                   'ai' AS source
            FROM react_steps
        """
        if conditions:
            query2 += " WHERE " + " AND ".join(conditions)
        query2 += " ORDER BY session_id, turn_id, step_idx DESC"

        cursor2 = conn.execute(query2, params)
        for row in cursor2:
            user_scope = parse_scope_field(row["user_scope"] or "[]")
            soul_scope = parse_scope_field(row["soul_scope"] or "[]")
            no_filter = not user_ids and not soul_ids
            match_user = user_ids and ids_match_scope(user_scope, user_ids)
            match_soul = soul_ids and ids_match_scope(soul_scope, soul_ids)
            print(f"[ctx-dbg] react turn={row['turn_id']} src={row['source']} "
                  f"u_scope={user_scope} s_scope={soul_scope} "
                  f"ask_u={user_ids} ask_s={soul_ids} no_filter={no_filter} "
                  f"match_user={match_user} match_soul={match_soul}")
            if no_filter or match_user or match_soul:
                results.append(dict(row))

    conn.close()

    # 按时间戳或 turn_id + idx 降序排列（最近的在前）
    results.sort(key=lambda r: (
        r.get("turn_id", 0),
        r.get("oratio_idx", 0) if r.get("source") == "human" else r.get("step_idx", 0)
    ), reverse=True)
    # 去重（2026-08-28 加固）：键加入 soul_id + user_id——不同角色/不同行种类的
    # 同号行不再互吃（旧键曾把出题与甲思考的 react 行 (turn1,step0) 判为重复，
    # 静默吞掉甲思考，导致甲亮答上下文丢前文）。撞键时不再静默丢行：全部保留
    # 并高声告警——历史台账存在旧竞态写入的同键行，硬报错会炸老场次回放，故
    # 选择"全保留+告警"；新引擎 turn 号由 _alloc_turn 独占分配，正常不会再撞。
    seen = set()
    unique = []
    for r in results:
        key = (r["session_id"], r["turn_id"],
               r.get("oratio_idx", -1) if r["source"] == "human" else r.get("step_idx", -1),
               r["source"], str(r.get("soul_id") or ""), str(r.get("user_id") or ""))
        if key in seen:
            print(f"[ctx-dbg] ⚠️ 台账同键重复行（保留不丢）: key={key} "
                  f"content={str(r.get('content', ''))[:60]!r}")
        else:
            seen.add(key)
        unique.append(r)
    # 截断到 max_turns
    return unique


def get_session_context(
    session_id: int,
    user_ids: List[str] = None,
    soul_ids: List[str] = None,
) -> str:
    """获取当前 session 的完整对话上下文"""
    records = _get_records_visible_to(
        user_ids=user_ids,
        soul_ids=soul_ids,
        session_id=session_id,
        include_ai=True,
        max_turns=999999,  # 足够大的数，取所有记录
    )
    ##print(f"[DEBUG context] 检索到 {len(records)} 条可见记录")
    print(f"[ctx-dbg] session={session_id} 检索到 {len(records)} 条可见记录 "
          f"(ask_u={user_ids}, ask_s={soul_ids})")
    for r in records[:3]:
        print(f"[ctx-dbg]   - source={r['source']}, turn={r.get('turn_id')}, "
              f"soul={r.get('soul_id')}, content={str(r.get('content',''))[:60]!r}")
    if not records:
        return ""

    # 排序主键（2026-08-29 换 turn 主序）：turn_id 在 _alloc_turn 后=节点因果
    # 序，par 慢分支的发言按自己节拍归位（910 实证），不再被墙钟完成时间打乱；
    # 节点内按 timestamp、idx 兜底（兼管 legacy 撞号行）。react 行按
    # (turn_id, soul_id) 分组、step_idx 升序拼轮，可见性由文件顶部 VISIBILITY
    # 控制：自己=cot/response/tool 全量，别人=只拼 response（tool 可开关）。
    # legacy 全量转写行（cot/tool 列为空）按 response 原样渲染，不做正则剥除。
    ##print(f"[DEBUG final records count] {len(records)}")
    #for r in records:
        ##print(f"  - source={r['source']}, turn={r.get('turn_id')}, content={r.get('content','')[:80]!r}")

    from femCompiler.db_utils import get_soul_by_id, get_user_by_id
    import json
    name_cache = {}

    def _parse_first_id(raw):
        """从可能是 JSON 数组的字段中提取第一个 ID 字符串"""
        if not raw:
            return ""
        if isinstance(raw, list):
            return str(raw[0]) if raw else ""
        if isinstance(raw, str):
            # 尝试 JSON 解析
            s = raw.strip()
            if s.startswith('[') and s.endswith(']'):
                try:
                    arr = json.loads(s)
                    if isinstance(arr, list) and arr:
                        return str(arr[0])
                except Exception:
                    pass
            return s
        return str(raw)

    def get_name(record):
        source = record.get("source")
        if source == "human":
            uid = _parse_first_id(record.get("user_id"))
            if not uid:
                return "用户"
            # 特殊处理：user_id 为 "0" 时，使用该记录 soul_id 对应的灵魂名称
            if uid == "0":
                sid = _parse_first_id(record.get("soul_id", ""))
                if sid:
                    if sid not in name_cache:
                        soul = get_soul_by_id(sid)
                        name_cache[sid] = soul.get("soul_name", sid) if soul else sid
                    return name_cache[sid]
                else:
                    return "AI"
            if uid.startswith('femshow-'):
                return "[节点提醒]"
            if uid.startswith('fems-'):
                return None
            if uid not in name_cache:
                user = get_user_by_id(uid)
                name_cache[uid] = user.get("user_name", uid) if user else uid
            return name_cache[uid]
        else:  # ai
            sid = _parse_first_id(record.get("soul_id"))
            if not sid:
                return "AI"
            if sid not in name_cache:
                soul = get_soul_by_id(sid)
                name_cache[sid] = soul.get("soul_name", sid) if soul else sid
            return name_cache[sid]

    def _is_self(row):
        row_soul = str(row.get("soul_id") or "")
        return bool(soul_ids) and row_soul in {str(s) for s in soul_ids}

    # react 行按 (turn_id, soul_id) 分组成一个发言块；dialog 行（旁白/提醒/
    # 人类输入）保持逐行。blocks 元素=(turn_id, timestamp, idx, seq, name, content)。
    ai_groups = {}
    blocks = []
    seq = 0
    for r in records:
        name = get_name(r)
        if name is None:
            continue
        ts = r.get("timestamp", 0) or 0
        turn = r.get("turn_id", 0) or 0
        if r.get("source") == "ai":
            key = (turn, str(r.get("soul_id") or ""))
            g = ai_groups.setdefault(key, {"rows": [], "ts": ts, "name": name, "self": _is_self(r)})
            g["rows"].append(r)
            g["ts"] = min(g["ts"], ts)
        else:
            content = r.get("content", "")
            blocks.append((turn, ts, r.get("oratio_idx", 0) or 0, seq, name, content))
            seq += 1
    for key in sorted(ai_groups.keys()):
        g = ai_groups[key]
        vis = VISIBILITY.get("self" if g["self"] else "other", VISIBILITY["other"])
        rounds = []
        for row in sorted(g["rows"], key=lambda x: (x.get("step_idx", 0) or 0)):
            parts = []
            if vis.get("cot") and str(row.get("cot") or "").strip():
                parts.append(f"[思考] {str(row['cot']).strip()}")
            if vis.get("tool"):
                tool_result = str(row.get("tool_result") or "").strip()
                tool_call = str(row.get("tool_call") or "").strip()
                if tool_result:
                    parts.append(tool_result)
                elif tool_call:
                    parts.append(f"[工具调用] {tool_call}")
            # 注意：SELECT 里 response AS content——ai 行的发言在 content 键，
            # 读 response 键会永远拿到空（915 场实测：Eve 谜面整块消失）。
            resp_text = str(row.get("content") or row.get("response") or "").strip()
            if vis.get("response") and resp_text:
                parts.append(resp_text)
            if parts:
                rounds.append("\n".join(parts))
        if not rounds:
            continue
        # idx 取大数：同一 turn 内 react 块永远排在 prompt/show/人类输入之后
        blocks.append((key[0], g["ts"], 10 ** 9, seq, g["name"], "\n\n".join(rounds)))
        seq += 1
    blocks.sort(key=lambda b: (b[0], b[1], b[2], b[3]))
    lines = [f"[{name}]：\n{content}" for _, _, _, _, name, content in blocks]
    return "\n\n".join(lines)


def findThisSession(
    session: int,
    actor_info: dict,
) -> str:
    """默认 context 提取入口（返回全部上下文）"""
    ##print(f"[ContextExample] 📖 提取 session={session} 的完整上下文")
    user_ids = []
    soul_ids = []
    if "user" in actor_info:
        user_ids.append(str(actor_info["user"]))
    if "soul" in actor_info:
        soul_ids.append(str(actor_info["soul"]))

    #print(f"[ContextExample] 查询参数: session={session}, user_ids={user_ids}, soul_ids={soul_ids}")

    context = get_session_context(
        session_id=session,
        user_ids=user_ids if user_ids else None,
        soul_ids=soul_ids if soul_ids else None,
    )
    ##print(f"[ContextExample] ✅ 上下文提取完成，长度: {len(context)} 字符")
    #if context:
    #    #print(f"[ContextExample] 内容预览:\n{context[:500]}")
    return context
