# MEOW 修改记录（dsh-femwa 仓库内留痕）

> 与 D:\myFiles\dsh\MEOW修改记录及指南.md 同步。条目只追加不改写。

## 2026-08-18 flow 引用校验（裸名 action 必须有定义）

用户指出（原话）："flow里就是 带括号的节点，裸名action。节点可以冒号action来定义它里面的action，也可以不定义那就是空节点。节点名字可以随便乱起。裸名action必须有定义，没有action定义的名字会报错"。
### 根因
FEM_normalizer._replace_bare_in_fragment（L284-301）把任意裸 token 无条件替换成 `[节点]` 绑定并注册（`self._definitions[node_key] = token`），不校验是否已声明——解析器原有的裸名报错（chain_tokens L960 / _reg_node L1031）永远没机会触发：`[START] -> no_such_action -> [END]` 编译通过，运行时才炸。
### 实现（femCompiler/FEM_parser.py）
1. 新增 `validate_flow_refs(flow, known_actions, known_modules, where)`：节点绑定的 action_name/module_ref 必须已声明；空节点（无绑定）合法
2. `eval_flow(block, known_actions=None, known_modules=None)`：mainflow 调用时传 script.actions/modules，构建后立即校验（清晰报错，先于任何下游处理）
3. `validate_module_flows(mod, script)`：parse_script 尾部递归校验模块 flow（模块内 action + 嵌套 module + 全局 module）
### 修正的测试剧本（陪衬 flow 写法错误，非被测对象）
- tests/test_source_validate.py（未跟踪新文件，source 校验配套测试）：`[START] -> ai [host]` 臆造写法 ×3 → `[START] -> [END]`（项目代码/文档无此语法来源）
- tests/test_file_resolve.py：裸 `END` ×2 → `[END]`（保留字必须带括号）
### 验证
- tests/test_flow_ref_validation.py 6/6（裸名未声明拒绝/空节点合法/裸名已声明 OK/&module 未声明拒绝/模块 flow 引用拒绝/模块 flow 合法）
- 全量 pytest 78 passed（72 旧 + 6 新）
- 备份：MEOW_backups/FEM_parser.py.bak-20260818-134614

## 2026-08-18 错误处理三桶模块化（第一步）+ bridge check 命令

用户拍板：错误处理模块化——三桶分类（FATAL 炸/AGENT 反馈重试/TOLERANT 忽略），好调用的 def 供引擎各处直接调用；LLM 调用失败拆两半（配置错 FATAL / 临时错 AGENT）；重试用尽默认放弃继续、fallback: fatal 升级炸（第三步）；编译错误作为 femwa-run 工具返回结果给主模型。
### 实现
1. **femCompiler/FEM_errors.py（新建）**：ErrorCategory（FATAL/AGENT/TOLERANT）+ FEMConfigError + FEMTransientError + classify_error（Transient→AGENT，其余→FATAL 兜底；执行者输出类错误不走这里——走 assign_errors 通道）
2. **femBridges/llmBridge.py**：4 处配置错误 ValueError → FEMConfigError（无 key/模型/URL/provider）；2 处流式失败 return None → FEMTransientError（可重试）
3. **femCompiler/FEM_runtime.py**：import 三桶；新增 `handle_error(error, node_id)`（FATAL→emit flow_error / AGENT→返回 / TOLERANT→log）；_exec_ai 重试循环 catch FEMTransientError→feedback 注入+continue（消耗 attempt），FEMConfigError→raise 传播到 worker 全停（避免重复 flow_error）
4. **python/femwa_bridge.py**：新增 `check` 命令——同步 parse_script 编译校验（成功 actions 数 / 失败完整错误细节），不启动运行无状态
5. **src/index.ts toolDeps.runScript**：前置 `bridge.send('check')`——编译失败（send reject）→ throw → femwa-run 工具返回「剧本编译失败：<细节>」给主模型指导改剧本
### 验证
- tests/test_error_buckets.py 6/6（classify 4 + bridge check 2：好剧本 ok / par 语法错误带细节）
- 全量 pytest 72 passed（62 旧零回归）；build 通过（lib/index.js 102.9kb）
- 注：未知 action 名编译期不报（auto node 特性），运行时炸走 FATAL——check 只拦编译期错误
- 备份：MEOW_backups/{FEM_runtime,llmBridge,femwa_bridge,index.ts}.bak-20260818-132914
- 待 3081 重启后实测：主模型 femwa-run 编译失败剧本 → 工具返回错误细节

## 2026-08-18 meta.owner 留空默认 u001（dsh 插件唯一用户）

用户需求（原话）："我们这是dsh插件了，一共只有一个用户，我记得默认用户是u001（貌似，你检查下），你就直接默认owner留空是u001就好了"。
### 确认
db_utils ensure_default_data 默认用户 u001（user_name=「用户」，profile 空）——与 soul 创建 user_id/created_by 固定 u001 同源。
### 修改明细
1. **FEM_parser.py** parse_script owner 归一化：owner 缺失/空列表（`if not owner_val`）→ `['u001']`；显式值（数字/字符串/列表）原样保留（数字转字符串）
2. **语法文档.md** meta 表 owner 行：补「dsh 插件版：留空（不写或 []）默认 u001」
3. **tests/test_parser.py** 新增 TestOwnerDefault 4 用例：缺失默认 u001 / 空列表默认 u001 / 显式 [1] 保留 / 标量字符串保留
### 验证
- pytest 66/66 全绿
- 3081 重启（PID 19200，bridge 18108）实测：无 owner 剧本 → react_steps user_scope=["u001"]（对照改前旧记录 []）；子代理正常输出「好。」
- 备份：MEOW_backups/FEM_parser.py.bak-20260818-124650

## 2026-08-18 AI 赋值 out 白名单校验（防幻觉乱赋值）

用户需求（原话）："要写out的，必须写out。为了防止ai幻觉乱赋值" + "赋值输出必须属于out范围，否则报错返回给ai，输出不保存，重跑此节点"。
### 检查结论（两类报错引擎有区分）
- **不保存+重试**：`_extract_ai_assignments` 抛 FEMVariableError → assign_errors（L2518）→ feedback 注入 system prompt（L2694-2699）→ ai_retry 事件 → 重跑本节点 LLM（上限 max_retries+1 默认 3）；失败轮次输出不落库（save_ai_turn 在重试循环后）
- **直接炸**：LLM 调用失败（llm_output None）→ flow_error+分支暂停；@func/@assign 返回值不匹配/未声明 → raise
- **宽容**：格式类解析失败 → SET_VARIABLE 列表（交给 resolve/丢弃）
### 实现（FEM_runtime.py）
1. `_extract_ai_assignments(llm_output, out_whitelist=None)`：解析 var_name 后、赋值前校验——不在白名单 → `FEMVariableError("变量 'x' 不在本节点的 out 声明范围内（out 只声明了: ...）")` → 走 assign_errors 重试通道
2. `_exec_ai`：构造 `out_whitelist = {od.var_name for od in ad.outs}`（out 为空 → 空集合 → 任何赋值都拒绝，严格模式）并传入
3. 白名单匹配直接比 var_name（`_parse_single_assignment` 正则 `@?\w+` 无点号；dict.key 形式 AI 赋值本来走宽容路径，out 的 root 名即可）
### 验证
- tests/test_out_whitelist.py 4/4（拒绝出界/空白名单全拒/名单内放行到 apply_assign/无白名单保持旧行为）
- 全量 pytest 62 passed（54 旧零误伤：现有剧本教赋值的 AI/mind 节点均有 out；狼人杀无 out 节点如 tell_seer/god_announce 的 prompt 不教赋值）
- 备份：MEOW_backups/FEM_runtime.py.bak-20260818-124733

## 2026-08-18 示例剧本五件套 + persona/femwa:docs 指路 examples

用户拍板"先读 examples 照着改，冷门语法再查文档，还要给 AI 指路去哪读"。
### 示例剧本（examples/，新增目录）
1. **goal-loop.fems**：Goal 模式极简骨架——单节点回环 `[work] -> if (done==false) -> [work]`，prompt 教 AI 完成后 `SET VARIABLE: <<done = true>>`，变量判断退出（对照：dsh goal 工具是回合制防 AI 中途停止，fems 引擎持有运行权天然无此问题）
2. **group-chat.fems + random_wait_time.py**：用户定稿——par 三线 AI + mainflow 独立人类分支随时插话；@func(WAIT.random_interval) 随机 2~6s 间隔
3. **discussion.fems**：用户定稿——for 轮番讨论→赋值判断→par 独立探索（scope 分离）→汇报→人类拍板；actors tools:true；vars 声明 @speaker/all；驳回回 [START]（主持人有上下文可重分配任务）
4. **town.fems**：斯坦福小镇——位置状态=三个地点数组（add/remove 移动，唯一状态源，scope 天然一致）；无 location 字典/无移动 action；mainflow=par 嵌套 for（[pf] -> for @speaker in place: + 分支 if in 判断）——**par 嵌套 for 运行时暂不支持**（_run_par_fork join BFS 找不到 join→普通 fork→变量丢失，test_par_nested_for.py 记录限制，用户将修引擎）
### persona / femwa:docs 更新
- persona【写剧本】段：先读 examples/ 示例照着改（列出 4 个示例一句话定位），冷门语法再查完整文档
- src/index.ts injectFemwaDocs：text 加 `示例剧本在：${packageRoot}examples/（...）`，写剧本先读最接近需求的示例
### 验证
- npm run build 通过（lib/index.js 100.7kb，含 examples 指路）
- 备份：MEOW_backups/agent.cordis.yml.bak-20260818-121936 + index.ts.bak-20260818-121936
- 待 3081 重启生效（persona 新会话可见；par 嵌套 for 待用户修引擎后实测 town.fems）

## 2026-08-18 source 链路 3081 实测通过 + runAiSubagent sid TDZ 存量 bug 修复

### 实测（用户操作剧本 `ai @小助手 = soul:1, source:deepseek-official/deepseek-v4-flash`，"说一句简短的中文问候，不超过20字"）
1. **编译期校验通过**（source 在 dsh 模型白名单内，不存在的模型会编译报错）
2. ai_request 事件带 source → 宿主解析 → 子代理启动，stop=completed，输出「你好！欢迎回到 Fem 剧场。🎭」
3. **对照实验（铁证 source 生效）**：同样剧本改 source:deepseek-official/deepseek-v4-pro 再跑（插件配置默认 model 是 deepseek-v4-flash）→ 解压归档子代理会话 session.jsonl.zstd（python zstandard）查 request/header → model=deepseek-v4-pro；flash 版为 deepseek-v4-flash。剧本声明的模型精确控制子代理实际调用。
### 存量 bug（实测暴露）
第一次运行报 `ReferenceError: Cannot access 'sid' before initialization`——runAiSubagent 中 `const sid = String(session.id)` 声明在 L1549，但 L1540 `projections.get(sid)` 先使用（TDZ）。投影窗功能引入时的存量 bug，此前 3081 子代理路径未真跑通所以一直潜伏。修复：sid 声明上移到 armIdle() 之后、nodeName 附近，删除原位声明。lib/index.js 100.3kb。
### 验证
- flash/pro 两版均跑通，子代理会话 request/header 确认模型分别正确；子代理会话归档 user_data/subagent_sessions/
- 备份：MEOW_backups/index.ts.bak-20260818-*（sid 修复）
- 3081 已重启生效（PID 30444，bridge pid=19252）
- 辅助脚本：D:\myFiles\dsh\_tmp\scan-subagent-model.py（zstd 解压扫描子代理会话模型）

## 2026-08-18 persona 更新（运行出错约定 + 剧本存哪规范，用户定稿措辞）

用户提供最终措辞，直接采用：
1. **【运行出错时】**（新增）：运行正常主模型收不到消息；编译出错/运行中报错/正常跑完系统会告诉（报错可见）；出错先看错误信息判断与剧本语法或依赖 Python 文件有关；剧本/python 是主模型自己写的可立即改不用问用户；用户提供的要先确认。
2. **【剧本存哪】**（重写，合并原【剧本存哪】+【依赖 Python 文件】）：剧本存当前项目目录（工作目录）合适位置，建议项目根/femwa/下；单剧本直接放、多剧本建子目录；依赖 Python 文件可放剧本旁边（相对引用基于剧本文件位置解析）也可放任意处用绝对路径引用；多剧本可共用同一 python 文件。
3. **【会话模式】**：删"跑完用户会告诉你"（改指【运行出错时】）。
4. **src/tools.ts femwa-run 描述**：同步删"跑完用户会告诉你"→"跑完/报错系统会通知你（见【运行出错时】）"。
### 发现（进 todo）
- deriveMessages 只投影 user/message、assistant/message、tool/result 三类事件 → `dsh-femwa/chat`（flow_done/flow_error/flow_stopped 写入）不进主模型 LLM 上下文：persona 说"系统会告诉你"目前只对 UI 成立、对主模型不成立 → 已记 meow-memory todo「主模型收运行通知（persona 行为对齐）」
- 编译错误路径（bridge run 失败 → HTTP 500/SSE 面板）同样无主会话可见通知 → 同上 todo
### 验证
- npm run build 通过（lib/index.js 98.3kb）；persona YAML 结构保持
- 备份：MEOW_backups/agent.cordis.yml.bak-20260818-095240
- 待 3081 实测：新会话 persona 生效（【运行出错时】【剧本存哪】新措辞）

## 2026-08-18 femwa:docs 注入兜底（agent-preset/selected recompose 路径）

用户实测发现：普通新建会话 + 下拉菜单选「Fem 剧本模式」（agentPreset.select → recompose）后，主模型答 "I'll look at the femwa plugin's injected system prompt..."——解码测试会话 request/header 证实 persona（含最新修改）注入正常，但 **femwa:docs section 缺失**。根因：section 注入只写在插件 handleCreateSession 的 agents.create setup 回调里；recompose 路径（UI 菜单切换）不执行插件 setup。
### 方案（用户拍板：不动 dsh 本体，注入必须成功）
1. **抽公共函数 `injectFemwaDocs(agentCtx)`**（src/index.ts）：原 setup 内联注入逻辑原样抽出，返回 effect disposer；无 systemPrompt/同名重复注册失败返回 undefined 并打日志。
2. **setup 回调**：改为调用公共函数，成功后 disposer 记入防重表 `femwaDocsSections`（Map<sessionId, disposer>）。
3. **agent-preset/selected 监听扩展**（原监听只写 presetOverrides）：preset 切到 dsh-femwa 且未注入 → `ctx.agents.get(sessionId)` 拿 agent → `injectFemwaDocs(agent.ctx)` 补注入（防重跳过）；切走 → dispose 清除 section 并删表（普通会话不留 Fem 文档段）。
### 坑
- systemPrompt.section 同名同 scope 重复注册抛错 → Map 防重覆盖 setup+事件两条路径
- section 注册是 effect（agent ctx 销毁自动清理），disposer 幂等，会话销毁后表条目残留无害
- 事件类型经 `import type {} from '@deepseek-ai/dsh-agent-presets'` 副作用导入可用
### 验证
- npm run build 通过（lib/index.js 98.2kb 含新逻辑 5 处关键词）
- 待 3081 实测：普通会话 → 下拉选 Fem 模式 → 问主模型"你的 system prompt 里语法文档路径是什么"应能复述；切回普通模式文档段应消失
- 备份：MEOW_backups/index.ts.bak-20260818-092837

## 2026-08-18 preset persona 更新（剧本存哪 + 依赖 Python 文件地址规则）

用户要求："把femwa的system prompt注入改一下，关于.FEMS文件的保存地址，不要指定地址了。只说保存在合适的地方，我们本来应该说的是如有依赖python文件，这个python的地址如何指定"。
改 dsh-home/.agent-presets/dsh-femwa/agent.cordis.yml persona 两段：
1. **【剧本存哪】**：去掉"默认存 user_data/projects/<剧本名>.fems 或 <项目名>/<剧本名>.fems"的具体地址指引 → 改为"保存到合适的地方即可（按项目整理目录，方便和依赖文件放一起）"。
2. **新增【依赖 Python 文件】**：code: 区 file:"xxx.py" 地址规则——绝对路径可直接用；相对路径基于剧本文件所在目录解析（依赖文件放剧本旁边/子目录）；剧本未保存（纯文本直接运行）时相对路径不可用只支持绝对路径，可先导出 .FEMS 再运行。
依据 README「@func / file: 文件放置约定」（FEM_runtime.py PythonBridge.load + tests/test_file_resolve.py）；src/index.ts femwa:docs 指路文案（L2110）已含"file: 地址规则（相对=剧本目录/未保存只支持绝对）"，与新 persona 一致，无需改动。
验证：纯文本 persona 改动，YAML 缩进结构保持（6 空格块内文本）；新会话生效（preset 加载在会话创建时）。备份：MEOW_backups/agent.cordis.yml.bak-20260818-085943。

## 2026-08-18 README + 语法文档补充 @mind 节点说明

@mind 节点源码早已实现（狼人杀支持包 f100119：FEM_parser.py MIND 执行者类型 + FEM_runtime.py `_exec_mind` 运行时按执行者类型分发 + tests/test_mind.py 三用例 + femGen 前端 mind 类型支持），但 README.md 与 语法文档.md 未同步。本次纯文档补充：

1. **语法文档.md**：新增「6.3 动态分发动作（@mind）」小节（原 6.3/6.4 顺延为 6.4/6.5）——运行时按执行者类型分发的语义、执行者可为静态角色或 @actor 变量、每轮重新解析（@assign 切换后自动改走对应路径）、行为复用 AI/human 全流程、前端跟随渲染、限制（执行者须为 actors 中 ai/human，blueprint 未实现）；符号速查表加 `@mind` 行；第 11 节报错信息补 mind 相关报错
2. **README.md**：「它是什么」补 mind 动态分发 bullet；剧本语言行补 `@mind` 运行时分发

### 验证
- 纯文档改动，无代码/行为变更；语义逐条对照 FEM_runtime.py `_exec_mind`（L3224-3254）与 tests/test_mind.py 确认
- src/index.ts 语法文档指路文案（L2110）早已含 "@mind 运行时分发"，无需改动，现已与文档一致

## 2026-08-18 前端样式 token 化（主题机制就位，先不写主题配色）

### 目标（用户原话）
"把 femgen 的前端元素的样式放一起""弄几个主题样式可以换""先别写主题。我是让你把样式整理一下提出来"——本次只做样式整理抽取，不写深色配色、不写切换按钮。浅色外观必须与之前 100% 一致。

### 方案
CSS 变量（design tokens）主题系统：全部颜色抽成语义 token（var(--fem-*)），集中定义在 `femGen/src/themes.js`（THEME_CSS + FEM_THEMES 元数据）。换主题 = 切根容器 data-fem-theme 属性 + themes.js 加一个属性块。布局样式（尺寸/间距/flex）一律不动。

### 修改明细
1. **新增 `femGen/src/themes.js`**：约 90 个 token，浅色主题（`:root` + `[data-fem-theme]`）= 全部原值；dark 占位注释；FEM_THEMES 元数据（仅 light）
2. **common.jsx**：FontStyle 注入 THEME_CSS（@import 保持最前）；TYPES/SPECIAL_COLORS/共享样式/ErrorBoundary 颜色→var()；CSS 裸值（滚动条/聚焦/keyframes 光晕/流式光标）→var()
3. **FemWorAuto.jsx**：桌面根 div 挂 `data-fem-theme="light"`；颜色→var()（含 SVG stroke/fill、marker 数组、边色三元）
4. **mobileView.jsx**：MobileLayout 根 div 挂 `data-fem-theme="light"`；T 主题对象颜色→var()（手机壳固有深色区独立 token 组 `--fem-mobile-*`）
5. **其余 7 个 jsx**（actionModal/bubbleOverlay/canvasNodes/femPreview/libPanel/projectPanel/soulModal）：颜色→var()
6. **src/client.tsx**：仅 1 处 #e5484d→var(--dsw-danger, #e5484d)（外壳其余已用宿主 --dsw-* 变量，不动）
7. **canvasNodes.jsx**：`${c}22` 8 位 hex alpha 拼接→color-mix(in srgb, ${c} 13%, transparent)（var() 不能拼 alpha，4 处）
8. 批量替换脚本归档：`scripts/theme-tokenize/`（round1-quoted.ps1 / round2-bare.ps1 / color-extract.txt）

