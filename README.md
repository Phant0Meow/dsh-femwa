# dsh-femwa — FemWA 多智能体剧本引擎（dsh 自包含插件版）

> 把"像写剧本一样编排多智能体"的 FemWA 引擎做成一个 **DeepSeek Harness (dsh) 插件**。
> **引擎、桥接器、插件代码、用户数据目录全在这个文件夹里**——整个文件夹就是一个插件，
> 搬到哪里都能用，不需要任何外部 FemWA 安装。

## 它是什么

Fem 会话 = **dsh 主模型会话 + 多智能体剧本引擎**：

- **主模型 = 导演**：可以正常聊天、写/改剧本（`femwa-mount` 挂载到会话）、运行剧本（`femwa-run`）；剧本运行时引擎拥有会话（pre-step 拦截主模型请求，运行中不插话），空闲时主模型照常可用
- **上帝/角色视角 = 子代理投影窗**：每个角色一个投影窗（origin:subagent），角色发言投影进对应窗口；主会话表面只留戏外内容——主模型上下文天然干净
- 每轮发给 LLM 的 system prompt 与上下文由 **FemWA 引擎**按角色组装（soul 卡片 + 记忆 + scope 视角隔离）
- 聊天窗口是**舞台监视器**：角色发言渲染为彩色气泡、节点提示渲染为公告条、流程状态居中灰字
- human 节点等待时你的回复会桥接进引擎；非等待时打字 = 硬停止
- 主模型写剧本前，system prompt 会指路语法文档（`femwa:docs` section），先读文档再写，不凭印象猜语法
- AI 节点可走 dsh 子 agent（工具调用 + 思考链），也可走引擎内置 LLM 桥
- 节点执行者支持 `ai` / `human` / `@mind` 动态分发：同一节点按运行时执行者自动分流（AI 走 LLM 路径、人类等待输入），执行者由变量指向、运行中可切换

剧本语言（.fems）：`meta / actors / code / vars / action / module / mainflow`，支持 scope 视角隔离、par 并行、fork/join 网关、断点续跑、`@mind` 运行时分发。AI 角色可用 `source` 指定模型（`source:模型id` 走默认 provider，或 `source:provider/模型id` 完全指定；省略跟随主模型），编译期校验，写错立即报错（详见语法文档）。

## 目录结构（自包含布局）

```
dsh-femwa/                  ← 整个文件夹就是插件
├── src/                    TS 插件代码（host + client）
├── python/                 桥接器 femwa_bridge.py（stdio JSON-RPC）+ 测试剧本
├── femCompiler/            FemWA 引擎：parser / runtime / 并发 / SQLite 记忆
├── femBridges/             LLM 桥 + getDir（用户目录解析）
├── func_code/              官方 @func 示例模块（首启复制到 user_data/func_code，见「@func 约定」）
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
| `dshProvider` | `deepseek-official` | 裸 id `source` 归属的 dsh LLM provider；空 source 跟随主模型（见语法文档） |
| `defaultActorTools` | `true` | 角色未声明 `tools:` 时的工具开关；剧本里可逐角色 `tools: true/false` 或白名单 |

## dsh 版本要求

插件往会话日志写入自定义事件类型 `dsh-femwa/chat`。历史加载需要 dsh 的**事件注册面**
（`registerSessionEventType`，dsh 官方注释预留的特性，未随官方版本发布）：

- **含注册面的 dsh**（本特性上游化后的官方版，或打补丁的构建）：完整功能，历史正常加载
- **官方原版**：插件照常工作、live 会话完全正常；**唯一限制**——重启后，含 `dsh-femwa/chat` 事件的旧会话历史无法加载（dsh 拒绝未知事件类型是设计行为）。新会话不受影响

### 给官方 dsh 打补丁（推荐，10 分钟）

让官方版也支持历史加载，只需把 `dsh-femwa/chat` 加进 dsh 的**已知事件类型白名单**。
改动极小（一个文件一行），下面给出精确到行的操作步骤。

**目标文件**：`@deepseek-ai/dsh-session` 包内的 `KNOWN_SESSION_EVENT_TYPES` 定义处。

**源码运行版**（`node --import tsx` 启动的 dsh，文件在
`packages/core/session/src/known-event-types.ts`）：

找到这个数组（第 19 行起）：

```ts
export const KNOWN_SESSION_EVENT_TYPES: ReadonlySet<string> = new Set([
  'agent-preset/selected',
  'agent/inbox/spliced',
  'approval/asked',
  'approval/decided',
  'approval/policy',
  'assistant/chunk',
  'assistant/message',
  'command/done',
  'command/run',
  'compaction/end',   // ← 在 'command/run', 和 'compaction/end', 之间插入一行
```

**把**：

```ts
  'command/done',
  'command/run',
  'compaction/end',
```

**改成**：

```ts
  'command/done',
  'command/run',
  'dsh-femwa/chat',
  'compaction/end',
```

**npm 安装版**（`npm install` 的 dsh，运行时加载的是编译产物）：

1. 定位包：`node -e "console.log(require.resolve('@deepseek-ai/dsh-session'))"`（或在
   `node_modules/@deepseek-ai/dsh-session/lib/` 下找）
2. 在产物文件里**全文搜索** `command/run`（白名单数组就在它附近），找到形如
   `"command/run", "compaction/end"`（或换行写法）的数组
3. 在 `"command/run"` 之后插入 `"dsh-femwa/chat"`（保持数组语法一致）

**注意事项**：

- 该文件头部标注 `GENERATED ... do not edit by hand`——手改可用，但 dsh 升级/重装后**需要重打**（升级后重新执行本步骤）
- 改完重启 dsh 生效；这是白名单唯一需要动的地方，其余文件都不用碰
- 高级替代：把完整注册面特性（`registerSessionEventType` API + coordinator 消费）合入 dsh——改动更正规、可随上游升级，详见本项目文档与 dsh 的 `known-event-types.ts` 头部注释（"a registration surface ... deferred until such a consumer exists"）

## 剧本

`.fems` 剧本放在 `user_data/projects/`（子目录或直接文件）。侧边栏 🎭 按钮新建 Fem 会话，会话顶部「Fem 剧本」面板选择/编辑/保存并运行；👁 视角切换（上帝/角色视角/🎬 戏外主模型）。

### @func / `file:` 文件放置约定

剧本 `code:` 区通过 `file:"xxx.py"` 引用 Python 模块，地址按以下规则解析：

| 写法 | 解析 |
|---|---|
| 绝对路径，如 `file:"D:/a/b.py"` | 直接使用 |
| 相对路径，如 `file:"utils/battle.py"` | 相对**剧本文件所在目录**解析（不是项目根、不是 CWD） |
| 剧本未保存（纯文本运行）时用相对路径 | 报错：提示先「导出 .FEMS」保存剧本，或改用绝对路径 |
| 文件不存在 | 报错 `Python Bridge: 文件不存在 <完整路径>`（不静默兜底） |

`func_code/` 只是官方内置示例模块（首启时复制到 `user_data/func_code/`），**不再作为相对路径的回退查找位置**。自定义模块请放在剧本同目录（或子目录），与剧本一起移动。

## 开发与测试

```bash
npm install
powershell -ExecutionPolicy Bypass -File scripts/link-workspace.ps1   # 建 @deepseek-ai 构建镜像（Windows junction）
npm run build                 # lib/index.js（host）+ lib/client.js（browser）
python python/dev-bridge-test.py   # 桥接器协议冒烟
```

## 许可证

Apache-2.0
