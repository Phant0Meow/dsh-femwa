#femCompiler/tests/repro_wait_empty_poison.py
"""
复现脚本：SaveQueue 哨兵毒丸导致第二轮 wait_empty 永久卡死。

根因：wait_empty 往队列塞 None 哨兵后，worker 消费它时直接 break、不调
task_done() → Queue.unfinished 计数永远 ≥1 → 同进程第二次 run 的
wait_empty 卡死在 queue.join() → flow_done 永不发出。

修复：worker 吃到哨兵时补一次 self._queue.task_done()。

本脚本 monkeypatch 掉 _process_item（零数据库写入），断言两轮连跑都能在
时限内返回。修复前运行会在 ROUND 2 挂死（线程 join 超时后报 FAIL）。
"""
import sys
import threading
import time

sys.path.insert(0, r'D:\myFiles\dsh\dsh-femwa')

from femCompiler import save_dialog  # noqa: E402

# 不写数据库：只验证队列簿记行为。
save_dialog.save_queue._process_item = lambda item: None


def enqueue_one():
    save_dialog.save_queue.enqueue_ai(
        session_id=999999, turn_id=1, step_idx=0,
        response='poison-test', soul_id='', cot='',
        user_scope=[], soul_scope=[],
    )


def run_round(tag: str):
    """跑一轮 enqueue + wait_empty；wait_empty 放线程里跑以便超时判定。"""
    result = {'done': False, 'error': None}

    def body():
        try:
            enqueue_one()
            save_dialog.save_queue.wait_empty(timeout=5)
            result['done'] = True
        except Exception as exc:  # noqa: BLE001
            result['error'] = str(exc)

    thread = threading.Thread(target=body, daemon=True)
    thread.start()
    thread.join(timeout=15)
    if not result['done']:
        detail = '挂死在 queue.join()' if result['error'] is None else f'异常: {result["error"]}'
        raise RuntimeError(f'{tag}: wait_empty 15s 内未返回（{detail}）')
    print(f"✅ {tag}: wait_empty 正常返回")


def main():
    started = time.time()
    # ROUND 1：进程内第一次 wait_empty —— 修复前后都应通过（计数尚干净）。
    run_round('ROUND 1')
    # ROUND 2：restart 后再跑一轮 —— 修复前哨兵毒丸让 queue.join() 永久阻塞。
    if not save_dialog.save_queue._running:
        save_dialog.save_queue.restart()
    run_round('ROUND 2')
    print(f'✅ PASS：两轮连跑全部正常收尾（{time.time() - started:.1f}s）')


if __name__ == '__main__':
    main()
