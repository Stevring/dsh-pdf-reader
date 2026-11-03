# PDF 阅读（DSH Web 插件）

在右侧边栏打开 PDF，选中文字后引用到输入框。打开时插件把每页正文、图索引和 PDF 原件登记给 Host，并在 agent 的 runtime context 里标明「当前打开的是哪本 PDF」；agent 通过 `pdf_read` / `pdf_toc` / `pdf_figures` 读正文、目录和图片，不需要你在 quote 里写文档信息。

浏览器文件选择器不会给出磁盘路径，插件也不需要：正文和图索引在浏览器里生成，PDF 原件也由浏览器上传，都走鉴权的 `/api` 通道。

## 入口

- **输入框左侧的书本按钮**：在右侧边栏打开「PDF 阅读」标签页。
- **右侧边栏的指南页**：指南卡片里的「PDF 阅读」。

## 使用

1. 点「选择 PDF 文件」，或把 PDF 拖进侧边栏。
2. 页面按侧边栏宽度自适应，滚动时逐页懒渲染；后台同时提取每页正文、识别图注、上传 PDF 原件（标题栏显示「索引中」，失败显示「索引失败」/「图片不可用」）。
3. 选中文字，点浮出的「引用第 N 页」，原文进入输入框。
4. 直接问也行：agent 从 runtime context 知道哪本 PDF 打开着，会自己调工具读需要的页。

### 再次打开同一份文件

浏览器对文件字节算 MD5，先调 `POST api/pdf-reader/lookup`：

- **命中**：复用原来的 doc id，跳过文本/图索引和 PDF 上传，只把该文档标记为当前 Session 打开。
- **未命中**：正常全量索引；`register` 带上 hash，Host 按 hash 复用行（重索引时保留已上传的 PDF）。

同一文件不会重复上传，也不会在 store 里产生第二份。`indexVersion` 变了（索引逻辑升级）会强制重索引，但 id 和 PDF 原件保留。

> `crypto.subtle` 要求安全上下文，而页面是 `http://192.168.x.x:3080`，所以 MD5 用内置的纯 JS 实现（`hash.js`），只用于文件身份识别，不用于安全。

### 引用格式

```
> [PDF] how-to-take-smart-notes.pdf · p.42
> The slip-box is not a storage system but a thinking tool.
```

只有文件名和页码，没有文档 id——id 由上下文提供。

### 上下文

每个打开的 PDF 会出现在该 Session 的 runtime context 里：

```
The user has the following PDF open in the PDF reader:
- "how-to-take-smart-notes.pdf" (doc:1a2b3c4d, 312 pages)
Use pdf_read to read pages and pdf_toc for the table of contents.
```

- 按 Session 隔离：只有打开它的会话能看到。
- 每次请求重新计算：换一本或关掉阅读标签页后，下一次请求里就没有它（DSH 会把 runtime context 更新成空快照，不需要插件手写 session 事件）。
- 关闭时机：阅读标签页卸载、换文件、或页面 `pagehide`（关窗/刷新）时通知 Host。

### 图与图片

打开时同时建立图索引。PDF 没有标准的「图 ID + 标题」字段，所以分两条路：

- **Tagged PDF**（带结构树）：读 `/Figure` 元素的 `/Alt` 和 `/BBox`，得到精确位置，`source: "tagged"`。
- **普通 PDF**：用图注行合成，例如 `Figure 3.2: ...`、`Fig. 3`、`Table 2.1`、`图 3.2`，`source: "caption"`。

```text
- fig-3.2 — Overall encoder block architecture (p.42, tagged)
- tab-2.1 — Test conditions (p.87, caption)
```

坐标存成归一化的视口矩形（0–1，左上角原点），浏览器已经处理了页面旋转；Host 按它裁剪渲染出的页面。`source` 是 `caption` 时没有 bbox，`image: true` 返回整页。

取图链路：`pdf_figures` 列图 → `pdf_read({ figure: "fig-3.2", image: true })` → Host 用 PyMuPDF 渲染该页 → 按 bbox 裁剪 → 存成 image attachment → 以 `image` block 返回。需要当前模型声明支持图片输入，否则工具只回文字并说明原因。

## Agent 工具

### `pdf_read`

读取已打开 PDF 的正文。

| 参数 | 说明 |
|---|---|
| `document` | 必填。runtime context 里的 doc id，或文件名 |
| `pages` | 可选。`"12"`、`"12-18"`、`"3,7,12-14"` |
| `query` | 可选。大小写不敏感短语，返回命中的页和片段 |
| `figure` | 可选。`pdf_figures` 返回的 id，如 `"fig-3.2"`；读取该图的标题和所在页正文 |
| `image` | 可选。配合 `figure` 或单个 `pages`，返回渲染后的图片 |
| `maxChars` | 可选。返回上限，默认 12000，最大 40000 |

不传 `pages`、`query`、`figure` 时返回元数据、目录和第一页。单次最多返回 40 页，超出会提示分批读取。

### `pdf_figures`

列出图索引：`id`、标题（图注或 `/Alt`）、页码、定位来源（`tagged` 精确 / `caption` 近似）。没有图的 PDF 明确说明。

