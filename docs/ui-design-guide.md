# DSH 插件 UI 设计规范（对齐官方 Desktop / Web 客户端）

> 用途：指导第三方 DSH 插件的浏览器端（`./client`）UI 重构，使其在视觉、组件、交互上与官方 Desktop UI 保持一致。
> 来源：基于 `deepseek-harness` 宿主仓库（master @ 2e39e70496，0.2.2-rc.5）源码与官方规范整理，并在本地构建的 Web 客户端中逐项读取计算样式、明暗主题截图核对（见文末[核对记录](#13-渲染核对记录)）。**令牌名是契约，数值仅供理解**——写代码时永远引用令牌，不要抄数值。

---

## 目录

1. [总原则](#1-总原则)
2. [技术约束：插件能用什么、不能用什么](#2-技术约束)
3. [设计令牌](#3-设计令牌)
   - 3.1 颜色 · 3.2 字体 · 3.3 圆角 · 3.4 描边与阴影 · 3.5 间距 · 3.6 动效 · 3.7 焦点环 · 3.8 滚动条
4. [基础组件规范（ui-primitives）](#4-基础组件规范)
5. [按扩展点的布局模板](#5-按扩展点的布局模板)
6. [交互与反馈](#6-交互与反馈)
7. [图标](#7-图标)
8. [响应式与触屏](#8-响应式与触屏)
9. [文案与本地化](#9-文案与本地化)
10. [重构检查清单](#10-重构检查清单)
11. [常见反模式对照](#11-常见反模式对照)
12. [官方源码参照索引](#12-官方源码参照索引)
13. [渲染核对记录](#13-渲染核对记录)

---

## 1. 总原则

1. **复用优先于重写。** 官方控件全部在 `@deepseek-ai/dsh-client-ui-primitives`，它是宿主的平台模块（`PLATFORM_MODULES`），插件可直接 import、不会重复打包。只有 primitives 确实没有的控件才自己写。
2. **只用语义令牌。** 颜色、字体、阴影、圆角一律使用 `--dsw-*` 变量（颜色只用 `--dsw-alias-*`），不写任何字面色值。
3. **主题由宿主负责。** 插件 CSS 中不出现 `[data-ds-dark-theme]` 等主题选择器；令牌本身会随明暗主题切换。
4. **克制的视觉语言。** 黑白灰为主、单色品牌（主按钮在浅色下是近黑色，在深色下是近白色），蓝色（`state-business-primary`）只用于焦点、信息、链接；字重 ≤ 500；0.5px 发丝线；大量使用透明 hover 填充而不是边框。
5. **整页参照 Plugins 页。** 做整页/列表/卡片时，以官方 Plugins 页（`ui-plugin-manager`）为基准；做设置项时以 Settings 弹窗为基准。

---

## 2. 技术约束

| 项 | 规定 |
|---|---|
| 样式方案 | CSS Modules + `clsx`。**禁止** Tailwind、第三方组件库（AntD/MUI 等）、CSS-in-JS 主题。 |
| 颜色 | 只用 `--dsw-alias-*`（少数场景 `--dsw-specific-*`）。禁止 hex/rgb/`white`/`black`/`--dsw-static-*`。透明度变化用 `color-mix(in srgb, var(--dsw-alias-xxx) 10%, transparent)`。 |
| 内联样式 | 只允许传递组件局部 CSS 自定义属性（如 `style={{ '--progress': '40%' }}`），不允许写主题分支。 |
| hover | 所有 `:hover` 必须包在 `@media (hover: hover) { … }` 中；selected / expanded / pressed / focus 样式不放进该条件。 |
| 圆角 | 只用 `--dsw-radius-*`；全圆（`50%`/`999px`）必须同一规则里加 `corner-shape: round`。 |
| 描边 | 中性描边 0.5px；浮层用 elevation 阴影且 `border: 0`。 |
| 字重 | 功能 CSS 中 `font-weight` ≤ 500（Markdown 排版令牌除外）。 |
| 浮层 | 菜单/下拉/选择列表必须用 `Menu` 或 `MenuSurface` 包裹，不能自建半透明卡片。 |
| 组件取数 | 组件只吃 props（slot 派生的 props、store、inject 回调），不碰 `ctx`、不自建订阅。 |
| 文案 | 所有用户可见字符串（含 aria-label、tooltip、placeholder）走本地化字典 `t()`。 |
| 图片资源 | 放在 `src/client/assets/`，CSS 用相对 `url()`，TS 用相对 `import`。 |

---

## 3. 设计令牌

令牌定义源：`packages/client/ui-theme/src/styles/`（`base.css`、`design-platform.css`、`gradient-shadow-text.css`、`focus.css`、`corner-shape.css`、`scrollbar.css`）。

### 3.1 颜色

#### 文字（label）

| 令牌 | 用途 | 浅色 | 深色 |
|---|---|---|---|
| `--dsw-alias-label-primary` | 正文、标题、主要值 | rgb(15,17,21) | rgb(249,250,251) |
| `--dsw-alias-label-secondary` | 次要说明、描述、次级图标按钮 hover 态 | rgb(97,102,107) | rgb(207,211,214) |
| `--dsw-alias-label-tertiary` | 辅助信息、placeholder、卡片描述、空态文字 | rgb(129,133,140) | rgb(173,178,184) |
| `--dsw-alias-label-caption` | 最弱信息、图标按钮静止态、分隔点 | rgb(173,178,184) | rgb(129,133,140) |
| `--dsw-alias-label-dimmed` | 极弱（禁用装饰等，慎用于文字） | rgb(225,229,238) | rgb(67,69,74) |
| `--dsw-alias-label-on-color` | 彩色底上的文字 | 白 | 白 |
| `--dsw-alias-label-primary-foreground` | 主按钮上的文字 | — | — |

层级口诀：**primary → secondary → tertiary → caption**，一个信息单元里通常最多用两级。

#### 背景层（bg）

| 令牌 | 用途 | 浅色 | 深色 |
|---|---|---|---|
| `--dsw-alias-bg-base` | 页面底色（整页滚动区） | 白 | rgb(21,21,23) |
| `--dsw-alias-bg-layer-1` | 一级表面（输入框底、表头） | 白 | rgb(35,35,36) |
| `--dsw-alias-bg-layer-2` | 二级表面（弹窗、设置卡片、Pill） | 白 | rgb(44,44,46) |
| `--dsw-alias-bg-layer-3` | 三级表面（表单控件底） | 白 | rgb(53,54,56) |
| `--dsw-alias-bg-module-platform` | 模块底色（neutral Tag 等） | rgb(245,246,247) | rgb(53,54,56) |
| `--dsw-alias-bg-skeleton` | 骨架屏填充 | 黑 4% | 白 8% |
| `--dsw-alias-bg-mask-1` | 模态遮罩 | 黑 24% | 黑 50% |
| `--dsw-alias-settings-card-fill` / `-stroke` | 设置类卡片的填充 / 描边 | = layer-2 / border-l4 | 同 |
| `--dsw-alias-markdown-code-block` | 代码块、工具详情卡底 | — | — |

> 浅色下 layer-1/2/3 都是白色，靠描边和阴影区分；深色下逐级变亮。所以**不要依赖背景色做浅色下的分组**。

> ⚠️ **不存在的令牌**：`--dsw-alias-label-error`、`--dsw-alias-bg-layer-4` 在运行时**未定义**（官方 `SettingsForm` 源码里引用了它们，但实际解析为空）。插件不要照抄；错误色用 `--dsw-alias-state-error-primary`。

#### 描边（border）

| 令牌 | 浅色 | 深色 | 用途 |
|---|---|---|---|
| `--dsw-alias-border-l1` | 黑 4% | 白 6% | 最弱分隔（菜单面描边、卡片内弱线） |
| `--dsw-alias-border-l2` | 黑 10% | 白 12% | 行分隔线、表单字段分隔 |
| `--dsw-alias-border-l3` | 黑 12% | 白 16% | outline 按钮描边 |
| `--dsw-alias-border-l4` | 黑 16% | 白 20% | 输入框、设置卡片、outline Tag、elevation 默认描边 |
| `--dsw-alias-border-selected` | — | — | 选中描边 |

#### 交互态（interactive）

| 令牌 | 用途 |
|---|---|
| `--dsw-alias-interactive-bg-hover` | 通用 hover 填充（ghost 按钮、行、菜单项） |
| `--dsw-alias-interactive-bg-active` | 按下 / 当前项（current row）填充 |
| `--dsw-alias-interactive-bg-hover-accent` | 更强的 hover |
| `--dsw-alias-interactive-bg-hover-danger` | 危险操作 hover |

#### 品牌、链接与状态

| 令牌 | 用途 | 备注 |
|---|---|---|
| `--dsw-alias-brand-primary` / `--dsw-alias-button-primary-fill` | 主按钮填充 | **单色**：浅色近黑、深色近白 |
| `--dsw-alias-button-primary-hover` | 主按钮 hover | |
| `--dsw-alias-state-business-primary` | 焦点环、info、选中强调、输入框 focus 边 | DeepSeek 蓝 rgb(65,118,230) / rgb(122,170,255) |
| `--dsw-alias-link` | 可点击链接文字 | 同蓝；`font-weight: 500`，静止无下划线，hover/focus 显示 dotted 下划线（offset 3px） |
| `--dsw-alias-state-success-primary` | 成功 | 绿 |
| `--dsw-alias-state-warn-primary` / `-label` | 警告 | 琥珀 |
| `--dsw-alias-state-error-primary` | 错误、危险操作文字 | 红 |

#### 浮层专用

| 令牌 | 用途 |
|---|---|
| `--dsw-alias-tooltip-bg` / `-label` | Tooltip（两主题都偏深） |
| `--dsw-alias-toast-bg` / `-label` / `-action` | Toast（两主题都偏深） |
| `--dsw-alias-hovercard-*` | HoverCard |
| `--dsw-menu-surface-fill` + `--dsw-menu-backdrop-filter` | 菜单材质，**插件不得覆写**，用 `MenuSurface` 即可 |

### 3.2 字体

**字体族**

- 正文：`var(--dsw-font-family)`（系统字体 + 苹方/雅黑，用户可在设置中前置自定义字体）
- 代码：`var(--ds-font-family-code)`（SF Mono / JetBrains Mono …）
- 品牌：`var(--dsw-font-family-brand)`（Montserrat，仅品牌位）

**界面字号阶梯（`font` 简写令牌，已包含行高）**

| 令牌 | 值 | 典型用途 |
|---|---|---|
| `--dsw-font-xl-24` | 600 24/32 | 极少用（大标题） |
| `--dsw-font-l-20` | 500 20/28 | 整页标题（Plugins 页标题 20/28/500） |
| `--dsw-font-m-18` | 500 16/28 | — |
| `--dsw-font-base-16` / `-strong-16` | 16/24（500） | 弹窗标题（16/24/500）、设置导航标题 |
| `--dsw-font-s-14` / `-strong-14` | 14/22（500） | 按钮、输入框、设置行标题、分组标题 |
| `--dsw-font-xs-13` / `-strong-13` | 13/20（500） | **最常用的行/详情尺寸**：菜单项、tooltip、卡片描述、表单 label、页面说明 |
| `--dsw-font-xxs-12` / `-strong-12` | 12/18（500） | 小按钮、Pill、设置行描述、帮助文字 |
| `--dsw-font-xxxs-11` / `-strong-11` | 11/14（500） | Tag、紧凑菜单 |

**跟随用户"内容字号"设置的变量**（对话区/内容区使用，界面 chrome 不用）

- `--dsh-content-font-size`（默认 14px，用户可调 10–22）
- `--dsh-content-font-size-secondary`（默认 13px，正文的下一级，工具行、思考文本用）
- `--dsh-content-font-delta`：行高随字号同步偏移，如 `line-height: calc(24px + var(--dsh-content-font-delta, 0px))`
- `--dsw-font-markdown-*`：Markdown 排版（h1–h4、base、table、small、code），只有这里允许 600/700 字重
- 代码：`--dsh-code-font-size`（默认 11px）

**规则**

- 字号必须与行高成对出现；优先使用上面的令牌，其次用当前页面已有的比例，**不为单个元素发明新字号**。
- 同角色元素同字号；13px 是官方确立的"行/详情"尺寸。
- 强调靠字号或墨色（primary/secondary），不靠加粗；`font-weight` 只用 400 / 500。
- 数字列加 `font-variant-numeric: tabular-nums`。

### 3.3 圆角

| 角色 | 典型尺寸 | 令牌 | 值 |
|---|---|---|---|
| 小细节 | 高 < 20：键帽、行内代码、checkbox、骨架条 | `--dsw-radius-xs` | 4px |
| 紧凑控件 | 高 20–28：小按钮、图标按钮、紧凑菜单项、Tooltip | `--dsw-radius-sm` | 8px |
| 标准控件 / 单行单元 | 高 32–40：按钮、输入框、下拉、导航行、菜单项、树行 | `--dsw-radius-md` | 12px |
| 大控件 / 内容组 | 多行单元、嵌套表单组、代码块、diff、预览卡、Toast、标准菜单外框 | `--dsw-radius-lg` | 16px |
| 独立内容卡片 | 设置卡片、插件卡片、消息气泡、引导入口卡 | `--dsw-radius-xl` | 20px |
| 主外框表面 | 输入框 Composer、对话框、主/浮动面板 | `--dsw-radius-panel` | 28px |

规则：

- **按角色选圆角**，不按宽高。卡片再高也是 R20，不升级到 R28；按钮文字换行也保持按钮圆角。
- **嵌套同心内缩**：内 R = 外 R − 内边距。官方菜单：外 R16 + 4px padding + 项 R12；紧凑菜单：外 R12 + 4px + 项 R8。
- **贴边填充**：子元素贴着父容器边时，父容器 `overflow: hidden` 负责圆角，子元素 `border-radius: 0`。
- **独立子卡片**用自己的角色圆角（如 R20 卡片里放 R16 编辑器），不要机械减去父级 padding。
- 全局默认使用 `superellipse(1.5)` 平滑曲线（宿主已注入，无需处理）；**圆形/胶囊**必须写：
  ```css
  .avatar { border-radius: 50%; corner-shape: round; }
  .pill   { border-radius: 999px; corner-shape: round; }
  ```
- hover、pressed、selected、loading、disabled 各状态**不得改变圆角和尺寸**。
- 禁止 10/14/18/24px 这类不在刻度上的圆角（官方对 40px 图标砖 R10 是登记过的例外）。

### 3.4 描边与阴影

**平面描边（卡片、输入框、分隔线、按钮）**

```css
border: 0.5px solid var(--dsw-alias-border-l2);   /* 分隔线 */
border: 0.5px solid var(--dsw-alias-border-l4);   /* 输入框 / 卡片 */
```

- 中性描边一律 0.5px（Chromium 绘制为 1 个设备像素）。
- 虚线、状态色描边（警告面板）保留 1px。
- outline 按钮用内阴影画描边：`box-shadow: inset 0 0 0 0.5px var(--dsw-alias-border-l3)`。

**浮起表面（菜单、Popover、弹窗、面板、浮动按钮）**

```css
.surface {
  border: 0;
  box-shadow: var(--dsw-elevation-panel);      /* 面板、浮动按钮 */
  /* 或 var(--dsw-elevation-prominent)          弹窗、菜单 */
  /* 或 var(--dsw-elevation-soft)               仅 Composer 类大面 */
}
```

- elevation 阴影的第一层就是 0.5px 发丝描边，**绝不能再叠加 `border: … var(--dsw-alias-border-*)`**。
- 需要改描边色时重绑 `--dsw-elevation-stroke-color`（菜单用 `border-l1`）。
- 普通设置卡片**不加阴影**。
- Toast 使用 `--dsw-shadow-lv3`。

### 3.5 间距

官方不定义间距数值刻度，而是按**语义分组**决定距离：同组内的距离必须明显小于组与组之间的距离；标题要离自己的内容比离上一组更近。实践中官方使用的值集中在：

`2 · 4 · 6 · 8 · 10 · 12 · 14 · 16 · 20 · 24 · 32 · 48`

| 场景 | 官方取值 |
|---|---|
| 图标与文字 | 4–6px（按钮 4，输入框/菜单项 6） |
| 同一行的并列控件 / 操作组 | 8px |
| 卡片内 标题 ↔ 描述 | 4px |
| 卡片图标 ↔ 卡片正文 | 14px（图标 48px） |
| 列表卡片之间 | 2px（靠 hover 填充区分，不靠间隙） |
| 分组标题 ↔ 分组内容 | 8px |
| 页面区块之间 | 32px |
| 页面左右边距 | `clamp(24px, 4vw, 48px)`，窄屏（≤767px）20px |
| 页面顶部 | 28px |
| 页面底部留白 | 48px |
| 设置行内上下 | 16px；表单字段上下 12px |
| 弹窗左右内边距 | 24px |

规则：

- 先确认"谁和谁是一组"，再定距离；不要按 DOM 兄弟关系统一套一个 gap。
- 判断间距看**渲染后的实际空白**（含行高、padding、图标留白），不是 CSS margin 数值。
- 复用相同构成时，间距、padding、对齐必须一致，不因文案长短而变。

### 3.6 动效

| 变量 | 值 |
|---|---|
| `--ds-ease-in-out` | `cubic-bezier(0.4, 0, 0.2, 1)` |
| `--ds-transition-duration-fast` | 0.1s（淡入淡出、hover） |
| `--ds-transition-duration` | 0.2s（弹窗、列表位移） |
| `--ds-transition-duration-slow` | 0.3s |

- 所有动画提供 `@media (prefers-reduced-motion: reduce)` 降级。
- 列表重排用 `AnimatedRows`（200ms 位移 + 100ms 淡入淡出），不要自写。

### 3.7 焦点环

宿主已全局设置 `:focus-visible` 的颜色（`state-business-primary`）和宽度（`--dsw-focus-ring-width: 2px`），并在指针操作时自动隐藏非输入控件的焦点环。自定义控件写法：

```css
.control:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 2px;   /* 紧凑控件可用 1px */
}
```

- 不要 `outline: none` 了事；菜单项等以 hover 填充作为焦点指示的组件除外。
- 保证焦点环不被父容器 `overflow: hidden` 裁掉。

### 3.8 滚动条

- 宿主全局皮肤，宽 5px，不要写 `::-webkit-scrollbar` 自定义样式。
- 在浮起表面（菜单、弹窗、卡片内滚动区）上，重绑为 l2 色：
  ```css
  .elevated {
    --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2);
    --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2);
  }
  ```
- 滚动条必须在容器内、不被圆角裁切。

---

## 4. 基础组件规范

所有组件从 `@deepseek-ai/dsh-client-ui-primitives` 引入。下表"尺寸"列供核对自定义组件时使用。

### 4.1 按钮 `Button`

| 属性 | `size="md"`（默认） | `size="sm"` |
|---|---|---|
| 高度 / 圆角 | 36 / R12 | 28 / R8 |
| 字号 | 14/22 | 12/18 |
| 左右内边距 | 14 | 10 |
| 图标 | 16×16，gap 4 | 同 |

| variant | 外观 | 用途 |
|---|---|---|
| `primary` | 单色实心（浅色黑底白字） | 页面/弹窗里唯一的主操作 |
| `ghost`（默认） | 透明，hover 填 `interactive-bg-hover` | 次要操作、工具栏 |
| `outline` | 0.5px 内描边 | 并列的次操作（取消、配置） |
| `toolbar` | 半透明灰底 | 浮在图片/预览上的工具按钮 |

- 禁用：`opacity: 0.4; cursor: not-allowed`，尺寸圆角不变。
- 一个视图里最多一个 `primary`。
- 危险操作：文字用 `state-error-primary`，hover 用 `interactive-bg-hover-danger`；高风险操作用 `RiskConfirmation`。

### 4.2 图标按钮（官方未单独导出，按以下规格写）

```css
.iconButton {
  display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; padding: 0;
  border: 0; border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-caption);       /* 静止态 */
  cursor: pointer;
}
.iconButton:active:not(:disabled) { background: var(--dsw-alias-interactive-bg-active); }
@media (hover: hover) {
  .iconButton:hover:not(:disabled) {
    background: var(--dsw-alias-interactive-bg-hover);
    color: var(--dsw-alias-label-secondary);
  }
}
.iconButton:disabled { opacity: 0.4; cursor: not-allowed; }
```

- 弹窗/面板的关闭按钮同为 28×28 R8，颜色 `label-secondary`。
- 含义不直观的纯图标按钮必须包 `Tooltip`，并提供 `aria-label`；不要用原生 `title`。

### 4.3 输入 `Input` / `InlineEditor`

- `Input`：高 32、R12、左右 padding 8、`0.5px border-l4`、底 `bg-layer-1`、字 14/22；focus 时边框变 `state-business-primary`；前置图标 16px、`label-tertiary`；placeholder `label-tertiary`。
- 触屏（`pointer: coarse`）字号下限 16px（防 iOS 缩放）——自写输入框也必须加。
- 多行短文本用 `InlineEditor`（Enter 保存、Shift+Enter 换行、Esc 取消、IME 安全）。
- 搜索框：前置放大镜和 placeholder 必须是同一个颜色角色。

### 4.4 开关与选择

| 组件 | 规格 | 何时用 |
|---|---|---|
| `Switch` | 36×20，`label` 必填；开启态轨道为 `label-primary`（浅色黑、深色白，**不是蓝色**），关闭态为 12% 灰 | 立即生效的二态设置 |
| `Checkbox` | 16×16 R4 | 独立多选、需要保存才生效的选项 |
| `SegmentedControl` | 外 R12、内缩 4、段高 28、13/20 | 卡片/面板内 2–4 个互斥模式切换（tablist 语义） |
| `SegmentedTabs` | md：42 高、内缩 4、外 R16、段 34 高 R12、14/20；sm：34 高、内缩 2、段 30 高 R12、外圆角 14（= 12 + 2）；底 `bg-module-platform` | 页面级等宽 Tab（Plugins 页用 sm） |
| `Pill` | 高 24、胶囊、12/18、底 `bg-layer-2`；active 填 `button-ghost-active-fill` | 可独立切换的筛选芯片，可多选 |
| `Tag` | 11/17、500、胶囊、padding 1×8；tone：`outline`/`solid`/`neutral`/`quiet`/`success`/`info`/`warning`/`danger` | 只读徽标（版本号、状态） |

易混淆：**Tag = 只读**、**Pill = 可点**；**多个 Pill = 独立开关**、**SegmentedControl = 单选模式**。

### 4.5 菜单 `Menu` / `MenuItemButton` / `MenuSurface` / `MenuGroup`

| | 标准菜单 | 紧凑菜单 |
|---|---|---|
| 外框 | R16，padding 4，`elevation-prominent`，半透明模糊材质 | R12，padding 4 |
| 菜单项 | 最小高 34，padding 6×8，R12，13/20，gap 6 | 高 24，padding 2×6，R8，11/17 |
| 图标 | 14px，颜色 `--dsw-alias-menu-icon`（比文字略浅） | 12px |
| 宽度 | 144–360px | ≥156px |

- 下拉、右键、子菜单、自定义 listbox **全部**用 `Menu`，自定义内容包 `MenuSurface`。
- 快捷键提示通过 `shortcut` 属性交给菜单渲染，右对齐、弱色、无底。
- 禁用项若有原因，用 `disabledReason`（保持可聚焦，显示 Tooltip）。
- 不要覆写 `--dsw-menu-surface-fill` / `--dsw-menu-backdrop-filter`。

### 4.6 对话框 `Modal` / `RiskConfirmation`

| 部位 | 规格 |
|---|---|
| 卡片 | 宽 `min(380px, 100%)`，R28，底 `bg-layer-2`，`elevation-prominent`，无 border |
| 头部 | padding `22px 24px 12px`；标题 16/24/500 `label-primary`；关闭按钮 28×28 R8 |
| 描述 / 正文 | 左右 24px；描述 14/22 |
| 区块间距 | 20px |
| 底部操作 | 右对齐，gap 8，左右 24px，底部 24px |
| 遮罩 | `bg-mask-1`，**不模糊** |
| 警告态 | `tone="warning"`：标题前加琥珀警告图标 |

- 初始焦点控件加 `data-modal-autofocus`，**不要用 React `autoFocus`**。
- Esc、Tab 循环、关闭后焦点回归由 `Modal` 处理，不要自己实现。

### 4.7 提示类

| 组件 | 规格 / 用法 |
|---|---|
| `Tooltip` | 13/20，padding 3×7（带快捷键时右侧 5），R8，深色底 `tooltip-bg`（两主题都深）；用于说明不直观的图标按钮，快捷键用 `shortcutKeys`；`portal` 逃离裁剪容器；`onlyWhenClipped` 用于被省略的文本 |
| `HoverCard` | 可读/可复制的悬停预览（列表项详情）；深色底 `hovercard-bg`（两主题都深）、R16、padding 12×16、`--dsw-shadow-lv3`；正文/次要文字用 `--dsw-alias-hovercard-label-*` |
| `Toast` | 顶部居中（top 40），padding 12×16，R16，14/22，深色底；**仅用于短暂的成功/失败** |
| `StateDot` | 状态点：`done` 绿 / `warning` 琥珀 / `error` 红 / `idle` 灰（10px 槽位）、`ongoing` 14px 旋转加载 |
| `ConnectionIndicator` | 连接中断/重试/恢复 |

### 4.8 内容与列表

| 组件 | 用途 |
|---|---|
| `DisclosureRow` | 24px 单行折叠行（标题与内容并排），工具行同款 |
| `AnimatedRows` | 列表增删重排动画 |
| `PathLabel` | 文件路径（目录弱化、保留文件名、溢出左侧渐隐） |
| `MarqueeText` + `useHoverMarquee` | 单行溢出文字 hover 滚动 |
| `TextShimmer` | 进行中文字的高光扫过 |
| `MarkdownText` | 渲染 Markdown（`variant="compact"` 为 13/20 次要内容） |
| `CodeBlock` / `JsonTree` / `JsonBlock` | 代码 / JSON |
| `TerminalBlock` / `ReadBlock` / `DiffBlock` / `SearchBlock` / `WebBlock` | 工具输出卡片 |
| `DetailDocument` | 长 Markdown 说明（自带骨架、错误重试、滚动） |
| `FileTypeIcon` | 28px 文件类型图标 |
| `SettingsForm` / `SettingsValueField` / `SettingsSecretField` / `SettingsFormModel` | 插件设置页（暂存-保存模型） |
| `useClipboardCopy` | 复制按钮（1 秒成功反馈） |

### 4.9 自定义卡片（primitives 中没有，按官方材质写）

```css
/* 设置 / 插件 / 账户类卡片的默认材质 */
.card {
  border-radius: var(--dsw-radius-xl);
  border: 0.5px solid var(--dsw-alias-settings-card-stroke);
  background: var(--dsw-alias-settings-card-fill);
}
```

列表型可点击卡片（Plugins 页样式，无描边、hover 出底）：

```css
.cardRow {
  margin: 0 -8px;                         /* hover 底比内容左右各宽 8px，内容仍与页头对齐 */
  border-radius: var(--dsw-radius-xl);
}
.cardHead { display: flex; align-items: center; gap: 14px; padding: 8px; }
.cardIcon {
  width: 48px; height: 48px; border-radius: var(--dsw-radius-lg);
  border: 0.5px solid var(--dsw-alias-border-l3);   /* 透明底 + 发丝描边的图标砖，内放 36×36 插画 */
}
.cardTitle { font-size: 14px; line-height: 20px; font-weight: 500; }
.cardDesc  { font-size: 13px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
@media (hover: hover) { .cardRow:hover { background: var(--dsw-alias-interactive-bg-hover); } }
.cardRow:active { background: var(--dsw-alias-interactive-bg-active); }
```

卡片标题旁的状态标签（"实验性"等）在 Plugins 页用的是**紧凑版**：高 18、10px、500、padding 0×7、胶囊、info 调（10% 蓝底蓝字），比 `Tag` 默认的 11/17 更小。

预览类卡片（文件卡、计划卡、代码块）用 R16；卡片内 40px 图标砖用 R10（官方登记例外）。对话区交付文件卡实测：R16、`card-fill` 底、`0.5px border-l1`、padding 8×10、文件名 13/20/500。

选项卡片（如"外观"里的浅色/深色/跟随系统）：R20、`0.5px border-l4`、透明底；选中态 `bg-module-platform` 底 + `border-selected` 描边，尺寸不变。

---

## 5. 按扩展点的布局模板

插件 UI 通过 slot 进入宿主。下面按常见扩展点给出官方参照布局。

### 5.1 整页（参照 Plugins 页）

```
┌───────────────────────── page（bg-base，可滚动）─────────────────────────┐
│  inset = clamp(24px, 4vw, 48px)，≤767px 时 20px；内容 max-width 960px 居中  │
│  ↓ 28px                                                                  │
│  标题 20/28/500 primary                          [工具栏 gap 8]          │
│  ↓ 4px                                                                   │
│  说明 13/20 secondary  (ⓘ 20×20 caption)                                  │
│  ↓ 32px                                                                  │
│  分组标题 14/22/500    ← 8px →  分组内容（卡片列表 gap 2）                  │
│  ↓ 32px                                                                  │
│  下一个分组 …                                                             │
│  ↓ 48px 底部留白                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

- 标题优先完整显示，空间不足时把操作区换到下一行，而不是截断标题。
- 页头工具栏按钮高 32、R12、13/20、左右 12：主操作为单色实心（Plugins 页"添加插件"，带下拉的分体按钮），次操作为 0.5px 内描边 outline（"刷新"）。
- 窄屏下工具栏按钮收为纯图标并换行到 Tab 下方，标题保持完整。
- 状态/空态文字 13/20 `label-tertiary`；错误 `state-error-primary`。
- macOS 顶部要考虑窗口拖拽区与 `--dsh-frame-top-clearance`（见 6.5）。

### 5.2 插件配置页（`plugins.item` / `plugins.bundle.config` / `plugins.row.config` / `settings.section`）

- 宿主绘制标题、图标、面包屑，插件只绘制表单内容。
- **直接使用 `SettingsForm` + `SettingsValueField` / `SettingsSecretField`**，不要自绘保存按钮。
- 字段规格（自定义字段对齐用）：

| 部位 | 规格 |
|---|---|
| 字段 | 纵向，gap 6，上下 padding 12；相邻字段之间 `0.5px border-l2` 分隔 |
| label | 13/500 `label-primary`（行高 1.5） |
| 输入框 | 高 34，padding 0×12，`0.5px border-l4`，R12，底 `bg-layer-3`，13px |
| 字段提示（常显） | 12/18 `label-tertiary`，位于输入框下方 |
| 帮助按钮 | 24×24 R8 `label-tertiary` |
| 帮助文字（点开后） | 12px，行高 1.6，`label-secondary` |
| 校验失败 | 边框 `state-error-primary`，下方 12px 红字 |
| 保存按钮 | 底栏 padding-top 16；按钮约高 32、R12、13px、padding 5×14、单色实心；未修改时禁用（opacity 0.4） |
| 页头（宿主绘制） | 面包屑 → 48px 图标砖 → 标题 20/28/500 → 描述 |

- `view === 'summary'` 时只返回一句纯文本摘要。
- 向别的插件详情页贡献：`plugins.detail.actions`（头部控件）、`plugins.detail.badge`（标题旁 `Tag`）、`plugins.detail.section`（页面下方区块，自绘区块 chrome，复用上面的分组标题样式）。

### 5.3 设置行（Settings 弹窗中"标题 + 描述 + 右侧控件"）

```css
.row {
  display: flex; align-items: center; justify-content: space-between;
  gap: 8px;                                                   /* 官方多数行；文字与控件间距由弹性布局撑开 */
  padding: 16px 0;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);   /* 最后一行由容器去掉 */
}
.title       { font-size: 14px; line-height: 22px; font-weight: 400; color: var(--dsw-alias-label-primary); }
.description { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
```

> 实测"通用设置"13 行中有 11 行是上面的 14/22 + tertiary；开发者工具等少数行是 14/20 + secondary。以多数为准。

右侧控件：
- `Switch`（立即生效的开关）；
- 下拉选择触发器：高 36、R12、padding 0×14、14px、底 `bg-module-platform`、**无描边**，右侧 chevron 与文字同色，点开为 `Menu`；
- `Button size="sm"` 或 `md` outline。

设置弹窗本体：800 宽、高 ≤800、R28、`elevation-prominent`、遮罩 `bg-mask-1` 不模糊；导航项高 40、R12、padding 9/16/9/12、14/22，选中项浅灰填充；关闭按钮 28×28 R8；内容区左右 24。

### 5.4 右侧栏 Tab（`ctx.sidebarRightTabs` + `sidebar.right.pane.tab`）

- 每个 Tab 类型**必须有有意义的图标**；`title(address)` 返回芯片文字。
- 需要出现在引导页时提供 `guide: { order, title, description?, icon? }`；引导入口卡 R20，图标为 36×36 的插件插画。
- 正文区域：容器自身滚动；左右 padding 参考 16–20px；顶部行与对话区头部保持同一高度和基线。
- 树/列表行参照文件树：行 padding `5px 10px`、R12、图标与文字 gap 6、每级缩进 `16px + 6px`；hover `interactive-bg-hover`，当前项 `interactive-bg-active`（hover 保持）。
- 不要自建第二个侧边栏，右侧内容一律注册为 Tab。

### 5.5 对话流中的工具卡片（`tool.call.toolview`）

- **摘要行**：使用 `DisclosureRow` 语义，24px 单行：`[16px 图标] 6 [标题] 8 [2×2 分隔点 caption] 8 [摘要，可省略号]`；字号用 `--dsh-content-font-size-secondary`（默认 13），行高 `calc(24px + var(--dsh-content-font-delta))`；静止 `label-tertiary`、hover `label-secondary`。
- **展开详情**：R16、`0.5px border-l1`、底 `--dsw-alias-markdown-code-block`、`font: var(--dsw-font-xs-13)`、`label-secondary`；列表项 padding `10px 14px`，项间 `0.5px border-l2`；最大高 320 后内部滚动。
- 能用官方输出卡就用（`TerminalBlock` / `DiffBlock` / `ReadBlock` / `SearchBlock` / `WebBlock` / `JsonBlock`）。它们实测为 R16、`markdown-code-block` 底、padding 12×14、**无描边**；上面带 `border-l1` 的是列表型详情卡（ToolDetails），两者不要混用。
- 文件路径可点击：dotted 弱色下划线。diff 统计 `+n` 用 success、`-n` 用 error，且仅在展开或 hover 时上色。
- 数据异常时回落到通用卡片，不要崩溃。

### 5.6 对话区全高视图

覆盖在对话区域中的全高面板（如统计视图），底部需为 Composer 让位：

```css
.root { height: 100%; min-height: 0; padding-bottom: calc(var(--dsh-composer-height, 152px) + 8px); }
```

表格：表头 sticky、底 `bg-layer-1`、`label-tertiary`、12px/500；行分隔 `0.5px border-l2`；单元格 padding `6px 8px`。

---

## 6. 交互与反馈

### 6.1 选择反馈载体

| 场景 | 载体 |
|---|---|
| 短暂的成功/失败（复制成功、删除失败） | `Toast`，且由比来源面板寿命更长的宿主承载（如 `shell.overlay`），**不要 toast 进行中状态** |
| 区域自身失败（查询失败、字段校验） | 就地提示 + Retry；有内容时紧凑地放在内容旁，只有空面板才居中显示错误态 |
| 操作失败 | 保留可见数据（删除失败时行不消失） |
| 风险操作 | `RiskConfirmation` |

错误文案：一句话、口语化、可操作，不带内部术语（必要的诊断码除外）；**中文提示不超过两句时，不加句末"。"**；为提示预留空间或用浮层，避免挤动邻居。

### 6.2 加载

- 列表用**骨架屏**：`background: var(--dsw-alias-bg-skeleton)`，文字条高 12px R4，宽度模拟真实内容（标题 ~144px、描述 ~280px）。
- 其他页面级加载：居中一个裸 spinner（`StateDot state="ongoing"` 或同款）。
- 一个页面/组件只用一种加载形态；只有上下文需要时才加加载文字。

### 6.3 浮层

合并前逐个检查菜单、Popover、Tooltip：

- 点击外部关闭；可聚焦时 Esc 关闭；
- 不超出视口，保留边距（官方 12px）；
- 不被祖先 `overflow`、containing block、相邻元素遮挡，必要时 portal 到 body；
- 只翻转到放得下的一侧，两侧都不行时不来回抖动。

### 6.4 状态组合

同时出现时必须仍可区分：选中 + 另一行 hover（当前项仍可识别）、选中 + 自身 hover（选中不被冲掉）、选中 + 键盘焦点、选中 + 禁用（禁用不能看起来像未选中）。

### 6.5 平台窗口适配

- 新的页头/页面要考虑 macOS 红绿灯与 Windows 标题栏；`Menu`、`Modal` 等已消费 `--dsh-frame-top-clearance`。
- 仅针对 macOS 的局部修正写成 `[data-platform='darwin'] .xxx { … }`，不要改全局变量。
- macOS 窗口拖拽由行自身盒子负责：把顶部 28px 内边距放在头部行上，而不是页面容器上。

---

## 7. 图标

- **先复用**：`ui-primitives` 的 `icons/*`，命名 `IconXxxOutlineRegular` / `IconXxxOutlineMedium`，`size` 控制尺寸；不复制 SVG 到插件里。
- 线条：Regular 1px、Medium 1.3px，使用 `non-scaling-stroke`，任意尺寸笔画不变。
- 风格：极简几何、单色描边、继承 `currentColor`；无渐变、阴影、3D、插画式细节；约 1px 的克制圆角。
- 尺寸惯例：菜单 14px（紧凑 12px）、按钮 16px、侧边导航 16–18px、链接前缀 14px（`LinkIconMedium`）、文件 28px（`FileTypeIcon`）、插件插画 36×36。
- **图标与其文字同色同透明度同状态变化**（包括子菜单值的 chevron、搜索框放大镜）；状态/品牌色除外。
- 插件自身图标（插件卡片、引导入口）用 36×36 固定配色插画，无专属插画时用 `PluginArtworkDefault`。
- 必须自绘时：可编辑 SVG，提供 Regular/Medium 两个字重，在实际尺寸与同类图标对比验证。

---

## 8. 响应式与触屏

- 最小验收宽度 **390px**：无重叠、无裁切、无整页横向滚动、主要操作可达。
- 常用断点：`@media (max-width: 767px)`（页面边距 → 20px、设置弹窗 → 全屏）。
- 处理顺序：先调整空间分配/换行 → 再考虑截断、图标化、收进"更多"；不靠全局缩字号、缩点击区。
- 截断的内容必须能在别处看到完整版（Tooltip `onlyWhenClipped`、详情页、菜单）；错误等关键信息不截断。
- 页面标题优先完整显示；卡片标题优先自然换行。
- 图标化的前提：含义清晰或高频使用，且有 Tooltip。
- 触屏：hover 效果只在 `(hover: hover)` 下生效；点按不能残留 hover 态；纯辅助性的 tooltip（如"复制"）在移动端不显示，补充说明性 tooltip 支持点按显示（`openOnClick`）。
- 移动端不要自动弹出键盘；`(pointer: coarse)` 下输入框字号 ≥16px。
- 不用 UA 判断布局；用 media query。

---

## 9. 文案与本地化

- 所有产品可见文字（含 aria-label、tooltip、placeholder、单位格式）进类型化本地化字典，经 slot 的 `t` 或已本地化的 props 到达组件。
- primitives 不带默认文案，调用时 `label` 等属性必须传完整本地化字符串。
- 英文用 **Sentence case**（包括插件标题）："Add plugin"，不是 "Add Plugin"。
- 用户/模型/协议数据与代码标识原样显示，不翻译；内部匹配用稳定 id，不用本地化文本。
- 列表搜索：匹配名称、标题、描述、id；名称支持前缀/子串/词首模糊（`cpt` → `compact`），描述只支持连续子串；忽略大小写、全半角、变音符；可用 `TextSearchIndex`。

---

## 10. 重构检查清单

**样式**
- [ ] 无字面色值、无 `--dsw-static-*`，只有 `--dsw-alias-*`
- [ ] 无主题选择器，无 Tailwind/组件库
- [ ] 所有 `:hover` 都在 `@media (hover: hover)` 中
- [ ] 圆角全部来自 `--dsw-radius-*`，角色正确；全圆配 `corner-shape: round`
- [ ] 中性描边 0.5px；浮层 `border: 0` + elevation，未叠加 border
- [ ] `font-weight` ≤ 500；字号成对行高；同角色同字号
- [ ] 无自定义 `::-webkit-scrollbar`；浮起表面重绑 l2 滚动条
- [ ] 禁用态 `opacity: 0.4`，各状态不改变尺寸/圆角

**组件**
- [ ] 按钮、输入、开关、菜单、弹窗、Tooltip、Toast、Tag/Pill 均替换为 `ui-primitives`
- [ ] 下拉/右键/选择列表全部用 `Menu` / `MenuSurface`
- [ ] 插件设置页使用 `SettingsForm` 系列
- [ ] 工具卡片优先使用官方输出卡与 `DisclosureRow` 规格
- [ ] 纯图标按钮有 Tooltip + aria-label，无原生 `title`

**交互**
- [ ] 加载：列表骨架、其他居中 spinner，单页单形态
- [ ] 错误：就地提示 + 重试；Toast 只用于瞬时结果且承载者寿命足够
- [ ] 浮层：外部点击/Esc 关闭、视口内、不被裁切
- [ ] 弹窗初始焦点用 `data-modal-autofocus`
- [ ] 焦点环可见、未被裁剪

**验证**
- [ ] 浅色 + 深色主题都看过（尤其是弱色文字与背景对比）
- [ ] 窄容器 + 长文案（含中英文混排）看过
- [ ] 390px 宽度看过
- [ ] hover / focus / disabled / loading / error / expanded 中受影响的状态都操作过
- [ ] macOS 顶部间距与 Windows 标题栏看过（如有新页头）
- [ ] 所有文案已进字典，英文 Sentence case

---

## 11. 常见反模式对照

| ❌ 反模式 | ✅ 官方做法 |
|---|---|
| `color: #666` / `background: #fff` | `color: var(--dsw-alias-label-secondary)` / `background: var(--dsw-alias-bg-layer-2)` |
| `body.dark .card { … }` | 删除，令牌自动切换 |
| `border: 1px solid #e5e5e5` | `border: 0.5px solid var(--dsw-alias-border-l2)` |
| 弹层 `border: 1px solid …; box-shadow: 0 4px 12px …` | `border: 0; box-shadow: var(--dsw-elevation-prominent)` |
| `border-radius: 6px / 10px / 24px` | 按角色选 `--dsw-radius-sm/md/xl` |
| `border-radius: 999px`（无 corner-shape） | 加 `corner-shape: round` |
| `.btn:hover { … }` 裸写 | 包进 `@media (hover: hover)` |
| `font-weight: 600/700` 做强调 | 500 + 更深墨色或更大字号 |
| 主按钮用蓝色 | `Button variant="primary"`（单色） |
| 自绘下拉卡片 | `Menu` / `MenuSurface` |
| `<button title="删除">🗑</button>` | 图标组件 + `Tooltip` + `aria-label={t('delete')}` |
| 加载时显示"加载中..."文字 + spinner + 骨架混用 | 列表骨架 / 页面居中 spinner，单一形态 |
| 查询失败弹 Toast | 就地错误提示 + 重试按钮 |
| 卡片之间 12px 间距 + 每张都有边框阴影 | 列表卡片 gap 2，靠 hover 填充；设置卡片仅 0.5px 描边无阴影 |
| `<input autoFocus>` 放在弹窗里 | `data-modal-autofocus` |
| 自定义滚动条样式 | 删除，必要时重绑 `--dsh-scrollbar-thumb` |
| 硬编码中英文 | `t('key')` |
| "Add New Plugin" | "Add new plugin" |

---

## 12. 官方源码参照索引

以下路径相对宿主仓库根目录 `deepseek-harness/`。

| 主题 | 位置 |
|---|---|
| UI 设计总则 | `.agents/skills/dsh-client-ui-ux/SKILL.md` 及 `references/{alignment,spacing,icons}.md` |
| 响应式 | `.agents/skills/dsh-responsive-ui/SKILL.md` |
| 样式规则 | `docs/web-styling.md` |
| 圆角标准 | `docs/ui-radius.md` |
| 设计评审案例 | `docs/ui-design-review-cases.md` |
| 令牌定义 | `packages/client/ui-theme/src/styles/*.css` |
| 组件目录与行为 | `packages/client/ui-primitives/README.md`（Component catalog） |
| 组件样式源码 | `packages/client/ui-primitives/src/*.module.css` |
| 整页参照（Plugins 页） | `packages/client/ui-plugin-manager/src/client/PluginManagerPage.module.css` |
| 设置弹窗 / 设置行 | `packages/client/ui-settings-general/src/client/SettingsRoot.module.css`、`DeveloperToolsRow.module.css` |
| 设置表单 | `packages/client/ui-primitives/src/settings-form/` |
| 工具行 / 工具详情 | `packages/client/ui-tool/src/client/tool/components/ToolRow.module.css`、`ToolDetails.module.css` |
| 文件树行 | `packages/client/ui-sidebar-files/src/client/FileTree.module.css` |
| 全高表格视图（实验插件示例） | `packages/experimental/client-ui-stats/src/client/stats.module.css` |
| Slot 机制 | `docs/subsystems/slots.md`、`packages/client/AGENTS.md` |
| 右侧栏 Tab | `docs/subsystems/sidebar-right.md` |
| 插件配置页 / 详情页扩展点 | `docs/cookbook/adding-a-settings-card.md`、`packages/client/ui-plugin-manager/README.md#configuration-pages` |
| 工具 UI 呈现 | `docs/cookbook/adding-a-tool.md#web-client-presentation` |
| 插件插画 | `.agents/skills/dsh-official-plugin-artwork/SKILL.md` |

---

## 13. 渲染核对记录

核对环境：本地 `build:artifacts` 后以 `dsh web --patch apps/web/tests/pin-browse-picker.overlay.yml` 启动，内置浏览器 1280×800（另测 390×800），读取 `getComputedStyle` 并截图；平台为 Web（非 macOS 原生窗口）。

| 区域 | 浅色 | 深色 | 结果 |
|---|---|---|---|
| 令牌（背景层、文字、描边、交互态、状态、圆角、焦点环） | ✓ | ✓ | 与 3.1–3.7 一致；发现 `label-error`、`bg-layer-4` 未定义 |
| Plugins 页（页头、Tab、分组、卡片、开关、标签、工具栏按钮、骨架屏） | ✓ | ✓ | 一致；补充了图标砖描边、紧凑状态标签、SegmentedTabs sm |
| 插件配置页（终端：字段、输入框、提示、保存） | ✓ | — | 一致；补充输入框 34 高 / 13px、提示文字 tertiary |
| 设置弹窗（面板、导航、遮罩、设置卡片、设置行、下拉触发器、选项卡片） | ✓ | ✓ | **修正**设置行为 14/22 + tertiary 描述；补充下拉触发器与选项卡片 |
| 菜单（用户菜单） | ✓ | — | 一致；补充菜单图标令牌 |
| 对话区（工具行、输出卡、交付文件卡、链接、HoverCard、Tooltip） | ✓ | — | 一致；补充 HoverCard、文件卡、输出卡无描边 |
| 390px 窄屏（Plugins 页） | ✓ | — | 边距 20、无横向滚动、工具栏图标化并换行 |

未覆盖：`Modal`/`RiskConfirmation` 确认弹窗与 `Toast`（需触发真实操作）、右侧栏 Tab、macOS 原生窗口顶部间距、触屏设备。这几项的规格目前仍只来自源码。
