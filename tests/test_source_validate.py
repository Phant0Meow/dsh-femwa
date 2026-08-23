# -*- coding: utf-8 -*-
"""编译期 source 校验测试：剧本 ai actor 的 source 必须命中 dsh 可用模型列表。

覆盖：裸 id 命中/未命中、provider/model 命中/未命中、空跳过、human 数字跳过、
blueprint 跳过、models=None 兼容（旧调用路径零影响）。
"""
import pytest
from femCompiler.FEM_parser import parse_script, validate_actor_sources

MODELS = {
    'defaultProvider': 'deepseek-official',
    'providers': [
        {'id': 'deepseek-official', 'models': ['deepseek-v4-flash', 'deepseek-v4-pro']},
        {'id': 'openai', 'models': ['gpt-4.1', 'gpt-5.6-sol']},
    ],
}

SCRIPT_AI = """\
meta:
  name: test

actors:
  ai @host = soul:0, source:{source}

flow:
  [START] -> [END]
"""


def test_bare_id_hit():
    s = parse_script(SCRIPT_AI.format(source='deepseek-v4-flash'), models=MODELS)
    assert s.actors['@host'].source == 'deepseek-v4-flash'


def test_bare_id_miss_raises():
    with pytest.raises(ValueError, match='deepseek-v4-ultra.*不是可用模型'):
        parse_script(SCRIPT_AI.format(source='deepseek-v4-ultra'), models=MODELS)


def test_provider_model_hit():
    s = parse_script(SCRIPT_AI.format(source='openai/gpt-4.1'), models=MODELS)
    assert s.actors['@host'].source == 'openai/gpt-4.1'


def test_provider_model_miss_provider():
    with pytest.raises(ValueError, match='anthropic/claude-4.*不是可用模型'):
        parse_script(SCRIPT_AI.format(source='anthropic/claude-4'), models=MODELS)


def test_provider_model_miss_model():
    with pytest.raises(ValueError, match='deepseek-official/glm5.*不是可用模型'):
        parse_script(SCRIPT_AI.format(source='deepseek-official/glm5'), models=MODELS)


def test_empty_source_ok():
    s = parse_script(SCRIPT_AI.format(source=''), models=MODELS)
    assert s.actors['@host'].source == ''


def test_no_models_skips_validation():
    # 旧调用路径：不传 models 不校验，任意 source 都能编译
    s = parse_script(SCRIPT_AI.format(source='deepseek-v4-ultra'))
    assert s.actors['@host'].source == 'deepseek-v4-ultra'


def test_human_numeric_source_skipped():
    script = """\
meta:
  name: test

actors:
  ai @host = soul:0, source:deepseek-v4-flash
  human player = soul:9, source:0

flow:
  [START] -> [END]
"""
    s = parse_script(script, models=MODELS)
    assert s.actors['player'].type.value == 'human'
    assert s.actors['player'].source == '0'


def test_blueprint_source_skipped():
    script = """\
meta:
  name: test

actors:
  blueprint wolf:
    soul = 1
    source = not-a-real-model
  ai @host = soul:0, source:deepseek-v4-flash

flow:
  [START] -> [END]
"""
    s = parse_script(script, models=MODELS)
    assert s.actors['wolf'].is_blueprint is True


def test_error_message_lists_available():
    with pytest.raises(ValueError) as ei:
        parse_script(SCRIPT_AI.format(source='nope'), models=MODELS)
    msg = str(ei.value)
    assert 'deepseek-official/deepseek-v4-flash' in msg
    assert 'openai/gpt-4.1' in msg


def test_validate_actor_sources_none_models():
    # 直接调用辅助函数：None / 空 dict 均安全跳过
    script = parse_script(SCRIPT_AI.format(source='nope'))
    validate_actor_sources(script, None)
    validate_actor_sources(script, {})