### `pdf_toc`

读取目录（PDF outline），每行是章节标题和页码，按层级缩进。没有 outline 的 PDF 会明确说明，并建议改用 `pdf_read` 的页范围。

三个工具都接受 id（含前缀）或文件名；同名多份文档时返回候选 id。找不到时列出已登记的文档。**关掉阅读标签页后文档仍在 store 里**，按文件名仍可读取，只是不再出现在 runtime context 中。

## 实现

- **Client 半**（`src/client/`）：React 渲染标签页与目录面板；PDF.js 负责渲染、text layer 和 `getTextContent()` 文本提取；引用走 `inputActions.insertQuote()`。
- **上传**：`POST api/pdf-reader/register`（`{ sessionId, hash, name, pages, outline, figures }`）、`POST api/pdf-reader/binary?id=<docId>`（原始 PDF 字节，流式）、`POST api/pdf-reader/lookup`（`{ hash, sessionId }`）、`POST api/pdf-reader/close`，都走 `ctx.connection.fetch` 的鉴权 `/api` 通道（`credentials: 'include'`）。
- **Host 半**（`index.js`）：收下正文和图索引存到 `~/.dsh/pdf-reader/documents/`（`index.json` 元数据 + `<id>.json` 每页文本 + `<id>.pdf` 原件），维护「每个 Session 当前打开哪些文档」，并注册一个全局 `systemPrompt.context`：provider 从 assembly 的 `context.agent` 取 Session id，按请求实时渲染，因此不需要给每个 Agent 单独注册。
- 存储上限：单文档 5000 页 / 24 MB 文本；保留最近 40 份、60 天（按最后写入/复用时间），写入时自动清理。
- 工具直接读 store，不依赖浏览器在线。

## 构建

仓库已带构建产物 `lib/client.js`，只有改 `src/client/` 时才需要重新构建。Host 半（`index.js`）是纯 Node ESM，不需要构建。

```bash
DSH_CHECKOUT=/path/to/deepseek-harness node build.mjs
```

`build.mjs` 从 DSH checkout 取 esbuild 与 `pdfjs-dist`（本包没有自己的 `node_modules`）。不设 `DSH_CHECKOUT` 时默认找本仓库同级的 `../deepseek-harness`。

产物是 CJS 形式包在 `window.__ModuleLoader__.load({ id, factory })` 里：`react` / `react-dom` / `react/jsx-runtime` 走页面模块表，其余（含 PDF.js 主包与 worker 源码）内联。

Client 改动走 bundle 的 `rebuilt` 热替换；Host 半改动由 HMR 的模块比对在下次 reconcile 时重载（可用 `plugin_manager` 禁用/启用 `include:pdf-reader` 触发，无需重启进程）。

## 安装

1. 克隆本仓库，确认 `lib/client.js` 存在。
2. 把本目录装进 DSH profile（下面以 `web` 为例）：
   - 用 `plugin_manager` 工具的 `install_bundle`，spec 指向本目录；或
   - 在 profile 的 `package.json` 里加 `"@local/pdf-reader": "link:/path/to/dsh-pdf-reader"`，并在 `dsh.profile.bundles` 里选中 `@local/pdf-reader`。
3. 重载 DSH（重启进程，或在插件列表里禁用/启用一次）。

`cordis.patch.yml` 会插入 `pdf-reader` 行，不需要手改 composition。插件没有配置项。

## 要求

- DSH Web（client platform 为 `web`）。
- 文本、目录、图索引只依赖 Node。
- 取图需要 Host 上的 `python3` + PyMuPDF + Pillow。

## 依赖检查

```bash
python3 -c "import fitz, PIL; print('ok')"
```

缺失时 `pip install pymupdf pillow`。不装也能用，只是 `image: true` 会返回失败原因。

## 限制

- 正文只有文本；双栏排版顺序可能交错。图片按页渲染，不做 OCR。
- 图注识别是启发式的：没有图注的图（示意图、照片）不会进入图索引；矢量图没有 `/Figure` 时也只能按图注定位。
- 取图依赖 Host 上的 `python3` + PyMuPDF（`fitz`）+ Pillow；缺失时工具返回文字并说明渲染失败原因。
- 模型必须声明支持图片输入，否则 `image: true` 只回文字。
- 加密 PDF 不支持（未做密码输入）。
- 扫描版 PDF 没有文本层，提取结果为空。
- 索引是打开时一次性提取的。
- 超过 5000 页或 24 MB 文本的文档会被拒收，引用里只有文件名。
- 页面崩溃（不是正常关闭）时 Host 里的「打开」状态会残留到进程重启；工具仍能读，只是上下文会多一条。
- 没有内联 PDF.js 的 cMap / standard fonts 资源，少数非嵌入字体的 PDF 排版会有偏差（不影响文本提取）。
- 图索引上限 500 条/文档；PDF 原件上限 200 MB，超出后仍可读文本，但不能取图。
- MD5 只用于判断「是不是同一份文件」；理论上可碰撞，实际使用不受影响。
