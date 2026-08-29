#!/usr/bin/env python3
"""
femwa_bridge.py — stdio NDJSON JSON-RPC bridge for the FemWA compiler.

Runs the FemWA engine (FEM_parser + FEM_runtime) as a headless subprocess and
speaks newline-delimited JSON over stdin/stdout:

  host -> bridge:  {"id": 1, "cmd": "run", "args": {"fems": "...", "base_dir": "..."}}
  bridge -> host:  {"type": "response", "id": 1, "ok": true, "result": {...}}
                   {"type": "response", "id": 1, "ok": false, "error": "..."}
                   {"type": "event", "event": "<event_type>", "data": {...}}   # 15 FemWA event types, verbatim

Commands:
  run            Start one workflow (single-run serial; rejects while running).
  pause          Pause the current workflow (global stop semantics).
  resume         Resume a paused task by task_id.
  stop           Stop the current workflow.
  human_input    Provide human input for a waiting human node (wait_key + body).
  list_scripts   List .fems scripts under the user_data projects dir.
  ping           Liveness probe.
  shutdown       Exit the bridge.

Protocol notes:
  - One JSON object per line, UTF-8. Every outbound line goes through a lock
    (event callbacks fire from LLM stream threads).
  - FEMRunner is driven exactly like main.py's server mode: _human_input_event
    is set so human nodes wait on wait_key channels instead of stdin.
  - parse_script writes debug_normalized_output.fems into the CWD; the host
    should launch the bridge with a workdir it is allowed to pollute.
"""

import sys
import os
import json
import shutil
import threading
import argparse
import time
import traceback

# fork 循环回流每轮嵌套一层 asyncio 任务（见 FEM_runtime._run_fork），
# 深层任务链的 Task.cancel() 是同步递归，默认 1000 栈深会在 stop 时
# RecursionError（maximum recursion depth exceeded）。提高递归限制兜底。
sys.setrecursionlimit(200_000)

# ── resolve the FemWA project root ────────────────────────────────────────
def resolve_femwa_root():
    root = os.environ.get("FEMWA_ROOT", "")
    if root and os.path.isdir(root):
        return root
    return None

def ensure_func_code(femwa_root):
    """Ensure the user-data func_code dir has the FemWA official example
    files (copied from the project's bundled func_code, never overwriting
    user files). PythonBridge loads @func modules from there."""
    try:
        from femBridges.getDir.get_dir import get_user_dir
        src = os.path.join(femwa_root, "func_code")
        dst = os.path.join(get_user_dir(), "func_code")
        os.makedirs(dst, exist_ok=True)
        if not os.path.isdir(src):
            return
        for item in os.listdir(src):
            if item in ("__pycache__", "__init__.py"):
                continue
            s = os.path.join(src, item)
            d = os.path.join(dst, item)
            if os.path.exists(d):
                continue
            if os.path.isfile(s):
                shutil.copy2(s, d)
            elif os.path.isdir(s):
                shutil.copytree(s, d)
    except Exception as exc:
        sys.stderr.write(f"femwa_bridge: ensure_func_code failed: {exc}\n")

def ensure_default_data():
    """Insert FemWA's default souls/users (idempotent) so ai_name resolution
    (get_soul_by_id) finds the built-in characters (Eve, littlecat, ...)."""
    try:
        from femCompiler.db_utils import init_database, ensure_default_data as _seed
        init_database()
        _seed()
    except Exception as exc:
        sys.stderr.write(f"femwa_bridge: ensure_default_data failed: {exc}\n")

