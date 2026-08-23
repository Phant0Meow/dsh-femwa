// ═══════════════════════════════════════════════════════════════
// ═══ themes.js  ───  FEM Gen 前端主题 token 唯一定义处 ═══
// ═══════════════════════════════════════════════════════════════
//
// 【作用】
// 前端所有颜色（内联 style / SVG / CSS 注入块）一律引用这里的
// CSS 变量（var(--fem-*)），不再散落硬编码 hex。
// 换主题 = 切根容器 data-fem-theme 属性 + 这里加一组 token 覆盖，
// 无需改动任何组件代码。
//
// 【如何新增一个主题】
// 1. 在 FEM_THEMES 数组里加一项 { id, name, desc }
// 2. 在 THEME_CSS 里加一个属性块：
//      [data-fem-theme="dark"] { --fem-app-bg: ...; ... }
//    只写与 DSH 浅色不同的 token 即可，其余自动继承 DSH 浅色值。
// 3. 主题切换 UI 把根容器属性改成目标 id（如 data-fem-theme="dark"）。
//
// 【约定】
// - DSH 浅色（默认）= dsh 本体白天设计语言；DSH 深色 = dsh 本体黑夜设计语言。
// - 角色色（--fem-type-*）、移动壳（--fem-mobile-*）、预览壳
//   （--fem-preview-*）为"固有深色区域"，各主题可独立调整或保持不变。

// ── 主题元数据（供切换 UI 使用）──
export const FEM_THEMES = [
  { id: 'auto', name: '跟随 DSH', desc: '自动跟随 dsh 本体主题（白天→DSH 浅色 / 黑夜→DSH 深色）' },
  { id: 'dsh', name: 'DSH 浅色', desc: 'dsh 本体白天设计语言（deepseek 蓝 + bluish 色阶 + 系统字体）' },
  { id: 'dsh-dark', name: 'DSH 深色', desc: 'dsh 本体黑夜设计语言（深色 bluish 层级 + 亮色状态）' },
];

