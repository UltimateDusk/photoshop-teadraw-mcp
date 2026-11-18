# 和 AI 一起茶绘 / TeaDraw MCP

TeaDraw MCP 是一个面向回合式共同绘画的 Photoshop MCP 参考实现。它让聊天中的 AI 能够等待用户在 Photoshop 里的下一次画布变化、只读取发生变化的局部预览，并在明确的文档和图层上继续绘画。

它的目标不是远程自动修图，而是形成类似“茶绘 / 双人画板”的节奏：

1. 用户在 Photoshop 里画一小段。
2. AI 通过长轮询收到新的 revision 和近似 dirty bounds。
3. AI 获取局部预览，在自己的图层或组里接着画。
4. 双方重复这个回合。

> 当前版本：`0.3.0` · 49 个白名单工具 · Windows + Photoshop Desktop

## 能做什么

- 画布变化长轮询：`photoshop_wait_for_canvas_change`
- 单调 revision 和 `expected_revision` 冲突保护
- 全画布及局部预览
- 文档列表、切换和显式关闭
- PSD 保存、PSD/PNG/JPG 另存、PNG/JPG 导出
- 创建、编辑和定位文字图层
- 经过像素验证的画笔与橡皮
- opacity、flow、spacing、smoothing、roundness 和逐点 pressure
- 图层创建、删除、变换、分组和移入组
- 选区、填色、渐变、Undo/Redo
- resize canvas、resize image、crop 和 rotate canvas
- 轻量 collaboration session

完整工具分组见 [docs/TOOLS.md](docs/TOOLS.md)，系统结构见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 安全边界

TeaDraw MCP 刻意限制了远程能力：

- 所有编辑必须携带明确的正数 `document_id`。
- 可选的 `expected_revision` 会拒绝基于旧画面的写入。
- 不向云端暴露任意 JSX/ExtendScript 执行接口。
- 不提供远程打开任意本机文件的接口。
- 保存和导出必须使用绝对路径，并强制提供 `overwrite`。
- 不会静默覆盖已有文件。
- 写入工具尽可能检查像素、bounds、parent、文档尺寸或最终文件。
- 设备凭据使用当前 Windows 用户的 DPAPI 加密。
- 云端只保存短期任务、心跳和结果；预览读取后删除。

## 仓库结构

```text
photoshop-teadraw-mcp/
├── cloud/                 # Owner-private MCP relay / Sites Worker
│   ├── worker/            # MCP tool schemas and job relay
│   ├── scripts/           # Deterministic build and validation
│   └── .openai/           # Hosting template; real project ID is ignored
├── device/                # Windows bridge and revision engine
│   ├── bridge.cjs
│   ├── collab-runtime.cjs
│   ├── setup-device-credential.ps1
│   └── integration-smoke.cjs
└── docs/
```

## 前置条件

- Windows 10/11
- Adobe Photoshop Desktop
- Node.js 18 或更高版本
- 可通过 `npx` 启动的 `@alisaitteke/photoshop-mcp@1.7.38`
- 一个部署了 `cloud/` 的私有 MCP 服务
- 该服务为设备签发的 bearer credential

本仓库不会包含任何可直接使用的 Site ID、服务 URL、用户令牌或第三方 API Key。云端部署和设备授权依赖你的宿主环境；源码默认以 owner-private 的 OpenAI Sites relay 为目标。

## 云端准备

1. 复制 hosting 模板：

   ```powershell
   Copy-Item .\cloud\.openai\hosting.example.json .\cloud\.openai\hosting.json
   ```

2. 把 `project_id` 替换为你自己的 Sites 项目 ID，并为 `BUCKET` 配置 R2 存储绑定。
3. 构建和验证：

   ```powershell
   Set-Location .\cloud
   node --test worker.test.mjs
   npm.cmd run build
   npm.cmd run validate
   ```

4. 通过你的 Sites source/deployment workflow 发布 `dist/`。不要把真实 `hosting.json` 提交到 Git。

## Windows 设备桥接

在 `device/` 目录中，用交互式脚本创建当前 Windows 用户专用的 DPAPI 凭据：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\setup-device-credential.ps1 `
  -ServiceUrl "https://your-private-service.example"
```

脚本会以安全输入方式询问 bearer token，不会把 token 放进命令行参数。随后运行：

```powershell
.\start.cmd
```

停止连接：

```powershell
.\stop.cmd
```

运行时生成的凭据、PID、日志和 revision 状态均已加入 `.gitignore`。

## 测试

纯逻辑和云端测试：

```powershell
node --test .\device\collab-runtime.test.cjs
Set-Location .\cloud
node --test worker.test.mjs
npm.cmd run build
npm.cmd run validate
```

真实 Photoshop 冒烟测试会新建临时文档、执行像素写入、保存和导出，再关闭临时文档并清理测试文件：

```powershell
node --use-env-proxy .\device\integration-smoke.cjs
```

运行真实测试前，请先保存自己的工作，并确认 Photoshop 没有模态对话框。

## revision 模型

revision 由设备侧维护并持久化。一次采样综合比较 history、合成直方图、文档尺寸、图层顺序、图层 ID、名称、可见性、opacity、blend mode、bounds 和文字内容指纹。

同一采样间隔内的多次修改可能合并为一个 revision；这适合回合式共同绘画，但不是毫秒级多人同步。`dirty_bounds` 是可靠的近似区域，不保证等于 Photoshop 内部的精确 dirty rectangle。

## 已知限制

- 当前笔刷使用受约束的 selection-raster engine，不是完整 Photoshop 原生 brush preset engine。
- 请求 `use_current_brush_preset` 时会明确返回 fallback，不会假报已使用 preset。
- 长轮询期间目标文档必须保持为活动标签；桥接不会每秒强行抢回标签页。
- 多个修改发生在一次采样间隔内时会被合并。
- 尚未提供 duplicate group、merge selected layers 和 rasterize layer 这三个可选工具。

## 上游依赖

本项目通过 npm 使用 [`@alisaitteke/photoshop-mcp`](https://www.npmjs.com/package/@alisaitteke/photoshop-mcp) 作为本地 Photoshop MCP 基础服务。TeaDraw MCP 的云端 relay、协作 revision、局部预览、安全文件操作和共同绘画工具层位于本仓库中。

本项目与 Adobe 或 OpenAI 均无官方隶属关系。Photoshop 是 Adobe 的商标。