### 验证
- femGen vite build 通过（54 modules）；build.mjs 重打 lib 成功
- 浅色主题下所有 token 值 = 原颜色值，外观理论零变化
- 待 3081 实测：刷新页面 → 编辑器外观与改前一致
- 备份：MEOW_backups/*.bak-20260817-182723（17 个文件）

## 2026-08-18 sketch 块注释化（todo #2，M-018）

### 目标（用户原话）
"生成的时候，把整个sketch块生成为注释，整个sketch块每一行开头加#。解析的时候……检测#sketch作为标志，把整个sketch块拿出来。每一行都去掉行开头的#，剩下的再走正常链路解析"；"sketch是一个纯前端行为，他控制的是前端的显示位置，和后端运行完全无关。所以后端就把他当普通注释直接去掉就好。后端不需要sketch信息。"

### 方案
生成端 sketch 块每行行首加 #（`#sketch:` 标志 + 内容行 # 前缀）；解析端新增 `extractHashSketch` 作为编译第零步（先于 stripComments）：检测行首 `#\s*sketch:` 开始收集块，块内每行剥行首一个 #（# 后空格 = 原缩进）还原为普通 `sketch:` 块，再走正常链路；后端零改动（`_remove_comment` 天然把 # 行删空）。

### 修改明细
1. **femGenerator.jsx**：模块 sketch（emitModule 内）与 mainflow sketch 两处输出行加 # 前缀
2. **femParser.jsx**：新增 `extractHashSketch()`；parseFEMS 接线（stripComments 之前）；export 清单加 extractHashSketch
3. **tests/strip_comments.test.mjs**：+6 用例（还原单元×2、顶层/模块内/块内手写注释/无 sketch 集成×4）
4. **tests/femParser.test.mjs**：esbuild 重打包（构建产物，未跟踪）

### 验证
- strip_comments.test.mjs 28/28 通过（22 旧 + 6 新）
- 后端 FEM_normalizer normalize 含 #sketch 剧本 → 输出无 sketch 残留（python 实测）
- 旧未注释 sketch: 解析链路原样保留（用户拍板不强制兼容，但旧路径无害共存）

## 2026-08-18 样式全量 token 化（round 3：形状/边框/字体/画布）

用户确认归并档位后实施。themes.js 追加：圆角 8 档（--fem-radius-xs/sm/md/lg/xl/pill/top/bubble）、边框宽度 5 档（--fem-border-w/strong/selected/accent/node）、字体 3 个（--fem-font-sans/mono/body）、画布点阵（--fem-canvas-dots 嵌套颜色 var 联动 + --fem-mobile-canvas-dots）、滚动条宽（--fem-scrollbar-w）。10 个 jsx 约 216 处替换 + common.jsx 滚动条/共享样式 + font.css body 字体。尺寸/布局/字号不动（用户红线）；阴影形状不动；client.tsx 外壳保持宿主 dsw 体系。脚本：scripts/theme-tokenize/round3-shape.ps1。备份 *.bak-20260818-013510。vite build + build.mjs 通过，待 3081 刷新实测。

## 2026-08-18 README 更新（架构段 + @func 文件放置约定）

用户确认后更新 README.md（备份 MEOW_backups/README.md.bak-20260818-*）：
1. **「它是什么」段改写**：旧文描述"Fem 会话 = 没有主模型的 dsh 会话"已过时——8/17 已恢复主模型（提交 326248f：pre-step 仅运行中拦截）+ 子代理投影窗（ab2d2e1）+ 主模型工具 femwa-mount/femwa-run（3bb171c/bba2b08）+ 语法文档指路 femwa:docs（d846c1e）。新文：主模型 = 导演（聊天/写剧本/挂载/运行，运行中引擎拥有会话）、上帝/角色视角 = 子代理投影窗（主会话表面只留戏外内容）、输入语义（human_wait 桥接 / 非等待打字 = 硬停止）、AI 节点可走 dsh 子 agent 或引擎内置桥。
2. **目录树 func_code 行**：改为"官方 @func 示例模块（首启复制到 user_data/func_code）"。
3. **剧本章节新增「@func / file: 文件放置约定」小节**（依据 FEM_runtime.py PythonBridge.load 实现 + tests/test_file_resolve.py）：绝对路径直接使用；相对路径相对剧本文件所在目录（不是项目根/CWD）；剧本未保存用相对路径 → 报错提示先导出 .FEMS；文件不存在 → 报错「Python Bridge: 文件不存在 <完整路径>」（不静默兜底）；func_code 不再作为相对路径回退查找位置。

### 验证
- 改动纯文档，无代码/行为变更；规则逐条对照代码与测试确认（todo #2 用户拍板版）

## 2026-08-18 手机版 femGen 插件模式放开（窄视口自动切 MobileLayout）

用户需求：手机打开 dsh（tailscale 访问 3081）时自动显示 femGen 手机版视图。
### 方案
femGen 已有 `useMobile(768)`（window.innerWidth < 768 + resize 监听）响应式检测；渲染分支原本写死 `if (isMobile && !plugin)`（注释"插件模式不提供移动端布局（dsh web 桌面为主）"）。MobileLayout 不依赖独立运行模式（状态/回调全走 props，运行/暂停按钮最终到插件 onRun/onStop 回调），功能上无阻碍。
### 修改明细
1. **femGen/src/FemWorAuto.jsx**（1 行）：`if (isMobile && !plugin)` → `if (isMobile)` + 注释更新（窄视口提供移动端布局，插件模式同样支持）
### 验证
- npm run build 重打 lib/client.js 通过（454.0kb）；产物含 MobileLayout 全量代码
- 备份：MEOW_backups/FemWorAuto.jsx.bak-20260818-*
- 待实测：3081 桌面视口不变；DevTools 窄视口（375px）出 MobileLayout；手机 tailscale 真机（https://<tailscale-域名>:8443）验证；关注点=MobileLayout 100vh 布局在 dsh 顶部栏占用后的溢出表现（若溢出再做容器高度适配）

## 2026-08-18 手机版 femGen 改造（全屏沉浸 + 返回键开 dsh 边栏 + 设置 tab）

用户拍板（原话）："好吧，全屏沉浸也行……但问题是左上角的返回键我建议是打开dsh的边栏。然后把api秘钥这个按钮删了，新加一个切换主题按钮（和桌面版一致），还有新建soul这俩按钮放到下面的标签里。下面的标签，现在是仓库，项目，属性。我们在后面再加一个设置。设置栏里放切换主题按钮和新建soul按钮"。
### 调研结论
- MobileLayout 根容器本为 position:fixed inset:0（全屏覆盖型），嵌入标签页有溢出/功能重复/fixed 弹层错位三问题 → 全屏沉浸
- dsh 侧边栏官方开关：ctx.layout.toggleSidebar()（ui-sidebar 同款用法；ui-layout LayoutController，AppFrame 三列 grid 普通流，最高 z-index 20 overlayLayer）
### 修改明细
1. **mobileView.jsx**：MobileTitleBar 加可选 onBack（渲染 ← 返回键，替代汉堡键；独立模式无左侧键）；MobileLayout 加 onBack/zIndex props 透传；MobileSideMenu 组件整体删除（API 密钥+新建 Soul 入口迁走）；BOTTOM_TABS 加 {id:'settings',label:'设置'}；MobileBottomPanel 加 themeName/onCycleTheme/onOpenSoul props + 设置 tab（🎨 主题名按钮 + 新建 SOUL 按钮，样式照桌面版）
2. **FemWorAuto.jsx**：FEMEditor 签名加 onBackToShell；mobileFs state（默认 true）；MobileLayout 传 zIndex={plugin&&mobileFs?900:undefined}、onBack={plugin?退出全屏+toggleSidebar:undefined}、themeName、onCycleTheme
3. **client.tsx**：ScriptViewInjected 加 toggleSidebar；scriptViewInjected 返回 ctx.layout.toggleSidebar；FemEditorView 传 onBackToShell
### 交互语义
手机进 Fem 编辑器标签页 → 自动全屏（zIndex 900 盖 dsh 外壳）；← 返回键 → 退出全屏 + dsh 侧边栏弹出；底部标签=仓库|项目|属性|设置。
### 验证
- npm run build 通过（lib/client.js 452.6kb，含 设置/新建SOUL/返回/onCycleTheme/toggleSidebar）
- 备份：MEOW_backups/{mobileView,FemWorAuto,client.tsx}.bak-20260818-073226
- 待实测（风险点=退出全屏后 MobileLayout fixed 层与 dsh sidebar 的层级关系）：3081 DevTools 375px 全屏→返回键→sidebar 可见性；手机真机 8443

### 迭代 2（2026-08-18，用户实测"侧边栏确实被挡住了"后的修复）
**根因**：MobileLayout 根容器写死 position:fixed inset:0；退出全屏后 zIndex=auto，仍以 fixed 层盖住视口——dsh sidebar 是 AppFrame grid 普通流列（z-index auto，DOM 靠前），被后置的 fixed 层覆盖。
**方案（不改 dsh 本体）**：MobileLayout 加 fixedMode prop（默认 true）；插件模式非全屏 → fixedMode=false → 根容器 position:absolute，相对 FemEditorView 容器（client.tsx 容器 div 加 position:relative）——只占 conversation 列区域，sidebar 天然可见；全屏仍 fixed 900。FemWorAuto 传 fixedMode={plugin ? mobileFs : true}（独立模式恒 fixed）。build 通过 452.8kb；备份 *.bak-20260818-073852。待实测：返回键后 sidebar 应可见且 femGen 缩在标签页容器内。

### 迭代 3（2026-08-18，用户实测"现在看着非常好"后的连贯性优化）
用户反馈（原话）："点了左上角返回之后，dsh的壳子出来了，那么左上角返回应该变成一个向右的箭头（全屏），此时再点一下，dsh壳子应隐藏，同时左上角变成向左按钮（返回），这样操作逻辑才连贯"。
**改动**：MobileTitleBar 加 onExpand（→ 全屏键），左侧按钮三态：onExpand 存在 → →（回全屏）；否则 onBack 存在 → ←（返回）；否则无。MobileLayout 加 onExpand prop，按 fixedMode 分发（fixedMode→onBack，非 fixedMode→onExpand）。FemWorAuto 传 onExpand={plugin?()=>setMobileFs(true):undefined}。build 通过 459.7kb；备份 *.bak-20260818-090254。交互闭环：全屏（←）⇄ 容器内（→）。

### 迭代 4（2026-08-18，手机项目面板输入框重叠修复）
用户反馈（原话）："Version和owner的输入框重叠了，这种输出框都在重叠"。
**根因**：common.jsx 的 inp 样式 width:'100%' + padding 7px 10px + 边框，缺 boxSizing:'border-box'——实际宽度=容器宽+22px 溢出；并排字段（Version/Owner、Database/Session）在手机窄容器（Field flex:1 各约 170px）里两个 input 各向外溢 → 重叠；桌面宽容器轻微越界不明显。
**修复**（1 处全局）：common.jsx inp 加 boxSizing:'border-box'。textarea 等 {...inp} 派生样式一并生效。build 通过 459.7kb；备份 *.bak-20260818-091606。

## 2026-08-18 actor Tools UI 改版（全或无三态，替代具体工具勾选）

用户需求（原话要点）："tools的ui还是旧版的选择具体工具，我们改一下。我们新版的代码支持的实现是，全或无。打开工具就是全部都有，关闭工具就是全都没有……给他三个选择框：所有工具，关闭工具，输入工具，如果点输入工具，就允许输入文本，在文本里用户自己写工具列表。然后图生文本的时侯，这里ui的选择要正确的填写在剧本文本里。不选就是没写工具这个参数。文本生图的时候，剧本的文本要正确映射到ui这里，剧本没写则这里不选。如果不写工具参数，就默认打开所有工具"。
### 调研确认（零后端改动）
- compiler FEM_parser.py 735-772：tools: true/false → tools_enabled 布尔；tools = [list] → 白名单；未声明 → tools_enabled=None（宿主默认）
- femGen femParser.jsx 546-607：解析 true/false/数组；619 未声明 → []
- femGenerator.jsx 119-124：已正确输出 tools: true / tools: false / tools = [a, b] / 空数组不写
- host index.ts:109 defaultActorTools 默认 true（未声明=全开）✓ 用户预期符合
### 修改明细
1. **projectPanel.jsx** Tools 区：checkbox 具体工具列表 → 三态 radio（所有工具=true / 关闭工具=false / 输入工具=数组）+ 输入工具时显示文本框（逗号分隔，解析按逗号 split+trim+filter）；未声明（[]）三态均不选
### 验证
- build 通过 460.7kb（产物含 toolsMode 三态逻辑 + radio）
- 备份：MEOW_backups/projectPanel.jsx.bak-20260818-092154
- 待实测：画布 actor 三态选择 → 生成剧本 tools 参数正确；解析剧本（true/false/列表/未写）→ UI 回填正确

### 修复（2026-08-18，用户实测两个问题）
**① "输入工具无法选中也无法输入文本"**：根因=选中「输入工具」时 tools 置 []（空数组），但 toolsMode 判定要求 length>0 → 空数组被误判为「未选」，radio 弹回、文本框不渲染。修复=projectPanel 加 UI 态 customSel（按 actor 名记录「输入工具」选中），空数组在选中态下仍保持 custom；切到 all/off 时清除该标记；解析出非空数组仍走派生 custom。
**② "femgen代码区输入文本时页面自动放大"**：iOS Safari 对 <16px 输入控件聚焦自动整页放大（meta user-scalable 自 iOS 10 被忽略，唯一可靠路径=字号≥16px）。修复=common.jsx FontStyle 加 @media (max-width:767px) 下 [data-fem-theme] input/textarea/select:focus { font-size:16px !important }（聚焦临时 16px 抑制缩放，失焦恢复；仅限 femGen 容器，桌面宽视口与 dsh 外壳不受影响）。
build 通过 462.0kb；备份 *.bak-20260818-092646。

## 2026-08-18 femParser 中文节点名规范化修复（par/for 体中文裸节点报错）

用户剧本（群聊室 par 并行线）报错："第 33 行: 未识别的流程语法: '随机等一会儿 -> AI发言'"。
### 根因（esbuild 打包 + 日志实测定位）
流程行「全局裸引用规范化」（femParser.jsx 1140-1183）只把纯 ASCII 标识符（/^[a-zA-Z_]\w*$/）转成 [label]，中文节点名（随机等一会儿/AI发言）走"原样保留"分支；par/for 分支处理体行时把剩余 body 递归进 parseFlowSection，递归要求行首 [label]——中文裸名行首不命中任何分支 → 1751 兜底报错。goblin-v2 等能跑是因为节点都带方括号或 if。
### 修改明细
1. **femParser.jsx**（1171 行 1 处）：纯标识符正则 /^[a-zA-Z_]\w*$/ → /^[\p{L}_][\p{L}\p{N}_]*$/u（Unicode 字母，含中文）。mainflow 裸中文节点也统一成 [label] 形式。
### 验证
- 群聊室剧本 parse OK：module 群聊 nodeDecls=随机等一会儿/AI发言/IN/PAR[PAR] cond=@speaker in [@阿明,@阿芳,@阿强]/PAR_out，edges=IN→PAR→随机等一会儿→AI发言→PAR_out→IN（循环闭环）
- 回归：python/ 与 user_data/projects 全部 .fems（18 个）——15 正常剧本全过，3 失败均为故意负面用例（未声明变量/裸字符串字面量，预期报错）✓ 无回归
- build 通过 462.0kb；备份 *.bak-20260818-103639
- 注意：tests/femParser.test.mjs 是 esbuild 打包产物（未跟踪），测的是旧代码，需重打才反映本修复

## 2026-08-18 循环回流实测 + par/for 迭代器内联列表修复（FEM_runtime.py）

用户问：循环回 [IN]/回 [START] 是否支持（以前有 bug）。
### 实测结论（bridge 起新进程）
- **回 [IN]**（module 内 par 循环、主流程只指向 module、无 OUT）：允许 ✓（vars 声明列表版 12454 步无限流转无错误；checkpoint 记录模块态在 [IN]，恢复回到 [IN]）
- **回 [START]**（mainflow 循环）：允许 ✓（6.8 万步流转无错误）
- 引擎对节点重复进入无循环上限；module 无 OUT = 永不正常结束（靠 stop/中断），设计允许
### 新坑 + 修复：par/for 迭代器内联列表字面量
- 用户群聊室剧本 `par @speaker in [@阿明, @阿芳, @阿强]` 运行报「无法求值表达式: [@a1, @a2]」
- **根因**：FEM_runtime.py `_eval_iterable_expr`（1943）用 **Python eval()** 求值迭代器——`@a1` 中 @ 是 Python 装饰器符号 → SyntaxError；vars 声明的 members=[@a1,@a2] 在解析阶段已转成真列表，eval('members') 只查变量所以没事
- **修复**（1977-1981）：eval 失败回退 `self.eval_expr(expr)`（FEM 表达式求值器 1892-1897 支持列表字面量 + @ 引用，_split_items 深度感知切分），再失败才报原错
- **验证**：内联列表版 _loop-in.fems 修复后 13303 步无 flow_error（par 双线 node_start/assign_result 各 26602）；**pytest 43 passed**（52s）无回归
- 备份：MEOW_backups/FEM_runtime.py.bak-20260818-104614
- ⚠️ 3081 的 bridge 是插件启动时 spawn 的持久进程，**改引擎代码需重启 3081 生效**（本地 bridge 新进程即时生效）

## 2026-08-18 剧本 source 字段接 dsh 模型调用（编译期校验 + 前端下拉）

用户需求（原话）："actors @ai定义区，有一个source字段，我是希望这里能写AI模型……用户实际上在dsh里支持的模型列表，应该是dsh这边来提供的。我是想把fem剧本里的source字段和dsh调用模型的实际行为接上"；拍板："方案C（兼容双写）：裸 id 走默认 provider；带 / 则显式指定 provider。裸 id 在默认 provider 下查不到 → 报错提示'请写成 provider/model 形式'"；"报错停节点（显式提示'模型不存在，可用列表：…'）而且这是编译的时候就要返回的，而不是运行的时候发现不对"；"source 文本框改成下拉~并且显示为provider/model"；"throttle 按真实 provider 分桶"。
### 链路（改造前）
生成端输出 source → 前后端解析进 ActorDef.source → FEM_runtime._resolve_ai_source **仅用于 throttle_llm 限流分桶（语义错位：模型名当 provider key）** → 插件模式 ai_request 事件**不带 source** → 宿主 runAiSubagent 固定用配置 resolved.model（断点）→ 直连模式同样固定。dsh 侧能力：ctx.llm.listProviders()/listModels()/resolveModelInfo()。
### 语法规范（定稿）
`source:模型id`（裸 id）= 默认 provider（配置 dshProvider）下查；`source:provider/模型id` = 完全指定；省略 = 插件默认模型；写错 → 编译期报错（信息带可用列表）。human 的 source 数字（user 身份）语义不动。blueprint 不校验。
### 修改明细
1. **femCompiler/FEM_parser.py**：parse_script 加可选参数 models（None 不校验，旧路径零影响）；新增 validate_actor_sources——遍历 AI actor，裸 id 查 defaultProvider、provider/model 全表查，失败 raise ValueError（`ai @X: source "..." 不是可用模型。可用列表：...`）
2. **femCompiler/FEM_runtime.py**：新增 _resolve_actor_def（抽公共 actor 解析：动态 @变量 + as_actor 回退，复用三处）；_invoke_ai_llm 的 ai_request payload 加 source 字段（宿主选模型用）；_resolve_ai_source 改为返回真实 provider（source 含 / 取前半，否则回退 user_api_provider）——throttle 按 provider 分桶；新增 _resolve_ai_model（直连模式 source 覆盖 model）
3. **src/index.ts**：新增 collectLlmModels（ctx.get('llm') 聚合 listProviders+listModels，llm 缺失/单 provider 失败兜底默认，绝不整体失败）；新路由 GET /dsh-femwa/models（前端下拉数据源）；startRunOnSession run 参数带 models（引擎编译校验白名单）；runAiSubagent 新增 resolveSourceModel——source → agentOptions(provider, model)，空用配置默认
4. **femGen/src/projectPanel.jsx**：导出 useModelList（fetch /dsh-femwa/models）+ sourceOptions（空默认 + 全部 provider/model + 原值不在列表时追加防丢）；ai 类型 source 文本框 → 下拉（显示 provider/model），human 保留文本框（placeholder 改 数字ID）；新增 actor 默认 source 'deepseek' → ''（旧默认值裸 id 在 deepseek-official 下不存在，会触发编译错误）
5. **femGen/src/mobileView.jsx**：同款下拉改造
6. **语法文档.md**：5 节 actors 示例更新（裸 id + provider/model 双写示例）、source 说明重写（三态语法 + 编译期校验）、blueprint 示例 source 改合法值、静态属性表 source 示例更新
7. **README.md**：剧本语言行补 source 一句话说明
8. **tests/test_source_validate.py**（新增 11 用例）：裸 id 命中/未命中、provider/model 命中/未命中（provider 错/模型错）、空跳过、models=None 兼容、human 数字跳过、blueprint 跳过、报错信息含可用列表、validate_actor_sources 直接调用安全
### 验证
- pytest 54/54 通过（43 旧 + 11 新）
- host build.mjs 通过（lib/index.js 100.3kb 含 collectLlmModels/resolveSourceModel/models 路由）；femGen vite build 54 modules；重打 lib/client.js 463.8kb 含 useModelList/sourceOptions
- 备份：MEOW_backups/{FEM_parser,FEM_runtime,index.ts,projectPanel,mobileView,语法文档,README}.bak-20260818-20260818-111722
- ⚠️ 待 3081 重启实测：①运行带不存在 source 的剧本 → 启动即报编译错误带可用列表；②下拉显示 dsh 模型列表、ai/human 分派正确；③source 选模型 → 子代理实际用该模型（日志）；④旧剧本裸 id 不在列表 → 编译期报错提示写法

## 2026-08-18 scope: all 保留字段（全可见，后端解析 + 前端透传）

用户拍板（原话）："哦那你给我加个保留字段吧，就all，scope: all 全可见。在后端parser支持一下编译，在前端认识一下这个词别报错"。
### 背景
实测确认 scope: all 原先**不是**保留字段：FEM_scope_resolver.resolve_scope 只认 [@列表]/vars 变量/+ 连接，'all' 被当变量名 → flow_error「变量 'all' 未在脚本的 vars: 中预声明」，大小写都不行；且不写 scope ≠ 全可见（_build_scope 空 scope 自动注入发言者+meta.owner，仅发言人+owner 可见）。
### 修改明细
1. **femCompiler/FEM_scope_resolver.py**（2 处）：resolve_scope 与 scope_str_to_actor_list 开头特判 `scope_str.strip().lower() == 'all'` → 展开全部 actors（resolve_scope 按 ai/human 分类 user/soul；to_list 返回全部 @actor 名）。大小写不敏感（all/ALL/All/带空格）
2. **语法文档.md**：scope 段落补 all 保留字段说明 + 「不写 scope ≠ 全可见」提醒
3. **前端零改动**（确认 5 个处理点全为字符串透传：actionModal 输入框 / femParser 787-788 原样存 / femGenerator 51 原样输出 / FemWorAuto+mobileView 只读展示 / host 631 用引擎展开的 scope 数组）
### 验证
- 单测：resolve_scope('all'/'ALL'/'All'/' all ') → 全部角色正确展开（user/soul 分类）；scope_str_to_actor_list('all') → 全 @actor 列表；原列表形式无回归
- 端到端：scope: all 剧本（human 节点）→ human_wait 事件 scope=["@a1","@a2","@h1"] 全展开，无 flow_error
- pytest 54 passed 无回归
- 备份：MEOW_backups/FEM_scope_resolver.py.bak-20260818-112151
- ⚠️ 引擎改动需重启 3081 生效

## 2026-08-18 议题讨论会示例剧本检查 + 引擎直连模式 import 修复（FEM_runtime.py）

用户教学示例剧本（for 轮番讨论/par 独立探索/scope 分离/人类拍板）跑通性检查。
### 剧本检查结论（用户示例，非本仓库剧本）
- 前端 femParser parse OK：actors tools:true、mainflow 结构全对（START→开场→pos→PAR→调查→PAR_out→准备发言→FOR→发言→FOR(back)→judge→汇总/回pos[agree==false]→final→END/回START[通过==false]）
- 引擎 parse_script OK：中文变量（通过）、out 带类型（agree(bool,"是否达成一致")、通过(bool,"是否批准")）、prompt: | 管道多行、scope: AImembers/@speaker/all/[@主持人,@用户] 全部解析正确
- 结论：剧本本身编译全过，语法均为合法特性
### 发现并修复引擎 bug：直连模式 call_ai_with_blocks NameError
- bridge 直连跑 → flow_error `name 'call_ai_with_blocks' is not defined`
- **根因**：FEM_runtime.py `_invoke_ai_llm`（2429）直连分支（2482-2493）引用 call_ai_with_blocks，但 import 只在另一函数 `_exec_ai`（2567）——函数级 import 局部作用域，此处 NameError；3081 走 dsh 子 agent 后端（_dsh_ai_backend）不触发，现有测试剧本均无 AI 节点，直连路径从未被覆盖
- **修复**（1 处）：直连 else 分支内补 `from femBridges.llmBridge import call_ai_with_blocks`（保持函数级局部 import）
- **遗留（环境限制非剧本问题）**：直连模式无 API key 时 call_ai_with_blocks 返回 None → 上层正则崩「expected string or bytes-like object, got NoneType」——本地 bridge 无 key 属预期；3081 dsh 后端模式不经过此路径。是否改为清晰报错待用户判断
### 验证
- NameError 修复后错误推进到 key 检测阶段（证明 import 生效）
- pytest 54 passed 无回归
- 备份：MEOW_backups/FEM_runtime.py.bak-20260818-113246
- ⚠️ 待 3081 重启后以 dsh 后端模式实测议题讨论会

### 补充修复（2026-08-18，用户提醒"得和dsh运行的模式分清楚"）
用户指出：dsh 运行（3081）就是无 key 的（key 在 dsh 侧），若"无 key 报错"不分模式会导致 dsh 一直报错。
**模式隔离确认**：host `dshAiBackend` 默认 true（index.ts:101）且 run 命令必传（2123）→ bridge 设 `_dsh_ai_backend=True`（femwa_bridge.py:166）→ `_invoke_ai_llm` 2447 走 ai_request 分支，**永不进入 call_ai_with_blocks**；只有显式 `dshAiBackend: false` 才走直连（需要 key）。
**修复**（llmBridge.py 4 处）：未检测到 provider / 缺 API Key / 缺模型名 / 缺 URL 的 `return None` → `raise ValueError` 清晰报错（文案含「dsh 子 agent 模式（dshAiBackend=true）无需 key，不走此路径」）。
**验证**：直连无 key → flow_error 变为清晰 key 错误（不再「expected string or bytes-like object」正则崩）；pytest 54 passed 无回归。备份 *.bak-20260818-114104。

## 2026-08-18 主模型新增 femwa-script 工具：查看本会话挂载的剧本内容

用户需求：给 dsh-femwa 加一个 AI 能用的工具，查看本 session 挂载的剧本内容。
### 修改明细（2 文件，均备份 MEOW_backups/*.bak-20260818-125110）
1. **src/tools.ts**：
   - `FemwaToolDeps` 新增 `readScript(sessionId)` 依赖（返回 `{path?, text?, finalText}`）
   - 新增 `femwa-script` 工具 schema：无参数，返回剧本全文 + 来源（file=文件地址 / session-text=会话内原文）+ 行数；未挂载剧本时明确报错
   - register 支持可选 renderText 覆盖（剧本全文以纯文本呈现，不走 JSON.stringify 转义）
2. **src/index.ts**：
   - `toolDeps.readScript` 实现：读会话剧本记录 + `readSessionScriptText`（text 优先 → path 文件）
   - **顺手修正一致性隐患**：`toolDeps.runScript`（femwa-run 省略 scriptPath）原为 path 优先（有地址就读文件），与引擎「永远跑前端文本」/用户三态定稿（text 优先）相悖——统一改用 `readSessionScriptText`，保证 femwa-script 看到的 = femwa-run 实际跑的
### 验证
- npm run build 通过（lib/index.js 102.6kb，含 femwa-script 注册 + readScript 依赖）
- 工具仅 Fem 主会话可用（复用 callerSessionId 校验），子代理（角色）不可调用
- ⚠️ 待 3081 重启生效（junction 指向本仓库，重启即加载新 lib）

## 2026-08-18 多地点并行线 flow 验证失败：分支饿死（引擎 bug 定位，未修）

用户要求：town 示例改 @assign 验证 flow（两个地点 + 一个 agent 移动 + par 并行），"起一个fem窗，用最简单的流程……看能不能成功移动到另一个地点还能看见他。每个地点同时assign个啥，这样就知道par他们一起运行了"。
### 验证剧本（_town-move-test.fems，@assign 无 AI）
两地点线：`[START] -> 酒馆标记 -> par @speaker in 在酒馆的人: -> 阿明移动 -> -> [START]` + `[START] -> 公园标记 -> par @speaker in 在公园的人: -> 公园看见 -> -> [START]`
### 实测结果（bridge 直连，统计 5 秒）
- ✅ 阿明移动成功：remove/add 赋值正确（在酒馆的人=[] / 在公园的人=['@阿明']）
- ✅ 单线循环正常（酒馆线 13763 轮，checkpoint 41289 次，无 flow_error）
- ❌ **公园线饿死**：fork 网关只触发 1 次（主流程首次回 START），Task-3（酒馆）创建即无限循环、Task-4（公园）从未执行（公园标记 0 次）
### 根因（日志 + 探针定位）
1. 主流程回 [START] → 1188-1196 多出边 fork → _run_fork 并发 Task-3/4 ✓（唯一一次 fork）
2. **分支内部回 [START] 不再 fork**（"进入 fork 网关"统计=1）——分支 _execute_path 内 START 的处理与主流程不一致（机制待深挖，探针确认 [90] START 执行后无出边/fork 日志直接续跑酒馆线）
3. **协作式事件循环饿死**：Task-3 内部全为立即完成的 await（assign/空 par/join），永不真正挂起 → asyncio 轮不到 Task-4
### 结论
- 剧本语法全对（编译/移动/单线循环正常）——**引擎缺陷**：fork 是"一次性并发+等待全完成"语义，不适合"常驻并行线 + 回 [START]"设计；三地点 town 示例会同样饿死（只有第一线活）
- 修复方向（未实施，待用户拍板）：A. 分支内回 [START] 与主流程一致走 fork；B. 空 par/join 时 await 让出事件循环防饿死；C. 剧本结构改用显式 fork/join 常驻并行（workaround）
- 探针已移除，FEM_runtime.py 恢复干净（本次无代码改动残留，仅 113246/114104 两处既有修复）

## 2026-08-18 femwa-run 升级为四动作控制工具（from_scratch/stop/pause/resume）

用户需求（原话）："run本来写的应该是直接只有run吧？那么我们把run改为支持参数，run_from_begining（啊这个名字有点丑，有没有更好的表述？但必须强调从头，不然会和resume搞混）， stop， pause，resume必须传参数，且system prompt或者工具schema要改，要说明白，run的四个参数分别代表什么，让ai一看就明白。现在就把工具端4个都支持了。pause和resume其实femgen本身就是支持的，稍后应该很好接入。"
### 设计定稿
- 命名：`from_scratch`（地道英文「从头开始」，与 resume 字形语义均不混）替代 run_from_beginning
- `femwa-run` 不再收 scriptPath（剧本地址只在 femwa-mount 时传），改为必填 action 四选一：
  - `from_scratch`：从头运行已挂载剧本（清 checkpoint，reset=true）
  - `stop`：停止当前运行（保留断点，可 resume）
  - `pause`：暂停（bridge 现有语义；引擎真实现后无缝升级）
  - `resume`：从断点继续（不 reset 的 run，前端「继续」同款 checkpoint 续跑链路）
- schema description 逐动作写明含义（AI 一看就明白）；工具数量保持 3 个（mount/run/script），未来 pause 真实现也无需新增工具
### 修改明细（2 文件，备份 MEOW_backups/*.bak-20260818-134214）
1. **src/tools.ts**：FemwaToolDeps 接口改为 runScript(sessionId)/stopScript/pauseScript/resumeScript 四方法（原 runScript 带 scriptPath 参数删除）；runTool schema 重写（action 必填 enum 四值 + 逐动作描述）；注册逻辑 switch 分发四动作并返回各自语义 note
2. **src/index.ts**：抽出 `resolveMounted` 公共函数（会话校验+读挂载剧本 text 优先+编译 check 校验，from_scratch/resume 共用）；runScript=resolveMounted+startRunOnSession(reset=true)；resumeScript=resolveMounted+startRunOnSession(reset=false)（checkpoint 续跑）；stopScript/pauseScript=runState 校验+bridge.send（无运行时报错）
### 验证
- npm run build 通过（lib/index.js 105.1kb）
- 四动作分发逻辑 14/14 测试通过（缺/非法 action 拒绝、stop/pause 需 running、from_scratch/resume 不要求 running、reset 语义正确）
- bridge pause 现状=runner.stop()（半实现，README 已知限制）；resume 走 checkpoint 续跑链路（可靠）
- ⚠️ 待 3081 重启生效

## 2026-08-18 pause/resume 与 femGen 按钮状态机对齐（flow_stopped 携带 paused 标记）

用户要求（原话）："femgen右上角还有个按钮，会切换运行、暂停、继续的状态。你也可以研究一下它的相关链路。我们这个pause和resume无疑和他有关，可以借用它的链路，也要注意这两者别打架，要状态一致"。
### 链路研究结论
- femGen 右上角三态按钮（mobileView.jsx L270-296 → FemWorAuto.jsx handlers）：
  - 「运行」（idle）→ onRun(fem, {reset: flowStatus!=='paused'}) → reset=true 从头
  - 「暂停」（running）→ POST /dsh-femwa/pause → bridge pause（=stop 半实现）
  - 「继续」（paused / running-无活跃节点）→ handleRunWorkflow() → reset=false 断点续跑（**与工具 resumeScript 同链路**）
- 工具端已对齐：resumeScript=resolveMounted+startRunOnSession(reset=false)（同「继续」）；stop/pause 走 bridge 命令（同 /stop、/pause 路由）
### 修复的状态不一致（根因）
- 暂停与停止共用 flow_stopped 事件；前端无条件 setFlowStatus('idle') → 暂停后按钮变回「运行」，用户/工具以为暂停了但点「运行」会 reset=true 从头（断点白留）；pausedByUser 在事件回调里读完即清，前端无法从事件流得知"这次停止是暂停"
### 修改明细（2 文件，备份 MEOW_backups/*.bak-20260818-134736）
1. **src/index.ts**：dsh-femwa/event 回调里 flow_stopped 事件附加 `paused: runState.pausedByUser` 标记（broadcastSse + lastEvents 重放都携带）——暂停/停止由宿主判定，前端可见
2. **femGen/src/FemWorAuto.jsx**：flow_stopped 分支 `setFlowStatus(data?.paused === true ? 'paused' : 'idle')`——暂停显示「继续」、停止显示「运行」
### 验证
- npm run build 通过（lib/index.js 105.2kb + lib/client.js 含 paused 判断）
- 状态机 7/7 测试通过：暂停→前端 paused→继续 reset=false / 停止→idle→运行 reset=true / flow_done→idle / 重放 flow_stopped(paused=true)→paused
- ⚠️ 待 3081 重启生效

## 2026-08-18 回多出边节点编译期报错 + 常驻并行线修复（fork 饿死闭环）

用户拍板（原话）："其实禁止回到这种节点是对的。我们该改剧本，在start处fork，每个fork加个不同的空节点，让他们回这个空节点，这不会爆炸。那么对于回公共多出边节点这件事其实应该报错，能检测到这种情况吗……该节点有多个'出边'，不能回到这种节点。原因是，每次回到这里往下运行都会从一变成多分支，分支数会爆炸。建议在本节点之后的分支中加空节点，让他们回到空节点。"
### 问题复盘（实测定位三连）
1. 分支执行器 `_execute_path`（1515）1586 行只走第一条边（无多出边 fork）——分支内回任何多出边节点（START/hub）并线
2. **入口 [START] 特殊处理**（1097-1103）：入口不 fork 只走第一条边——START 直接多出边不会 fork
3. **协作式调度饿死**：assign 等快速节点循环永不挂起 → fork 出的其他线饿死（hub 锚点结构实测：公园线 32765 次独占）
### 修改明细
1. **编译期检测（femParser.jsx validateFlow + FEM_parser.py validate_flow_reentry）**：无条件出边 ≥2 且有「回流入边」（排除 [START]/[IN] 入口边）的节点 → 报错（用户文案）；排除 for/par/fork/join 网关（迭代/并发语义）；重复边去重（par 出口链重复生成）
2. **FEM_runtime.py 协作式让出**：_execute_flow 与 _execute_path 循环每节点后 `await asyncio.sleep(0)`——事件循环公平轮转，常驻并行线不再饿死
3. **examples/group-chat.fems + town.fems 改 hub+锚点结构**：`[START] -> [hub]`（入口单边）→ hub 一次性 fork 各线 → 每条线回自己的空节点锚点（[群聊环]/[人类环]/[酒馆环]/[公园环]/[市场环]）
4. **tests/test_town_structure.py** 同步新结构（hub+锚点）
### 验证
- hub+锚点 assign 测试：**三条线均衡并行**（酒馆 6216 / 公园 6218 / 市场 6217，fork=1，阿明移动 1 次）✓ 闭环
- 检测：town 旧版（回 START）/hub 回流版报错 ✓；goblin-v2/discussion/议题讨论会/群聊室新版不误伤 ✓
- pytest **80 passed**（含 sleep(0) 与检测改动回归）；build 通过 lib/client.js 465.4kb
- 备份：*.bak-20260818-141218（femParser/FEM_parser）/ *.bak-20260818-141437（examples）
- ⚠️ 引擎改动需重启 3081 生效

### 补充修复（2026-08-18，用户拍板"start多出边应该是支持的"）
**入口 [START] 多出边 fork 修复**：原 _execute_flow 1097-1103 入口 [START] 特殊处理只走第一条边——START 直接多出边（无回流）会**静默吞掉其余分支**（实测线B 0 次且 flow_done，违反"不静默兜底"原则）。修复：入口 START 多出边 → `await self._run_fork(...)`（与循环内语义一致，一次性 fork；_run_fork gather 等分支完成，分支错误聚合上报），单边仍走第一条。验证：START 双出边剧本线A/线B 各 1 次 + flow_done ✓；hub+锚点三线并行无回归（5251/5253/5253）；pytest 80 passed。备份 *.bak-20260818-143420。

## 2026-08-18 导演手册注入完善 + soul 非必须语义 + 编译期 soul 校验

### 背景（用户决策原话）
- 注入分层："剧本角色的system prompt注入我们还没写呢……主模型是导演手册，我们正在写。确实是分开的。"——本次只写主模型导演手册（persona + femwa:docs section）
- 语法内联："我建议内联速查表（那我们还得写个速查表）、最小模版，并指路更多模版推荐ai自己去看，并说更多语法细节去看文档，再指路文档。"
- soul 语义："最小模版要不就别写soul了。既然不写soul能运行，有的时候ai只是用fem跑个goal模式或者子代理的剧本，根本不需要多么复杂的角色设定。""soul非必须，只在有角色设定的剧本里使用soul也可以。""但是soul写错应报错，并且编译期就应该报错，并且把错误返回给ai……报错文案就是：soul id不存在，哦同时还要输出行号和错误的那行内容"
- 会话模式措辞（用户指正）："剧本运行在后台，你不会被剧本实况打扰。（就是说，用户发消息他是能收到的，所以不能说收不到消息）"
- 工作流双模式："看剧本是为了干啥。如果用户只想要结果，就模型自己跑。如果用户想要过程（比如想玩狼人杀），那就用户参与。"

### 修改明细（6 文件 + 12 测试剧本，备份 MEOW_backups/*.bak-20260818-150116）
1. **dsh-home/.agent-presets/dsh-femwa/agent.cordis.yml**：persona 全文重写（`>-` 折叠 → `|-` 字面块保留模板换行）：新增【这是什么模式】（心智模型：actors/action/mainflow/scope/vars + "上下文不是变量"哲学）、【语法速查表】（14 行内联）、【关于 soul】（非必须；无 soul=裸执行者看全量上下文）、最小模板（Goal 模式裸 actor 版，无 session=new 无 soul）、【运行】双工作流（结果导向自主闭环 / 过程导向用户参与）+ 三工具教学；【会话模式】修正"剧本后台运行不被打扰、用户消息能收到"；保留用户定稿【剧本存哪】【运行出错时】
2. **src/index.ts**：femwa:docs section 文案更新（速查表/模板已在 persona；冷门语法指文档；写复杂剧本先通读 examples/）
3. **femCompiler/FEM_parser.py**：① eval_actors 支持裸 actor（`ai @执行者` 无 `=`，soul/source=None——原实现静默跳过该行导致角色不存在）；② 新增 `validate_actor_souls`（normalize 前扫原始文本，行号对应用户所见；soul 不存在 → ValueError 一次列出全部错误：行号+该行原文+soul id+可用列表；soul_checker 为 None 跳过保持纯解析可测）；③ parse_script 签名加 `soul_checker` 可选参数；④ typing import 补 Callable
4. **femCompiler/db_utils.py**：新增 `list_all_soul_ids()`（校验报错可用列表用）
5. **python/femwa_bridge.py**：新增 `make_soul_checker()`（check_soul_id_exists + 挂 `_soul_ids` 可用列表）；check/run 两处 parse_script 调用注入
6. **femBridges/ContextExample.py**：`_get_records_visible_to` 无 user 无 soul → 不过滤（no_filter，本 session 全部可见）——修复裸 actor 上下文恒空（goal 模式循环失忆）实测坑
7. **12 个测试/示例剧本 soul 更新**：旧式数字 soul（soul:1/2/3/4/5/9，默认库不存在）→ 真实 id（the1stlittlesoul/littlecat/AI助手/Portia/debugmanager/human）——新校验下数字 soul 编译报错（预期行为变化）；goal-mode.fems 改裸 actor 与 persona 模板一致

### 验证
- pytest **80 passed**（基线对比确认 13 failed 系 soul 校验拦截旧式数字 soul，更新剧本后全恢复）
- 探针：裸 actor 解析 ✓（soul=None）；soul 校验报错含行号+错误行+可用列表 ✓；好 soul 通过 ✓；无 checker 跳过 ✓；examples 4/4 真实 DB 校验通过 ✓；无 soul 上下文 4438ch 全可见 / 有 soul 3717ch 过滤不变 ✓
- npm run build 通过（lib/index.js 105.4kb，docs section 新文案已入产物）
- ⚠️ 待 3081 重启生效（persona 新会话加载 + 引擎校验）
- 已知后续：femwa-soul 工具（list/create）延后写；"可用 femwa-soul create 新建"提示放工具 prompt 不放报错文案

## 2026-08-18 femwa-soul 工具（主模型角色库管理，list/create 双动作）

用户拍板（4 点）：①单个工具带 action 参数（list/create 二选一），不拆两个；②list 返回精简（soul_id+名字，不含描述）；③create 三字段全必填（soul_id/soul_name/description）；④测试=真实库建测试 soul 留着。
### 修改明细（4 文件，备份 MEOW_backups/*.bak-20260818-150116 已含）
1. **femCompiler/db_utils.py**：新增 `list_souls()`（精简 soul_id+soul_name，按 idx 排序）
2. **python/femwa_bridge.py**：新增 `list_souls` 命令；`create_soul` 命令加存在性检查（重复 soul_id → 报错"已存在"，防 AI/前端重复插入垃圾行；DB 无唯一约束，此前重复 create 会静默插入）
3. **src/tools.ts**：FemwaToolDeps 加 `soulList()`/`soulCreate()`；注册 `femwa-soul` 工具（action: list/create；create 校验三字段必填 + soul_id 不含空格/逗号——剧本 soul:xxx 引用格式；renderText 组装角色清单文本；仅 Fem 主会话可用同三件套）
4. **src/index.ts**：toolDeps 实现 soulList（bridge list_souls）/soulCreate（bridge create_soul，user_id 固定 u001，与前端 soul 弹窗同链路）
5. **agent.cordis.yml persona**：【关于 soul】补"写剧本前先用 femwa-soul list 查库选角；库里没有的角色先用 femwa-soul create 新建"
### 验证
- npm run build 通过（lib/index.js 109.4kb 含 soul 工具）
- bridge 命令级测试：list_souls 返回 11 个角色 ✓；create 新建成功且立即可见 ✓；重复 create 拦截报错 ✓
- pytest 80/80 回归通过
- 测试残留：testsoul-femwa / testsoul-femwa2 两个测试角色留库（用户拍板留）
- ⚠️ 待 3081 重启生效（工具注册 + bridge 新命令）

## 2026-08-19 子代理默认模型跟随主模型（空 source 语义修正）

### 需求（用户原话）
"我希望开启的子Agent默认和主模型同一个模型，除非剧本里面指定。DSH好像有个bug，就是开启的子Agent它默认的好像是Pro，我主模型明明是Flash的。……就算没有bug，咱们也可以防他一手。就是如果不指定的话，那么必须跟主模型同一个模型。"

### 根因
空 source 时 resolveSourceModel 返回插件配置静态默认（resolved.dshProvider/resolved.model，默认 deepseek-official/deepseek-v4-flash）——子代理模型 = 插件配置而非主模型，两者一致纯属默认值巧合；UI 切换主模型后立即脱钩。dsh 本体子代理链路（resolveChildAgentOptions）在父 agent options 无模型时落部署隐式默认（群友报告"子代理默认 Pro"即此类）。修复=空 source 永远显式传主模型，堵死隐式默认路径。

### 修改明细（4 文件，无引擎改动）
1. **src/index.ts**：新增 `resolveMainModel(parent, defaultModel)`——① 主会话最近一次请求头 `session.requestHeader()?.config`（含 UI 会话内切换，对齐 dsh web selectionFor 语义）→ ② `agentDefaultModel.currentSelection()`（用户保存默认）→ ③ undefined 回退配置；`resolveSourceModel(resolved, source, mainModel?)` 空 source 优先 mainModel；runAiSubagent 的 subagents.start 前解析并传入。显式 source（裸 id/provider 双写）逻辑原样不动，编译期白名单校验不变。
2. **femGen/src/projectPanel.jsx**：sourceOptions 空项 label "默认（插件配置模型）" → "跟随主模型（默认）"。
3. **语法文档.md**：省略 source 语义改为"跟随主模型（主会话当前实际使用的模型，含 UI 内切换；取不到时回退用户保存的默认模型）"。
4. **README.md**：剧本语言行 source 说明同步；配置表 dshProvider 说明补"空 source 跟随主模型"。

### 验证
- npm run build 通过（lib/index.js 体积含 resolveMainModel）；femGen 前端重打 lib/client.js
- ⚠️ 待 3081 重启实测：①无 source 剧本 → 子代理 request/header model=主模型（deepseek-v4-flash）；②对照组 source:deepseek-official/deepseek-v4-pro → 仍精确用 pro（对照实验法沿用 2026-08-18）

### 实测结果（2026-08-19 晚，用户手动重启 3081 已加载新构建）
- **函数级验证 11/11 通过**（tests/verify-model-functions.mjs，从 lib/index.js 提取 resolveMainModel/resolveSourceModel 真实函数）：空 source+主模型 flash→flash；空 source+主模型 pro（会话内切换）→pro；无请求头→兜底保存默认；请求头残缺→兜底；全无→undefined→配置兜底；显式 provider/model 双写/裸 id/trim 均原样。主模型解析链：session.requestHeader()?.config → agentDefaultModel.currentSelection() → 配置。
- **端到端**（tests/verify-subagent-model-3081.mjs + diag）：无 source 剧本与 source:.../deepseek-v4-pro 剧本均 flow_done、子代理正常回复"收到"（无回归）。子代理 uuid 会话不落盘（one-shot 归档即清），request/header 无法事后取证，故以函数级验证为准。
- **额外发现**：start-meow.ps1 的 tailscale 探测在受限权限下 NativeCommandError 直接终止启动——已加 try/catch 容错（探测失败 fallback 100.64.33.74）。
- **引擎文案同步**：FEM_parser.py validate_actor_sources 报错提示"（或省略 source 用默认模型）"→"（或省略 source 跟随主模型）"（无测试断言，pytest 无需改动）。

## 2026-08-20 运行结束通知主模型（femwa:notify section 注入上下文，不污染界面）

### 需求（用户 ask 四要素确认，2026-08-20）
三类全通知（运行完成/出错/停止）+ 结果摘要 + **注入主模型上下文、不污染用户可见聊天** + 摘要含出错详情（错误类型/行号/错误行、停止节点名）。用户原话："注入上下文，不污染对话界面"、"结果摘要就好"、"三类全通知，可读可响应"。生命周期：**不清空**（摘要保持到下一次运行覆盖，用户拍板"不清空"）。

### 机制（在 dsh 源码验证可行）
主模型上下文 = `session.deriveMessages()`，只认 `user/message`/`assistant/message`/`tool/result` 三种 surface 事件（packages/core/session/src/surface.ts），`dsh-femwa/chat` 永远进不了——此路不通。正确通道 = **systemPrompt.section**（packages/core/system-prompt）：section 的 `text` 支持函数，每次主模型调用组装 system prompt 时动态求值；system prompt 本身不进用户可见聊天 → 天然满足"注入上下文不污染界面"。空 text 的 section 被 renderPrompt 过滤。

### 修改明细（仅 src/index.ts，host 层，零引擎/前端改动）
1. 新增模块级 `runNotices: Map<string,string>`（每主会话最近一次运行摘要文本）+ `runNoticeSections: Map<string, disposer>`（判重）。
2. 新增 `injectRunNotice(agentCtx, sid)`：注册 `femwa:notify` section（order 60），text 用函数 `() => runNotices.get(sid) ?? ''`（每次 assemble 动态读）。
3. 新增 `ensureRunNotice(ctx, sessionId)`：幂等（runNoticeSections 判重），`ctx.agents.get(sessionId)` 拿主会话 agent.ctx（复用 agent-preset/selected 处理器模式），取不到则跳过不阻断。
4. `flow_start` case：`ensureRunNotice(ctx, sessionId)`（只在真正跑过剧本的会话挂载）。
5. `flow_done`/`flow_error`/`flow_stopped` 三 case：各写一条摘要到 `runNotices`：
   - flow_done：`✅ 已完整跑完。checkpoint 已清除——重跑从头开始（不可 resume）`
   - flow_error：`❌ 运行出错。错误信息：<error>`（error 含类型/行号/错误行）
   - flow_stopped：区分暂停/停止，均 `保留断点，可用 resume 续跑`

### 验证
- esbuild CLI 打包 host 通过（lib/index.js 重建）；client 未改动无需重打
- tsc --ignoreConfig 报错全在既有代码行（declaration merging 未加载的预存噪音），无新增行报错
- pytest 引擎无回归（改动纯 host 层）；沙箱下 16 例 WinError5 为环境限制非改动引入
- ⚠️ 待 3081 重启实测：运行剧本后主模型下一轮 system prompt 能读到结果摘要、用户可见聊天无新增气泡

## 2026-08-21 dsh-dark 画布区视觉精修（官方设计语言对齐，第一轮仅深色）

### 需求（用户拍板）
整体视觉精修，**先只改 dsh 深色**看效果，满意后再同步到浅色；必须契合 dsh 官方设计语言（取值自 dsh-meow `packages/client/ui-theme/src/styles/design-platform.css` 等官方 token，只读参考、零本体改动）；重点攻克画布+节点区域观感。诊断四根因：①节点黑投影在 #151517 近黑底上不可见→糊在画布上；②类型标签实色底白字对比差（human 绿/func 琥珀）；③连线高饱和蓝虚线喧宾夺主；④点阵 1.2px 偏粗。

### 机制（全 token 化，浅色零变化）
themes.js 新增精修 token：默认块浅色值=历史观感（严格只改深色），dsh-dark 块覆盖新值——
- 节点阴影 4 token（`--fem-node-shadow-{rest,sel}{,-sm}`）：暗色卡片质感=顶部内高光 `inset 0 1px 0 白4%` + 微描边环 `0 0 0 1px 白3%` + 外扩暗影 `0 4px 16px 黑40%`（官方暗色靠边框分层不靠黑投影）。
- 连线 2 token（`--fem-edge`/`--fem-edge-sel`）：常态 `rgba(103,158,254,0.55)` 收敛蓝，选中 `#679efe` 提亮。
- 类型徽章 12 token（`--fem-badge-{bg,fg}-{ai,human,mind,func,assign,module}`）：官方 tertiary 语言=暗底亮字（ai=deepseek-800 底 deepseek-400 字等），组件按 `` var(--fem-badge-bg-${key}) `` 拼名引用，executorType 不在 TYPES 时回退 ai（与 ti 回退一致）。
- 点阵：dsh-dark 整条覆盖 `--fem-canvas-dots`（1px、白5.5%）。

### 修改明细
1. `femGen/src/themes.js`：默认块追加 18 token（阴影4+连线2+徽章12），dsh-dark 块追加同名覆盖 + canvas-dots 覆盖。
2. `femGen/src/canvasNodes.jsx`：ActionNode/SpecialNode/PositionNode/ParOut 四处 boxShadow 换 shadow token（选中光环 color-mix 段保留组件内拼接）；ActionNode 左上角标签 background/color 换 badge token（新增 badgeKey 计算）。
3. `femGen/src/FemWorAuto.jsx`：模块视图+主视图 marker `as`/`a_for` fill 换 edge token；自环边/回边 stroke、模块视图 stroke 三元、主视图 col 计算中 primary-strong→`var(--fem-edge)`、primary(选中)→`var(--fem-edge-sel)`；语义边（danger/warning/neutral）与拖拽临时连接线（primary）不动。

### 不动的
尺寸/布局/字号（红线）、手机壳 mobileView（独立渲染不共用）、neon 主题、auto/light 切换逻辑、dsh-meow 本体零接触。

### 验证
- 备份：MEOW_backups/{themes.js,canvasNodes.jsx,FemWorAuto.jsx}.bak-20260821-darkpolish
- esbuild 构建通过（lib/client.js 469.4kb / lib/index.js 112.2kb），产物含新 token（grep 18 处命中）
- ⚠️ 待 3081 重启实测（start-meow.bat）：深色主题下节点浮起/徽章暗底亮字/连线收敛/点阵细腻四项观感，浅色主题逐项对照零变化

## 2026-08-21 dsh-dark 精修第二轮（黑金连线实验 + 点阵收小 + ActionNode 重设计）

### 需求（用户看过第一轮实机后反馈）
①点阵再小些；②连线试金色——"黑色+金色会不会好看？说不定很有质感"；③"节点的设计本身很丑……把节点改改"。第一轮其余方向获认可（"看到变化了"）。

### 修改明细
1. `themes.js`：
   - dsh-dark 点阵 1px→0.6px、alpha 0.055→0.07（补偿可见性）；
   - 黑金三档：`--fem-edge` rgba(228,192,92,0.6)（强调边）/ `--fem-edge-sel` #f0c75e / 新增 `--fem-edge-flow` rgba(212,175,55,0.32)（普通顺序边，量大要低调）；浅色档对应 token 保持原值（灰/蓝）零影响；
   - 新增 `--fem-node-border`(暗=白9%)/`--fem-node-border-w`(暗=1px，官方全 1px 规范；浅=rgba(0,0,0,0.12)/1.5px 旧观感)。
2. `FemWorAuto.jsx`：两视图普通顺序边 fallback 与 'a' marker fill 从 var(--fem-neutral) 换 var(--fem-edge-flow)（4 处）；语义边/拖拽临时线不动。
3. `canvasNodes.jsx` ActionNodeView 重设计：
   - 左上悬挑徽章（position absolute top:-11 left:-5）**废除**，改为卡片内行内芯片（badge token 复用，8.5px mono，与标题同行 `[ai] 节点名`）；
   - 四边不等宽边框（3×1.5px + 左侧粗色条）**统一为单边框** var(--fem-node-border-w) solid（未选中 node-border / 选中类型色 c）；删除 border 变量与 module 第二行的重复 'module' 小标签；
   - 内边距 14px→11px 12px 9px（内部布局微调，节点外形 100×64/端口位置零改动——画布连线几何依赖）。
   - 运行气泡/端口/呼吸灯保留。SpecialNode/PositionNode 本轮不动。

### 验证
- 备份：MEOW_backups/*.{bak-20260821-round2}
- esbuild 构建通过（lib/client.js 469.6kb），新 token 命中 14 处
- ⚠️ 待 3081 重启实测：黑金观感是否成立（不成立回滚只需改 themes.js 三行）、芯片入卡后节点观感、点阵颗粒感

## 2026-08-21 dsh-dark 精修第三轮（金线实色化 + 边宽 token 化 + 节点信息补全）

### 需求（用户看过第二轮后反馈）
①"金线不要半透明，可以细一点，但颜色亮眼也能看清，要更有质感一点"；②节点缺信息（节点名/action名/类型/执行者都不能缺），且类型+action名同行动作名显示不全——用户主意："把节点类型和执行者放一行，执行者一般名字不长"。

### 关键考证
node.label 与 action 名同步（FemWorAuto L2425/2427/3689/3697：改名时 `label: \`[${actionWithPath.name}]\` 双向写回`）——**显示 action 名即显示了节点名**，无需单独行，四信息三行位齐全。

### 修改明细
1. `themes.js`：
   - 金线去 alpha 改实色（明度分层代替透明度）：`--fem-edge` #e3bc55（正金）/ `--fem-edge-sel` #f7cf6b（亮金）/ `--fem-edge-flow` #b18e35（古铜金暗一档）；浅色档对应值仍为历史原值；
   - 新增边宽 token 三枚：`--fem-edge-w`(默认1.8px/深1.5px)、`--fem-edge-w-thin`(默认1.5px/深1.2px)、`--fem-edge-w-sel`(默认2.5px/深2px)——SVG strokeWidth prop 不解析 CSS var，改为 style 传 var。
2. `FemWorAuto.jsx` 四处边宽改 style var：模块自环(L2313)/模块普通边(L2327)/主视图回边(L3012)/主视图几何边(L3082)；透明点击热区宽度不动。
3. `canvasNodes.jsx` ActionNode 布局重排：行1=类型芯片+执行者(mono 10px neutral)，行2=action名独占整行(12.5 bold)——action 名可用宽度从 ~60px 恢复到 ~76px；module 卡=芯片行 + &modRef 行；padding 10/12/9。

### 过程坑（已修复）
L2327 编辑时 new_string 误写 `d={pathD}`（该作用域无此变量，渲染会 ReferenceError）+ 丢失列表 key——读回验证发现并修复为 `key={`v${i}`} d={d}`。教训：多行 JSX 替换后必须读回或让构建/运行验证。

### 验证
- 备份：MEOW_backups/*.bak-20260821-round3
- esbuild 构建通过（lib/client.js 470.2kb）；产物含新 token 7 处命中，旧 alpha 金/坏变量残留 0
- ⚠️ 待 3081 实测：实色金线质感/细线可读性/节点两行信息完整性

## 2026-08-21 dsh-dark 精修第四轮（手机壳去蓝对齐官方中性黑 + 金线流光动画）

### 需求（用户看过第三轮后反馈）
①"深色背景有点偏蓝，是我的错觉吗？哦手机端是偏蓝的，这个要改"——考证：桌面深色底 #151517 为官方中性黑无误；**手机壳/预览条调色板是 GitHub-dark 风格真蓝调**（#0d1117/#0c1428/#1a2236/#161b27 等），属历史遗留未对齐；②"金色看着愣愣的……顺着箭头方向，就在线上，加个光感反光流动的动画，可能更有金属质感"。

### 修改明细
1. `themes.js` 默认块（固有深色区全局生效）：
   - `--fem-mobile-*` 14 枚全部去蓝：bg→#151517(950)/bg-2→#1b1b1c(900)/bg-3·surface→#232324(layer-1)/surface-hover→#2c2c2e(layer-2)/border→白12%/border-light→白16%/border-strong→#2c2c2e/text-1→#f9fafb/text-2→#979da6/text-2-alt→#cfd3d6/text-3→#61666b/mask 底色同步；
   - `--fem-preview-*` 5 枚同步去蓝（bg/bg-2 同上、text→bluish-400、border→白12%）；
   - 新增 `--fem-edge-sheen`：默认块=primary-strong（浅色不显示无观感），dsh-dark=#ffe9ad 淡金白高光；
   - THEME_CSS 追加作用域流光 CSS：`.fem-edge-shimmer` 默认 opacity:0（浅色/neon 零影响），`[data-fem-theme="dsh-dark"]` 点亮 opacity .85 + `femEdgeShimmer 3.2s linear infinite`（stroke-dashoffset 144→0，亮段16+间隙128，递减即沿路径正向=箭头方向）。
2. `FemWorAuto.jsx` 四处金线叠加 overlay 高光路径（className fem-edge-shimmer，宽=主线×0.65 calc(var)）：模块自环/模块 pathDs（包 <g key> 并排除 isParBroken||isForBroken 红色边）/主视图回边/主视图 geo.pathDs（排除 isParBroken/isForBrokenFinal）——红色语义边不发光。

### 原理与代价
纯 CSS stroke-dashoffset 动画（GPU 合成友好），每条金边多一条 overlay path（大图边缘数 ×2，仅深色渲染时可见；浅色 opacity:0 仍存在但不动画）。手机壳 mobileView 自有渲染不叠加流光（本次未动 mobileView.jsx）。

### 验证
- 备份：MEOW_backups/{themes.js,FemWorAuto.jsx}.bak-20260821-round4
- esbuild 通过（lib/client.js 474.4kb）；产物 shimmer class 6 处、sheen/keyframes 6 处；源码旧蓝值/坏变量残留 0
- ⚠️ 待 3081 实测：手机端壳是否还偏蓝、金线流动感是否自然（速度 3.2s/透明度 .85 可调）

## 2026-08-21 dsh-dark 精修第五轮（流光柔化 + 属性面板补节点名）

### 需求（用户看过第四轮后反馈）
①"流光也有点愣愣的。光段的开头结尾能不能渐变，别这么清晰"；②节点第二行显示的是什么？节点名和 action 名不一样——节点上显示 action 名即可，**节点名加到属性面板**（用户明示："这个不是主题修改了，但值得修改"）。

### 概念澄清
节点名=flow 语法 `[方括号]` 引用的图上身份；action 名=动作定义名。绑定状态下两者同步（改名写回），但概念独立、需分别可见。

### 修改明细
1. `themes.js`：dsh-dark 流光 CSS 加 `filter: blur(2px)`——光段头尾柔化成渐隐光斑（无清晰切口），opacity .85→0.9 补偿 blur 损失的亮度。
2. `FemWorAuto.jsx` 桌面属性面板 action 节点区块：首行新增 `<PR k="节点名">`（label 去方括号显示），原"名称"行改标 `Action 名` 以区分两个概念。
3. `mobileView.jsx` MobilePropsPanel：头部下方新增 `MobPropRow 节点名`（同去括号），与桌面面板对齐。

### 验证
- 备份：MEOW_backups/*.bak-20260821-round5
- esbuild 通过（lib/client.js 474.9kb）；blur(2px)/fem-edge-shimmer/节点名/Action 名 均确认进产物（中文以 \uXXXX 转义形式存在）
- ⚠️ 待 3081 实测：流光是否柔和、选中节点后两端属性面板是否显示节点名

## 2026-08-21 dsh-dark 精修第六轮（流光 v2：三层叠加真渐变光斑）

### 需求（用户看过第五轮后反馈）
"还是不够渐变，渐变部分要和现有光段一样长，所以整体变为现有长度的3倍。现有光段颜色加亮加白。"——即 渐亮16px→亮核16px→渐隐16px=48px 总长，且亮核更白。

### 原理（dash 段做不了段内渐变 → 三层叠加伪造）
`EdgeShimmer({d, w})` 组件（FemWorAuto.jsx 顶部）渲染三层同色 overlay 路径：
- 晕层 dasharray 48 240、宽×1.5、strokeOpacity .25
- 中层 32 256、宽×1.0、opacity .5
- 亮核 16 272、宽×0.6、opacity 1（近白 #fff1c2）
三层 cycle 均 288、头对齐（dash 起点相同）→ 同速前进时亮核在前、渐晕拖尾，视觉即长渐变光斑；CSS keyframes 改 dashoffset 288→0 无缝循环，blur 2px→1.5px（渐变靠叠层，blur 只抹层间过渡），class opacity .9→1（透明度已分层到 strokeOpacity）。`--fem-edge-sheen` #ffe9ad→#fff1c2 加亮加白。
四调用点收敛为 `<EdgeShimmer d={…} w="var(--fem-edge-w[-thin])"/>`：自环/模块 pathDs/回边/主视图 geo.pathDs；红色语义边排除逻辑不变。

### 验证
- 备份：MEOW_backups/{themes.js,FemWorAuto.jsx}.bak-20260821-round6
- esbuild 通过（lib/client.js 474.2kb）；产物 EdgeShimmer×8、新 dasharray 三层各1、旧 "16 128" 残留 0、#fff1c2/keyframes 288 就位
- ⚠️ 待 3081 实测：渐变是否够长够柔、亮核是否够白；速度(3.2s)/层透明度(.25/.5/1)/长度比(48/32/16)均可再调

## 2026-08-21 dsh-dark 精修第七轮（流光 v3：对称渐变 + 反光收进线内）

### 需求（用户看过第六轮后反馈）
①"渐变是两头都要有啊，你是不是只加了一头hhh"——v2 三层是头对齐（亮核前缘硬切口、渐晕只拖尾）；②"不用加发光效果，只在线本身上反光就行了，发光超出线之外了"——晕层宽×1.5+blur 出界形成线外辉光，不要。

### 修改明细
1. `FemWorAuto.jsx` EdgeShimmer 改**中心对齐**：mid/halo 用负 animation-delay 把图案后移 8/16px 使三层中心与亮核重合（周期 3.2s×cycle 288 → 后移 1px=延迟 1/90s；mid=-0.0889s、halo=-0.1778s；inline style 的 animation-delay 长手优先级高于 class 的 animation 简写重置）。宽度全部压到 ≤ 线宽：晕 ×1.0(op .3)/中 ×0.85(op .55)/核 ×0.5(op 1)——辉光不再出界。
2. `themes.js`：blur 1.5px→0.5px（仅抹三层台阶，不产生线外光晕）。

### 坑
负 delay 与速度/长度耦合：改动画时长或 dash 长度需按"后移 px = delay(s)×90px/s"重算延迟。

### 验证
- 备份：MEOW_backups/{themes.js,FemWorAuto.jsx}.bak-20260821-round7
- esbuild 通过（lib/client.js 474.3kb）；产物含 -0.1778s/-0.0889s/blur(0.5px)
- ⚠️ 待 3081 实测：两头渐变是否对称柔和、是否有线外辉光

## 2026-08-21 dsh-dark 精修第八轮（金色整体提亮一档）

### 需求（用户看过第七轮后反馈）
"金色线本身好像还是有透明度？我希望它别透明。又或者是颜色太深了？那就稍微浅一点。"

### 考证
三个金值均为实色 hex 无 alpha——"透明感"来源=**细线(1.2~1.5px)在近黑底上的抗锯齿混色**（边缘像素与 #151517 混合，整线等效变暗变灰）；另循环/自环边是虚线（5,3/7,3 间隙为语义设计），视觉天然偏"断"。

### 修改明细
`themes.js` dsh-dark 三档金整体提亮 ~12%（宽度不动，保持用户选的细线）：`--fem-edge` #e3bc55→#eec962、`--fem-edge-sel` #f7cf6b→#ffd97f、`--fem-edge-flow` #b18e35→#c4a044。

### 验证
- 备份：MEOW_backups/themes.js.bak-20260821-round8
- esbuild 通过；三新值各 1 处进产物
- ⚠️ 待 3081 实测：金线明度是否到位；若仍觉暗下一杠杆=加粗线宽而非再加亮

## 2026-08-21 dsh-dark 精修第九轮（节点极简质感：官方扁平语言做足）

### 需求（用户看过第八轮后反馈）
金线认可（"现在就好多了"）；节点 UI 仍觉丑，要"有质感有设计感"。方向确认（用户自定义回答）："我希望是偏极简，要和dsh官方的设计语言匹配嘛。但是……又不能丑"——即 B 方向：不加花活，靠工艺精度。

### 诊断
单色平板+一圈细边=贴纸感；缺 figure-ground 分离、边缘不够利落、投影单层单薄、第一行芯片+执行者拥挤。

### 修改明细（全部 token 化，浅色零变化）
1. `themes.js` dsh-dark：
   - 新增 `--fem-node-bg` #252528（表面提半档，875→偏 850 之间，画布上浮起更清楚；默认块=var(--fem-surface)）；
   - `--fem-node-border` 白 9%→11%；
   - `--fem-node-shadow-rest/sel` 升级双层投影：近接触影(0 2px 6px 黑30%)+远环境影(0 10px 24px 黑38%)，选中同理加强。
2. `canvasNodes.jsx` ActionNodeView：background 换 var(--fem-node-bg)；第一行执行者 marginLeft:auto 右对齐（结构改动两端生效——纯层次优化），第二行 action 名独占不变。

### 验证
- 备份：MEOW_backups/{themes.js,canvasNodes.jsx}.bak-20260821-round9
- esbuild 通过（lib/client.js 474.7kb）；fem-node-bg/252528/双层投影均进产物
- ⚠️ 待 3081 实测：节点是否"坐"在画布上、极简质感是否成立

## 2026-08-21 dsh-dark 精修第十轮（金色显著边框 + 节点高度压缩）

### 需求（用户看过第九轮后反馈）
"救命我还是看着丑。要不确实你把边框改的颜色显著一些，让它更利落，和亮晶晶的金线一样嘛。还有要不你把节点的宽度高度改一下？比如高度改小一点，现在其实只有两行文字"——用户主动解锁尺寸红线。

### 修改明细
1. `themes.js` dsh-dark：`--fem-node-border` 白11% → **金色调 rgba(240,210,120,0.35)**——与黑金连线呼应，节点轮廓一眼可辨；选中仍变类型色。
2. `common.jsx`：**NH 64→56、MH 74→66**（两行文字实际内容约36px+留白19px，64 有 ~9px 浪费；端口/连线几何均按 getNodeSize 动态计算自动跟随）。NW/MW 宽度不动（标题需要行宽）。

### 验证
- 备份：MEOW_backups/{themes.js,common.jsx}.bak-20260821-round10
- esbuild 通过（lib/client.js 475.5kb）；金边框值进产物、NH=56 源码确认
- ⚠️ 待 3081 实测：金边框显著性/扁节点观感/连线端口对位是否正常（几何动态应无恙）

## 2026-08-21 dsh-dark 精修第十一轮（中文换 MiSans 字体）

### 需求（用户看过第十轮后反馈）
"好像好看一点了。对了，也许是字体的问题，可以换个更好看的字体吗？中文字体全面有点丑"——此前中文走系统栈（Windows=微软雅黑，小字号+粗头发糊）。

### 选型与考证
选 **MiSans**（小米，免费商用，现代 UI 风）。加载方案考证：CJK 全量 5-15MB 必须子集化——npm `misans-webfont@4.3.1` 是"每字重独立族名"设计（MiSans Medium 等，weight 全标 400），会导致 font-weight 匹配失效，**弃用**；npm `misans@4.1.0` lib/Normal/ 为单族名 "MiSans"+官方新字重刻度（Regular330/Medium380/Demibold450/Semibold520/Bold630/Heavy700，各 100 个 unicode-range woff2 子集、font-display:swap），**采用**。femGen 的 fontWeight 400-900 由浏览器就近映射到 330-700 真字重。CDN=jsDelivr（已实测可达，走用户 7897 代理）；加载失败静默回退系统栈零风险。

### 修改明细
1. `common.jsx` FontStyle：@import 区新增 6 条 MiSans 引入（Regular/Medium/Demibold/Semibold/Bold/Heavy，保留原 DM Sans+JetBrains Mono 的 Google Fonts 引入）。
2. `themes.js` 两处字体栈（默认块+dsh 共享块）：`--fem-font-sans/body` 在 'DM Sans' 后插入 'MiSans'（拉丁仍 DM Sans，中文落 MiSans，雅黑降级为兜底）；mono 不变。

### 注意
字体全局生效（浅色深色都换）——字体本身与主题无关，用户诉求即全局。首次加载会按需拉取子集，之后走缓存。

### 验证
- 备份：MEOW_backups/{themes.js,common.jsx}.bak-20260821-round11
- esbuild 通过（lib/client.js 476.4kb）；misans@4.1.0×6、MiSans×18 进产物
- ⚠️ 待 3081 实测：中文观感（雅黑→MiSans 差异应明显）；若 jsDelivr 不通则回退系统栈（F12 网络 可查 css 是否 200）

## 2026-08-21 dsh-dark 精修第十二轮（面板配色统一 dsh + 去手机画布点 + 流光 v4 五层 + 减字重）

### 需求（用户看过第十一轮后反馈，四条）
①加粗中文太粗；②深色模式边栏/标题栏/右栏背景别扭——"你看dsh本体的边栏是哪个颜色，用那个吧，然后画布的颜色和dsh聊天窗口的背景颜色一致。配色统一~手机端同理"；③手机端画布背景点去掉（"其实电脑端画布也没点"——round4 的 0.6px 点在深色下已不可见）；④手机端标题栏自带的扫光动效比流光 v3 好看，参考它改金线。

### 考证
dsh 官方 dark：sidebar-fill=bluish-900 #1b1b1c、聊天底=bg-base bluish-950 #151517。femwa 画布 app-bg 本就 #151517 ✓；面板用的 surface #232324 偏亮故"别扭"。手机标题栏扫光实现=60% 宽 linear-gradient(90deg,transparent,glow,transparent) 带 4s 扫过——美在宽而软的真渐变。

### 修改明细
1. `themes.js`：新增 `--fem-panel-bg`（默认=surface 浅色不变；dsh-dark=#1b1b1c 对齐 sidebar-fill）；`--fem-mobile-canvas-dots` → none（默认块，全主题去手机画布点）；`--fem-mobile-surface` #232324→#1b1b1c、hover→#232324（手机端同理）。
2. `FemWorAuto.jsx`：左边栏(L2495)/中工具栏(L2717)/右属性栏(L3316) background 换 var(--fem-panel-bg)；L2782 控件保持 surface。
3. `common.jsx`：移除 MiSans-Heavy 引入——800/900 就近落 Bold(630)，加粗中文减粗一档。
4. `FemWorAuto.jsx` EdgeShimmer v4：三层→五层（56/44/32/24/16px，op .10/.18/.30/.50/1，宽 ≤线宽），中心对齐 delay 链 -0.2222/-0.1556/-0.0889/-0.0444/0s——更宽更软的对称渐变光带，模拟标题栏扫光质感。

### 验证
- 备份：MEOW_backups/{themes.js,FemWorAuto.jsx,common.jsx}.bak-20260821-round12
- esbuild 通过（lib/client.js 477.7kb）；panel-bg×5/新 dasharray/delay 进产物，MiSans-Heavy 残留 0
- ⚠️ 待 3081 实测：面板配色统一感/手机无点画布/流光柔度/加粗中文厚度

## 2026-08-21 dsh-dark 精修第十三轮（类型色板换莫兰迪实色 + 仓库卡片与画布统一）

### 需求（用户看过第十二轮后反馈）
"仓库里的action显示，能不能也和画布上的统一风格……现在那个半透明蓝，半透明绿，是真的好丑。能不能别用半透明。画布上action/节点的类型标签也是半透明蓝绿的，也别用半透明。用实色，但是把颜色挑和谐点。可以考虑莫兰迪色系"

### 考证
"半透明感"来源=低饱和暗彩 tint 底（primary-soft/success-soft 等，视觉等效半透明叠加）+ 仓库卡片边框字面量 alpha（`${c}18`≈9%）。画布芯片底走 --fem-badge-*→type-*-bg，与仓库卡 TYPES.bg 同源——改 type 色板即全链路统一。

### 修改明细（全部 dsh-dark 块，浅色/neon 不动）
1. `themes.js`：type 色板换莫兰迪实色成对（底+字同族低饱和）——ai 灰蓝 #46586B/#A9BEDC、human 灰绿 #44584C/#A9C9B4、mind 灰玫瑰 #5C4747/#D2A9A9、func 灰驼 #5E5343/#D6C39E、assign/par 灰紫 #554D66/#BFB3DC；success-soft/warning-soft 同步莫兰迪（等待/完成气泡、START/IN 底共用）。
2. `common.jsx`：TYPES.ai.bg 从 var(--fem-primary-soft)（选中态共用色，不能动）改指 var(--fem-type-ai-bg)。
3. `libPanel.jsx`：仓库卡片边框 `${c}18`（alpha）→ var(--fem-border) 实色细边 + 左侧类型色条不变——与画布节点同构（neutral 边框+彩色 accent）。
4. `mobileView.jsx`：手机属性面板类型芯片 `c+'22'` alpha → badge token 实色（与画布芯片同源）。

### 影响面
type-* c 变莫兰迪后：节点选中边框/流式气泡边框/仓库"+画布"按钮底同步变柔和（一致的设计语言）；--fem-primary/-strong 保持亮蓝不动（选中态/主按钮不受影响）。

### 验证
- 备份：MEOW_backups/{themes.js,common.jsx,libPanel.jsx,mobileView.jsx}.bak-20260821-round13
- esbuild 通过（lib/client.js 482.0kb）；五组莫兰迪值进产物、旧 alpha 芯片残留 0
- ⚠️ 待 3081 实测：仓库卡/画布芯片/气泡的莫兰迪观感与统一性

## 2026-08-21 dsh-dark 精修第十四轮（仓库卡片画布同构 + 芯片文字提白）

### 需求（用户看过第十三轮后反馈）
①颜色不错，但节点芯片上的 ai/human 文字与背景区分太小，改白一点；②画布节点舒服多了；③仓库 action 依然丑——"我希望它和画布上的节点action同一个设计风格"。

### 修改明细
1. `themes.js` dsh-dark：badge-fg 六枚从 var(--fem-type-*)（muted 同调，对比不足）改为近白同色系浅调 #DCE7F5/#DFEFE5/#F2DEDE/#F0E6D2/#E6E1F2（module 保持 #cfd3d6）——底承载类型身份、字负责可读。
2. `libPanel.jsx` 仓库 action 卡片重写（画布节点同构）：底 var(--fem-node-bg) + 边框 var(--fem-node-border)（金调，同画布）+ 去 alpha 边框和左色条；行1=类型芯片(badge token)+名称(flex 省略)+E 钮，行2=执行者(mono neutral)+「+ 画布」钮（底=类型色 c）；删除旧 @type 彩色文字与 maxWidth:110 硬限宽。

### 验证
- 备份：MEOW_backups/{themes.js,libPanel.jsx}.bak-20260821-round14
- esbuild 通过（lib/client.js 482.8kb）；提白 fg/同构边框/badge 引用 15 处进产物
- ⚠️ 待 3081 实测：仓库与画布并排对比统一感、芯片文字可读性

## 2026-08-21 dsh-dark 精修第十五轮（莫兰迪提亮 + 特殊节点灰实色 + 功能钮统一 primary + 手机去包裹卡）

### 需求（用户看过第十四轮后反馈，四条）
①ai 节点找个更蓝的颜色；整个莫兰迪色系过于灰，"把颜色拉起来一点"；②手机端仓库区域有奇怪的圆角卡片背景，去掉；③「+画布」按钮颜色应全局统一=dsh deepseek 蓝，「+新建」之类功能按钮同理；④START/END/FOR/FOROUT/PAR/PAROUT 节点背景去半透明观感，改带灰度实色、与文字色拉开区分。

### 修改明细
1. `themes.js` dsh-dark：type 色板整体拉起饱和/明度——ai #3E5C94/#8FB8F0、human #3E6B4E/#85D6A8、mind #744949/#EDA3A3、func #75603A/#EDBE72、assign·par #5C5190/#B4A5EC；success/warning-soft 同步 #3E6B4E/#75603A；badge-fg 五枚随拉起微调（#CFE2FA 等）。
2. `themes.js` 新增特殊节点底色 token 五枚：默认块=原 soft 值（浅色不变）；dsh-dark=灰度实色——sp-start #383E3A/sp-end #423B3D/sp-break #403C34/sp-for #373D4A/sp-par #413C4C。
3. `common.jsx`：SPECIAL_COLORS 的 bg 从 success/danger/warning-soft、primary-soft、special-par-bg 改指专用 sp-* token——与气泡/语义底解耦，可独立调灰。
4. `libPanel.jsx`：「+画布」按钮 background 从类型色 c 改 var(--fem-primary)（deepseek 蓝，与 btnP/mobBtnP 全局功能钮一致）。
5. `mobileView.jsx`：手机 tab 内容包裹层去圆角卡片（background var(--fem-surface)→transparent、删 borderRadius radius-top）——仓库等区域融入壳背景。

### 验证
- 备份：MEOW_backups/{themes.js,common.jsx,libPanel.jsx,mobileView.jsx}.bak-20260821-round15
- esbuild 通过（lib/client.js 483.9kb）；提亮色板/sp token 接线/primary 按钮进产物，radius-top 手机包裹处已移除
- ⚠️ 待 3081 实测：拉起后的色板鲜度/特殊节点灰底与文字区分/功能钮统一蓝/手机仓库无卡片感

## 2026-08-21 事故修复：session-script 路由双写响应崩掉整个 3081 进程（ERR_HTTP_HEADERS_SENT）

### 现象
3081 两次启动后均在用户发消息后立即整体崩溃：`dsh: fatal load failure: ERR_HTTP_HEADERS_SENT: Cannot write headers after they are sent to the client`（栈：writeJson ← session-script handler 的 catch），bridge 随之退出，[ELIFECYCLE] exit 1。

### 根因
`/dsh-femwa/session-script` 路由（src/index.ts）：scriptPath / fems 成功分支已经 `writeJson(res,200,…)` 后，控制流掉出 if/else 又执行了一次末尾的 `writeJson(res,200,{ok:true})` → 对同一响应二次 writeHead 抛 ERR_HTTP_HEADERS_SENT → 被 async IIFE 的 catch 捕获，catch 里第三次 `writeJson(res,500)` 再次抛出 → unhandledRejection → dsh web 按 fatal 策略带崩整个进程。触发链=前端发消息同时画布防抖保存（POST session-script），故表现为"一发消息就炸"；成功保存必炸，非偶发。

### 修复（源码层双保险）
1. 删除成功分支之后多余的 `writeJson(res, 200, { ok: true })`——每个分支自行写完响应即结束（根因消除）。
2. `.catch` 加 `res.headersSent` 防御：响应已发出后再出错只 console.warn 返回，绝不再二次 writeJson（错误处理器自身不得再抛，否则 unhandledRejection 照样炸进程）；源码注释留痕「2026-08-21 实测教训」。
（源码修复与构建由并行窗口当日完成；本窗口负责诊断定位、lib 新旧比对、重启加载与验证，并补本条留痕。）

### 验证（2026-08-21）
- 备份：lib/index.js.bak-20260821-crashfix、src/index.ts.bak-20260821-crashfix
- 运行版 lib/index.js 核实：双写残留行已不存在、headersSent 防御在位（约 L1805）
- start-meow.bat 重启 3081：端口监听 ✓；GET / → 200；GET /dsh-femwa/session-state → 200 正常 JSON；GET /dsh-femwa/actors → 200 {ok:true,actors:[]}；meow-smooth 压缩代理 8444 随起 ✓
- 教训：**服务崩溃先查"正在运行的 lib"与磁盘产物是否一致**——崩溃栈的行号内容对不上当前文件 = 进程跑的是旧构建；先比对 src/lib mtime 与栈行号再决定要不要动代码，避免重复修或修错版本。

## 2026-08-21 dsh-dark 精修第十六轮（金线再细再亮 + 特殊节点深实色 + 功能钮清扫 + 手机卡片区同构）

### 需求（用户看过第十五轮后反馈，三条）
①金线再细一点颜色再亮一点；②特殊节点的「+画布」按钮颜色不对要统一；③for/par/start/end/in/out/parout 节点看着还是半透明——round15 的近画布灰底+鲜字再次形成"半透明叠加"错觉，改为真正的深色实色彩底。

### 修改明细
1. `themes.js`：金线 width 1.5/1.2/2→**1.25/1/1.75px**，颜色提亮 #eec962→#f4d268、#ffd97f→#ffe58f、#c4a044→#d6b052。
2. `themes.js` sp-* 五枚改深实色彩底：start #2C5540 / end #5A3034 / break #5A4726 / for #2F4A78 / par #4A4272——涂漆感杜绝半透明错觉，鲜字对比充足。
3. 功能钮统一 primary 清扫：libPanel 特殊区「+画布」(s.c)、模块区「+画布」(tag-bg)、「创建」(tag-bg)；mobileView action「+」(c)、模块「+画布」(tag-bg)——全部 var(--fem-primary)。
4. 仓库卡片同构补完：libPanel 特殊卡（s.bg+s.c28 alpha 边）与 POSITION 卡（fem-bg+neutral28）→ node-bg/node-border 同构；mobileView action 卡（bg-3+c30）/模块卡（bg-3+tag-bg）→ node-bg/node-border；手机特殊节点 chips（s.c+'18' alpha 底）→ 对应 sp-* 实色底。

### 验证
- 备份：MEOW_backups/{themes.js,libPanel.jsx,mobileView.jsx}.bak-20260821-round16
- esbuild 通过（lib/client.js 483.9kb）；新金值/sp 实色/1.25px 进产物，c+30 与 s.c+18 alpha 残留 0
- ⚠️ 待刷新页面实测：金线粗细亮度/特殊节点实色感/功能钮全蓝/两端仓库统一

## 2026-08-21 dsh-dark 精修第十七轮（特殊节点底色和谐化：中性灰+一缕色相）

### 需求（用户看过第十六轮后反馈）
"画布上的start end par for 这些节点背景颜色太丑了，调一下，和整体更和谐"——round16 的深饱和色块（#2C5540 等）在"中性黑+黑金"的整体语言里跳戏。

### 修改明细
`themes.js` dsh-dark sp-* 五枚改**中性灰+一缕色相**实色（明度介于 surface 与 bg-2 之间，融入整体；类型身份由鲜色文字承载）：start #343E37 / end #463A3C / break #443D30 / for #363D4D / par #3F3B4A。手机端特殊 chips 同 token 自动跟随。

### 验证
- 备份：MEOW_backups/themes.js.bak-20260821-round17
- esbuild 通过；三抽查值进产物
- ⚠️ 待刷新实测：与整体和谐度；若仍不满意备选=全部统一暖金灰（彻底去彩色）

## 2026-08-21 dsh-dark 精修第十八轮（特殊节点鲜明彩底+白字）

### 需求（用户看过第十七轮后反馈）
"去彩色也不一定好看……或许你太过于克制了，让这几个节点颜色更鲜明一点看看"——从克制灰转向鲜明彩。

### 修改明细
1. `themes.js` dsh-dark sp-* 五枚改**中等明度高饱和彩底**：start 鲜绿 #2E9E5B / end 鲜红 #D24B4B / break 鲜琥珀 #DB9524 / for 鲜蓝 #3B82D6 / par 鲜紫 #8468DC。
2. `themes.js` THEME_CSS 追加 `[data-fem-theme="dsh-dark"] .fem-special-label { color: var(--fem-on-accent) !important }`——彩底上文字切白（浅色档淡底彩字不变）。
3. `canvasNodes.jsx`：SpecialNodeView/PAR_OUT 文字 span 加 fem-special-label class；`mobileView.jsx` 特殊 chips 文字直接 var(--fem-on-accent)（手机壳恒深色）。

### 验证
- 备份：MEOW_backups/{themes.js,canvasNodes.jsx,mobileView.jsx}.bak-20260821-round18
- esbuild 通过（lib/client.js 484.2kb）；五彩值+label class 进产物
- ⚠️ 待刷新实测：彩底鲜度与白字可读性；FOR 小圆点（出）仍是描边风格未动

## 2026-08-21 dsh-dark 精修第十九轮（特殊节点归队莫兰迪）

### 需求（用户看过第十八轮后反馈）
"这也太彩，你给他们也换成莫兰迪色试试"——vivid 彩底过艳，回归与类型色板同族的莫兰迪。

### 修改明细
`themes.js` dsh-dark sp-* 五枚换**类型色板同族莫兰迪**：start #3E6B4E(human 绿族)/end #744949(mind 玫瑰族)/break #6E5C3E(func 驼金族微调防全同)/for #3E5C94(ai 蓝族)/par #5C5190(assign 紫族)。白字门控 .fem-special-label 与手机 on-accent 不变。

### 验证
- 备份：MEOW_backups/themes.js.bak-20260821-round19
- esbuild 通过（lib/client.js 484.3kb）；五值进产物
- ⚠️ 待刷新实测：与芯片/仓库的色系统一感

## 2026-08-21 事故修复二：AI 节点必炸 `No module named 'requests'`（FEM_runtime.py 死 import）

### 现象
跑剧本到 AI 节点即报「剧本出错：No module named 'requests'」。配置 dshAiBackend=true 正确、系统 Python 确无 requests（纯标准库原则），但 AI 节点本不该走直连链路。

### 根因
`femCompiler/FEM_runtime.py` 的 `_exec_ai` 函数体内有一行**无条件且零引用的死 import**：`from femBridges.llmBridge import call_ai_with_blocks`。import 副作用拉起模块链 llmBridge → llmProviders 顶层 `import requests` → ModuleNotFoundError。实际 LLM 调用走 `self._invoke_ai_llm()`（内部才有规范的按 `_dsh_ai_backend` 分支延迟 import），这行是纯遗留——但在它被删除前，dsh 宿主模式下每个 AI 节点进门就死，根本轮不到子代理分支。

### 修复（1 处删行 + 注释说明）
删除该死 import；原位注释警示「此处不得 import llmBridge/llmProviders——其模块顶层 import requests，违反纯标准库零 pip 原则」。
- 备份：`MEOW_backups/FEM_runtime.py.bak-20260821-requests-fix`
- 验证：py_compile 通过；`import femCompiler.FEM_runtime` 干净加载且 sys.modules 无 requests / femBridges.llmBridge；手动以宿主同款净化 env spawn bridge → ping 返 pong
- 生效方式：bridge 是长驻 Python 子进程（模块进程内缓存），**改 .py 必须重启 3081 让 bridge 重生**；纯前端（femGen→client.js）才是刷新热更新

### 排障插曲（教训）
本轮"重启"曾连续三次无效：3081 端口上同时有 tailscaled 的转发监听（OwningProcess=tailscaled pid），`Get-NetTCPConnection -LocalPort 3081` 拿 OwningProcess 会拿到 tailscaled 而非 dsh node——Stop-Process 被 SilentlyContinue 吞掉，旧实例一直占着端口，新实例全部 EADDRINUSE 秒退（其 bridge exit 1 是 fatal shutdown 连带 taskkill，非自身故障）。正确姿势：先 `Get-CimInstance Win32_Process` 核对命令行含 `bin.ts web --port 3081` 再杀。

## 2026-08-21 dsh-dark 精修第二十轮（功能钮统一 deepseek-500 + 特殊节点回归同底彩边）

### 需求（用户看过第十九轮后反馈，两条）
①POSITION 的「+画布」颜色不对；所有「+画布」普遍太亮——"深色模式下的dsh原生的蓝也不是那个蓝啊……你得去看dsh的ui代码"；项目设置面板"+"、右上角「继续」都应同一颜色。②特殊节点莫兰迪底仍不和谐——改成和其它节点同底色（灰黑），边框改彩色试试。

### 考证（dsh 官方源码）
ui-conversation/InputBar.module.css 注释实锤：发送钮 "#3964FE light / #679EFE dark — the info-fill pair (500→400)"；ChatView 状态渐变用 deepseek-500。用户记忆中的"原生蓝"=更深的 **deepseek-500 #4176e6**（品牌蓝）。

### 修改明细
1. `themes.js`：新增 `--fem-btn-primary`（默认=var(--fem-primary) 浅色不变；dsh-dark=#4176e6 deepseek-500）；dsh-dark sp-* 五枚 → var(--fem-node-bg)（与其它节点同底）；删除 .fem-special-label 白字覆盖（文字回归类型色 sc.c，与彩色边框呼应）。
2. `common.jsx` btnP、`mobileView.jsx` mobBtnP：background 换 var(--fem-btn-primary)——项目设置"+"等 btnP 家族自动跟随。
3. `FemWorAuto.jsx`：「▶ 继续」按钮 background → var(--fem-btn-primary)（「运行」保持 success 绿语义色未动）。
4. `libPanel.jsx`：五处功能钮背景（+新建/action+画布/special+画布/module+画布/创建）→ var(--fem-btn-primary)。
5. `mobileView.jsx`：action「+」、模块「+画布」→ btn-primary；特殊 chips 改 node-bg 底+s.c 彩边+彩字（与画布一致）。

### 影响面
--fem-primary（400 亮蓝）继续用于选中态/tab/焦点/链接等 accent 场景；功能钮独立走 --fem-btn-primary（500），两层语义解耦。

### 验证
- 备份：MEOW_backups/*.bak-20260821-round20（5 文件）
- esbuild 通过（lib/client.js 484.4kb）；btn-primary×10/4176e6×4 进产物
- ⚠️ 待刷新实测：功能钮深蓝统一感/特殊节点灰底彩边观感

## 2026-08-21 dsh-dark 精修第二十一轮（特殊节点边框常显类型色）

### 需求（用户看过第二十轮后反馈）
"边框颜色不够显眼，希望是选中节点时的边框颜色"——round20 只改了特殊节点底色为 node-bg，未选中边框仍是中性 var(--fem-border)，不显眼。

### 修改明细
`canvasNodes.jsx` SpecialNodeView：border 从 `sel ? sc.c : 'var(--fem-border)'` 改为**常显 sc.c 类型色**；宽度未选中用 var(--fem-border-w)（细），选中 var(--fem-border-w-selected)（加粗）+ 原光环。START 绿框/END 红框/FOR 蓝框/PAR 紫框常驻，与灰黑底形成"彩边灰底"身份标识。ForOut 小圆点本就彩边未动；PositionNode 未提及未动。

### 验证
- 备份：MEOW_backups/canvasNodes.jsx.bak-20260821-round21
- esbuild 通过（lib/client.js 484.4kb）；源码 grep 确认 border=sc.c 常显 + 细宽度接线
- ⚠️ 待刷新实测：彩边显著性/与金边 action 节点的整体协调度

## 2026-08-21 视角显示架构拍板落地：删除 StreamPreviewBar 下方弹窗（纯前端）

### 需求（用户三点设计重申 + 拍板）
用户原话："1. 主会话='戏外'……这是对的。我不希望戏外视角能看见戏内内容。**也不需要下方弹窗气泡。** 2. 上帝视角的对话流里应该能看见戏外戏内内容，这才是全视视角。所以角色发言应直接映射到上帝视角窗口的对话流里，包括cot，toolcall和实际发言。3. 角色视角是戏内scope视角，应看到符合自己视角的发言……包括cot，toolcall和实际发言。"——"我本来是这么设计的……现在的实现怎么乱七八糟的"。

### 考证结论（改动前核实）
第 2/3 点**现状已实现且与设计一致**：FORWARD_CHILD_EVENTS 白名单含 assistant/chunk（思考+正文块）/tool/call/tool/result/assistant/message 等，god 窗全量分发、角色窗按 scope 命中，dsh 原生 assistant 节点渲染（含 cot 折叠/工具卡片/发言）。"乱七八糟"的实际来源=①主会话对话流无 AI 发言（镜像架构使然，用户认可）②StreamPreviewBar 底部悬浮条抢戏（16836d1 方案丁引入，流式期间常驻 bottom:96px 显示累积正文）。

### 修改明细（仅 src/client.tsx，备份 MEOW_backups/client.tsx.bak-20260821-remove-previewbar）
1. 删除 apply() 内 StreamPreviewBar 挂载块（独立 React 根 + portal 到 body 的 #dsh-femwa-stream-preview）。
2. 删除 StreamPreviewBar 组件定义整段（SSE ai_token 订阅 + fixed 悬浮条渲染）。
3. 清理悬空 import：`createRoot` from 'react-dom/client'（仅预览条挂载使用过）；createPortal 保留（冲突弹窗仍在用）。
4. host 侧 ai_token 广播保留——femGen 画布节点流式文本（nodeStates.streamingText）仍消费该事件。

### 验证
- node build.mjs 双 bundle 通过（lib/client.js 484.4→481.9kb；pwsh 报 exit 1 为 esbuild stderr 输出触发 NativeCommandError 假警报，产物正常）
- 产物 grep：StreamPreviewBar/stream-preview 引用 **0**；femwa-role 聊天节点在 ✓；host ai_token 广播在 ✓
- 生效方式：纯前端改动，浏览器刷新即生效（3081 无需重启）
- ⚠️ 待刷新实测：运行剧本确认下方弹窗消失；上帝窗/角色窗对话流含 cot/toolcall/发言完整性

## 2026-08-21 dsh-dark 精修第二十二轮（特殊节点未选中彩边压暗对齐金边框灰度）

### 需求（用户看过第二十一轮后反馈）
霓虹灯效果不错，但红绿边框太亮——"让它的灰度跟咱们之前调的那个金色的边框的灰度差不多？选中它的时候，才变成那个亮边框，这个颜色不变"。

### 修改明细
`canvasNodes.jsx` SpecialNodeView：新增 borderDim = `color-mix(in srgb, sc.c 50%, var(--fem-node-bg))`（类型色与节点底各半混合——明度自动落到金边框混底档位 ~40%，色相保留，且随主题自适应：浅色下混合浅底成柔和粉彩边）；未选中边框用 borderDim 细线，选中恢复全鲜 sc.c 加粗+光环不变。

### 验证
- 备份：MEOW_backups/canvasNodes.jsx.bak-20260821-round22
- esbuild 通过；borderDim 接线 ×2 进产物
- ⚠️ 待刷新实测：压暗档位是否合适（50% 可调：更暗 40% / 更亮 60%）

## 2026-08-21 dsh-dark 精修第二十三轮（仓库特殊节点卡全周压暗彩边）

### 需求（用户看过第二十二轮后反馈）
"仓库里显示的特殊节点，把边框也改成我们现在要的那个颜色？而且不要只有左侧边框有颜色，整个边框统一颜色。"

### 修改明细
1. `libPanel.jsx` 特殊节点卡：三面 node-border+左色条 → **全周 color-mix(s.c 50%, node-bg) 压暗彩边**（与画布未选中态完全同款公式）。
2. `mobileView.jsx` 特殊 chips：全鲜彩边 → 同款压暗彩边（文字保持鲜色 sc 系）。

### 验证
- 备份：MEOW_backups/{libPanel.jsx,mobileView.jsx}.bak-20260821-round23
- esbuild 通过；源码三处（canvas/lib/mobile）压暗公式各 1 处确认
- ⚠️ 待刷新实测：仓库特殊卡与画布的边框一致感

## 2026-08-21 dsh-dark 精修第二十四轮（POSITION 空节点卡灰色统一 + 模块卡同构补完）

### 需求（用户看过第二十三轮后反馈）
"还有空节点呢，别忘了。既然空节点显示为灰色边框，那就改为灰色吧。"

### 修改明细
`libPanel.jsx`：
1. POSITION 空节点卡：去左侧 neutral 灰条，全周 var(--fem-border) 灰边（与画布空节点一致），底 var(--fem-bg)（=画布空节点同底）。
2. 顺手补完（既定同构方向漏网）：模块卡从 bg-2+tag-bg-faint 边+tag-bg 左条 → node-bg+node-border 全周（与 action/special 卡统一）；模块「编辑」文字钮 color 从 tag-bg（深色下近不可见）→ neutral。

### 验证
- 备份：MEOW_backups/libPanel.jsx.bak-20260821-round24
- esbuild 通过（lib/client.js 484.5kb）；libPanel 内 borderLeft/tag-bg 残留 0——仓库四类卡（action/special/module/position）全部同构完成
- ⚠️ 待刷新实测：POSITION 灰卡观感、模块卡统一感

## 2026-08-21 手机端交互优化（round25：仓库长按拖拽 + 画布命中扩大）

### 需求（用户两条交互反馈）
①手机端仓库拖节点应为**长按激活**，现在碰到就拖"太离谱"；②画布节点保留触碰即拖，但**命中判定比节点大一圈**（小节点不好碰）；边连接线判定也比线宽一圈（不易判定失败）。

### 现状考证
画布手势钩子本就是长按相位机（LONG_PRESS_MS=200：port→连线/node→nodeDrag/空→平移，pending 移动超 5px 取消转平移）——节点拖拽实际已是长按，保持不动；hitTest=elementFromPoint 只认端口/节点 DOM，无扩圈、无边检测；仓库拖拽 handleLibTouch* 是碰触即武装 + touchmove 一律 preventDefault（连列表滚动都被掐死）。

### 修改明细
1. `mobileView.jsx`：
   - 新增 LIB_LONG_PRESS_MS=300 / NODE_TOUCH_PAD=12 常量与 libTimerRef；
   - 仓库拖拽改长按门控：touchstart 仅记录+起计时器；**激活前 touchmove 不 preventDefault**（移动超 5px 取消意图，列表滚动恢复原生）；300ms 到点 vibrate(15)+armed+ghost 出现；armed 后 move 才拦截并拖 ghost；end 未 armed=mere 点击（选择走原 onClick 不受影响）；
   - hitTest 扩圈兜底：elementFromPoint 未命中时，按 nodesRef 数学矩形外扩 NODE_TOUCH_PAD/s 逐节点（自顶向下）判定——端口优先级不变；
   - import 补 getNodeSize。
2. `FemWorAuto.jsx`：透明点击热区加宽（可见线不动）——自环/模块普通边/主视图回边 12→18，主视图几何边 12→18、par 并行线 18→24。

### 验证
- 备份：MEOW_backups/{mobileView,FemWorAuto}.jsx.bak-20260821-round25
- esbuild 通过（lib/client.js 485.6kb）；LIB_LONG_PRESS_MS/NODE_TOUCH_PAD/24:18 进产物
- ⚠️ 待手机实测：仓库长按 300ms 激活+震动反馈、激活前可滚列表；节点外扩 12px 命中；边热区变宽；确认误触率下降

## 2026-08-21 手机端修复（round26：点选金线连线失效）

### 需求（用户真机反馈）
"现在手机上无法点中节点之间的连接边（金线）"。

### 根因
手机手势系统 hitTest 只认端口/节点（elementFromPoint+closest），**从不返回边**；边选中一直依赖浏览器合成的 click 事件，而 onTouchEnd 的 preventDefault 会压制合成 click——时灵时不灵；round25 节点扩圈又让近节点的点按被 node 抢走。

### 修改明细
1. `FemWorAuto.jsx`：四处透明点击热区路径加 `data-edge-id={e.id}`（自环/模块 pathDs/主视图回边/主视图几何 midIdx）。
2. `mobileView.jsx`：hitTest 增加 `closest('[data-edge-id]')` → { type:'edge', id }（排在节点精确命中之后、数学扩圈兜底之前——节点优先于边的次序保持）；touchend pending 相机处理 hit.type==='edge' → setSel({type:'edge',id})，不再依赖合成 click。

### 验证
- 备份：MEOW_backups/{FemWorAuto,mobileView}.jsx.bak-20260821-round26
- esbuild 通过（lib/client.js 485.9kb）；data-edge-id×5/edgeEl×3/edge 选中分支进产物
- ✅ 手机实测已确认（用户 ask_user_question 回复"修好了"）：点金线稳定选中边

## 2026-08-22 手机端交互优化（round27：仓库长按激活拖拽的三层视觉反馈）

### 需求（用户原话）
"手机端，从仓库里面往外拖拽节点时，长按，然后才激活拖拽……我希望在激活拖拽模式的时候，视觉上有一些改变，让人知道可以拖动了。"

### 根因
round25 长按激活的唯一反馈是 ghost 胶囊悄悄出现 + navigator.vibrate(15)——**iOS Safari 不支持 vibrate API**（安卓 Chrome 有效），iPhone 上激活瞬间近乎零反馈；被按卡片本身无变化、画布无"可放置"提示。

### 修改明细
1. `mobileView.jsx`：
   - 新增 `libArmedKey` state（"type:id"）：长按 300ms 到点瞬间 set（与 ghost 同帧）；handleLibTouchEnd 一律清空；透传 MobileBottomPanel → LibPanel；
   - ghost 胶囊加 `ghostPopIn 0.18s`（scale 0.7→1.05 弹性淡入）+ `ghostBreath 1.1s infinite alternate`（光晕呼吸；只动 box-shadow，与 popIn 的 opacity/transform 属性不相交可同列）；
   - 激活期间画布内浮现可放置提示层（zIndex 150/151，低于 dragReady 小环 200）：inset 8 虚线主色描边 + `--fem-primary-soft-faint` 混底 + 顶部居中"松手放置到画布"胶囊，`dropHintIn 0.22s` 浮现，抬手即消；
   - MobileGlobalStyle 注册 3 个新 keyframes（ghostPopIn/ghostBreath/dropHintIn），全 token 化四档主题通用。
2. `libPanel.jsx`：
   - 新 prop `armedKey=null`（桌面端不传永不命中，零影响）；
   - 组件内 `isGrabbed(type,item)`/`grabStyle()` 辅助；四类卡片（action/module/special/position）命中抓起态：主色边框 + 主色淡底 + `scale(1.04)` + 主色光晕，`grabTransition`（transform 弹性曲线 + border/background/shadow 0.15s）平滑亮起/回落；special 卡的 color-mix 特殊色边框被 spread 覆盖为主色，回落恢复。

### 验证
- 备份：MEOW_backups/{mobileView,libPanel}.jsx.bak-20260821-round27
- 构建：`npm run build`（esbuild JS API）在本会话沙箱被 named-pipe 限制挡（spawn EPERM，文档化边界）；按 restructure 路径改用 **esbuild CLI 直调**（PowerShell 原生进程不受 pipe 限制）仅重建 lib/client.js（489.5kb，host 端未动）——banner/footer 参数与 build.mjs clientOptions 逐项对齐
- ghostPopIn/libArmedKey/松手放置到画布/grabTransition 均 13 处命中产物
- ⚠️ 待手机真机验证：长按 300ms 瞬间卡片亮起+ghost 弹出+画布虚线框三信号齐发；抬手/取消全部回落；列表滚动不受影响

## 2026-08-21 浅色档同步（round27-light：深色设计语言全面翻译到 light 默认块）

### 需求（用户拍板开启第二阶段）
"深色档现在很好看了，我们需要把这套设计语言迁移到浅色，但颜色不能和深色完全一样，因为底色不一样，配合起来要和谐好看且清晰。"

### 翻译原则
同语言、不同明度——每个深色决策都给出浅色底下的对应表达；组件零改动（token 架构收益），仅 themes.js 默认块+CSS 一处+neon 补丁。

### 修改明细（全在 themes.js 默认块，除注明外）
1. 画布 --fem-app-bg #f5f6f7→**#ffffff**（官方浅色聊天底 bg-base）；面板 --fem-panel-bg→**#F9FAFB**（官方浅色 sidebar-fill）。
2. 节点阴影四 token → 双层浅灰影+白内高光（与深色双层工艺对应）。
3. 节点边框 → **哑金 rgba(191,155,74,0.55)**（白底上加深显形，与深色亮金同一语言）。
4. 金线三档浅色版：edge **#b8933d** 古金 / sel **#8f6f1d** 深金 / flow **#d4bc7a** 浅古金（普通边也入金，白底上反向加深）；宽度维持历史值。
5. 类型色板莫兰迪浅色版（粉彩底+深字成对）：ai #DFE9F5/#4A6FA5、human #DFEDE3/#4A7A5C、mind #F3E3E3/#A56A6A、func #F2EAD8/#997B3D、assign/par #E9E5F5/#7A6FAE。
6. 徽章默认块：粉彩底(var type-bg)+深莫兰迪字（ai #3E5C94/human #3D664C/mind #8A5050/func #7A6535/assign #63598F），module 保持 tag-bg 白字。
7. 特殊节点 sp-* 五枚浅色=**与深色同一套鲜彩实色**（#2E9E5B/#D24B4B/#DB9524/#3B82D6/#8468DC——彩底白字与主题底色无关）；`.fem-special-label` 白字规则改为全局（round20 曾删，本轮按需重加）。
8. neon 块补 badge 十二枚覆盖（tint 底+亮字+module #2a3449/#eef2f9），防被浅色粉彩默认值波及。

### 不变的
结构类 token 全部自动跟随（node-bg/btn-primary/edge-w/仓库同构/压扁 56/MiSans）；success/warning-soft 浅色保持原淡彩；流光仍仅深色启用。

### 验证
- 备份：MEOW_backups/themes.js.bak-20260821-round27
- esbuild 通过（lib/client.js 491.3kb）；F9FAFB×4/b8933d/4A6FA5/2E9E5B/fem-special-label×4 进产物
- ⚠️ 待刷新实测：切浅色主题逐项检查（画布白底/面板灰/哑金边框/古金线/粉彩芯片/鲜彩特殊节点/功能钮蓝）

## 2026-08-21 主题裁撤（round28：删除 neon 霓虹主题）

### 需求（用户看过浅色同步后）
"帮我把那个'霓虹'主题删掉，也太丑了。我们只留我们改好的dsh深色和dsh浅色就好了"——auto（跟随 DSH）保留：它不是独立配色，是自动跟随本体白天/黑夜的机制，产出的就是深/浅两套。

### 修改明细
`themes.js`：
1. FEM_THEMES 数组删 neon 项（剩 auto/dsh/dsh-dark 三项）；
2. 删除整个 [data-fem-theme="neon"] CSS 块（124 行，pwsh 行号锚点切除 + [System.IO.File]::WriteAllLines UTF8 无 BOM 写回——PS5 Set-Content utf8NoBOM 不支持）。
3. 兼容性说明（round28 后用户澄清）：不存在存过 'neon' 的 localStorage 会话，未加任何兼容代码；FEM_THEMES 校验回退是原有逻辑非本次新增。
4. 顺手修正流光 CSS 注释（三层→多层、去 neon 提法）。

### 验证
- 备份：MEOW_backups/themes.js.bak-20260821-round28
- esbuild 通过（lib/client.js 485.2kb）；源码 neon 仅剩 2 处无害注释（删除说明+流光注释已修正），bundle 内 neon 仅注释类字符串
- ⚠️ 待刷新实测：主题循环按钮只剩 跟随DSH→DSH浅色→DSH深色 三档

## 2026-08-21 浅色黑白金属版（round29：金色→纯黑系 + 浅色启用白色流光）

### 需求（用户看过浅色同步后）
"深色版是黑金比较好看，浅色可能白黑比较好看。黑是那种很纯的黑，加上纯白的流光，制造一种发亮的金属效果……你把原版里本来是金色的地方改成纯黑试试看？还有光效颜色也改一下。这是浅色主题，深色主题不变哦"

### 修改明细（全在 themes.js 默认块+CSS，dsh-dark/neon 已删不受影响）
1. 节点边框 哑金 rgba(191,155,74,0.55) → **近纯黑 rgba(10,10,10,0.85)**。
2. 连线三档古金 → 黑系三档：edge **#1c1c1c** 近纯黑 / sel **#000000** 纯黑 / flow **#4a4a4a** 深灰黑。
3. --fem-edge-sheen 占位 → **#ffffff 纯白**；CSS 流光门控从仅 dsh-dark 扩展为 dsh-dark+dsh 双档启用（同 3.2s/blur0.5px 参数）——白光扫过黑线=发亮金属。

### 不变的
类型莫兰迪色板/徽章/特殊节点鲜彩底白字/功能钮 deepseek 蓝/投影/宽度；深色主题全部 token 未动。

### 验证
- 备份：MEOW_backups/themes.js.bak-20260821-round29
- esbuild 通过（lib/client.js 485.3kb）；黑系三值/sheen 白/dsh 流光门控进产物
- ⚠️ 待刷新实测：切 DSH 浅色——黑白金属观感、白流光扫过黑线的发亮效果

## 2026-08-21 精修第三十轮（金线细化提亮 + 流光 v5 真渐变光珠）

### 需求（用户三条）
①电脑端连线再细一点（手机端还行，一起调了）；②深色金线电脑端看着比手机暗淡，再调亮一点点；③流光分三/五段还是愣——"做成真渐变的吗，从纯白到无的一段渐变流光。（纯白到无，那就是深色浅色都能用了）"

### 根因与方案
①②粗细/颜色 token 双主题共用，感知差异来自电脑端插件模式 zoom:0.75 的抗锯齿变细变暗——细化一档+提亮补偿。③dash 段无法段内渐变，多层叠加是近似——改用 **SVG radialGradient(纯白→透明) 光珠 + SMIL animateMotion 沿路径运动**：一段真正的连续渐变光珠滑线，天然深浅通用。

### 修改明细
1. `themes.js`：dsh-dark 边宽 1.25/1/1.75→**1/0.85/1.5px**、浅色 1.8/1.5/2.5→**1.5/1.25/2.25px**；dsh-dark 金三档提亮 #f4d268→**#ffd76b**、#ffe58f→**#ffec9c**、#d6b052→**#e3c05e**；双主题 sheen 统一**纯白 #ffffff**。
2. `FemWorAuto.jsx`：EdgeShimmer 重写为单 `<g className="fem-edge-comet">` 内 `<circle r=5 fill=url(#femCometGrad)>` + `<animateMotion dur=3.2s path={d}>`；两个 svg defs 各加 radialGradient femCometGrad（0% 不透明→45% 55%→100% 透明，stopColor 走 style var()）。
3. `themes.js` CSS：.fem-edge-shimmer 规则+keyframes 删除，换 .fem-edge-comet 门控（默认 opacity 0，dsh-dark/dsh 点亮）。
4. 调用点不变（w 参数弃用不传参兼容）；语义边仍不走流光。

### 验证
- 备份：MEOW_backups/{themes.js,FemWorAuto.jsx,mobileView.jsx}.bak-20260821-round30
- esbuild 通过（lib/client.js 484.6kb）；femCometGrad×3/animateMotion×2/comet 门控进产物，旧 shimmer/keyframes 残留 0
- ⚠️ 待刷新实测：真渐变形态是否满意、SMIL 动画流畅度（Chrome/手机 Safari 均支持）、金线亮度档位

## 2026-08-21 精修第三十一轮（流光 v6：线性渐变胶囊光带，回弃光珠）

### 需求（用户看过第三十轮后反馈）
"你不要改成光珠啊，我喜欢你之前写得那个光段，很长一段，但你之前写的是三段渐变，渐变段数太少就显得很楞，我们只是要细化他"——保留长光段形态，消灭分段感。

### 修改明细
`FemWorAuto.jsx`：
1. EdgeShimmer v6：五层 dash 段与 round30 光珠均弃用，改为 **rect 胶囊（64×3px）装 linearGradient(透明→纯白50%→透明) + animateMotion rotate=auto**——胶囊随路径切线旋转、始终与线方向对齐，渐变数学连续零分段；高 3px 略浮于 1px 线上作高光。
2. 两个 svg defs：femCometGrad(radial) → femCometLin(linear, objectBoundingBox 五档 stop)。
3. 门控 .fem-edge-comet CSS 不变（默认 opacity:0，dsh-dark/dsh 点亮）；调用点/语义边排除不变。

### 验证
- 备份：MEOW_backups/FemWorAuto.jsx.bak-20260821-round31
- esbuild 通过（lib/client.js 485.4kb）；femCometLin×3/rotate auto 进产物，femCometGrad 残留 0
- ⚠️ 待刷新实测：胶囊长光带的连续渐变观感；长度 64px/高度 3px/时长 3.2s 均可调

## 2026-08-21 精修第三十二轮（流光 v7 蒙版限定 + 深浅线宽统一）

### 需求（用户三条）
①深浅连接线粗细不一样，都改成细的；②线弯曲时流光不跟着弯，很奇怪；③流光严重超出线的范围——"能不能只在线内部的部分看见流光，外面不要有，金属反光不是发光。类似于蒙版，可以实现吗"

### 方案（用户提议的蒙版 = SVG mask 标准解法）
EdgeShimmer 外层加 `<mask>`（内容=同 d 的白色描边、宽度=可见线宽 w token）罩住胶囊——**胶囊被裁成只剩落在笔画内的部分**：弯线自动跟随弯曲、绝不超出线宽、纯反光不发光。胶囊本体放大到 64×6px 让渐变完整覆盖蒙版窗口。

### 修改明细
1. `FemWorAuto.jsx` EdgeShimmer v7：签名恢复 { d, w }（四个调用点原本就传 w）；实例级 maskId=useMemo+模块序号；mask 内 path strokeWidth 走 style var(w)；rect 6px 高被蒙版裁成线内反光。
2. `themes.js` 浅色边宽对齐深色细线：1.5/1.25/2.25 → **1/0.85/1.5px**（三档）。

### 验证
- 备份：MEOW_backups/{themes.js,FemWorAuto.jsx}.bak-20260821-round32
- esbuild 通过（lib/client.js 486.1kb）；femCometMask 进产物
- ✅ 教训沉淀：SVG mask 罩"会动/会在远处"的元素时必须显式 userSpaceOnUse 大区域，默认 objectBoundingBox 只罩原地
- ⚠️ 待刷新实测：流光恢复可见且只在线内

## 2026-08-21 精修第三十四轮（真凶实锤：mask 内容不解析 CSS var）

### 需求（用户刷新后仍反馈）
"没回来，话说是不是因为那是线，那不是填充"

### 客观定位（不再瞎猜）
写四宫格对照页 `_shimmer-test.html`（基线/无蒙版胶囊/mask+var 线宽/mask+字面量线宽），用 meow-smooth shot.mjs CDP 截图 + ask_eyes 判读：B/D 有白色光带、**C（mask 内 strokeWidth:var()）空**——Chromium 的 `<mask>` 内容不解析 CSS var()，白描边宽度取不到值 → 蒙版成空。

### 修改明细
`FemWorAuto.jsx`：EdgeShimmer mask 内 path 的线宽从 style var(--fem-edge-w*) 改为**字面量数值 w**（四个调用点分别传 0.85/0.85/1/1，与 themes.js 深浅统一后的 --fem-edge-w* 数值同步维护，注释已标注联动关系）。可见线的 style var 用法不变（mask 外解析正常）。

### 验证
- 备份：MEOW_backups/FemWorAuto.jsx.bak-20260821-round34
- esbuild 通过；四调用点全字面量、源码无 EdgeShimmer 路径上的 var 残留
- ⚠️ 待刷新实测：流光恢复可见且只在线内（深浅双主题）

## 2026-08-21 精修第三十三轮（修复：蒙版流光整条消失）

### 需求（用户真机反馈 round32 后）
"看不到流光了……"——v7 蒙版方案上线后流光完全不可见。

### 根因
SVG `<mask>` 默认 maskUnits="objectBoundingBox"——**蒙版作用区域按被罩元素（胶囊）自身包围盒的 -10%~120% 计算**，即胶囊未变换时的原始位置那一小圈；而光珠滑到路径远端时早跑出该区域 → 蒙版交集为空 → 整条消失。mask 内容坐标本就是 userSpaceOnUse（画布绝对坐标），与区域坐标系错位。

### 修改明细
`FemWorAuto.jsx` EdgeShimmer 的 `<mask>` 显式声明 `maskUnits="userSpaceOnUse" x=-10000 y=-10000 width=20000 height=20000`——作用区域覆盖全画布，光珠滑到任何位置都在蒙版窗口内。

### 验证
- 备份：MEOW_backups/FemWorAuto.jsx.bak-20260821-round33
- esbuild 通过；userSpaceOnUse 进产物
- ✅ 教训沉淀：SVG mask 罩"会动/会在远处"的元素时必须显式 userSpaceOnUse 大区域，默认 objectBoundingBox 只罩原地

## 2026-08-21 round44（修复：全局 touch-action:none 污染触摸链——仓库卡片无法滚动的真凶）

### 需求（用户真机调试反馈）
悬浮层实证 JS 层清白（卡片滑动 → CANCEL→原生滚动 正确放行）但列表不滚；间隙滚动正常。差异锁定=**触点元素链上的 CSS touch-action**。

### 根因
`MobileGlobalStyle` 里 `html, body { touch-action: none }`——Chrome 从触点向上累积 touch-action 到根，body 的 none 污染所有手势链（此前以为"间隙能滚"已排除它，实为误判）。画布区本就有独立的 .fem-canvas-zone{touch-action:none}，全局规则冗余且有害。

### 修改明细
`mobileView.jsx` MobileGlobalStyle：删除 html,body 的 `touch-action: none`（保留 overscroll-behavior/user-select）；.fem-canvas-zone{touch-action:none} 保留（拖节点/连线/平移仍走自定义手势）。副作用评估：页面级双指缩放本就被 viewport meta 禁用；body 无需禁触。

### 验证
- 备份：MEOW_backups/mobileView.jsx.bak-20260821-round44
- esbuild 通过（lib/client.js 494.3kb）；源码 'touch-action: none' 仅剩 canvas-zone 一处
- ⚠️ 待手机实测：卡片上滑=滚列表、画布拖拽/连线/平移正常、页面无异常回弹

### 教训
全局 `touch-action:none` 是隐形杀手——它会沿祖先链污染所有子区域的原生触摸行为；禁触需求应精确挂在需要的最小区域。

## 2026-08-22 rc.2 切换善后：web 前端/客户端包未构建 + bridge subprocess 竞态（两处修复）

### 背景
用户将喵版工作区切换到官方新版快照 `dsh-meow0.1.1-rc.2`（start-meow.ps1 已改 Set-Location，回滚=改回 dsh-meow）。切换后 3081 无法启动：①01:31 手动启动的实例卡死成僵尸（无监听、无 bridge）；②AI 代重启时 boot 快速失败。

### 诊断（diag-uncaught.mjs 展开 AggregateError——Node 打印 AggregateError 不含 errors 数组，dsh-femwa 的 uncaughtException handler 只打 stack 也看不到；脚本 prependListener 抢先展开）
两个失败 entry，**均与 dsh-femwa 无关**（femwa 路由+四工具注册成功、meow-smooth 正常）：
1. `directory-picker`：`Cannot find module ...\profiles\node_modules\@deepseek-ai\dsh-client-ui-directory-picker-native\lib\index.js` —— profiles 包是 junction 指向 rc.2 的 pnpm 依赖结构，**rc.2 的 client 包从未构建（缺 lib/）**；
2. `web-runtime (@deepseek-ai/dsh-web-app)`：`frontend dist not built; run pnpm run build from the repository root first` —— **rc.2 的 web 前端 dist 未构建**。
dsh host 是 tsx source-launch 不需要构建，但 client 包与前端必须——切快照漏了这步。

### 修复 A：补构建
- rc.2 根 `pnpm run build` 全量构建（所有包 lib ✓ 含 directory-picker-native）；最后一步 web-frontend 在沙箱 job 里因子进程 PATH 无 pnpm 失败 → 手动补 PATH 重跑 `pnpm --filter @deepseek-ai/dsh-web-frontend run build` ✓（首次 EBUSY favicon.svg 为残留进程瞬时锁，清进程后通过）。

### 修复 B：bridge subprocess 竞态（src/index.ts）
构建补齐后服务能起但出现新日志 `[dsh-femwa] subprocess service unavailable; bridge not started`——插件 apply 完成早于 base bundle 的 subprocess provider（插件树并发装配完成顺序不定；rc.2 插件更多、固定 1s 延迟不再够）。修复：`bridge.start(ctx, config, attempt)` 改为轮询等待（subprocess 未就绪每秒重试，上限 30 次），就绪后打 `subprocess service ready after Ns wait`。
- 备份：MEOW_backups/index.ts.bak-20260822-subprocess-wait
- 验证：重启后日志 `subprocess service ready after 1s wait; starting bridge`、bridge pid 存活、端口+路由 200 ✓

### 教训
1. **切 dsh 快照目录 = 新 checkout 需要完整构建**（host 免构建 ≠ client lib + 前端 dist 免构建）；
2. 插件 apply 内依赖其他 bundle 服务时不得假设装配已完成——轮询等待或挂 loader 就绪钩子；
3. Node 的 AggregateError 打印不含 errors 子数组，诊断需 prependListener 自行展开。

## 2026-08-21 精修第三十五轮（流光 v8：多层 dash 光带回撤定稿，弃蒙版/光珠）

### 需求（用户看过第三十轮后反馈）
①线弯曲时胶囊光带不跟着弯；②严重超出线的范围——"只在线内部的部分看见流光……类似于蒙版"。round32 蒙版方案 + round34 var 修复后**流光仍不可见**。

### 客观探针定位（_shimmer-probe.mjs：页面内栅格化逐格统计白像素）
八宫格实证：外层 g 蒙版+内层变换（E）与同元素 mask+静态变换（F）双双 **0 白像素**——mask 在"带 transform 的元素/嵌套变换"场景下 Chromium 渲染不可靠；渐变 stop 用 var() 反而正常（G/H 均 450）。结论：放弃 mask 路线。

### 修改明细（v8 回撤定稿）
`FemWorAuto.jsx`：
1. EdgeShimmer 重写为 **SHIMMER_LAYERS 六层同路径 dash 短划**（16→76px 长、strokeOpacity 1→0.04、cycle 288、负 animation-delay 中心对齐 0/-0.0667/-0.1333/-0.2/-0.2667/-0.3333s），stroke=var(--fem-edge-sheen) 纯白、strokeWidth=w token——**流光就是线本身的描边**，构造性保证随弯+零溢出。
2. `themes.js` CSS 门控换 .fem-edge-comet-layer（默认 opacity:0，dsh-dark/dsh 点亮）。
3. 清理：两处 svg defs 的 femCometLin 渐变定义删除（无引用）；femCometMask 相关全清。

### 验证
- 备份：MEOW_backups/FemWorAuto.jsx.bak-20260821-round35
- esbuild 通过（lib/client.js 490.6kb）；SHIMMER_LAYERS 进产物，femCometLin/femCometMask 残留 0
- ⚠️ 待手机实测：首滑即滚/慢滑不误武装/长按拖拽正常；调试条实时显示 st=scrollTop 供客观判读

## 2026-08-21 round48（touchcancel 诊断 + 横向行 pan-x 声明）

### 关键线索（用户真机观察）
"dy 记录 0.x 秒后冻结，手指还在滑但 dy 不再变"——**touchmove 事件流中途终止**。典型机制=浏览器判定手势归属后向 JS 发 touchcancel 接管。嫌疑场景：仓库 Actions 行是横向滚动容器（overflow-x:auto），斜向滑动被方向锁定给横向行 → 垂直面板永不滚。

### 修改明细
1. `mobileView.jsx`：新增 handleLibTouchCancel（dbg TCANCEL+清态），透传 LibPanel；四类卡挂 onTouchCancel。
2. `mobileView.jsx`：Actions 行与 Modules 行容器加 `touchAction: 'pan-x'`——声明该行只处理横向手势，竖直滑动放行给面板垂直滚动（若 touchcancel 实锤，此声明即修复）。

### 验证
- 备份：MEOW_backups/{mobileView,libPanel}.jsx.bak-20260821-round48
- esbuild 通过（lib/client.js 496.0kb）；TCANCEL×1/onLibTouchCancel 五处接线进产物
- ⚠️ 待手机实测：若调试条出现 TCANCEL=方向锁定实锤（pan-x 应已修复）；仍复现则读 TCANCEL 后的 st 值

## 2026-08-21 精修第三十六轮（修复：v8 光带不动——动画规则漏挂新类名）

### 需求（用户看过第三十五轮后反馈）
"光感好看了，但是它现在不动…"

### 根因
round35 重写 EdgeShimmer 时把光带类名换成 .fem-edge-comet-layer，但 themes.js 的动画规则仍绑在旧类 .fem-edge-shimmer 上且已被删——六层 dash 只有静态形态、无 dashoffset 动画。

### 修改明细
`themes.js`：补 `.fem-edge-comet-layer { animation: femEdgeSweep 3.2s linear infinite }` + `@keyframes femEdgeSweep { stroke-dashoffset 288→0 }`（各层 inline animationDelay 相位不变）；过程中误吞的 .fem-special-label 白字规则已即时补回。

### 验证
- esbuild 通过（lib/client.js 491.1kb）；femEdgeSweep/fem-special-label/fem-edge-comet-layer 全进产物
- ⚠️ 待刷新实测：光带沿箭头方向滑动

## 2026-08-21 round43b（诊断插桩：仓库触摸判定链路悬浮层）

### 背景
round43 加固后用户仍报卡片区域无法滚动——headless 合成触摸又复现不了真机，改为**真机可视化插桩**：在手机上实时显示判定链路每一步。

### 修改明细
`mobileView.jsx`：handleLibTouch* 各决策点埋 dbg()（TS 触发+目标 touchAction / MOVE 位移 / ARMED / CANCEL→原生滚动 / ARM-CANCEL / TE 收尾），MobileLayout 渲染 fixed 悬浮层（绿字黑底、pointerEvents:none）。**临时插桩，验收后移除。**

### 验证
- esbuild 通过；ARM-CANCEL 等标记进产物
- ⚠️ 待手机复现：慢滑 action 卡片，读悬浮层文字序列反馈（重点看是否出现 ARMED=被误武装 / CANCEL→原生滚动后列表是否真的滚了 = CSS/原生层问题）

## 2026-08-21 手机端主题拆分（round37：移动壳配色跟随主题，不再恒暗）

### 需求（用户）
"手机端的UI，不同主题的配色好像在代码里没有分开。比如说元件的颜色、背景画布的颜色之类的……模仿电脑端，把手机端的主题相关元素拆到主题里面。"

### 考证
--fem-mobile-* 十六枚壳层 token 只存在于默认块、数值固定深色（早年"移动壳=固有深色区"设计遗留）——任何主题下手机壳同一套配色，确未按主题拆分。

### 修改明细（仅 themes.js）
1. 默认块（=DSH 浅色）：mobile-* 全组换浅色值——bg #ffffff（聊天底）/bg-2·surface #F9FAFB（sidebar-fill）/bg-3 #F1F3F5/surface-hover #ECEEF1/border rgba(0,0,0,0.12)/border-light rgba(0,0,0,0.22)（兼空态提示文字）/border-strong #ECEEF1/text-1 #17191D/text-2 #6A7077/text-2-alt #45494F/text-3 #9AA0A6/danger-soft #FDECEC/danger-border #F5C6C6/mask 黑 24%。
2. dsh-dark 块：补十六枚深色覆盖（即拆分前的原深色值）——深色档手机观感零变化。
3. 预览条 --fem-preview-* 保持固有深色未动（代码条观感）；画布点已全局去除不受影响。

### 验证
- 备份：MEOW_backups/themes.js.bak-20260821-round37
- esbuild 通过（lib/client.js 491.6kb）；mobile-bg 双定义×2/F9FAFB 进产物
- ⚠️ 待手机实测：浅色主题下手机壳变白/文字变深；深色主题下壳维持中性黑；两主题切换无残留

## 2026-08-21 精修第三十八轮（FEM 预览条按主题拆分——round37 漏网组）

### 需求（用户截图反馈）
电脑端 FEM 预览（剧本输入框+行号）在浅色主题下仍是深色底白字，"深色主题应是深色，浅色主题现在看着还是深色。看看是不是这个没按主题分开？"——确认：--fem-preview-* 五枚 token 确未拆分（round37 刻意遗留）。

### 考证
femPreview 组件大部分已 token 化且**借用 mobile token**（textarea 底=mobile-bg-2/代码字=mobile-text-2-alt/行号字=mobile-text-3）——round37 已随手机拆分变亮；真正残留的只有行号槽底(preview-bg-2)与分隔边(preview-border) 两处消费 + preview-bg/text/text-2 三个死 token。

### 修改明细
`themes.js`：
1. 默认块 preview-* 五枚换浅色值：bg #ffffff / bg-2 #F6F8FA（行号槽）/ text #444C56 / text-2 #8B949E / border rgba(0,0,0,0.12)。
2. dsh-dark 块补五枚深色覆盖（原值 #151517/#1b1b1c/#adb2b8/#61666b/白12%）——深色观感零变化。

### 验证
- 备份：MEOW_backups/themes.js.bak-20260821-round38
- esbuild 通过（lib/client.js 492.0kb）；F6F8FA/444C56/151517 各进产物
- ⚠️ 待刷新实测：浅色下预览条变浅色代码区、深色不变

## 2026-08-21 精修第四十二轮（POSITION 卡「+画布」按钮归队 primary）

### 需求（用户）
"仓库里的 position 节点，'+画布'按钮怎么是灰的，用那个蓝色吧"——round32 功能钮清扫漏网（当时只扫了 action/special/module/创建 五处）。

### 修改明细
`libPanel.jsx` POSITION 卡「+画布」background: var(--fem-neutral) → **var(--fem-btn-primary)**（深浅各自解析：深=#4176e6 deepseek-500 / 浅=主蓝）。至此 libPanel 六处功能钮（+新建/action+画布/special+画布/module+画布/创建/position+画布）全部 btn-primary。

### 验证
- 备份：MEOW_backups/libPanel.jsx.bak-20260821-round42
- esbuild 通过；libPanel 内 fem-btn-primary ×6 确认
### 教训
全局 `touch-action:none` 是隐形杀手——它会沿祖先链污染所有子区域的原生触摸行为；禁触需求应精确挂在需要的最小区域。

## 2026-08-21 round45（真凶二号：draggable 卡片阻止触摸滚动）

### 需求（用户 round44 后反馈）
删全局 touch-action 后**还是不行**，且现象精确化："行的那几下都是按到了节点中间的间隙"——按在卡片上永不滚，按在间隙必滚。

### 根因（真凶二号）
四类卡全部带 HTML5 `draggable` 属性（桌面端拖拽用）。**Chromium 触摸设备上，draggable 元素会抑制原生滚动启动**（浏览器保留长按语义）——与 JS 无关的纯浏览器行为，所以 JS 怎么放行都没用；间隙无 draggable → 原生滚动正常。时好时坏=手指落点是否恰好压在卡片上。

### 修改明细
1. `libPanel.jsx`：新增 `htmlDraggable = true` prop；四类卡 `draggable={htmlDraggable}`。
2. `mobileView.jsx`：MobileBottomPanel 接收并透传；MobileLayout 调用处传 **false**——手机端拖拽走我们自己的长按触摸逻辑，不需要 HTML5 拖拽。
桌面端默认 true 零变化。

### 验证
- 备份：MEOW_backups/{libPanel,mobileView}.jsx.bak-20260821-round45
- esbuild 通过（lib/client.js 492.7kb）；htmlDraggable×8 进产物
- ⚠️ 待手机实测：卡片上滑=滚列表（本次应该真的好了）；电脑端拖拽入画布不受影响

### 教训
移动端 Web 里 `draggable="true"` 元素是触摸滚动的隐形杀手——HTML5 拖拽语义与触摸滚动冲突；触摸交互应自实现（本项目已是），draggable 仅限桌面鼠标场景。

## 2026-08-21 精修第三十九轮（浅色特殊节点/空节点：深色设计骨架移植，弃莫兰迪粉彩）

### 需求（用户看过浅色同步后）
"浅色主题的特殊节点（start/end/par等）还有空节点，现在是奇怪的边框奇怪的底色……和深色主题的设计感统一一下，设计思路统一颜色可以不一样。我觉得浅色其实没那么适合莫兰迪"——特殊节点+POSITION 弃粉彩底，移植深色骨架：同款灰白底 + 类型彩边 + 类型色文字。

### 修改明细
1. `themes.js` 默认块：sp-* 五枚 → var(--fem-node-bg)（白底与 action 节点一致）；新增 `--fem-node-border-mix-base`（默认=#000000，dsh-dark=var(--fem-node-bg) 维持既定压暗档）——SpecialNodeView 未选中彩边 = color-mix(sc.c 50%, mix-base)：深色向表面压暗（不变），浅色向黑压深（鲜边在白底显形）。
2. `themes.js` CSS：.fem-special-label 白字规则收回 dsh-dark 门控（浅色=inline sc.c 彩字，与彩边呼应）。
3. `canvasNodes.jsx` PositionNodeView：文字 c 与未选中边框从 neutral/fem-border → **text-2 / tag-bg 实色**（灰卡在白画布上不再虚化）；选中仍 text-2 加粗。

### 验证
- 备份：MEOW_backups/{themes.js,canvasNodes.jsx}.bak-20260821-round39
- esbuild 通过（lib/client.js 492.5kb）；mix-base×3/special-label×3 进产物
- ⚠️ 待刷新实测：浅色特殊节点白底彩边彩字观感、空节点灰卡清晰度；深色档确认零变化

## 2026-08-21 精修第四十一轮（补齐 PAR_OUT 彩边 + 浅色彩边提亮）

### 需求（用户看过第三十九/四十轮后反馈）
①"par out 你漏了"——PAR_OUT 未选中边框还是中性色，没跟上特殊节点常显彩边；②浅色彩边压太黑——"感觉全是黑的，看不出颜色"，稍微提亮。

### 修改明细
1. `canvasNodes.jsx` ParOutNodeView：border 从 `sel ? sc.c : fem-border` 改为**常显 sc.c**，宽度未选中 var(--fem-border-w)/选中 w-selected——与 START/FOR/PAR 完全同款。
2. `themes.js` 浅色 `--fem-node-border-mix-base` #000000 → **#8F8F8F**（中灰基色：50% 混合后色相浮出，不再全黑）；dsh-dark 基色=node-bg 不变（深色既定观感零变化）。

### 验证
- 备份：MEOW_backups/{canvasNodes.jsx,themes.js}.bak-20260821-round41
- esbuild 通过（lib/client.js 492.6kb）；8F8F8F 进产物
- ⚠️ 待刷新实测：五类特殊节点+PAR_OUT 彩边的色相区分度；深色档确认零变化

## 2026-08-21 交互补丁（round43：仓库慢速滑动被误武装为拖拽的边缘洞）

### 需求（用户）
"手机端仓库，在任何地方上下滑动都是让仓库上下滑动……action 区域也应该支持上滑"——round25 已实现激活前不拦截滚动的主体行为，但用户实测卡片上滚动仍不顺。

### 根因（边缘洞）
300ms 武装计时器到点时**不校验当前位移**：慢速滚动（前 300ms 累计 <5px）会在到点瞬间被武装成拖拽态 → 后续 touchmove 被 preventDefault → 滚动劫持。快速甩动不受影响（超 5px 已提前取消），慢速滚动必中。

### 修改明细
`mobileView.jsx` handleLibTouch*：
1. pre-armed touchmove 记录 lastX/lastY 实时坐标；
2. 武装到点时复核实时位移——任一轴 >4px 即判定为滚动意图，放弃武装（libDragRef 清空让位原生滚动）。
阈值取 4px（<MOVE_THRESHOLD 5px）：轻微抖动不误伤长按，正常滚动速度必超。

### 验证
- 备份：MEOW_backups/mobileView.jsx.bak-20260821-round43
- esbuild 通过（lib/client.js 492.7kb）；lastX/武装复核进产物
- ⚠️ 待手机实测：卡片上慢速上下滑=滚列表、按住不动 300ms=长按拖拽、快速甩动=惯性滚动，三态并存

## 2026-08-21 round47（性能共犯清除：touchmove 内 setState → ref 直写 DOM）

### 关键线索（用户真机观察）
"刷新后第一次滑动一般失效""先摸间隙动一下之后就活了"——首次触摸期间主线程被重活阻塞，WebKit 来不及启动滚动的典型表现。

### 根因
round43b 的调试悬浮层在**每次 touchmove 都 setState**（dbg/MOVE/DRAG 分支）——setState 触发整棵 MobileLayout（含巨量 canvasContent）重渲染，主线程卡死几十至上百 ms：①WebKit 在渲染阻塞期间无法启动/延续滚动→手势失效；②时好时坏=取决于手指速度与渲染时机赛跑。间隙能"解锁"=第一次触摸的重渲染风暴过去后主线程已热。

### 修改明细
`mobileView.jsx`：
1. 调试条改**常驻节点+libDbgRef.textContent 直写**（零重渲染，且顺带显示 panel scrollTop 客观数据）。
2. ghost 胶囊改**常驻节点+ghostRef/ghostLabelRef 直写**（display/left/top/label 全 ref）；libDragGhost state 删除。
3. armed 开关保留唯一 state：libDragActive（驱动画布放置提示，每手势仅 2 次渲染）。
4. handleLibTouch* 内所有 setLibDragGhost/libDbg 调用点替换完毕。

### 验证
- 备份：MEOW_backups/mobileView.jsx.bak-20260821-round47
- esbuild 通过（lib/client.js 495.4kb）；libDragGhost 残留 0、ghostRef×12 进产物
- ⚠️ 待手机实测：首滑即滚/慢滑不误武装/长按拖拽正常；调试条实时显示 st=scrollTop 供客观判读

## 2026-08-21 round46（armed 拦截失效真凶：React 根级 touchmove 是 passive——改原生非 passive 绑定）

### 需求（用户规格书）
"长按过后的 drag 状态下，面板不动；TS cancel 状态下，面板要跟手滚动"——现状相反：armed 时面板跟手滚（preventDefault 失效）。

### 根因
React 17+ 在根容器把 onTouchMove 注册为 **passive** 监听（官方行为）——passive 里 preventDefault 无效。v8 armed 分支的 e.preventDefault() 从未生效 → 原生滚动照走。

### 修改明细
1. `mobileView.jsx` MobileBottomPanel：新增 useEffect 把 onLibTouchMove/onLibTouchEnd/onLibTouchCancel 以 **addEventListener({passive:false})** 挂到滚动容器 scrollRef 上（原生非 passive，preventDefault 生效）；卸载时解绑。LibPanel 卡片上的 React onTouchMove/End 挂载删除（onTouchStart 保留——无需 preventDefault）。
2. `libPanel.jsx`：删 onLibTouchMove/onLibTouchEnd props 与四类卡挂载。
3. MobileLayout 调用点不变（仍传 handleLibTouch*，经 props 进入 MobileBottomPanel 后走原生绑定）。

### 影响面
pre-armed 分支依旧不 preventDefault（滚动不受影响）；仅 armed 分支的拦截现在真实生效。桌面鼠标路径不经此处。

### 验证
- 备份：MEOW_backups/{mobileView,libPanel}.jsx.bak-20260821-round46
- esbuild 通过；原生绑定进产物
- ⚠️ 待手机实测：armed 拖拽时面板静止、ghost 跟手；松手放置正常

## 2026-08-23 femwa-run 动作更名：from_scratch → fresh_start

用户拍板（原话）："Fresh start最好。确实也是一个常用语嘛，而且不管是第一次还是第N次都很适用，也没有歧义。一看就是从头开始的意思"。缘起：用户指出 from_scratch 是当年笔误（应为 from_start，又嫌笨重），且希望词义兼顾"第一次开始"与"第 N 次重新开始"、强调从头、不与 resume 混淆；曾考虑 run/start/restart/from_zero，最终选 fresh_start。
### 修改明细
1. `src/tools.ts`：enum/描述/校验/case 共 7 处 from_scratch → fresh_start
2. `src/index.ts`：2 处注释
3. `.agent-presets/dsh-femwa/agent.cordis.yml`（dsh-home）：系统提示词【运行】段 2 处——主模型人设文本的真正源头在此 preset，不在插件源码
4. 不保留 from_scratch 旧值别名（纯笔误，仅两个用户）
### 影响
- 主模型调用 femwa-run 时 action 必须传 fresh_start；旧值会报"action 是必填参数：fresh_start / stop / pause / resume 四选一"
- 生效条件：node build.mjs 重建 + 重启 3081（host 换血）

## 2026-08-23 运行结果通知改造：femwa:notify section 废弃 → agent.steer 对话流直达

用户需求（原话摘要）：编译错误在 femwa-run 返回里报错（非 ok）；跑到一半报错/全部跑完后"立即再发一条工具消息给主agent，把报错信息详细反馈"，"这些都是要发在对话流里"。调研结论：dsh 官方支持插件主动给模型发消息——`agent.steer(UserMessage)`（空闲即开新回合，忙碌时下一 step 边界消费，必达不打断），meow-memory 的 dream 任务即此机制。
### 修改明细
1. `src/engine-events.ts`：新增 steerMainAgent()（ctx.agents.get(sid) 或 ctx.get('agents') 拿主模型 agent，构造 {id,role:'user',content,source:{kind:'plugin',plugin:'dsh-femwa'}} 后 steer）；flow_done/flow_error 两分支的 runNotices.set 替换为 steerMainAgent；flow_stopped 分支仅删除 runNotices.set（停止/暂停由发起方经工具返回值已知悉）；删除 flow_start 的 ensureRunNotice 调用
2. `src/persona.ts`：删除 femwa:notify 三件套（runNotices/runNoticeSections/injectRunNotice/ensureRunNotice）及头注释更新
3. `src/tools.ts`：femwa-run 描述改为"跑完/出错会有 [dsh-femwa] 开头的插件消息直接发进对话流"
4. 编译错误路径核实：startRunOnSession 编译失败同步 throw（index.ts L236），tools.ts catch 返回 ok:false——需求①天然满足未改码
### 已知缺陷（动机）
旧 femwa:notify section 把通知静默注入 system prompt，实测两次运行主模型均漏读（靠逐帧解压 session.jsonl.zstd 的 request/header 快照才实锤通知其实送达过）。
### 生效条件
node build.mjs 已重建；重启 3081 后生效。

## 2026-08-24 跑完通知时灵时不灵 + 新会话被「已有剧本在运行中」误拒：SaveQueue 哨兵毒丸根因修复
### 根因（日志+复现双实锤）
femCompiler/save_dialog.py wait_empty() 塞 None 哨兵后，_worker_loop 消费它时直接 break、不调 task_done() → Queue unfinished 计数从第一次 wait_empty 结束起永远 ≥1 → 同引擎进程第二轮 run 的 wait_empty 卡死在 queue.join() → flow_done 永不发出 → runState.running 卡 true。表现=①同进程第一场戏通知必达、之后每场全部静默（flow_error/stop 路径不走 wait_empty 不受影响，故「时灵时不灵」）；②running 全局单例卡死后任何新会话 femwa-run 被 resolveMounted 守卫拒绝，主模型对用户说「目前已有剧本在跑」（meow-3081-console.log L255-265 现行实录）。
### 修改明细
1. femCompiler/save_dialog.py：哨兵分支补 self._queue.task_done()（一行根因修复）
2. src/bridge.ts：新增 onExited 回调，进程退出时触发
3. src/index.ts：bridge.onExited 接线清孤儿 running/humanWait；resolveMounted 守卫文案带归属会话 id（本会话 vs 另一会话区分）
4. src/run-control.ts：handleRunOnSession 409 同样带归属会话
5. tests/repro_wait_empty_poison.py：复现脚本（monkeypatch 写入零 DB 触碰；修复前 ROUND 2 必挂 queue.join()，修复后两轮全过）
### 验证
- 复现脚本：stash 对照旧代码 ROUND 2 挂死/新代码 PASS
- pytest 全量 80/80 通过
- node build.mjs + tsc -p tsconfig.host.json 零错误；重启 3081
- 端到端：同一会话连跑 notify-theater 两场，两场均 flow_done+sys 广播+steered main agent（修复前第二场必卡死且后续全 409）
### 已知遗留（待议不动）
- shutdown 命令在 run 线程未清完 state[runner] 时会再调一次 runner.stop() → 双 flow_stopped（test_stop_cancels_fork_branch 偶发 flaky，12 次采样出现 1 次；与本修复无关的既有竞态）
- handleCreateSession 带 fems 时绕过 running 守卫直接覆盖 runState（跨会话事件串窗风险）
- 首跑竞态：broadcast dropped (no projection window) 仍在（todo 0mt6kvlfh）

## 2026-08-24 视角跳转的标签页跟手：切换后落哪由「切换前」所在标签页决定
### 需求（用户原话）
「切换视角后所在的标签页，取决于切换视角前所在的标签页。比如如果切换前在对话，那么切换后就在对话。如果切换前在fem编辑器，那么切换后就在fem编辑器。所以不需要存这个视角之前停在哪里了。只需要知道切换前是在哪里——这个可以直接知道。」
### 机制调研
每窗口激活 tab 存于 ui-conversation per-session chat store（view 字段，persist dsh.conversation.chat；点 tab = actions.setView(id)），不对外暴露且红线禁跨包 import → 走 client.tsx 已有先例的 DOM 契约（[role=tab]/aria-selected/文本匹配）。rc.2 tab 环仅两成员：chat(label 对话/Chat, id chat) + femwa(Fem 编辑器)。
### 修改明细（纯 src/client.tsx，刷新生效）
1. 模块级：FEM_EDITOR_TAB_LABEL/CHAT_TAB_LABELS 常量 + pendingTabTransfer 一次性标记（5s 过期）+ readActiveTabKind()（读 [role=tab][aria-selected=true] 文本判侧）
2. pickView 三个 openSession 分支跳转前设标记；offstage 同会话分支与降级分支不设
3. FemViewButton 挂载 effect 消费：非 fem 家族窗口（mainSid undefined）不消费防误触发；轮询 ~2s 等 tab 环；只认可见 tab（offsetParent 过滤，防点中普通会话上 display:none 的编辑器按钮）；已一致不点击（不多写持久化）；点击走官方链路=与手点行为完全一致
### 影响面
不经视角菜单的开窗（侧边栏/面包屑）完全不受影响，保留各窗自然记忆；无新增存储。

## 2026-08-24 视角跳转落编辑器：手机端以「header 在上」常规态起步，不进全屏沉浸
### 需求（用户原话）
「在fem编辑器切换视角的话，切换过来的femgen网页还是不要全屏，保持之前的状态（之前能切换说明上面header在上面呢）。切换之后保留之前header在上面的状态，除非用户手动按了那个全屏的按钮」
### 根因
FEMEditor 手机端插件模式 mobileFs useState(true) 每次挂载默认全屏沉浸（zIndex 900 盖住 dsh 外壳）→ 视角跳转=新会话挂载=必然全屏起步，header 被盖、视角菜单不可达。
### 修改明细
1. femGen/src/FemWorAuto.jsx：新增 initialMobileFs=true prop，mobileFs 初始值改用它（一行级；默认路径零变化）
2. src/client.tsx FemEditorView：首帧 useRef 快照 pendingTabTransfer（渲染期先于消费 effect，标记完整），视角跳转落编辑器时传 initialMobileFs=false
### 影响面
手动点编辑器 tab/侧边栏/独立模式全部照旧默认全屏；仅「经视角菜单跳转且落在编辑器 tab」的手机端挂载改为常规态起步。桌面端不读 mobileFs 不受影响。

## 2026-08-24 手机端 femGen 默认态改版：无条件「header 在上」起步（推翻沉浸优先）
### 需求（用户真机反馈后原话）
「切换过去之后……到底是全屏显示，还是在Header下面显示，取决于这个视角之前是怎么设置的。我希望的是，切过来的时候一定是在Header下面显示。默认在Header下面显示，除非用户手动点全屏。」
### 上一版（7b90594 initialMobileFs 豁免）为何失效
会话切换经 SessionProvider key={sessionId} 整体重挂载（ui-renderer session-provider.tsx 实证），但目标窗上次停在对话 tab 时编辑器要等 tab 对齐点击后才挂载——豁免标记已在点击瞬间被清掉，晚到的挂载读不到 → 回落默认全屏；停在编辑器则首帧读到 → 非全屏。故表现为「看之前怎么设置」。
### 新方案（用户规则升级：默认=header 在下，与跳转无关）
1. femGen/src/FemWorAuto.jsx：mobileFs 初始值 useState(true→false)；删除未发布的 initialMobileFs prop（签名还原）
2. src/client.tsx：删除 arrivedViaViewJumpRef 快照与 initialMobileFs 传参（7b90594 管道整体撤除）；pendingTabTransfer 标签页跟手保留
### 行为
任何挂载（视角跳转/手动开窗/切 tab 重挂载）一律 header 在上；全屏键进沉浸、返回键退出；独立模式与桌面端不读 mobileFs 零影响。

## 2026-08-25 引擎修复：for 循环出口边被吞，循环后首个动作节点被静默跳过
### 缘起
随手写《深夜食堂新品企划》（工作区 femwa/深夜食堂企划.fems）实测发现：`for ... -> [judge]:评审` 的评审动作从未发起 LLM 调用（Chronica react_steps 8 条而非 10 条；子代理会话目录只有 8 个），定稿同样被跳过；流程却因「顺藤摸瓜」兜底直达颁奖/END，戏看似演完——违反「不许静默吞错」红线。
### 根因
FEM_runtime.py `_run_for_loop`：网关只有无条件出边时（解析器保证注册顺序=体内链先、块后出口行后），旧代码把全部出边塞进 loop_entries，exit_edge=None；循环结束走「从入口顺藤摸瓜」兜底，返回了出口节点的下一个节点（如 [judge]→[颁奖]），夹在中间的动作节点整个被绕过。discussion.fems 同款写法同受影响。
### 修改明细
1. femCompiler/FEM_runtime.py `_run_for_loop` else 分支：无条件出边第一条=循环体入口，第二条（若有）=出口 exit_edge；>2 条无条件出边直接 raise ValueError（响亮报错，不静默）。
2. 回归测试：tests/repro_for_exit.py + python/for-exit-verify.fems（零 LLM，@assign 复刻「for→[judge]→if→颁奖 / for→[final]→END」骨架，断言 10 个动作全按序执行且 good_hits==1）。
### 验证
- pytest 全量 Python 测试 69 passed（test_parser/flow_events/par_nested_for/par_if_dispatch/mind/flow_ref_validation/out_whitelist/town_structure/stop 等）
- 静态扫描 examples/+python/+tests/ 全部 .fems：无任何 for 网关 >2 条无条件出边（werewolf-mind.fems 编译失败系既有问题，与本改动无关）
- 全新 bridge 子进程跑 repro_for_exit.py：✅ PASS（序列 开场→构思×2→提案×2→judge→颁奖→感言×2→final）
### 生效条件
femCompiler 是常驻 bridge 子进程启动时一次性 import——GUI 内运行需重启 3081 才用上新代码（与待办中既有的 3081 重启项合并为同一次）；直接 python 调引擎的路径即时生效。
## 2026-08-26 新增台账查询器 chronica.py + femwa:docs 指路
### 内容
1. 插件根目录新增 chronica.py（与 fem-chat.mjs 同族的剧场应急工具）：直连活体 user_data/memory/Chronica.wor（WAL mode=ro 只读，引擎运行中可查），无参=最新场次发言流 / 场次号=指定场次 / --list N=最近N场 / --scope=逐行附带可见用户与可见角色。输出按设计理念分两幕：【对话流】=showprompt 旁白+AI 发言+人类输入；【幕后指令】=节点 prompt（不属对话流）。判别依据 dialog.user_id：femshow-*=旁白 / fems-*=指令 / 其余=真人。
2. src/persona.ts injectFemwaDocs 的 femwa:docs section 追加「运行记录查询」段：指路 chronica.py（${packageRoot} 运行时插值，跨机器正确）+ 四个用法 + 对话流/幕后指令两幕说明。
### 生效条件
host 改动——需重启 3081 后新注入文本才出现（注意与 3080 侧重构窗口协调，后构建者胜）。
## 2026-08-26 修复：会话记录剥空（运行收尾竞态把档案写成 {sessionId}）
### 病根
state-files.ts 全部会话记录写入方（writeSessionScript/writePlayResume/updatePlayResume/appendFemSession）都是「async 读→改→async 写」三段式且零互斥。fs.writeFile 有 truncate→write 中间窗口，并发读撞进窗口读到半个 JSON→解析失败被静默当「档案不存在」→从空底重写整份文件。实测场次 869 收尾时（23:37:04，与最后一条 AI 发言同秒）记录被剥成只剩 {"sessionId"}，path/text/rev/femSessions 全灭；此前多次「重启后挂载丢失」实为同因（上一场结束时已中招）。
### 修改明细（全在 src/state-files.ts，调用方签名零变化）
1. 新增 recordLocks + withRecordLock(sid, fn)：同一 sessionId 的所有记录变更串行队列，读→改→写全程不交错；
2. 四个写入方全部改走锁；updatePlayResume 锁内直接经 setPlayResumeLocked 落盘（消除原「内部再调 writePlayResume」的嵌套自锁风险）;
3. readSessionRecord 加 quarantineOnParseError 参数（仅限持锁写入方开启）：解析失败=真损坏，坏档改名 .corrupt-<ts> 留证并大声报错后按缺失处理；普通读取方不开（并发瞬态撕裂读不可隔离，否则误伤好档）。
### 验证
build.mjs 通过，bundle 含隔离逻辑。行为级验证待重启 3081 后：跑任一剧本→flow_done 后检查 user_data/sessions/session-<sid>.json 应完整保留 text/femSessions。
## 2026-08-26 femwa-run「模拟按前端 run 按钮」（AI 触发复用多端守卫+语法检查）
### 背景/动机
用户拍板：femGen 前端的「run 按钮」多端不统一判定逻辑（未落盘修改守卫 femDirty/graphDirty）+ 语法检查（parseFEMS）很珍贵，AI 的 femwa-run 应复用同一份代码——工具不测任何不同，只带「这是 AI 按的」标签触发前端按钮，有错返回给 AI（谁触发就返回给谁）。
### 修改明细
1. femGen/src/FemWorAuto.jsx：handleRunWorkflow 加 source 参数（默认 'human'）——AI 触发（'ai'）不弹窗不 alert，各分流点（已有剧在跑/多端不统一/语法错/点火成功/运行错）经 onRunResult 回传（多端不统一时带 conflicts={textDirty,graphDirty,record,local} 供 AI 裁决）；成功时 reset 恒为 true（fresh_start 语义）。组件改 forwardRef + useImperativeHandle 暴露 triggerRun(source)，经 triggerRunRef 调最新 handleRunWorkflow（防闭包陈旧，同 handleGraphToFemRef 惯例）。
2. src/client-ui/editor-view.tsx：SSE 监听加 run_request 分支→editorRef.triggerRun('ai')；新增 reportRunResult → POST /dsh-femwa/run-result（带 sessionId）。
3. src/tools.ts：FemwaToolDeps 删 runScript、新增 runEditorCommand(sessionId)；fresh_start 分支改为「广播+等回传」，不再 readScript/takeEditorErrors（成功回执 appendChatBroadcast 🎬 保留）。新增导出 RunResult 类型。
4. src/index.ts：新增 runRequestPending Map + RUN_REQUEST_TIMEOUT=30s + resolveRunResult；toolDeps.runEditorCommand=广播 run_request{source:'ai'} + await 回传（超时明确报错）；resolveMounted 保留（resume 仍用），runScript 实现删除。
5. src/routes.ts：新增 route POST /dsh-femwa/run-result（resolve 对应 sessionId 等待者；无等待者静默忽略）。
### 生效条件
host+前端双改动——需重启 3081 后才生效（lib/client.js 与 lib/index.js 已重建）。
## 2026-08-26 单页常驻编辑器架构 v3（编辑器永不卸载 + 内容跟随打开的 Session）
### 背景/动机
实测发现「前端必然在线」假设不成立：Fem 编辑器 tab 没激活 → editor-view 未挂载（conversation.view only:active.id）→ host 的 run_request 无人接收 → femwa-run 30s 超时「前端未响应」，坏剧本的编译错误也传不回主模型。用户拍板：内存里只有一个 femgen 网页（单 FEMEditor 实例），内容跟随打开的 Session 加载（打开哪个加载哪个，切 Session 重载）。
### 修改明细（全在 client 侧，host 零改动）
1. 新增 src/client-ui/editor-page.tsx：①模块级单页 store（target/锚点/会话引用计数）+ 全局控制 SSE（/dsh-femwa/events 单例，管 run_request 与 script_changed）；②mountFemEditorPage = body 级隐藏容器（fixed inset:0 + visibility:hidden，保留视口尺寸使编辑器布局计算一致）+ createRoot（react-dom/client 已确认在 seed 映射里）；③EditorPageRoot 订阅 store、applyPagePlacement 把根容器 DOM 挪进锚点/挪回隐藏位（同一个 DOM 节点，React 状态零丢失；锚点销毁时即使根容器被连带 detach，fibers 不死，下次 applyPagePlacement 重新挂接即恢复）；④FemEditorPage = 编辑器页（key=sessionId 保证切 Session 全量重载），editor-view 的全部逻辑迁入（session-state 加载/409 冲突弹窗/定稿落盘/导出导入/preflight/restore 横幅/run_result 回传/triggerRun）。
2. src/client-ui/editor-view.tsx 重写为【锚点】：仅注册/注销 DOM 容器（useLayoutEffect，母会话 id 解析保留）+ composer 隐藏 + data-conversation-composer-overlay 契约；不再自建 SSE/状态。
3. src/client-ui/view-button.tsx：header.actions 挂载/卸载上报 editorPageOpenSession/CloseSession（refcount 计数，主窗与投影窗同 mainSid 合并）→ 内容跟随「打开的 fem 主会话」。
4. src/client.tsx：apply() 尾部 mountFemEditorPage(scriptViewInjected)。
5. femGen/src/FemWorAuto.jsx：坏剧本恢复失败（parseFEMS 抛错）时也 setFemText(initialScript) 载入原文（画布留空）——①人类可就地改；②AI 触发时 handleRunWorkflow 的 parseFEMS 回传真实错误而非「请先编写或导入 FEM 脚本」。
### 行为语义
- tab 切换：编辑器不卸载（状态/dirty/SSE 全存活），run_request 永远可达；
- 切 Session：key 变化 → 编辑器全量重载（从 record），符合「打开哪个加载哪个」；
- run_request 落在非当前会话：内容切过去加载并跑，跑完不切回（下次会话交互重新对齐）；
- 锚点（Fem 编辑器 tab）在任意窗口（主窗/投影窗，母会话 id）共享同一实例显示位。
### 已知待验
- 隐藏容器从视口尺寸切到锚点时画布自适应（可能有一帧尺寸差异）；
- 空 rollback：编辑器隐藏时其全局 keydown（space 平移画布）仍生效但不可见（无实际影响）。
### 生效条件
纯前端改动——刷新浏览器页面即生效（若缓存旧 client.js 则强刷 Ctrl+F5）。

## 2026-08-27 投影窗去重查重性能修复（O(n) 全扫 → O(1) Set 索引）
### 病根
projectionAppend / mirrorMainEventToGod / subagent ensureTurnStart·ensureStepStart 的幂等查重全部是 win.events.some() 全量扫描。投影窗事件积累到 13.7 万级后每次查重 O(n)、事件一多整体 O(n²)，事件循环被同步代码堵死 2.5~10 秒（3081 日志心跳实证 event-loop stall 2514~10274ms）——所有 HTTP RPC 排队超时，症状 = 发消息没反应 + 「signal timed out」+ 无法建立新会话 + 时好时坏（会话越大越频繁）。
### 修改明细（查重语义零变化，只换数据结构）
1. src/projection.ts：新增模块级 WeakMap<Session, 索引> 三件套——dedupeIndexFor（懒构建：首次遍历现有 events 全量建 Set）、dedupeStructKey（模块级化）、dedupeMarkIndexed（仅对已建索引的窗增量补键）；projectionAppend 查重与 append 后补键、projectionHasDescriptor 都改走索引；
2. src/god-mirror.ts：mirrorMainEventToGod 5 处 .some()（_srcSeq + 4 结构键）改 Set 查重 + append 后补键；
3. src/subagent.ts：ensureTurnStart/ensureStepStart 兜底查重改索引；
4. createProjectionRegistry 挂全局 ctx.on('session/event') 钩子——任何 append 来源（含 dsh 内部 surface 自动补 start）都同步补键，索引不漏。
### 验证
tsc 双绿；lib/index.js 重建；3081 重启后：13.7 万事件大会话 catch-up/投影请求由「卡 10 秒」变「毫秒级返回」（503 等防错响应也即时到达），健康探测全部 200 <50ms。用户待实测发消息/跑剧本流畅度。


## 2026-08-27 register legacy 'dsh-femwa/turn-scope' for session-event registry
### root cause
src/index.ts only registered 'dsh-femwa/chat' via registerSessionEventType. Legacy
sessions (pre turn-scope-file refactor) still contain 'dsh-femwa/turn-scope' log
events; the persistence read path refuses unregistered event types
(coordinator assertEventsSupported fail-closed), which also failed the
session-query-sqlite FTS observer on 3081 (search-status unavailable: event type
"dsh-femwa/turn-scope" unknown to this harness and not marked ignorable).
### change
src/index.ts: register 'dsh-femwa/turn-scope' alongside 'dsh-femwa/chat'.
### verification
build.mjs OK; lib/index.js rebuilt. Needs 3081 restart; then
POST /switch-search/api/search-status should return available:true.


## 2026-08-27 戏内投影窗 stage（搜索来源二分：主会话=戏外 / 戏内窗=戏内）
### 背景与拍板
跨会话搜索（session-query-sqlite + tool-session-query）把每个投影窗都索引，同一段
戏内对话命中多份。用户拍板（2026-08-27）：①加一个纯戏内归档投影窗（方案B），
搜索来源唯一化；②搜索排除走工具层（rc.2 官方包 MEOW_MODIFICATIONS 条目4，
`searchExcludeIdPrefixes:['fem-proj-']` / `searchExcludeIdExemptSuffixes:['-stage']`）；
③旧剧本不回填（旧戏内内容在上帝窗，被搜索排除后旧的搜不到——知情接受）。
### 实现要点（复用度极高，架构全走既有通路）
1. src/projection.ts：导出 `GOD_ACTOR`/`STAGE_ACTOR='stage'` 常量与 `ProjectionWindows`
   接口（god/stage/actors 三字段，替换 6 处内联形状）；descriptor label 收敛为
   `descriptorLabel()`（god=👁上帝视角 / stage=📜戏内 / 其余=🎭角色）；
   `ensureProjectionWindows` 增建 stage 窗（幂等/冷唤醒全自动）；
   **projectionAppend 加一行 `appendTo(windows.stage)`**——全部戏内事件（聊天行/名字行/
   turn/step/引擎通知/广播）自动进戏内窗；主会话镜像走 god-mirror 直写 god 窗不经此函数
   → 戏内窗天然零戏外内容（方案B的根基，零额外代码）；
   registry buildOnce 补 stage 兜底（旧 registry 条目/重启前窗自动补建）。
2. src/routes.ts：projection-windows API 返回加 stage id。
3. src/client.tsx + client-ui/view-button.tsx：listProjectionWindows 类型/proj 缓存加
   stage；视角菜单加「📜 戏内」项（FaScroll 图标，fa-icons.tsx 新增）；pickView stage
   分支不写 view 状态（戏内窗默认视图由 fem-proj- 前缀推导 god 视角=全显，无 scope 语义）；
   activeViewId/label/title 加 stage 情形。
### 零影响论证
现有 god/角色窗写入路径一字未动，只多 append 一个全新 id（fem-proj-<sid>-stage）的窗；
去重索引按窗隔离；lineage 子代理下拉按 fem-proj- 前缀过滤自动隐藏戏内窗；
chat-node scope 过滤只在非 god 视角生效（戏内窗恒 god 视角=全显）；流式直播锚点不认
stage 尾段 → 戏内窗无打字机直播（归档窗定位，预期行为）；导演发言/主会话镜像不进戏内窗。
已知边界（与 god 撞名同类，记档不修）：剧本角色恰好叫纯 ASCII `stage` 会与戏内窗撞 id
（ensure 幂等复用两窗合一）；engine 无保留名校验。
### 验证
tsc（tsconfig.host.json）exit 0；build.mjs 双 bundle 重建（banner 完整、FaScroll/stage/
📜 戏内转义字面量核验全过）；rc.2 侧排除规则 vitest 105/105。待 3081 重启后用户实测：
跑短剧本 → fem-proj-<sid>-stage 窗创建且内容=全戏内无戏外 → agent 搜索同关键词不再多份。

## 2026-08-27 戏内窗归档回填（修旧剧本 stage 窗 blank→Hero 无 header）
### 用户报告
"现在这个戏内窗连Header都没有。在UI方面，你写的应该是有点问题的，你再检查一下。好好参考其他投影窗的写法。"
### 根因（官方机制，非 stage 分支代码错）
宿主 blank 位只认 turn/start（api-proxy.ts sessionBlank：`!events.some(e => e.type === 'turn/start')`，
插件事件/descriptor 都不算）；blank 会话前端走 Hero 态（ConversationSessionHeader
`hideChrome = blank && composerPhase === 'blank'`）整个 header chrome 隐藏。god/角色窗
因子代理镜像必合成 turn/start 而从不 blank；旧剧本的 stage 窗迟到于历史演出、日志只有
descriptor → 永远 blank → 无 header，且 blank 会话有被"新建会话"复用的风险。
### 修复（推翻 2026-08-27 早前"不回填"拍板——UI bug 使限定回填成为必要，用户报告即授权）
projection.ts 新增 backfillStageArchive（registry buildOnce 尾部触发，幂等门槛=stage 窗
尚无 turn/start + 进程内 Set）：从 god 窗复制可判定为戏内的事件——①dsh-femwa/chat 行
全部；②_srcSeq 为 string 含 '#'（08-24 命名空间隔离后子代理镜像）；③turn/step 结构事件
且 turn ∈ turn_scopes 文件（子代理合成 turn 权威记录）。裸数字 _srcSeq（主会话镜像=戏外）
绝不复制（宁缺勿污，08-24 前旧格式 god 窗因此可能只有结构+chat 行）。复制走 appendEvent
（surfaceOp 原样），去重靠 stage 窗自身索引钩子。createProjectionRegistry 加 femwaRoot
参数（index.ts 调用处传 resolved.femwaRoot）。
### 零影响论证
只写 stage 窗；复制事件均为 god 窗日志已持久化的合法事件（迁移器合法性继承）；
god/角色/主会话零写入；O(n) 遍历仅一次（门槛挡重复）；08-24 前旧格式不可判定即跳过。
### 验证
tsc exit 0；build.mjs 重建（backfill/archivedTurns/turn_scopes 字面量核验）。
提交 f8007ef（index.ts 仅含本 hunk，git apply --cached 拆分，他窗遗留 hunks 留工作区）。

## 2026-08-28 戏内窗四项微调：回填补丁撤销（拍板变更）+ 文案/图标/流式锚点
### 用户反馈（原话要点）
"棒！现在显示正常了！" + ①"📜 戏内"改成"戏内视角" ②图标换电影相关 ③"旧剧本不用理！
当他们不存在就好，别担心那个" ④质疑 god 窗复制："戏内视角不应该依赖god窗啊……比较合理
的做法是和god窗一模一样的投影方式，只是不放主模型的部分……我们之前写得投影逻辑花了很多
心思，你直接复制过来就好。流式输出之类的都可以复用吧？" ⑤问 session 标题标记是什么。
### 澄清与决策
实时投影主通路本就与用户设想一致（projectionAppend 三分发，stage 与 god 同权，唯一例外
=god-mirror 主会话镜像不进 stage）；"从 god 窗复制"只是修旧剧本 header 的历史回补补丁，
不是投影通路。按 ③④ 拍板：**撤销 backfillStageArchive 整个补丁**（回填函数/调用/进程内
Set/readTurnScopeFile import/createProjectionRegistry femwaRoot 参数全部拆除，index.ts
调用恢复 createProjectionRegistry(ctx)）——旧剧本 stage 窗回归空窗（用户拍板"当他们
不存在"），投影逻辑回归纯粹：stage 窗=与 god 窗同一条实时投影通路，唯一区别无主模型镜像。
### 修改明细（6 文件）
1. projection.ts：删 backfillStageArchive+stageBackfilled+buildOnce 调用+readTurnScopeFile
   import；createProjectionRegistry 撤 femwaRoot 参数；descriptorLabel '📜 戏内'→'戏内视角'
   （此 label=subagent/descriptor 的 label 字段=dsh 原生会话显示名/子代理下拉名，即问题⑤的答案）
2. index.ts：调用恢复 createProjectionRegistry(ctx)（hunk 级提交）
3. fa-icons.tsx：FaScroll→FaClapperboard（FA6.7.2 权威 path，unpkg 核验，场记板=电影语义）
4. view-button.tsx：菜单/按钮 label '戏内视角'+FaClapperboard
5. chat-node.tsx：streamEligible 加 winActorKey==='stage'（流式打字机锚点对齐 god 窗——
   fem_stream SSE 本就全窗广播，stage 窗此前只差锚点判定一行）
6. chat-node.tsx 注释对齐（god/stage 窗显示全部演员）
### 语义影响
旧剧本 stage 窗回归 blank→Hero 态（用户拍板接受，"当他们不存在"）；新剧本 stage 窗实时
投影不受影响且新增流式直播。
### 验证
tsc exit 0；产物核验全过：backfill 字面量清零/FaClapperboard 在/FaScroll 清零/
stage 流式分支在/「视角」转义字面量在。

## 2026-08-28 戏内菜单项门控（用户实测拍板：没剧本记录不显示，和角色视角一个道理）
### 用户实测与拍板（原话要点）
"剧本还没开始跑，戏内视角根本没东西的时候，如果切换到戏内视角，就连header也没了
（也就导致换不回来了）。所以正确的修bug方向是，当本session没有任何剧本记录的时候，
上面的视角菜单里不要显示戏内视角这个选项。和角色视角一个道理吧……"
（先问"header 消失是因为补丁吗"——澄清：不是补丁，是宿主 blank 机制即上一条目根因；
回填补丁是当时的修复尝试，已于同日撤销。）
### 实现
view-button.tsx 菜单 stage 项加门槛 `actors.length > 0`（与角色项同源：scriptActors
来自 /dsh-femwa/actors 即剧本记录，chatActors 兜底；没跑过剧本两者皆空 → 菜单只有
戏外+上帝，空窗入口不存在，卡死场景根除）。跑过剧本后 flow_start 经 d37f33b 机制
重拉 actors → 菜单自动出现戏内项。pickView 的 proj.stage 守卫保留。
### 验证
纯前端改动刷新生效免重启；build 产物 gate 字面量核验（actors.length>0 条件 ×1）。

## 2026-08-28 AI 触发点火去 rAF（60s 点火根因修复）
### 根因（实测钉死）
femwa-run fresh_start 链路=工具广播 run_request SSE → femgen 页 settleThenTrigger
【rAF+30ms】→ handleRunWorkflow → POST /dsh-femwa/run。rAF 在隐藏窗口/后台标签
完全不跑 → 链条冻在等帧：实测广播后 62s 才点火（恰为窗口恢复可见时刻）、窗口持续
隐藏则 2 分钟零点火。服务端无辜：直打 POST /run 全程 90ms，引擎收到 run 后 0.2s 开跑；
/models 2.5ms（collectLlmModels 纯本地）。
### 用户拍板（原话要点）
"我想借用按钮的链路，不可能直接点火的，按钮后面有一堆检查呢，我们得复用。真正的问题
是为什么非得用rAF？把mount和run都改成AI这边调工具，femgen无论藏不藏都可以实时更新。
这样其实并不存在准备不好的问题。如果没mount到位就run了，那run按钮自己会报错的"；
"mount也不能是RAF，也需要工具调用之后立即反映在网页上，不管网页藏着还是显示。这两个
工具是一样的设计"。（host 兜底点火方案被否——守卫一份，必须复用按钮链路。）
### 修改明细（2 文件）
1. femGen/src/FemWorAuto.jsx handleRunWorkflow：AI 路径运行文本一律现取
   getRecordScript()（record 为准——mount 已在工具调用时落盘），取不到回落空串走
   既有「请先编写或导入 FEM 脚本」报错经 run-result 回传；绝不静默回落编辑器旧文本
   （不吞错原则）。人类按钮路径不动（仍以输入框文本为准）。
2. src/client-ui/editor-page.tsx：settleThenTrigger 的 rAF+30ms 删除 → triggerAiRun
   事件直达（loadSessionState 成功消费 / pageTriggerRef 就绪直触发 / 换目标重挂载
   排队消费，三触发点全不再等帧）；React 事件/effect/fetch 隐藏窗口照常跑，仅画帧
   冻结——链路从此不碰画帧。
### 验证
广播 → 工具 ok 回执 0.31s（06:02:07.374→06:02:07.681Z），点火 ≤2s（台账 06:02:09，
秒级粒度）；修复前对照组 30s 超时误报/62s 点火。build 产物核验：triggerAiRun ×4 在、
settleThenTrigger 清零。mount 链路核验无帧等待（SSE→fetch→setState→restore effect
全程事件驱动；余下 rAF 仅画布淡入动画/聊天流渲染，纯装饰）。




## 2026-08-29 投影窗刷新丢权限按钮/统计行（启动竞态：目录先于会话列表落地）

### 症状
刷新页面后，god/角色/戏内投影窗 composer 的权限设置按钮与输入框下统计行消失；切换 session 或切换视角（composer 重挂载）即恢复，仅刷新必现。

### 根因（探针确定性复现钉死）
恢复的 selection 直接落在投影窗时，宿主 handleConnected 同时发 session.list（重：summarize 全部会话含 13.7 万事件大会话）与 subagent 目录（轻：单 parent listChildren）。目录先回 → projectList 的 address walk 在 ids 还空着时先造出 byId[projSid]（带 parentId）→ composer 首次渲染 mainSid 非空，但 binding(mainSid) 走官方 sessions.resolve() 的 eligible 判据（ids 在册/恰为当前）→ 列表未到 → 返回 undefined → 被 useMemo([mainSid, getSessionFace]) 永久缓存（slot inject face 按 (entry, provideInfo) 缓存引用稳定，mainSid 之后不再变化 = 永不重算）；列表后到只换 byId 值、selector 输出不变，无重渲染触发。权限菜单/统计行读 mainFace 的 projections → 双双 render null。视角按钮不受影响（只依赖 byId）——探针实测「上帝视角按钮在、权限按钮缺」正是判别特征。a0f42ec（08-26 同症状修复）解决的是另一条路径（mainSid 字符串兜底让 selector 恒定），本条是其残留竞态缝。为何最近才稳定复现：大会话越来越多 → session.list 变慢 → catalog 稳定赢下竞态。

### 修复（src/client-ui/composer.tsx，+9 行）
新增 `mainListed = useSessions(state => ids.includes(mainSid))` 订阅（=官方 binding 可解析判据），useMemo deps 增 mainListed：列表落地翻真 → 强制重算 binding → 按钮自动出现。零行为变化论证：好次序下（list 先于 catalog 或都先于挂载）mainListed 与 mainSid 同一次 projectList 变真，memo 结果与旧代码完全一致；坏次序下从「永久缺失」变「列表落地即恢复」。

### 验证（scripts/probe-composer-refresh.mjs，新增探针）
headless Edge CDP + Fetch 拦截延迟 session.list 15s 确定性复现：修复后 AFTER-REFRESH 缺（列表未到，数据确实不可得，预期）→ AFTER-LIST-LAND 自动恢复 ✓（修复前同点位永不恢复）→ 切窗回归 ✓。正常无延迟启动（小/大会话各一）不受影响。tsc client 检查 composer 零新增错误。纯前端改动，junction 装配刷新即生效，未重启 3081。
