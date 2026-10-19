<div align="center">

# DeskPet 桌宠

**用你自己的图像模型，生成一个住进桌面的小人儿**

会呼吸、会卖萌、会自己找事做，还会记得提醒你喝水

[![Release](https://img.shields.io/github/v/release/lylong3011/deskpet?color=7fc4b8)](https://github.com/lylong3011/deskpet/releases/latest)
[![Platform](https://img.shields.io/badge/platform-Windows%2011%20x64-4a90d9)](https://github.com/lylong3011/deskpet/releases/latest)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Electron](https://img.shields.io/badge/Electron-39-47848F?logo=electron&logoColor=white)](package.json)

[**⬇️ 下载免安装版**](https://github.com/lylong3011/deskpet/releases/latest) · [功能](#功能) · [快速开始](#快速开始) · [常见问题](#常见问题)

</div>

---

## 功能

| | |
|---|---|
| 🎨 **专属形象** | 上传一张正脸照，用你自己的图像模型生成 Q 版立绘，自动抠白底 |
| 🕺 **28 个动作** | 呼吸 / 走 / 跑 / 跳 / 转圈 / 伸懒腰 / 跳舞 / 害羞 / 生气 / 晕倒…待机时随机自发小动作 |
| 🎒 **随身道具** | 水杯、咖啡、书、麦克风、爱心、星星开箱可用；也能用一句话让 AI 生成新道具 |
| 💬 **AI 对话** | 接你惯用的对话模型，双击桌宠就能聊天，带人设 |
| ⏰ **定时提醒** | 喝水、起身、护眼，间隔随机，跟着免打扰时段走 |
| 🫥 **低打扰** | 点击穿透（只有点到角色本体才响应）、勿扰模式、主动互动可整体关掉 |
| 🔌 **平台自由** | 火山方舟 / OpenAI / Gemini / 通义万相 / 任意 OpenAI 兼容中转站 |

### 动作一览

循环：`idle` `walk` `run` `play` `sleep`
跳转：`hop` `hopTwice` `jumpSpin` `float`
旋转：`spin` `flip` `tilt`
头部：`nod` `shakeHead`
伸展：`stretch` `squat` `yawn`
情绪：`angry` `shy` `sad` `surprise` `sneeze` `pulse`
组合：`dance` `lieDown` `wake` `faint` `peek`

> 当前是「单张主图 + 参数化变换」，做不了抬手臂这类四肢独立运动。要更接近 Live2D 需要分层骨骼或多帧序列，见 [已知限制](#已知限制)。

## 快速开始

### 直接用（推荐）

从 [Releases](https://github.com/lylong3011/deskpet/releases/latest) 下载 `DeskPet-0.2.1-portable.exe`，双击即可。

- 单文件免安装，**首次启动要解包约 30–40 秒**，期间任务管理器里看不到进程，别重复双击
- 未做代码签名，Windows 可能提示「已保护你的电脑」→ 更多信息 → 仍要运行

### 从源码跑

```bash
git clone https://github.com/lylong3011/deskpet.git
cd deskpet
npm install          # 首次会下载 Electron（约 100MB）
npm start            # 开发模式
npm test             # 58 条单元测试
npm run dist         # 打包 exe
```

产物在 `dist/`：`DeskPet-0.2.1-portable.exe`（单文件）与 `DeskPet Setup 0.2.1.exe`（安装版）。

#### 国内网络环境提示

Electron 二进制与打包工具从 GitHub 下载很慢，建议先设镜像：

```bash
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
export ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
npm install
npm run dist
```

若 `npm install` 卡在 electron 的 postinstall，可手动把 `%LOCALAPPDATA%\electron\Cache` 里对应版本的
`electron-vX.Y.Z-win32-x64.zip` 解压到 `node_modules/electron/dist`，并写入 `node_modules/electron/path.txt`（内容为 `electron.exe`）。

## 首次使用

1. 启动弹出向导，**第 1 步先配接口**：选平台 → 填 Base URL → 填图像模型名 → 填 API Key → 点「测试连接」。
2. 第 2 步上传照片 → 拖动裁剪 → 选画风 → 生成 → 取名。
3. 忘了配也没事：设置里「形象与外观」随时能补，`测试连接` 会告诉你到底哪一项不对。

> 只填图像模型也能通过测试连接，AI 对话模型可留空（那部分只是聊不了天）。

## 支持的图像平台

| 平台 | 参考图 | 默认模型 |
|---|---|---|
| 火山方舟 Seedream | ✅ | `doubao-seedream-4-0-250828` |
| OpenAI gpt-image-1 | ✅ | `gpt-image-1` |
| Google Gemini 图像 | ✅ | `gemini-2.5-flash-image-preview` |
| 阿里云百炼 通义万相 | ❌ 仅文生图 | `wanx2.1-t2i-turbo` |
| 自定义 OpenAI 兼容 | ✅ | 自行填写 |

Base URL 与模型名都可覆盖，支持中转站、自建服务。

## 操作方式

| 动作 | 效果 |
|---|---|
| 左键拖拽 | 移动桌宠，松手贴合屏幕 |
| 单击 | 摸摸头，好感 +2，爱心特效 |
| 右键 | 喂食 / 喝水 / 玩耍 / 聊天 / 设置 / 退出（点桌面任意处自动收起） |
| 双击 | 开启 AI 对话（需在设置里打开开关） |
| 托盘图标 | 显示隐藏、勿扰、开机自启、退出 |
| 设置 → 通用 | 桌宠大小、始终置顶、开机自启、**主动来找我互动** |

## 项目结构

```
deskpet/
├─ electron/
│  ├─ main.js       主进程：窗口、托盘、移动、IPC、主循环
│  ├─ preload.js    contextBridge 白名单 IPC
│  ├─ behavior.js   行为引擎（驱动值 + 效用函数 + 冷却）
│  ├─ scheduler.js  提醒调度（随机区间 + 静音 + 配额）
│  ├─ store.js      JSON 存储 + safeStorage 加密
│  └─ providers.js  5 个平台的图像/对话适配
├─ renderer/
│  ├─ pet/          透明桌宠窗（Canvas 程序化动画）
│  └─ settings/     设置窗口（向导、裁剪、抠图、表单）
├─ assets/          图标、提示音、3 个内置形象 SVG
├─ scripts/         资源生成脚本（零依赖）
└─ test/            44 条单元测试
```

## 关键技术点

- **逐像素穿透**：Canvas alpha 采样 + `setIgnoreMouseEvents(through, {forward:true})`，空白处点击直接穿过到桌面。
- **程序化动画**：单张图 + 呼吸（纵向正弦缩放）/ 摇摆 / 跳跃物理 / 挤压回弹，不用逐帧序列，也不用 Live2D 绑定。
- **行为引擎**：`thirst / hunger / energy / boredom / affection` 五项驱动随时间衰减，每秒用效用函数选动作，配三道防骚扰闸门（冷却、每日配额、静音/勿扰）。
- **无人判定**：`powerMonitor.getSystemIdleTime()`（系统级输入空闲），不是窗口焦点。
- **抠白底**：从边缘做洪水填充移除近白像素 + 边缘羽化 + 自动裁边，纯本地完成。

## 测试

```bash
npm test                      # 47 条单元测试（行为引擎 / 调度 / 存储 / 平台适配）

# 界面冒烟：启动后检查两个窗口渲染、IPC 通路、内置形象加载，7 秒后自动退出
DESKPET_SMOKE=1 DESKPET_USER_DATA=/tmp/deskpet-smoke \
  ./node_modules/electron/dist/electron.exe .

# 端到端：10 项流程校验（缩放、换形象、重命名、提醒、互动、Key 加密、行走、控制台无错误）
DESKPET_E2E=1 DESKPET_USER_DATA=/tmp/deskpet-e2e \
  ./node_modules/electron/dist/electron.exe .
```


## 接第三方中转站 / 聚合站

中转站 / 聚合站走的是 OpenAI 兼容协议，**平台必须选「自定义（OpenAI 兼容）」**：

| 字段 | 填什么 |
|---|---|
| 平台 | 自定义（OpenAI 兼容） |
| Base URL | `https://your-relay.example.com` —— 只填域名即可，程序自动补 `/v1` |
| 图像模型 | 按中转站文档填写 |
| 对话模型 | 按中转站文档填写 |
| API Key | `sk-...`（中转站签发的 Key） |

需要这四个端点可用：`/v1/models`（测试连接用）、`/v1/chat/completions`（对话）、
`/v1/images/generations`（生成）、`/v1/images/edits`（**按参考图生成，不支持就上传不了照片**）。

### 报错对照表

| 报错 | 真正原因 | 处理 |
|---|---|---|
| `The API key format is incorrect`（带 request id） | Key 与所选平台不是一家：把中转站的 `sk-` Key 填进了「火山方舟」 | 切到「自定义（OpenAI 兼容）」，填 Base URL |
| `404` / `接口地址不存在` | Base URL 缺 `/v1` | 只填域名（程序自动补）或填完整的 `.../v1` |
| `模型名不可用` | 模型名与平台清单不完全一致 | 用平台的 `/v1/models` 里的准确 id |
| `401` | Key 复制不全或已失效 | 重新复制；程序会自动去掉首尾空格、引号和 `Bearer ` 前缀 |

> 设置页底部会实时显示「当前平台 · 实际调用域名 · Key 尾号（是否加密）」，报错时先看这一行。
> 若 Key 与本机平台明显不匹配（如 `sk-` 填在方舟上），保存时就会直接提示，不会发出请求。

### 「测试连接」现在测什么（v0.1.3）

不再只是发一句「你好」，而是分三步、按需执行：

1. **免费校验地址 + Key**：调 `GET /v1/models`，拿到模型清单
2. **核对图像模型**：清单里有你填的图像模型 → 打 ✓；没有 → 明确警告名字不对
3. **对话模型**：填了才真发一句话验证；没填不影响生成形象，只提示「AI 对话不可用」

所以**对话模型留空也能通过测试连接**，生成形象照常可用。

> 火山方舟注意：图像模型名要填它的 endpoint id 或模型名，形如 `doubao-seedream-4-0-250828`，
> 填 `Seedream` 这类显示名会得到 404。

### 已修复问题（v0.1.2）

| 现象 | 原因 | 状态 |
|---|---|---|
| 点「保存配置」后 Base URL 与模型输入框被清空，随后生成报 404「模型名不可用」 | 保存时先 `await setApiKey()` 触发状态广播 → 设置页重渲染 → 把还没读走的输入框值覆盖成空，于是空值被写进配置 | 已修：保存前先快照全部字段；表单有未保存改动时禁止状态广播覆盖输入 |
| 图像模型留空时仍发出请求，服务端回 404 | 缺少空值前置校验 | 已修：直接提示「还没有填写图像模型名」，不发请求 |
| 明明填了对话模型，「测试连接」却说「请先在设置中填写对话模型名」 | 测试连接读的是 `provider.chatModel`（这个字段不存在），而真实对话读 `settings.chatModel` | 已修：统一读 `settings.chatModel`，并兼容旧字段 |

> 这两处都有自动化回归保护：单测 `模型名为空时提前给出明确错误`、端到端 `保存配置：状态广播不会清空已填的 URL / 模型`。


## v0.2.0 动作与交互

### 动作库（28 个，纯参数化生成，不需要逐帧美术）

| 类型 | 动作 |
|---|---|
| 循环 | idle 呼吸 · walk 走 · run 跑 · play 自娱 · sleep 打盹 |
| 位移/跳跃 | hop 单跳 · hopTwice 双跳 · jumpSpin 跳起转身 · float 悬浮 |
| 旋转 | spin 原地转圈 · flip 转身 · tilt 歪头 |
| 头部微动作 | nod 点头 · shakeHead 摇头 |
| 伸展 | stretch 伸懒腰 · squat 蹲下 · yawn 打哈欠 |
| 情绪 | angry 生气（泛红+抖） · shy 害羞（泛粉） · sad 失落 · surprise 惊喜 · sneeze 打喷嚏 · pulse 心跳 |
| 组合 | dance 跳舞（音符特效） · lieDown 躺下 · wake 起身 · faint 晕倒 · peek 探头 |

- 待机时每 6–15 秒随机挑一个小动作，不再是单调呼吸
- 动作带地面影子联动（跳起时影子缩小变淡）、落地挤压回弹、情绪染色
- 朝向跟随、鼠标在窗口内时会轻微朝你倾斜

### 交互修正

- **碰撞箱**：命中判定由「单像素」改为「15×15 邻域取最大 alpha」，等于把可点范围外扩约 7px，抠图留洞与细脖子都能点到；采样频率 70ms → 45ms
- **右键菜单**新增「退出桌宠」（红色危险项）
- **对话框**：新增 × 关闭按钮，Esc 与点击空白处也能关

### 新手引导（首装先配接口）

步骤：**1 接口配置** → 2 上传照片 → 3 裁剪画风 → 4 生成 → 5 命名。
第 1 步填完才能往下走，避免"先上传照片，生成时才发现没 Key"。

### 主动互动开关

设置 →「通用」→「主动来找我互动」：关闭后不再主动讨陪伴/闹脾气，只保留自我娱乐动作与你自己设的提醒。

### 动画能力的边界（说清楚，不糊弄）

当前是**单张主图 + 参数化变换**，能做出呼吸、跳跃、旋转、挤压、染色、位移等整体动作，
但做不到抬手臂、摆手、踢腿这类**四肢独立运动**——那需要把角色拆成头/躯干/四肢的骨骼图层。

要真正接近「天选姬」那种动作量，两条路：
1. **Live2D / 分层素材**：让图像模型按固定姿势生成分层部件，再上骨骼绑定（效果最好，工作量大）
2. **多帧序列**：为每个动作生成 6–12 帧精灵图（可接图像模型批量出图，包体变大）

现在这版先把「动作数量与变化」从 5 个拉到 28 个，并让待机行为不再呆板。


## v0.2.1 随身道具 + 菜单关闭

### 随身道具（贴图）

设置 →「形象与外观」→「随身道具」：

- **6 个内置道具**开箱可用：水杯、咖啡、书、麦克风、爱心、星星
- 点一下携带，再点取下；不同道具挂在不同位置（手边 / 头顶 / 身侧漂浮）
- **道具会跟随身体动作**：跳跃、转圈、歪头时一起动，转身时自动镜像

### 用 AI 生成新道具

输入一句描述（如「一杯珍珠奶茶」「一把小雨伞」）点生成：

1. 调当前平台的图像模型，提示词要求「单个物品、Q 版贴纸、纯白背景、无人物无手无文字」
2. 生成后自动抠白底 + 裁边（复用形象那套算法）
3. 存入 `%APPDATA%/deskpet/props/`，写进索引并自动戴上
4. 自定义道具右上角有 × 可删除；内置道具不可删

### 右键菜单点击桌面自动关闭

- **根因**：桌宠平时处于「点击穿透」状态，点桌面时点击事件根本不会送到本窗口，`mousedown` 收不到。
- **做法**：菜单打开时主进程启动 150ms 轮询，用 `screen.getCursorScreenPoint()` 判断光标是否还在窗口矩形内；连续两次检测到在窗口外就通知渲染层关闭菜单。另有窗口 `blur` 与 `mouseleave` 兜底，菜单打开期间强制关闭穿透（否则菜单本身点不到）。


## 数据存放

`%APPDATA%\deskpet\`

- `state.json` —— 设置、驱动值、统计（API Key 用系统 `safeStorage` 加密）
- `characters/<id>/sprite.png` —— 生成的形象

> 想彻底卸载：退出程序后删除 `%APPDATA%\deskpet` 与 exe 所在文件夹。

## 常见问题

**Q：点「测试连接」报「模型名不可用」／404？**
模型名要和平台模型列表**完全一致**。火山方舟要填 endpoint id 或模型名（如 `doubao-seedream-4-0-250828`），填空想名 `Seedream` 一定 404。

**Q：填了对话模型，却说「请先在设置中填写对话模型名」？**
v0.1.3 已修（测试连接读错字段）。升级到最新版即可。

**Q：脖子下面点不到？**
v0.2.0 已修：命中判定由单像素改为 15×15 邻域取最大 alpha，可点范围外扩约 7px。

**Q：双击 exe 没反应？**
便携版要先解包 87MB 到临时目录，30–40 秒后才出现进程。等它，别重复双击。

**Q：右键菜单点了桌面不消失？**
v0.2.1 已修：主进程在菜单打开时轮询光标位置，离开窗口即关闭。

**Q：我的 API Key 存哪儿？**
用 Electron `safeStorage` 加密后存在 `%APPDATA%\deskpet\state.json`，**不出本机**，也不会进仓库。

## 已知限制

- 动作是单图参数化变换，做不了四肢独立运动（无抬手、踢腿）
- 仅支持 Windows 11 x64，未做代码签名
- 图像生成依赖你自己的 API Key 与额度，本项目不自带任何密钥

