"""mind 节点测试：@mind(@执行者) 运行时按执行者类型分发。

执行者可能是变量（@mind(@speaker)），由剧本运行中赋值（人类或 AI 都可能），
编译期无法预判——分发必须发生在运行时。AI 路径的 LLM 调用在测试环境会失败
（无 API key），因此 AI 分发只断言到 context_ready（LLM 调用前的事件）；
human 路径断言到 human_wait。
"""
import pytest

from femCompiler.FEM_parser import parse_script, ExecutorType


def event_types(events):
    return [e["event"] for e in events]


MIND_AI_FEMS = """meta:
  name = mind-ai
  session = new
actors:
  ai @eve = soul:the1stlittlesoul
vars:
  @seer = @eve
action seer_check @mind(@seer):
  prompt: 你是预言家，请查验一位玩家
  showprompt: 预言家请睁眼
mainflow:
  [START] -> seer_check -> [END]
"""

MIND_HUMAN_FEMS = """meta:
  name = mind-human
  session = new
actors:
  human @p = soul:human, source:0
vars:
  @seer = @p
action seer_check @mind(@seer):
  prompt: 你是预言家，请选择查验对象
  showprompt: 预言家请睁眼
mainflow:
  [START] -> seer_check -> [END]
"""

MIND_DYNAMIC_FEMS = """meta:
  name = mind-dynamic
  session = new
actors:
  ai @eve = soul:the1stlittlesoul
  human @p = soul:human, source:0
vars:
  @seer = @eve
action assign_role @assign:
  out:
    @seer = @p
action seer_check @mind(@seer):
  prompt: 你是预言家，请选择查验对象
mainflow:
  [START] -> assign_role -> seer_check -> [END]
"""


class TestMindParse:
    def test_mind_parses_to_mind_executor(self):
        script = parse_script(MIND_AI_FEMS, base_dir=".")
        action = script.actions["seer_check"]
        assert action.executor_type == ExecutorType.MIND
        assert action.executor_param == "@seer"


class TestMindDispatch:
    def test_ai_executor_runs_ai_path(self, run_events):
        """mind + AI 执行者：node_start 发 node_type=ai，context_ready 带 showprompt。"""
        events = run_events(MIND_AI_FEMS, timeout=15)
        starts = [e for e in events if e["event"] == "node_start"]
        assert starts and starts[0]["data"].get("node_type") == "ai", \
            f"mind+AI 应发 node_type=ai: {event_types(events)}"
        ready = [e for e in events if e["event"] == "context_ready"]
        assert ready, f"应出现 context_ready: {event_types(events)}"
        assert ready[0]["data"].get("showprompt") == "预言家请睁眼"

    def test_human_executor_runs_human_path(self, run_events):
        """mind + human 执行者：node_start 发 node_type=human，随后 human_wait。"""
        events = run_events(MIND_HUMAN_FEMS, timeout=8)
        starts = [e for e in events if e["event"] == "node_start"]
        assert starts and starts[0]["data"].get("node_type") == "human", \
            f"mind+human 应发 node_type=human: {event_types(events)}"
        waits = [e for e in events if e["event"] == "human_wait"]
        assert waits, f"应出现 human_wait: {event_types(events)}"
        assert waits[0]["data"].get("prompt") == "你是预言家,请选择查验对象"

    def test_runtime_assignment_switches_dispatch(self, run_events):
        """执行者在运行中被 @assign 切换成 human：mind 必须按新值分发（用户提醒的坑）。"""
        events = run_events(MIND_DYNAMIC_FEMS, timeout=8)
        starts = [e for e in events if e["event"] == "node_start"]
        assert len(starts) >= 2, f"应有 assign + mind 两个 node_start: {event_types(events)}"
        assert starts[-1]["data"].get("node_type") == "human", \
            f"运行时赋值后 mind 应分发到 human: {starts[-1]['data']}"
        assert any(e["event"] == "human_wait" for e in events)
