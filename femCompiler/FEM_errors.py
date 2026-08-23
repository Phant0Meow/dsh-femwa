"""FEM 错误三桶分类（2026-08-18 模块化设计）。

统一错误处理入口：新代码遇到错误先 `classify_error` 归桶，再按桶处理——
- FATAL：编译/语法/结构错、LLM 配置错（无 key/模型/URL）→ 剧本暂停/不启动，
  错误信息回主模型与用户（host 转戏外视角）；
- AGENT：执行者输出问题（赋值违规、格式错、LLM 临时失败限流/超时）→
  错误反馈给当前节点执行者，该轮输出不落库，重跑此节点；
- TOLERANT：可忽略（格式类解析失败等）→ 走 resolve 回调或丢弃。

调用约定：FEMRunner.handle_error 是引擎内统一处理入口；分类判定用
classify_error；异常类标注用 FEMConfigError / FEMTransientError。
"""
from enum import Enum


class ErrorCategory(Enum):
    FATAL = 'fatal'
    AGENT = 'agent'
    TOLERANT = 'tolerant'


class FEMConfigError(Exception):
    """LLM 配置错误（无 key/模型/URL/供应商等）→ FATAL：剧本无法继续，直接报错。"""


class FEMTransientError(Exception):
    """LLM 临时失败（限流/超时/网络抖动）→ AGENT：反馈后重跑此节点。"""


def classify_error(error: Exception) -> ErrorCategory:
    """按异常类型归桶。兜底 FATAL（未知错误不静默）。

    执行者输出类错误（AI 赋值违规等）不在此分类——它们走
    _extract_ai_assignments 的 assign_errors 通道（AGENT 语义），
    不经过 handle_error。"""
    if isinstance(error, FEMTransientError):
        return ErrorCategory.AGENT
    # FEMConfigError、编译类（SyntaxError/ValueError）、未知错误 → FATAL
    return ErrorCategory.FATAL