def main():
    # Windows consoles default to GBK; FemWA's own prints carry emoji and
    # would crash, and our JSON protocol carries UTF-8 Chinese text. Force
    # UTF-8 on all three streams before importing FemWA.
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except Exception:
            pass

    parser = argparse.ArgumentParser(description="FemWA stdio JSON-RPC bridge")
    parser.add_argument("--fe4m", default=None, help="FemWA project root (default: $FEMWA_ROOT)")
    args = parser.parse_args()

    femwa_root = args.fe4m or resolve_femwa_root()
    if not femwa_root:
        sys.stderr.write("femwa_bridge: FEMWA_ROOT/--fe4m must point at the FemWA project\n")
        sys.exit(2)
    sys.path.insert(0, femwa_root)
    os.chdir(femwa_root)  # keep parse_script's debug file out of the harness cwd

    from femCompiler.FEM_parser import parse_script
    from femCompiler.FEM_runtime import FEMRunner

    def make_soul_checker():
        """构造 soul 存在性检查器：parse_script 编译期校验 actors 的 soul 用。
        携带 _soul_ids 可用列表，报错文案末尾附上（db_utils 无列表函数时省略）。"""
        from femCompiler.db_utils import check_soul_id_exists, list_all_soul_ids

        def checker(sid: str) -> bool:
            return check_soul_id_exists(sid)

        checker._soul_ids = list_all_soul_ids()
        return checker

    out_lock = threading.Lock()

    def emit(obj):
        with out_lock:
            sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
            sys.stdout.flush()

    def send_response(req_id, ok, result=None, error=None):
        payload = {"type": "response", "id": req_id, "ok": ok}
        if ok:
            payload["result"] = result
        else:
            payload["error"] = error
        emit(payload)

    # ── single-run state ───────────────────────────────────────────────────
    state = {
        "runner": None,
        "running": threading.Event(),   # True while a workflow is active
        "last_checkpoint": None,        # 最近一次 checkpoint 事件的分支位置
    }
    state_lock = threading.Lock()

    def event_callback(event_type, data):
        if event_type == "checkpoint" and isinstance(data, dict):
            with state_lock:
                state["last_checkpoint"] = data.get("checkpoints")
        emit({"type": "event", "event": event_type, "data": data})

    def start_run(fems_text, base_dir, user_api_key, user_api_provider,
                  user_api_url, user_api_model, dsh_ai_backend=False,
                  resume_state=None):
        def worker():
            runner = None
            try:
                script = parse_script(fems_text, base_dir=base_dir,
                                      soul_checker=make_soul_checker())
                runner = FEMRunner(
                    script,
                    base_dir=base_dir,
                    verbose=False,
                    event_callback=event_callback,
                    user_api_key=user_api_key,
                    user_api_provider=user_api_provider,
                    user_api_url=user_api_url,
                    user_api_model=user_api_model,
                    resume_state=resume_state,
                )
                if resume_state:
                    print(f"[bridge] resume state keys: {sorted(resume_state.keys())}")
                runner._human_input_event = threading.Event()
                runner._human_input_data = None
                if dsh_ai_backend:
                    # AI 节点走 dsh 子 agent 后端：_exec_ai 上行 ai_request 事件，
                    # 等待 host 回传（human_input 命令，wait_key 形如 ai_*）。
                    runner._dsh_ai_backend = True
                with state_lock:
                    state["runner"] = runner
                runner.run()
                emit({"type": "event", "event": "bridge_run_ended", "data": {"ok": True}})
            except Exception as exc:
                traceback.print_exc(file=sys.stderr)
                emit({"type": "event", "event": "flow_error", "data": {"error": str(exc)}})
                emit({"type": "event", "event": "bridge_run_ended", "data": {"ok": False}})
            finally:
                if runner is not None:
                    try:
                        import asyncio
                        asyncio.run(runner.engine.shutdown())
                    except Exception:
                        pass
                with state_lock:
                    state["runner"] = None
                state["running"].clear()

        state["running"].set()
        threading.Thread(target=worker, daemon=True).start()

    # ── command dispatch ───────────────────────────────────────────────────
    def dispatch(req_id, cmd, args_obj):
        if cmd == "ping":
            send_response(req_id, True, {"pong": True})
        elif cmd == "list_scripts":
            # Scan both the FemWA project's bundled projects dir and the
            # user-data projects dir (get_user_dir may resolve elsewhere).
            from femBridges.getDir.get_dir import get_user_dir
            candidates = []
            local_projects = os.path.join(femwa_root, "user_data", "projects")
            if os.path.isdir(local_projects):
                candidates.append(local_projects)
            home_projects = os.path.join(get_user_dir(), "user_data", "projects")
            if os.path.isdir(home_projects) and home_projects not in candidates:
                candidates.append(home_projects)
            scripts = []
            for projects in candidates:
                for name in sorted(os.listdir(projects)):
                    sub = os.path.join(projects, name)
                    if os.path.isdir(sub):
                        for f in sorted(os.listdir(sub)):
                            if f.endswith(".fems"):
                                scripts.append(os.path.join(sub, f))
                    elif name.endswith(".fems"):
                        scripts.append(sub)
            send_response(req_id, True, {"scripts": scripts})
        elif cmd == "check":
            # 同步编译校验（femwa-run 工具路径）：编译错误作为工具返回结果，
            # 带细节指导主模型改剧本；不启动运行、不产生状态。
            fems_text = args_obj.get("fems", "")
            if not fems_text.strip():
                send_response(req_id, False, error="fems is empty")
                return
            base_dir = args_obj.get("base_dir")
            try:
                script = parse_script(
                    fems_text,
                    base_dir=base_dir if base_dir is not None else femwa_root,
                    soul_checker=make_soul_checker(),
                )
                send_response(req_id, True, {"ok": True, "actions": len(script.actions)})
            except Exception as exc:
                traceback.print_exc(file=sys.stderr)
                send_response(req_id, False, error=str(exc))
        elif cmd == "run":
            fems_text = args_obj.get("fems", "")
            if not fems_text.strip():
                send_response(req_id, False, error="fems is empty")
                return
            if state["running"].is_set():
                # 上一轮 worker 可能正在收尾（stop 后 runner 停止、worker 清理），
                # 等待其退出而不是立即拒绝——否则"停掉 → 立刻续跑"会撞串行锁。
                # 【2026-08-29 修复】原 `if not state["running"].wait(10)` 语义写反：
                # Event.wait 等的是「置位」，事件已置位时 0 秒返回 True，拒绝分支
                # 永不可达 → 运行中再收到 run 会直接并发起第二个 worker（实测
                # fresh_start 双开事故的最后一道闸失效）。改轮询等待「清零」。
                deadline = time.monotonic() + 10
                while state["running"].is_set() and time.monotonic() < deadline:
                    time.sleep(0.1)
                if state["running"].is_set():
                    send_response(req_id, False, error="a workflow is already running (single-run serial)")
                    return
            ensure_func_code(femwa_root)
            ensure_default_data()
            start_run(
                fems_text,
                # base_dir：有剧本地址=剧本目录；未保存=空串（引擎对相对路径报错）。
                # 不能用 `or femwa_root` 回退——空串是「未保存」的合法语义。
                args_obj.get("base_dir") if args_obj.get("base_dir") is not None else femwa_root,
                args_obj.get("user_api_key"),
                args_obj.get("user_api_provider"),
                args_obj.get("user_api_url"),
                args_obj.get("user_api_model"),
                bool(args_obj.get("dsh_ai_backend", False)),
                resume_state=args_obj.get("resume_state") or None,
            )
            send_response(req_id, True, {"started": True})
        elif cmd == "get_checkpoint":
            with state_lock:
                checkpoint = state["last_checkpoint"]
            send_response(req_id, True, {"checkpoints": checkpoint or {}})
        elif cmd == "stop":
            with state_lock:
                runner = state["runner"]
            if runner is not None:
                runner.stop()
                send_response(req_id, True, {"stopped": True})
            else:
                send_response(req_id, True, {"stopped": False, "note": "no active runner"})
        elif cmd == "pause":
            with state_lock:
                runner = state["runner"]
            if runner is not None:
                runner.stop()
                send_response(req_id, True, {"paused": True})
            else:
                send_response(req_id, True, {"paused": False, "note": "no active runner"})
        elif cmd == "resume":
            task_id = args_obj.get("task_id", "")
            with state_lock:
                runner = state["runner"]
            if runner is not None and task_id:
                ok = runner.pause_manager.resume(task_id)
                send_response(req_id, True, {"resumed": ok})
            else:
                send_response(req_id, True, {"resumed": False})
        elif cmd == "human_input":
            wait_key = args_obj.get("wait_key", "")
            body = args_obj.get("body")
            with state_lock:
                runner = state["runner"]
            if runner is not None and wait_key and body is not None:
                runner.engine.human_input.provide_input(wait_key, body)
                send_response(req_id, True, {"delivered": True})
            else:
                send_response(req_id, True, {"delivered": False})
        elif cmd == "list_souls":
            # femwa-soul list：返回全部角色（精简 id+名字，主模型写剧本选角用）。
            from femCompiler.db_utils import list_souls as _list_souls
            send_response(req_id, True, {"souls": _list_souls()})
        elif cmd == "create_soul":
            # 插件模式 soul 创建：user_id/created_by 固定为默认用户 u001（前端不再输入）。
            from femCompiler.db_utils import create_soul as _create_soul
            from femCompiler.db_utils import check_soul_id_exists
            soul_id = str(args_obj.get("soul_id", "")).strip()
            soul_name = str(args_obj.get("soul_name", "")).strip()
            description = str(args_obj.get("description", ""))
            user_id = str(args_obj.get("user_id", "")).strip() or "u001"
            if not soul_id:
                send_response(req_id, False, error="soul_id is required")
                return
            if check_soul_id_exists(soul_id):
                send_response(req_id, False,
                              error=f'soul_id "{soul_id}" 已存在（角色库中已有同名角色，请换一个 soul_id）')
                return
            _create_soul(soul_id, soul_name, description, user_id)
            send_response(req_id, True, {"soul_id": soul_id})
        elif cmd == "shutdown":
            with state_lock:
                runner = state["runner"]
            if runner is not None:
                runner.stop()
            send_response(req_id, True, {"bye": True})
            # small delay so the response flushes before exit
            threading.Timer(0.2, os._exit, args=(0,)).start()
        else:
            send_response(req_id, False, error=f"unknown command: {cmd}")

    # ── stdin loop ─────────────────────────────────────────────────────────
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            emit({"type": "response", "id": None, "ok": False, "error": "invalid json"})
            continue
        req_id = req.get("id")
        cmd = req.get("cmd", "")
        args_obj = req.get("args") or {}
        try:
            dispatch(req_id, cmd, args_obj)
        except Exception as exc:
            traceback.print_exc(file=sys.stderr)
            send_response(req_id, False, error=str(exc))

if __name__ == "__main__":
    main()