// ── 主题 CSS（由 common.jsx 的 FontStyle 注入，两种模式都生效）──
// :root 兜底独立模式；[data-fem-theme] 限定编辑器容器作用域（插件模式不污染宿主）。
export const THEME_CSS = `
/* ══ 浅色主题（默认）：全部 token ══ */
:root, [data-fem-theme] {
  /* ── 应用背景 ── */
  --fem-app-bg: #ffffff;            /* 编辑器根背景（round27：对齐官方浅色聊天底 bg-base=纯白） */

  /* ── 主色（蓝）── */
  --fem-primary: #4176e6;           /* 主色：激活 tab / 选中 / 主按钮 / 连线选中 / 焦点 */
  --fem-primary-strong: #5686fe;    /* 主色强调：hover、@ai 角色、常态连线、流式光标 */
  --fem-primary-soft: #edf3fe;      /* 主色淡背景：选中项背景 */
  --fem-primary-soft-2: #e4edfd;    /* 主色极淡背景（#eff2ff 归并） */
  --fem-primary-soft-faint: rgba(65,118,230,0.08); /* 主色 8% 透明底 */
  --fem-primary-glow-weak: rgba(65,118,230,0.12);   /* 主色光晕弱（0.06/0.12 归并） */
  --fem-primary-glow: rgba(65,118,230,0.25);         /* 主色光晕中（0.25 归并） */
  --fem-primary-glow-strong: rgba(65,118,230,0.4);  /* 主色光晕强（0.4 归并） */
  --fem-primary-glow-x: rgba(65,118,230,0.6);       /* 主色光晕极强：选中描边 */
  --fem-primary-overlay: rgba(65,118,230,0.92);     /* 半透明主色按钮底 */

  /* ── 危险（红）── */
  --fem-danger: #ef4444;            /* 危险主色：错误文字 / 删除 */
  --fem-danger-weak: #f25a5a;       /* 危险弱：hover 删除按钮 */
  --fem-danger-strong: #ec1313;     /* 危险深（#991b1b 归并） */
  --fem-danger-soft: #fef2f2;       /* 危险淡背景（#fff0f0/#fff5f5 归并） */
  --fem-danger-soft-2: rgba(236,19,19,0.08);  /* 危险淡背景（半透明） */
  --fem-danger-border: #fee2e2;     /* 危险边框 */
  --fem-danger-glow-weak: rgba(236,19,19,0.15);  /* 危险光晕弱 */
  --fem-danger-glow: rgba(236,19,19,0.3);        /* 危险光晕中 */
  --fem-danger-glow-strong: rgba(236,19,19,0.5); /* 危险光晕强 */

  /* ── 警告（橙）── */
  --fem-warning: #f59e0b;           /* 警告主色 */
  --fem-warning-strong: #dd8629;    /* 警告深文字 */
  --fem-warning-soft: #fef5e7;      /* 警告淡背景（#fef3c7 归并） */
  --fem-warning-border: #f7ad31;    /* 警告边框 */

  /* ── 成功（绿）── */
  --fem-success: #22c55e;           /* 成功主色 */
  --fem-success-strong: #4ed17e;    /* 成功深（START/IN 节点色） */
  --fem-success-text: #16a34a;      /* 成功文字 */
  --fem-success-soft: #e6faed;      /* 成功淡背景（#f0fdf4/#edfaf4 归并） */

  /* ── 文本三级 ── */
  --fem-text-1: #0f1115;            /* 主文本 */
  --fem-text-2: #61666b;            /* 次级文本 */
  --fem-text-2-alt: #81858c;        /* 次级文本（偏灰） */
  --fem-text-3: #81858c;            /* 弱文本 */
  --fem-text-4: #adb2b8;            /* 占位文本（#a0aec0 归并） */
  --fem-text-4-weak: #cfd3d6;       /* 占位文本更弱 */
  --fem-neutral: #979da6;           /* 中性灰：弱文本/禁用底/中性边（#9aaccb 归并） */
  --fem-neutral-faint: rgba(151,157,166,0.09);   /* 中性灰 9% 底 */
  --fem-neutral-border: rgba(151,157,166,0.27);  /* 中性灰 27% 边 */

  /* ── 背景 / 表面 ── */
  --fem-bg: #f9fafb;                /* 面板背景 */
  --fem-bg-2: #f1f3f5;              /* 次级背景（输入框底等） */
  --fem-bg-hover: #e1e5ee;          /* 列表项 hover 背景 */
  --fem-surface: #ffffff;           /* 卡片/输入框表面 */
  --fem-on-accent: #ffffff;         /* 彩色按钮（主/成功/警告/标签）上的文字 */

  /* ── 边框 ── */
  --fem-border: rgba(0,0,0,0.08);            /* 常规边框（#edf0f8 归并） */
  --fem-border-strong: rgba(0,0,0,0.12);     /* 深边框 */
  --fem-tag-bg: #61666b;            /* 标签/强调底（深蓝灰） */
  --fem-tag-bg-faint: rgba(97,102,107,0.09);    /* 标签强调 9% 边 */
  --fem-scrollbar: #d4d4d4;         /* 滚动条 */

  /* ── 遮罩 / 阴影 ── */
  --fem-mask-soft: rgba(0,0,0,0.24);  /* 浅遮罩（0.3 归并） */
  --fem-mask: rgba(0,0,0,0.48);        /* 常规遮罩（0.45 归并） */
  --fem-mask-heavy: rgba(0,0,0,0.48); /* 深遮罩 */
  --fem-mask-blue: rgba(0,0,0,0.48); /* 蓝黑遮罩（弹窗） */
  --fem-shadow-sm: rgba(0,0,0,0.06);   /* 小阴影（0.08/0.12 归并） */
  --fem-shadow-md: rgba(0,0,0,0.1);  /* 中阴影（0.15 归并） */
  --fem-shadow-lg: rgba(0,0,0,0.16);   /* 大阴影（0.25/0.35 归并） */
  --fem-shadow-xl: rgba(0,0,0,0.24);  /* 特大阴影（0.4/0.5 归并） */
  --fem-shadow-blue: rgba(0,0,0,0.05); /* 节点蓝阴影 */

  /* ── 画布 ── */
  --fem-canvas-dot: #cfd3d6;        /* 画布点阵（桌面） */

  /* ── 角色色（节点类型）——round27 浅色同步：莫兰迪浅色版（粉彩底+深字成对）── */
  --fem-type-ai: #4A6FA5;           /* @ai */
  --fem-type-ai-bg: #DFE9F5;
  --fem-type-human: #4A7A5C;        /* @human */
  --fem-type-human-bg: #DFEDE3;
  --fem-type-mind: #A56A6A;         /* @mind */
  --fem-type-mind-bg: #F3E3E3;
  --fem-type-func: #997B3D;         /* @func */
  --fem-type-func-bg: #F2EAD8;
  --fem-type-assign: #7A6FAE;       /* @assign */
  --fem-type-assign-bg: #E9E5F5;
  --fem-special-par: #7A6FAE;       /* PAR 特殊节点 */
  --fem-special-par-bg: #E9E5F5;

  /* ── 特殊节点底色（round39 浅色 v2：与其它节点同白底，类型身份走彩边彩字——深色彩底白字语言在浅色的对应形态）── */
  --fem-sp-start-bg: var(--fem-node-bg);
  --fem-sp-end-bg: var(--fem-node-bg);
  --fem-sp-break-bg: var(--fem-node-bg);
  --fem-sp-for-bg: var(--fem-node-bg);
  --fem-sp-par-bg: var(--fem-node-bg);

  /* ── 特殊节点彩边压暗混合基色（round41：浅色基色从纯黑提亮到中灰——50% 混合后色相浮出，不再"全黑"）── */
  --fem-node-border-mix-base: #8F8F8F;

  /* ── 移动端壳（round37 按主题拆分：默认块=DSH 浅色壳，dsh-dark 块覆盖深色壳）── */
  --fem-mobile-bg: #ffffff;             /* 壳背景（=浅色聊天底 bg-base） */
  --fem-mobile-bg-2: #F9FAFB;           /* 壳背景 2（侧栏/错误壳，sidebar-fill） */
  --fem-mobile-bg-3: #F1F3F5;           /* 壳背景 3（错误卡，内嵌灰底） */
  --fem-mobile-surface: #F9FAFB;        /* 壳面板（sidebar-fill） */
  --fem-mobile-surface-hover: #ECEEF1;  /* 壳面板 hover */
  --fem-mobile-border: rgba(0,0,0,0.12);        /* 壳边框 */
  --fem-mobile-border-light: rgba(0,0,0,0.22);  /* 壳浅边框（兼作空态提示文字色） */
  --fem-mobile-border-strong: #ECEEF1;  /* 壳深边框/按钮底 */
  --fem-mobile-text-1: #17191D;         /* 壳主文本 */
  --fem-mobile-text-2: #6A7077;         /* 壳次级文本 */
  --fem-mobile-text-2-alt: #45494F;     /* 壳次级文本偏深 */
  --fem-mobile-text-3: #9AA0A6;         /* 壳弱文本 */
  --fem-mobile-danger-soft: #FDECEC;    /* 壳危险底 */
  --fem-mobile-danger-border: #F5C6C6;  /* 壳危险边框 */
  --fem-mobile-mask: rgba(15,17,21,0.24);/* 壳内遮罩 */

  /* ── FEM 预览条（round38 按主题拆分：默认块=浅色，dsh-dark 覆盖深色）── */
  --fem-preview-bg: #ffffff;        /* 预览条背景 */
  --fem-preview-bg-2: #F6F8FA;      /* 行号槽背景（浅色代码底） */
  --fem-preview-text: #444C56;      /* 预览文本 */
  --fem-preview-text-2: #8B949E;    /* 预览弱文本 */
  --fem-preview-border: rgba(0,0,0,0.12); /* 分隔边 */

  /* ── 形状：圆角（主题可整体换风格：圆润/方正）── */
  --fem-radius-xs: 2px;                        /* 微型圆角（手机端小标签） */
  --fem-radius-sm: 6px;                        /* 小圆角（4/5/6 归并） */
  --fem-radius-md: 8px;                        /* 中圆角（7/8 归并：输入框/按钮/卡片） */
  --fem-radius-lg: 10px;                       /* 大圆角（节点/大面板） */
  --fem-radius-xl: 16px;                       /* 特大圆角（14/16/18 归并：弹窗） */
  --fem-radius-pill: 50%;                      /* 圆形（端口/状态点/开关） */
  --fem-radius-top: 8px 8px 0 0;               /* 弹窗顶部圆角（底部直角） */
  --fem-radius-bubble: 10px 10px 10px 2px;     /* 节点状态气泡 */

  /* ── 边框宽度（主题可整体换粗细）── */
  --fem-border-w: 1px;              /* 常规边框 */
  --fem-border-w-strong: 1.5px;     /* 输入框/按钮边框 */
  --fem-border-w-selected: 2px;     /* 选中/激活描边（2/2.5 归并） */
  --fem-border-w-accent: 3px;       /* 左侧强调边（列表选中/错误条） */
  --fem-border-w-node: 4px;         /* 节点左侧粗色条 */

  /* ── 字体族（主题可整体换字体）── */
  --fem-font-sans: 'DM Sans', 'MiSans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  --fem-font-mono: 'JetBrains Mono', monospace;
  --fem-font-body: 'DM Sans', 'MiSans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; /* 独立模式 body 回退字体 */

  /* ── 画布背景（主题可换点阵/网格/纯色）── */
  --fem-canvas-dots: radial-gradient(circle, var(--fem-canvas-dot) 1.2px, transparent 1.2px);   /* 桌面画布点阵（颜色嵌套联动） */
  --fem-mobile-canvas-dots: none; /* 手机壳画布点阵（round12：用户拍板去掉——桌面深色下点已不可见，统一无点） */

  /* ── 面板底色（边栏/标题栏等 chrome；round27 对齐 dsh 浅色 sidebar-fill bluish-50）── */
  --fem-panel-bg: #F9FAFB;                       /* 浅色=官方 sidebar-fill */
  --fem-btn-primary: var(--fem-primary);         /* 功能按钮底（浅色=主蓝历史值） */

  /* ── 滚动条 ── */
  --fem-scrollbar-w: 8px;           /* 滚动条粗细 */

  /* ── 节点阴影（round27 浅色同步：双层浅灰影+白内高光，与深色双层工艺对应）── */
  --fem-node-shadow-rest: inset 0 1px 0 rgba(255,255,255,0.9), 0 1px 2px rgba(0,0,0,0.05), 0 6px 16px rgba(0,0,0,0.08);      /* action 节点常态 */
  --fem-node-shadow-sel: inset 0 1px 0 rgba(255,255,255,0.9), 0 4px 10px rgba(0,0,0,0.08), 0 14px 30px rgba(0,0,0,0.12);     /* action 节点选中 */
  --fem-node-shadow-rest-sm: inset 0 1px 0 rgba(255,255,255,0.8), 0 1px 4px rgba(0,0,0,0.06), 0 3px 10px rgba(0,0,0,0.07);   /* 小节点常态 */
  --fem-node-shadow-sel-sm: inset 0 1px 0 rgba(255,255,255,0.9), 0 3px 8px rgba(0,0,0,0.08), 0 10px 22px rgba(0,0,0,0.10);   /* 小节点选中 */

  /* ── 节点边框（round29 浅色黑白版：纯黑边框，白底上利落醒目）── */
  --fem-node-border: rgba(10,10,10,0.85);
  --fem-node-border-w: 1.5px;
  --fem-node-bg: var(--fem-surface);             /* 节点表面（浅色=纯白） */

  /* ── 连线（round29 浅色黑白版 + round30 同步细化）── */
  --fem-edge: #1c1c1c;                         /* 强调连线常态（循环/for/自环）：近纯黑 */
  --fem-edge-sel: #000000;                     /* 连线选中：纯黑 */
  --fem-edge-flow: #4a4a4a;                    /* 普通顺序边：深灰黑 */
  --fem-edge-w: 1px;                           /* 主视图几何边宽（round32：深浅统一细线） */
  --fem-edge-w-thin: 0.85px;                   /* 模块视图/自环边宽（统一细线） */
  --fem-edge-w-sel: 1.5px;                     /* 选中边宽（统一细线） */
  --fem-edge-sheen: #ffffff;                   /* 流光光珠：纯白（radialGradient 纯白→透明，深浅通用） */

  /* ── 节点类型徽章（round27 浅色同步：粉彩莫兰迪底+深字，与深色彩底白字同一语言不同明度）── */
  --fem-badge-bg-ai: var(--fem-type-ai-bg);
  --fem-badge-fg-ai: #3E5C94;
  --fem-badge-bg-human: var(--fem-type-human-bg);
  --fem-badge-fg-human: #3D664C;
  --fem-badge-bg-mind: var(--fem-type-mind-bg);
  --fem-badge-fg-mind: #8A5050;
  --fem-badge-bg-func: var(--fem-type-func-bg);
  --fem-badge-fg-func: #7A6535;
  --fem-badge-bg-assign: var(--fem-type-assign-bg);
  --fem-badge-fg-assign: #63598F;
  --fem-badge-bg-module: var(--fem-tag-bg);
  --fem-badge-fg-module: var(--fem-on-accent);
}

/* ══ DSH 系主题共享：形状/边框粗细/字体/滚动条（浅色与深色一致）══ */
:root, [data-fem-theme] {
  /* ── 形状：更收敛（dsh 组件主圆角 8px）── */
  --fem-radius-lg: 8px;                  /* 大圆角收到 8px */
  --fem-radius-xl: 12px;                 /* 弹窗 12px */
  --fem-radius-top: 12px 12px 0 0;
  --fem-radius-bubble: 8px 8px 8px 2px;
  /* xs 2 / sm 6 / md 8 / pill 50% 保持（md 正好是 dsh 主圆角） */

  /* ── 边框宽度：更细（dsh 全部 1px）── */
  --fem-border-w-strong: 1px;
  --fem-border-w-selected: 1.5px;
  --fem-border-w-accent: 2px;
  --fem-border-w-node: 3px;

  /* ── 字体：DM Sans（拉丁）+ MiSans（中文，round11 换掉系统雅黑）── */
  --fem-font-sans: 'DM Sans', 'MiSans', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Helvetica Neue', Helvetica, Arial, sans-serif;
  --fem-font-mono: 'SF Mono', 'JetBrains Mono', 'Fira Code', Consolas, 'Liberation Mono', Menlo, Courier, 'PingFang SC', 'Microsoft YaHei';
  --fem-font-body: 'DM Sans', 'MiSans', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Helvetica Neue', Helvetica, Arial, sans-serif;

  /* ── 滚动条 8px（dsh 规范）── */
  --fem-scrollbar-w: 8px;
}

/* ══ DSH 深色主题：dsh 本体黑夜设计语言 ══
   取值来源：design-platform.css body[data-ds-dark-theme] alias 语义映射。
   设计原则：背景用 bluish 深色层级；选中/悬停用白基色阶（dsh dark interactive）；
   语义 tertiary 用 dsh dark 的暗 hue-mixed 底（deepseek-800/green-900/amber-900）。 */
[data-fem-theme="dsh-dark"] {
  /* ── 背景：dsh dark bluish 层级（画布最深 → 面板逐级提亮）── */
  --fem-app-bg: #151517;                 /* bluish-950 bg-base */
  --fem-surface: #232324;                /* bluish-875 layer-1 */
  --fem-bg: #2c2c2e;                     /* bluish-850 layer-2 */
  --fem-bg-2: #353638;                   /* bluish-800 layer-3 */
  --fem-bg-hover: #43454a;               /* bluish-750 */

  /* ── 主色：deepseek-400（dsh dark 业务主色）── */
  --fem-primary: #679efe;                /* deepseek-400 */
  --fem-primary-strong: #5686fe;         /* deepseek-450 */
  --fem-primary-soft: #34415b;           /* deepseek-800（dsh business-tertiary：暗蓝选中底）*/
  --fem-primary-soft-2: #243b5e;  /* 实色暗蓝：流式气泡底 / 工具栏激活按钮底（不透明，深底清晰）*/
  --fem-primary-soft-faint: rgba(255,255,255,0.05);
  --fem-primary-glow-weak: rgba(103,158,254,0.15);
  --fem-primary-glow: rgba(103,158,254,0.3);
  --fem-primary-glow-strong: rgba(103,158,254,0.45);
  --fem-primary-glow-x: rgba(103,158,254,0.65);
  --fem-primary-overlay: rgba(103,158,254,0.9);

  /* ── 危险：red-400 亮红 ── */
  --fem-danger: #f25a5a;                 /* red-400 error-primary */
  --fem-danger-weak: rgba(242,90,90,0.85);
  --fem-danger-strong: #f87171;
  --fem-danger-soft: #3d2024;            /* 实色暗红：错误底（原 alpha 0.14 太透）*/
  --fem-danger-soft-2: #4a2328;          /* 实色暗红 2 */
  --fem-danger-border: rgba(242,90,90,0.35);
  --fem-danger-glow-weak: rgba(242,90,90,0.15);
  --fem-danger-glow: rgba(242,90,90,0.3);
  --fem-danger-glow-strong: rgba(242,90,90,0.5);

  /* ── 警告：amber（tertiary 用 amber-900 暗底）── */
  --fem-warning: #f59e0b;                /* amber-500 */
  --fem-warning-strong: #f7ad31;         /* amber-400 */
  --fem-warning-soft: #75603A;           /* 莫兰迪提亮版灰驼（round15，与 func 底同族）*/
  --fem-warning-border: rgba(245,158,11,0.35);

  /* ── 成功：green（tertiary 用 green-900 暗底）── */
  --fem-success: #22c55e;                /* green-500 */
  --fem-success-strong: #4ed17e;         /* green-400 */
  --fem-success-text: #4ed17e;
  --fem-success-soft: #3E6B4E;           /* 莫兰迪提亮版灰绿（round15，与 human 底同族）*/

  /* ── 文本：深底亮字 ── */
  --fem-text-1: #f9fafb;                 /* bluish-50 primary */
  --fem-text-2: #cfd3d6;                 /* bluish-300 secondary */
  --fem-text-2-alt: #979da6;             /* bluish-500（偏灰次级）*/
  --fem-text-3: #adb2b8;                 /* bluish-400 */
  --fem-text-4: #81858c;                 /* bluish-600 caption */
  --fem-text-4-weak: #61666b;            /* bluish-700 */
  --fem-neutral: #979da6;                /* bluish-500 */
  --fem-neutral-faint: rgba(255,255,255,0.06);
  --fem-neutral-border: rgba(255,255,255,0.2);

  /* ── 边框：dsh dark 白 rgba 层级 ── */
  --fem-border: rgba(255,255,255,0.12);  /* l2 */
  --fem-border-strong: rgba(255,255,255,0.16);  /* l3 */
  --fem-tag-bg: #43454a;                 /* bluish-750 */
  --fem-tag-bg-faint: rgba(67,69,74,0.4);
  --fem-scrollbar: #3c3c3d;              /* neutral-700 */
  /* 细边线覆盖：仓库卡片/节点左侧强调边收窄到 1px（粗色条在暗底刺眼）*/
  --fem-border-w-accent: 1px;
  --fem-border-w-node: 1px;

  /* ── 遮罩 / 阴影 ── */
  --fem-mask-soft: rgba(0,0,0,0.5);      /* mask-1 */
  --fem-mask: rgba(0,0,0,0.6);
  --fem-mask-heavy: rgba(0,0,0,0.7);
  --fem-mask-blue: rgba(0,0,0,0.6);
  --fem-shadow-sm: rgba(0,0,0,0.2);
  --fem-shadow-md: rgba(0,0,0,0.3);
  --fem-shadow-lg: rgba(0,0,0,0.45);
  --fem-shadow-xl: rgba(0,0,0,0.6);
  --fem-shadow-blue: rgba(0,0,0,0.2);

  /* ── 画布点阵：白色半透明（更柔和）── */
  --fem-canvas-dot: rgba(255,255,255,0.07);

  /* ── 角色色：莫兰迪提亮版（round15：用户反馈过灰，整体拉起饱和/明度；仍成对同族）── */
  --fem-type-ai: #8FB8F0;
  --fem-type-ai-bg: #3E5C94;             /* 蓝（拉起） */
  --fem-type-human: #85D6A8;
  --fem-type-human-bg: #3E6B4E;          /* 绿（拉起） */
  --fem-type-mind: #EDA3A3;
  --fem-type-mind-bg: #744949;           /* 玫瑰（拉起） */
  --fem-type-func: #EDBE72;
  --fem-type-func-bg: #75603A;           /* 驼金（拉起） */
  --fem-type-assign: #B4A5EC;
  --fem-type-assign-bg: #5C5190;         /* 紫（拉起） */
  --fem-special-par: #B4A5EC;
  --fem-special-par-bg: #5C5190;

  /* ── 特殊节点底色（round20：回归与其它节点同底色（node-bg），类型身份改由彩色边框承载）── */
  --fem-sp-start-bg: var(--fem-node-bg);
  --fem-sp-end-bg: var(--fem-node-bg);
  --fem-sp-break-bg: var(--fem-node-bg);
  --fem-sp-for-bg: var(--fem-node-bg);
  --fem-sp-par-bg: var(--fem-node-bg);

  /* ── 特殊节点彩边压暗混合基色（round39：深色=表面底，维持既定压暗档）── */
  --fem-node-border-mix-base: var(--fem-node-bg);

  /* ── 移动端壳（round37：深色壳覆盖——保持中性黑观感不变）── */
  --fem-mobile-bg: #151517;
  --fem-mobile-bg-2: #1b1b1c;
  --fem-mobile-bg-3: #232324;
  --fem-mobile-surface: #1b1b1c;
  --fem-mobile-surface-hover: #232324;
  --fem-mobile-border: rgba(255,255,255,0.12);
  --fem-mobile-border-light: rgba(255,255,255,0.16);
  --fem-mobile-border-strong: #2c2c2e;
  --fem-mobile-text-1: #f9fafb;
  --fem-mobile-text-2: #979da6;
  --fem-mobile-text-2-alt: #cfd3d6;
  --fem-mobile-text-3: #61666b;
  --fem-mobile-mask: rgba(21,21,23,0.8);

  /* ── FEM 预览条（round38：深色覆盖——保持原深色代码条观感）── */
  --fem-preview-bg: #151517;
  --fem-preview-bg-2: #1b1b1c;
  --fem-preview-text: #adb2b8;
  --fem-preview-text-2: #61666b;
  --fem-preview-border: rgba(255,255,255,0.12);

  /* ── 画布点阵：更细腻的 0.6px 点（round2 再收小，透明度微补可见性）── */
  --fem-canvas-dots: radial-gradient(circle, rgba(255,255,255,0.07) 0.6px, transparent 0.6px);

  /* ── 节点边框（round10：金色调显著边框，与黑金连线呼应；选中仍变类型色）── */
  --fem-node-border: rgba(240,210,120,0.35);
  --fem-node-border-w: 1px;
  --fem-node-bg: #252528;                        /* 表面提半档：在 #151517 画布上 figure-ground 分离更清楚 */

  /* ── 面板底色（round12：边栏/标题栏/右栏对齐 dsh sidebar-fill bluish-900；画布 app-bg 已是 bg-base=聊天底色）── */
  --fem-panel-bg: #1b1b1c;

  /* ── 功能按钮底色（round20：dsh 官方深色功能钮实为 deepseek-500 #4176e6 品牌深蓝——
      见 ui-conversation InputBar「#3964FE light / #679EFE dark」注释与 ChatView 状态渐变用 500；
      用户确认 400 太亮，统一落 500。选中态/焦点仍用 --fem-primary(400) 不受影响）── */
  --fem-btn-primary: #4176e6;

  /* ── 节点阴影（round9：双层投影——近接触影+远环境影，卡片"坐"在画布上）── */
  --fem-node-shadow-rest: inset 0 1px 0 rgba(255,255,255,0.05), inset 0 0 0 1px rgba(255,255,255,0.03), 0 2px 6px rgba(0,0,0,0.3), 0 10px 24px rgba(0,0,0,0.38);
  --fem-node-shadow-sel: inset 0 1px 0 rgba(255,255,255,0.06), inset 0 0 0 1px rgba(255,255,255,0.04), 0 4px 10px rgba(0,0,0,0.35), 0 16px 36px rgba(0,0,0,0.45);
  --fem-node-shadow-rest-sm: inset 0 1px 0 rgba(255,255,255,0.04), 0 0 0 1px rgba(255,255,255,0.03), 0 2px 10px rgba(0,0,0,0.35);
  --fem-node-shadow-sel-sm: inset 0 1px 0 rgba(255,255,255,0.05), 0 0 0 1px rgba(255,255,255,0.04), 0 8px 24px rgba(0,0,0,0.45);

  /* ── 连线：黑金三档实色（round30：再细一档+金再亮一点，补偿电脑端 zoom 缩放的抗锯齿变暗）── */
  --fem-edge: #ffd76b;                         /* 强调边（循环/for/自环）：亮金 */
  --fem-edge-sel: #ffec9c;                     /* 选中：更亮金 */
  --fem-edge-flow: #e3c05e;                    /* 普通顺序边：金 */
  --fem-edge-w: 1px;
  --fem-edge-w-thin: 0.85px;
  --fem-edge-w-sel: 1.5px;
  --fem-edge-sheen: #ffffff;                   /* 流光光珠：纯白（radialGradient 纯白→透明，深浅通用） */

  /* ── 类型徽章：官方 tertiary 语言——暗底 + 亮字（取值联动上方 type-* token）── */
  /* ── 节点类型徽章（round14 fg 提白；round15 随色板拉起微调色相）── */
  --fem-badge-bg-ai: var(--fem-type-ai-bg);          /* 蓝（拉起） */
  --fem-badge-fg-ai: #CFE2FA;
  --fem-badge-bg-human: var(--fem-type-human-bg);    /* 绿（拉起） */
  --fem-badge-fg-human: #D4F0E0;
  --fem-badge-bg-mind: var(--fem-type-mind-bg);
  --fem-badge-fg-mind: #FAD4D4;
  --fem-badge-bg-func: var(--fem-type-func-bg);
  --fem-badge-fg-func: #FAE8C2;
  --fem-badge-bg-assign: var(--fem-type-assign-bg);  /* 紫（拉起） */
  --fem-badge-fg-assign: #DED7FA;
  --fem-badge-bg-module: #43454a;                    /* bluish-750 */
  --fem-badge-fg-module: #cfd3d6;                    /* bluish-300 */

  /* 按钮文字保持白字（主色为亮蓝，白字对比可读）；移动壳/预览壳为固有深色区，保持一致不覆盖 */
}


/* ══ 深色主题（占位，配色待后续设计）══
[data-fem-theme="dark"] {
  --fem-app-bg: ...;
  ...
}
*/

/* ══ 金线流光（round30）：真渐变光珠沿箭头方向滑行，深浅两档金线主题启用 ══
   光珠=radialGradient(纯白→透明) 圆珠 + SMIL animateMotion（组件侧），
   这里只做主题门控：默认 opacity 0（未点亮的主题零影响）。 */
.fem-edge-comet { opacity: 0; pointer-events: none; }
/* round29 起深浅两档都启用流光——深色暖白金光、浅色纯白光扫黑线 */
[data-fem-theme="dsh-dark"] .fem-edge-comet,
[data-fem-theme="dsh"] .fem-edge-comet { opacity: 1; }

/* ══ 流光推进（round36 补挂）：六层 dash 光带的 dashoffset 动画 ══
   288→0 递减 = 沿路径正向（箭头方向）前进；各层 cycle 均 288，
   层间 animationDelay（inline）做中心对齐相位。 */
.fem-edge-comet-layer { animation: femEdgeSweep 3.2s linear infinite; }
@keyframes femEdgeSweep {
  from { stroke-dashoffset: 288; }
  to   { stroke-dashoffset: 0; }
}

/* ══ 特殊节点文字（round39 按主题分流）：深色彩底用白字；浅色彩边灰底用类型色字（inline sc.c 生效）══ */
[data-fem-theme="dsh-dark"] .fem-special-label { color: var(--fem-on-accent) !important; }
`;
