# MEOW 修改记录（dsh-femwa 仓库内留痕）

> 与 D:\myFiles\dsh\MEOW修改记录及指南.md 同步。条目只追加不改写。

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
