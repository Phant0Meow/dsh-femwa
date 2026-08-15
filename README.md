# dsh-femwa — FemWA 多智能体剧本引擎（dsh 自包含插件版）

> 把"像写剧本一样编排多智能体"的 FemWA 引擎做成一个 **DeepSeek Harness (dsh) 插件**。
> **引擎、桥接器、插件代码、用户数据目录全在这个文件夹里**——整个文件夹就是一个插件，
> 搬到哪里都能用，不需要任何外部 FemWA 安装。

## 它是什么

Fem 会话 = **没有主模型的 dsh 会话**：

- 会话的 `agent/pre-step` 永远 reject → dsh 的主模型从不被调用
- 每轮真正发给 LLM 的 system prompt 与上下文由 **FemWA 引擎**按角色组装（soul 卡片 + 记忆 + scope 视角隔离）
- 聊天窗口是**舞台监视器**：角色发言渲染为彩色气泡、节点提示渲染为公告条、流程状态居中灰字
- human 节点等待时你的回复会桥接进引擎；非等待时打字 = 硬停止
- AI 节点可走 dsh 子 agent（工具调用 + 思考链），也可走引擎内置 LLM 桥

剧本语言（.fems）：`meta / actors / code / vars / action / module / mainflow`，支持 scope 视角隔离、par 并行、fork/join 网关、断点续跑。

## 目录结构（自包含布局）

```
dsh-femwa/                  ← 整个文件夹就是插件
├── src/                    TS 插件代码（host + client）
├── python/                 桥接器 femwa_bridge.py（stdio JSON-RPC）+ 测试剧本
├── femCompiler/            FemWA 引擎：parser / runtime / 并发 / SQLite 记忆
├── femBridges/             LLM 桥 + getDir（用户目录解析）
├── func_code/              官方 @func 模块
├── user_data/              ★ 运行时数据（自动创建：剧本/记忆库/checkpoint）
├── build.mjs / package.json / cordis.patch.yml
```

**用户数据自包含**：数据库、剧本、checkpoint 都落在本文件夹的 `user_data/` 下——整个文件夹打包/拷贝，数据跟着走。

## 安装

```bash
# 1. 把整个文件夹放进 profile 的 node_modules（或 junction 指过去）
#    e.g. ~/.dsh/profiles/web/node_modules/dsh-femwa

# 2. 环境要求
pip install requests          # Python 3 唯一必需依赖（引擎 LLM 调用）

# 3. 在 profile 的 cordis.patch.yml 注册
- insert:
    - id: dsh-femwa
      name: 'dsh-femwa'
      config:
        enabled: true

# 4. 重启 dsh web
```

配置里 `femwaRoot` **可省略**（缺省 = 插件文件夹自身）；只有把引擎拆出去单独放时才需要指定。

## 配置（cordis.patch.yml 可覆盖）

| 键 | 默认 | 说明 |
|---|---|---|
| `femwaRoot` | 插件包根 | 引擎根目录（缺省自包含；单独拆分引擎时指定） |
| `python` | `python` | Python 可执行名 |
| `provider` / `model` / `apiUrl` | deepseek / deepseek-v4-flash / api.deepseek.com | 引擎 AI 节点的 LLM 路由（引擎内置桥） |
| `apiKeyRef` | `DEEPSEEK_API_KEY` | dsh credentials 引用名 |
| `dshAiBackend` | `true` | AI 节点走 dsh 子 agent（原生工具调用 + 思考链） |
| `dshProvider` | `deepseek-official` | 子 agent 的 dsh LLM provider |
| `defaultActorTools` | `true` | 角色未声明 `tools:` 时的工具开关；剧本里可逐角色 `tools: true/false` 或白名单 |

## dsh 版本要求

插件往会话日志写入自定义事件类型 `dsh-femwa/chat`。历史加载需要 dsh 的**事件注册面**
（`registerSessionEventType`，dsh 官方注释预留的特性，未随官方版本发布）：

- **含注册面的 dsh**（本特性上游化后的官方版，或打补丁的构建）：完整功能，历史正常加载
- **官方原版**：插件照常工作、live 会话完全正常；**唯一限制**——重启后，含 `dsh-femwa/chat` 事件的旧会话历史无法加载（dsh 拒绝未知事件类型是设计行为）。新会话不受影响

## 剧本

`.fems` 剧本放在 `user_data/projects/`（子目录或直接文件）。侧边栏 🎭 按钮新建 Fem 会话，会话顶部「Fem 剧本」面板选择/编辑/保存并运行；👁 视角切换（上帝/角色视角）。

## 开发与测试

```bash
npm install
powershell -ExecutionPolicy Bypass -File scripts/link-workspace.ps1   # 建 @deepseek-ai 构建镜像（Windows junction）
npm run build                 # lib/index.js（host）+ lib/client.js（browser）
python python/dev-bridge-test.py   # 桥接器协议冒烟
```

## 许可证

Apache-2.0
