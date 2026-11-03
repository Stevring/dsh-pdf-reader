/**
 * Host half of the PDF reader.
 *
 * The browser owns the PDF bytes — a file picker never reveals a path — so the
 * reader uploads the text it extracts when the PDF is opened. This half stores
 * that text (one document per open) and serves it back to the agent through the
 * `pdf_read` tool, which the user's quotes address by document id.
 *
 * The upload arrives on the authenticated `/api` channel, so only a connected,
 * authorized page can register a document.
 */
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'

/** Services this plugin consumes. */
export const inject = ['tools', 'connection', 'systemPrompt']

/** Authenticated upload route (absolute path below `/api`). */
const ROUTE = '/api/pdf-reader/register'
/** Authenticated close route: the reader tab ended. */
const CLOSE_ROUTE = '/api/pdf-reader/close'
/** Authenticated route receiving the PDF bytes themselves. */
const BINARY_ROUTE = '/api/pdf-reader/binary'
/** Authenticated route checking whether one file was indexed before. */
const LOOKUP_ROUTE = '/api/pdf-reader/lookup'
/** Runtime-context position, after the operating facts and before deployment paths. */
const CONTEXT_ORDER = 150
/** Store below the harness home. */
const STORE_SEGMENT = 'pdf-reader/documents'
/** Index file listing every stored document. */
const INDEX_FILE = 'index.json'
/** Largest accepted page count for one document. */
const MAX_PAGES = 5000
/** Largest accepted extracted text for one document. */
const MAX_TEXT_BYTES = 24 * 1024 * 1024
/** Documents kept on disk; older ones are pruned on write. */
const MAX_DOCUMENTS = 40
/** Age after which a document is pruned. */
const MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000
/** Characters returned when the caller names no limit. */
const DEFAULT_MAX_CHARS = 12000
/** Hard characters returned for one call. */
const HARD_MAX_CHARS = 40000
/** Pages returned for one call. */
const MAX_PAGES_PER_CALL = 40
/** Matching pages returned by one search. */
const MAX_SEARCH_HITS = 8
/** Outline rows stored for one document. */
const MAX_OUTLINE_ROWS = 200
/** Figure rows stored for one document. */
const MAX_FIGURES = 500
/** Largest PDF accepted for figure rendering. */
const MAX_PDF_BYTES = 200 * 1024 * 1024
/** Rasterization density for one figure request. */
const RENDER_DPI = 180
/** Longest side of a returned figure image. */
const MAX_IMAGE_SIDE = 2400
/** Extraction layout version; bump when pages, outline, or figures change shape. */
const INDEX_VERSION = 2

/**
 * Register the upload route and the `pdf_read` tool.
 * @param ctx - host plugin context.
 */
export function apply(ctx) {
  const home = ctx.get('profileContext')?.home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const store = createStore(join(home, STORE_SEGMENT))
  // Which documents each live Session currently has open in the reader.
  const sessions = new Map()
  ctx.effect(() => ctx.connection.fetch.register({
    path: ROUTE,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: request => registerDocument(store, sessions, request),
  }), 'pdf-reader: register route')
  ctx.effect(() => ctx.connection.fetch.register({
    path: CLOSE_ROUTE,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: request => closeDocument(sessions, request),
  }), 'pdf-reader: close route')
  ctx.effect(() => ctx.connection.fetch.register({
    path: BINARY_ROUTE,
    methods: ['POST'],
    requestBody: 'streaming',
    fetch: request => storePdf(store, request),
  }), 'pdf-reader: binary route')
  ctx.effect(() => ctx.connection.fetch.register({
    path: LOOKUP_ROUTE,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: request => lookupDocument(store, sessions, request),
  }), 'pdf-reader: lookup route')
  ctx.effect(() => ctx.tools.register(readTool(store, ctx)), 'pdf-reader: read tool')
  ctx.effect(() => ctx.tools.register(tocTool(store)), 'pdf-reader: toc tool')
  ctx.effect(() => ctx.tools.register(figuresTool(store)), 'pdf-reader: figures tool')
  // The provider is global; `context.agent` names the Session the assembly is for,
  // so the list is recomputed per request and needs no per-agent bookkeeping.
  ctx.effect(() => ctx.systemPrompt.context({
    name: 'pdf-reader:open-documents',
    order: CONTEXT_ORDER,
    text: (context) => {
      const agent = context.agent
      return agent === undefined ? '' : openContext(sessions, agent.session.id)
    },
  }), 'pdf-reader: open documents context')
  void store.prune().catch((error) => { ctx.logger.warn(error) })
}

/**
 * Accept one document's extracted text.
 * @param store - document store.
 * @param request - authenticated request carrying `{ name, pages, outline? }`.
 * @returns `{ id }` on success, `{ error }` with a 4xx status otherwise.
 */
async function registerDocument(store, sessions, request) {
  let body
  try {
    body = await request.json()
  } catch {
    return jsonResponse(400, { error: 'body must be JSON' })
  }
  const name = typeof body?.name === 'string' ? body.name.trim() : ''
  if (name === '' || name.length > 512) {
    return jsonResponse(400, { error: 'name is required and must be at most 512 characters' })
  }
  if (!Array.isArray(body?.pages) || body.pages.length === 0) {
    return jsonResponse(400, { error: 'pages must be a non-empty array' })
  }
  if (body.pages.length > MAX_PAGES) {
    return jsonResponse(413, { error: `document holds more than ${MAX_PAGES} pages` })
  }
  const pages = body.pages.map(page => (typeof page === 'string' ? page : ''))
  const bytes = Buffer.byteLength(JSON.stringify(pages), 'utf8')
  if (bytes > MAX_TEXT_BYTES) {
    return jsonResponse(413, { error: `extracted text is ${bytes} bytes; the cap is ${MAX_TEXT_BYTES}` })
  }
  try {
    const id = await store.save({
      name,
      pages,
      outline: normalizeOutline(body?.outline),
      figures: normalizeFigures(body?.figures),
      hash: normalizeHash(body?.hash),
    })
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
    if (sessionId !== '') {
      const open = sessions.get(sessionId) ?? new Map()
      open.set(id, { id, name, pageCount: pages.length })
      sessions.set(sessionId, open)
    }
    return jsonResponse(200, { id, pages: pages.length, hasPdf: existsSync(store.pdfPath(id)) })
  } catch (error) {
    return jsonResponse(500, { error: error instanceof Error ? error.message : String(error) })
  }
}

/**
 * Answer whether one file content was indexed before, so a re-open can skip
 * extraction and upload.
 *
 * A hit also marks the document open for the calling Session: the reader tab is
 * showing it, so the runtime context must list it exactly like a fresh open.
 * @param store - document store.
 * @param sessions - per-Session open documents.
 * @param request - authenticated request carrying `{ hash, sessionId }`.
 * @returns the reused row, or `{ miss: true }`.
 */
async function lookupDocument(store, sessions, request) {
  let body
  try {
    body = await request.json()
  } catch {
    return jsonResponse(400, { error: 'body must be JSON' })
  }
  const hash = normalizeHash(body?.hash)
  if (hash === undefined) return jsonResponse(400, { error: 'hash must be 32 lowercase hex characters' })
  const rows = await store.rows()
  const row = rows.find(entry => entry.hash === hash && entry.indexVersion === INDEX_VERSION)
  if (row === undefined) return jsonResponse(200, { miss: true })
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
  if (sessionId !== '') {
    const open = sessions.get(sessionId) ?? new Map()
    open.set(row.id, { id: row.id, name: row.name, pageCount: row.pageCount })
    sessions.set(sessionId, open)
  }
  return jsonResponse(200, {
    id: row.id,
    name: row.name,
    pageCount: row.pageCount,
    figures: Array.isArray(row.figures) ? row.figures.length : 0,
    needsPdf: !existsSync(store.pdfPath(row.id)),
  })
}

/** One lowercase 32-character content hash, or undefined when malformed. */
function normalizeHash(value) {
  if (typeof value !== 'string') return undefined
  const hash = value.trim().toLowerCase()
  return /^[0-9a-f]{32}$/u.test(hash) ? hash : undefined
}

/**
 * Receive the PDF bytes themselves for figure rendering.
 *
 * Streams to `<id>.pdf.part` and renames only after the whole body arrived, so a
 * failed upload never leaves a truncated PDF that the renderer would trust.
 * @param store - document store.
 * @param request - authenticated streaming request with `?id=<docId>`.
 * @returns success with the stored byte count, or a JSON error.
 */
async function storePdf(store, request) {
  const id = new URL(request.url).searchParams.get('id') ?? ''
  if (!/^[0-9a-f]{8,32}$/u.test(id)) return jsonResponse(400, { error: 'id is required' })
  if (!(await store.has(id))) return jsonResponse(404, { error: 'unknown document id' })
  const body = request.body
  if (body === null) return jsonResponse(400, { error: 'missing PDF body' })
  const target = store.pdfPath(id)
  const partial = `${target}.part`
  let bytes = 0
  let tooLarge = false
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length
      if (bytes > MAX_PDF_BYTES) {
        tooLarge = true
        callback(new Error('PDF is too large'))
        return
      }
      callback(null, chunk)
    },
  })
  try {
    await mkdir(store.directory(), { recursive: true })
    await pipeline(Readable.fromWeb(body), counter, createWriteStream(partial, { mode: 0o600 }))
    await rename(partial, target)
    return jsonResponse(200, { ok: true, bytes })
  } catch (error) {
    await rm(partial, { force: true })
    return jsonResponse(tooLarge ? 413 : 500, {
      error: tooLarge
        ? `PDF exceeds ${MAX_PDF_BYTES} bytes`
        : error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * Validate figure rows uploaded with a document.
 * @param value - raw `figures` payload.
 * @returns at most {@link MAX_FIGURES} rows in the stored shape.
 */
function normalizeFigures(value) {
  if (!Array.isArray(value)) return []
  const rows = []
  for (const entry of value.slice(0, MAX_FIGURES)) {
    if (entry === null || typeof entry !== 'object') continue
    const id = typeof entry.id === 'string' ? entry.id.trim().slice(0, 80) : ''
    const page = typeof entry.page === 'number' && Number.isFinite(entry.page) ? Math.floor(entry.page) : 0
    if (id === '' || page < 1) continue
    const bbox = normalizeBbox(entry.bbox)
    rows.push({
      id,
      label: typeof entry.label === 'string' ? entry.label.trim().slice(0, 120) : id,
      title: typeof entry.title === 'string' ? entry.title.trim().slice(0, 400) : '',
      page,
      source: entry.source === 'tagged' ? 'tagged' : 'caption',
      ...(bbox === null ? {} : { bbox }),
    })
  }
  return rows
}

/** One normalized figure box, or null when it is missing or degenerate. */
function normalizeBbox(value) {
  if (value === null || typeof value !== 'object') return null
  const numbers = ['x', 'y', 'w', 'h'].map(key => value[key])
  if (!numbers.every(number => typeof number === 'number' && Number.isFinite(number))) return null
  const [x, y, w, h] = numbers.map(number => Math.min(Math.max(number, 0), 1))
  if (w < 0.02 || h < 0.02) return null
  return { x, y, w, h }
}

/**
 * Forget one document the reader tab no longer shows.
 * @param sessions - per-Session open documents.
 * @param request - authenticated request carrying `{ sessionId, id }`.
 * @returns an empty success even when the entry was already gone.
 */
async function closeDocument(sessions, request) {
  let body
  try {
    body = await request.json()
  } catch {
    return jsonResponse(400, { error: 'body must be JSON' })
  }
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
  const id = typeof body?.id === 'string' ? body.id : ''
  if (sessionId === '' || id === '') return jsonResponse(400, { error: 'sessionId and id are required' })
  const open = sessions.get(sessionId)
  if (open !== undefined) {
    open.delete(id)
    if (open.size === 0) sessions.delete(sessionId)
  }
  return jsonResponse(200, { ok: true })
}

/**
 * Render the runtime context for one Session.
 * @param sessions - per-Session open documents.
 * @param sessionId - Session whose request is being assembled.
 * @returns the model-facing context, or an empty string when nothing is open.
 */
function openContext(sessions, sessionId) {
  const open = sessions.get(sessionId)
  if (open === undefined || open.size === 0) return ''
  const lines = [...open.values()].map(entry => `- "${entry.name}" (doc:${entry.id}, ${entry.pageCount} pages)`)
  return [
    'The user has the following PDF open in the PDF reader:',
    ...lines,
    'Use pdf_read to read pages and pdf_toc for the table of contents.',
    'For diagrams, pdf_figures lists figure ids such as "fig-3.2"; pdf_read with',
    'image: true renders a figure or a single page.',
    'Quotes from this reader may carry only the file name and page number.',
  ].join('\n')
}

/**
 * Build the model-facing tool over one store.
 * @param store - document store.
 * @returns the tool definition handed to `ctx.tools.register`.
 */
function readTool(store, ctx) {
  return {
    name: 'pdf_read',
    description: [
      'Read the text of a PDF the user opened in the PDF reader.',
      'The runtime context lists the open PDFs with their document ids: pass that id',
      '(or the file name) as `document`.',
      'Use `pages` for one page or a range ("12", "12-18", "3,7,12-14"),',
      '`query` to find pages containing a phrase, or neither to get the metadata,',
      'outline, and the first page. `pdf_toc` lists the outline.',
      '`pdf_figures` lists figure ids such as "fig-3.2"; pass one as `figure` to read',
      'its caption and page, and add `image: true` to see the figure.',
      '`image: true` with exactly one page in `pages` renders that page.',
      'The text was extracted in the browser when the PDF was opened, so layout is',
      'not available; only figure and page images can be rendered.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        document: {
          type: 'string',
          description: 'Document id from the runtime context, or the PDF file name.',
        },
        pages: {
          type: 'string',
          description: 'Page or page range, e.g. "12", "12-18", or "3,7,12-14". Omit when using query.',
        },
        query: {
          type: 'string',
          description: 'Case-insensitive phrase to search for; returns matching pages with snippets.',
        },
        figure: {
          type: 'string',
          description: 'Figure id from pdf_figures, e.g. "fig-3.2"; reads its caption and page instead of page ranges.',
        },
        image: {
          type: 'boolean',
          description: 'With `figure` or exactly one page, render the figure or page and return it as an image.',
        },
        maxChars: {
          type: 'integer',
          description: `Maximum characters to return (default ${DEFAULT_MAX_CHARS}, max ${HARD_MAX_CHARS}).`,
        },
      },
      required: ['document'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          image: {
            type: 'object',
            properties: {
              attachmentId: { type: 'string' },
              mediaType: { type: 'string' },
            },
            required: ['attachmentId', 'mediaType'],
          },
        },
        required: ['text'],
      },
      render: (_args, value) => value.image === undefined
        ? [{ type: 'text', text: value.text }]
        : [{ type: 'text', text: value.text }, { type: 'image', attachment: value.image }],
    },
    async execute(args, exec) {
      const requested = typeof args?.document === 'string' ? args.document.trim() : ''
      if (requested === '') throw new Error('document is required')
      const rows = await store.rows()
      const found = resolveDocument(rows, requested)
      if (found.row === undefined) {
        if (found.ambiguous !== undefined) {
          return { text: `Several PDFs match "${requested}". Use one of these ids:\n${listDocuments(found.ambiguous)}` }
        }
        return { text: unknownDocument(requested, rows) }
      }
      const row = found.row
      const pages = await store.pages(row.id)
      if (pages === undefined) {
        return { text: `The stored text for "${row.name}" is missing. Ask the user to reopen that PDF in the reader.` }
      }
      const header = `[${row.name} · ${row.pageCount} pages · doc:${row.id}]`
      const maxChars = clampChars(args?.maxChars)
      const figureArg = typeof args?.figure === 'string' ? args.figure.trim() : ''
      if (figureArg !== '') {
        return await readFigure(store, ctx, row, pages, figureArg, args?.image === true, maxChars, exec)
      }
      if (args?.image === true) {
        const page = singlePage(args?.pages)
        if (page === null) {
          return { text: 'image: true needs a figure id, or exactly one page in `pages` (e.g. "42").' }
        }
        if (page < 1 || page > pages.length) {
          return { text: `Page ${page} is outside 1-${pages.length} for "${row.name}".` }
        }
        const pageText = clip(pages[page - 1] ?? '', maxChars)
        const rendered = await renderDocumentImage(store, ctx, row, { label: `page ${page}`, page, bbox: null }, exec)
        return 'image' in rendered
          ? { text: pageText, image: rendered.image }
          : { text: `${pageText}\n\n[image unavailable: ${rendered.reason}]` }
      }
      if (typeof args?.query === 'string' && args.query.trim() !== '') {
        return { text: searchPages(header, pages, args.query.trim(), maxChars) }
      }
      if (typeof args?.pages === 'string' && args.pages.trim() !== '') {
        return { text: readPages(header, pages, args.pages.trim(), maxChars) }
      }
      return { text: documentSummary(header, row, pages, maxChars) }
    },
  }
}


/** Promisified `execFile` for the rasterizer. */
const execFileAsync = promisify(execFile)

/**
 * Rasterize one page with PyMuPDF and crop it to a normalized figure box.
 * Args: pdf, page, out, x0, y0, x1, y1, dpi, max_side.
 */
const RENDER_SCRIPT = String.raw`
import sys, io
from PIL import Image
import fitz

pdf, page_no, out = sys.argv[1], int(sys.argv[2]), sys.argv[3]
x0, y0, x1, y1 = (float(value) for value in sys.argv[4:8])
dpi, max_side = int(sys.argv[8]), int(sys.argv[9])
doc = fitz.open(pdf)
page = doc[page_no - 1]
pix = page.get_pixmap(dpi=dpi)
image = Image.open(io.BytesIO(pix.tobytes("png"))).convert("RGB")
width, height = image.size
if x1 > x0 and y1 > y0:
    pad = int(0.02 * max(width, height))
    image = image.crop((
        max(0, int(x0 * width) - pad),
        max(0, int(y0 * height) - pad),
        min(width, int(x1 * width) + pad),
        min(height, int(y1 * height) + pad),
    ))
if max(image.size) > max_side:
    image.thumbnail((max_side, max_side))
image.save(out)
`

/**
 * Explain why the calling model cannot receive an image, or return null.
 * @param ctx - host plugin context.
 * @param exec - tool execution carrying the calling agent and its signal.
 * @returns a reason string, or null when the route accepts image input.
 */
async function imageRouteRefusal(ctx, exec) {
  const routed = exec?.agent?.session.requestHeader()?.config
  const provider = routed?.provider ?? exec?.agent?.options?.provider
  const model = routed?.model ?? exec?.agent?.options?.model
  const llm = ctx.get('llm')
  if (provider === undefined || model === undefined || llm === undefined) {
    return 'the current model route could not be resolved'
  }
  const info = await llm.resolveModelInfo(provider, model, exec?.signal)
  if (!Array.isArray(info?.inputModalities) || !info.inputModalities.includes('image')) {
    return `model "${model}" does not accept image input; switch to an image-capable model`
  }
  return null
}

/**
 * Render one page (optionally cropped to a figure box) and store it as an image
 * attachment the tool result can carry.
 * @param store - document store holding `<id>.pdf`.
 * @param ctx - host plugin context.
 * @param row - index row of the document.
 * @param figure - `{ label, page, bbox? }`.
 * @param exec - tool execution.
 * @returns `{ image }` or `{ reason }`.
 */
async function renderDocumentImage(store, ctx, row, figure, exec) {
  const pdfPath = store.pdfPath(row.id)
  if (!existsSync(pdfPath)) {
    return { reason: 'the PDF bytes are not on the host; reopen the PDF so the reader uploads them' }
  }
  const attachments = ctx.get('attachments')
  if (attachments === undefined) return { reason: 'no attachment store is mounted' }
  const refusal = await imageRouteRefusal(ctx, exec)
  if (refusal !== null) return { reason: refusal }
  const directory = await mkdtemp(join(tmpdir(), 'pdf-reader-'))
  const output = join(directory, 'figure.png')
  try {
    const bbox = figure.bbox ?? null
    const x0 = bbox?.x ?? 0
    const y0 = bbox?.y ?? 0
    await execFileAsync('python3', [
      '-c', RENDER_SCRIPT, pdfPath, String(figure.page), output,
      String(x0), String(y0), String(x0 + (bbox?.w ?? 0)), String(y0 + (bbox?.h ?? 0)),
      String(RENDER_DPI), String(MAX_IMAGE_SIDE),
    ], { timeout: 30_000, signal: exec?.signal, maxBuffer: 1024 * 1024 })
    const data = await readFile(output)
    const ref = await attachments.saveImage({
      data,
      mediaType: 'image/png',
      name: `${figure.label ?? `page-${figure.page}`}.png`,
    })
    return { image: { attachmentId: ref.attachmentId, mediaType: ref.mediaType } }
  } catch (error) {
    return { reason: `page rendering failed: ${error instanceof Error ? error.message : String(error)}` }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

/**
 * Read one figure: its caption, the page text, and optionally the image.
 * @param store - document store.
 * @param ctx - host plugin context.
 * @param row - index row of the document.
 * @param pages - stored page texts.
 * @param requested - figure id or label from the tool call.
 * @param withImage - whether to render the figure.
 * @param maxChars - text cap.
 * @param exec - tool execution.
 * @returns `{ text }` or `{ text, image }`.
 */
async function readFigure(store, ctx, row, pages, requested, withImage, maxChars, exec) {
  const figure = findFigure(row, requested)
  if (figure === null) {
    return { text: `No figure in "${row.name}" matches "${requested}".\n${listFigures(row, maxChars)}` }
  }
  const title = figure.title === '' || figure.title === figure.label ? '' : ` — ${figure.title}`
  let text = `[${row.name} · ${figure.label}${title} · p.${figure.page}]\n`
  if (figure.source === 'caption') text += '(located by its caption line; the box is approximate)\n'
  text += `\n${pages[figure.page - 1] ?? ''}`
  text = clip(text, maxChars)
  if (!withImage) return { text }
  const rendered = await renderDocumentImage(store, ctx, row, figure, exec)
  return 'image' in rendered
    ? { text, image: rendered.image }
    : { text: `${text}\n\n[image unavailable: ${rendered.reason}]` }
}

/**
 * Resolve a figure id, label, or filename-style reference to one row.
 * @param row - index row of the document.
 * @param value - the caller's `figure` argument.
 * @returns the matching figure, or null.
 */
function findFigure(row, value) {
  const figures = Array.isArray(row.figures) ? row.figures : []
  const needle = value.trim().toLowerCase()
  if (needle === '') return null
  const exact = figures.find(figure => figure.id.toLowerCase() === needle)
  if (exact !== undefined) return exact
  const labels = figures.filter(figure => figure.label.toLowerCase() === needle)
  if (labels.length === 1) return labels[0]
  const normalized = needle
    .replace(/^figure\s+/u, 'fig-')
    .replace(/^fig\.?\s+/u, 'fig-')
    .replace(/^table\s+/u, 'tab-')
    .replace(/^tab\.?\s+/u, 'tab-')
    .replace(/\s+/gu, '-')
  const byId = figures.find(figure => figure.id.toLowerCase() === normalized)
  if (byId !== undefined) return byId
  const prefix = figures.filter(figure => figure.id.toLowerCase().startsWith(needle))
  return prefix.length === 1 ? prefix[0] : null
}

/** One positive page number when `pages` names exactly one page. */
function singlePage(spec) {
  if (typeof spec !== 'string') return null
  const match = /^\s*(\d{1,5})\s*$/u.exec(spec)
  if (match === null) return null
  const page = Number(match[1])
  return page >= 1 ? page : null
}

/**
 * Render the figure list of one document.
 * @param row - index row.
 * @param maxChars - text cap.
 * @returns the model-facing list.
 */
function listFigures(row, maxChars = DEFAULT_MAX_CHARS) {
  const figures = Array.isArray(row.figures) ? row.figures : []
  if (figures.length === 0) {
    return `[${row.name} · ${row.pageCount} pages · doc:${row.id}]\nNo figures or tables were found in this PDF.`
  }
  const lines = figures.map((figure) => {
    const title = figure.title === '' || figure.title === figure.label ? '' : ` — ${figure.title}`
    return `- ${figure.id}${title} (p.${figure.page}, ${figure.source === 'tagged' ? 'tagged' : 'caption'})`
  })
  return clip([`[${row.name} · ${figures.length} figures · doc:${row.id}]`, ...lines].join('\n'), maxChars)
}

/**
 * Build the figure-list tool over one store.
 * @param store - document store.
 * @returns the tool definition handed to `ctx.tools.register`.
 */
function figuresTool(store) {
  return {
    name: 'pdf_figures',
    description: [
      'List the figures and tables of a PDF the user opened in the reader.',
      'Pass the document id from the runtime context (or the file name).',
      'Each row has an id such as "fig-3.2", its caption or description, its page,',
      'and whether the position came from tagged structure (exact) or from the',
      'caption text (approximate). Use pdf_read with that id to read the context,',
      'or add image: true to see the figure.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        document: {
          type: 'string',
          description: 'Document id from the runtime context, or the PDF file name.',
        },
        maxChars: {
          type: 'integer',
          description: `Maximum characters to return (default ${DEFAULT_MAX_CHARS}, max ${HARD_MAX_CHARS}).`,
        },
      },
      required: ['document'],
    },
    output: {
      schema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      const requested = typeof args?.document === 'string' ? args.document.trim() : ''
      if (requested === '') throw new Error('document is required')
      const rows = await store.rows()
      const found = resolveDocument(rows, requested)
      if (found.row === undefined) {
        if (found.ambiguous !== undefined) {
          return { text: `Several PDFs match "${requested}". Use one of these ids:\n${listDocuments(found.ambiguous)}` }
        }
        return { text: unknownDocument(requested, rows) }
      }
      return { text: listFigures(found.row, clampChars(args?.maxChars)) }
    },
  }
}

/**
 * Build the outline tool over one store.
 * @param store - document store.
 * @returns the tool definition handed to `ctx.tools.register`.
 */
function tocTool(store) {
  return {
    name: 'pdf_toc',
    description: [
      'Read the table of contents (PDF outline) of a PDF the user opened in the reader.',
      'Pass the document id from the runtime context (or the file name) as `document`.',
      'The result lists chapter titles with page numbers; follow up with `pdf_read`',
      'and a page range to read the text.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        document: {
          type: 'string',
          description: 'Document id from the runtime context, or the PDF file name.',
        },
        maxChars: {
          type: 'integer',
          description: `Maximum characters to return (default ${DEFAULT_MAX_CHARS}, max ${HARD_MAX_CHARS}).`,
        },
      },
      required: ['document'],
    },
    output: {
      schema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const requested = typeof args?.document === 'string' ? args.document.trim() : ''
      if (requested === '') throw new Error('document is required')
      const rows = await store.rows()
      const found = resolveDocument(rows, requested)
      if (found.row === undefined) {
        if (found.ambiguous !== undefined) {
          return { text: `Several PDFs match "${requested}". Use one of these ids:\n${listDocuments(found.ambiguous)}` }
        }
        return { text: unknownDocument(requested, rows) }
      }
      const row = found.row
      const header = `[${row.name} · ${row.pageCount} pages · doc:${row.id}]`
      return { text: tocText(header, row, clampChars(args?.maxChars)) }
    },
  }
}

/**
 * Render one document's outline.
 * @param header - document identity line.
 * @param row - index row carrying `outline`.
 * @param maxChars - character budget.
 * @returns the outline, or a note that the document has none.
 */
function tocText(header, row, maxChars) {
  if (!Array.isArray(row.outline) || row.outline.length === 0) {
    return `${header}\nThis PDF has no outline. Use pdf_read with page ranges instead.`
  }
  let text = `${header}\n`
  for (const entry of row.outline) {
    const indent = '  '.repeat(Math.min(Number(entry.depth) || 0, 6))
    text += `${indent}${entry.title}${typeof entry.page === 'number' ? ` — p.${entry.page}` : ''}\n`
  }
  return clip(text, maxChars)
}

/**
 * Read one page specification into 1-based page numbers.
 * @param spec - comma-separated pages or ranges, e.g. `"3,7,12-14"`.
 * @param pageCount - page count of the document.
 * @returns ascending, de-duplicated page numbers.
 * @throws when a part is malformed or outside the document.
 */
export function parsePageSpec(spec, pageCount) {
  const pages = new Set()
  for (const part of spec.split(',')) {
    const match = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/u.exec(part)
    if (match === null) throw new Error(`invalid page specification "${part}"`)
    const start = Number(match[1])
    const end = match[2] === undefined ? start : Number(match[2])
    if (start < 1 || end < start || end > pageCount) {
      throw new Error(`page range "${part}" is outside 1-${pageCount}`)
    }
    for (let page = start; page <= end; page += 1) pages.add(page)
  }
  return [...pages].sort((left, right) => left - right)
}

/**
 * Match one document reference against the stored index.
 * @param rows - index rows, newest first.
 * @param value - document id, id prefix, or file name.
 * @returns the matched row, the competing rows, or nothing.
 */
export function resolveDocument(rows, value) {
  const needle = value.trim().replace(/^doc:/iu, '').toLowerCase()
  if (needle === '') return {}
  const exactId = rows.find(row => row.id === needle)
  if (exactId !== undefined) return { row: exactId }
  const prefix = rows.filter(row => row.id.startsWith(needle))
  if (prefix.length === 1) return { row: prefix[0] }
  if (prefix.length > 1) return { ambiguous: prefix }
  const byName = rows.filter(row => row.name.toLowerCase() === needle)
  if (byName.length === 1) return { row: byName[0] }
  if (byName.length > 1) return { ambiguous: byName }
  return {}
}

/** Render page texts for one explicit request. */
function readPages(header, pages, spec, maxChars) {
  const selected = parsePageSpec(spec, pages.length)
  const limited = selected.slice(0, MAX_PAGES_PER_CALL)
  let text = header
  for (const page of limited) text += `\n\n--- p.${page} ---\n${pages[page - 1] ?? ''}`
  if (selected.length > limited.length) {
    text += `\n\n[stopped after ${limited.length} pages; request the remaining pages separately]`
  }
  return clip(text, maxChars)
}

/** Render matching pages for one phrase. */
function searchPages(header, pages, query, maxChars) {
  const needle = query.toLowerCase()
  let text = `${header}\nSearch: "${query}"`
  let hits = 0
  for (let index = 0; index < pages.length && hits < MAX_SEARCH_HITS; index += 1) {
    const page = pages[index]
    const at = page.toLowerCase().indexOf(needle)
    if (at === -1) continue
    hits += 1
    const start = Math.max(0, at - 240)
    const end = Math.min(page.length, at + needle.length + 240)
    const snippet = page.slice(start, end).replace(/\s+/gu, ' ').trim()
    text += `\n\n--- p.${index + 1} ---\n${start > 0 ? '…' : ''}${snippet}${end < page.length ? '…' : ''}`
    if (text.length > maxChars) break
  }
  if (hits === 0) text += '\n\nNo page contains that phrase.'
  return clip(text, maxChars)
}

/** Render metadata, outline, and the first page. */
function documentSummary(header, row, pages, maxChars) {
  let text = `${header}\n`
  text += Array.isArray(row.outline) && row.outline.length > 0 ? '\nContents:\n' : '\nThis PDF has no outline.\n'
  for (const entry of row.outline ?? []) {
    const indent = '  '.repeat(Math.min(Number(entry.depth) || 0, 6))
    const page = typeof entry.page === 'number' ? ` — p.${entry.page}` : ''
    text += `${indent}${entry.title}${page}\n`
  }
  text += `\n--- p.1 ---\n${pages[0] ?? ''}`
  return clip(text, maxChars)
}

/** The model-facing answer for a reference nothing matches. */
function unknownDocument(value, rows) {
  if (rows.length === 0) {
    return 'No PDF is open in the reader right now. Ask the user to open it in the right sidebar; the runtime context will then list it with its document id.'
  }
  return `No indexed PDF matches "${value}". Known documents:\n${listDocuments(rows)}`
}

/** One line per known document. */
function listDocuments(rows) {
  return rows.slice(0, 20).map(row => `- ${row.name} · doc:${row.id} · ${row.pageCount} pages`).join('\n')
}

/** Clamp one requested character budget. */
function clampChars(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return DEFAULT_MAX_CHARS
  return Math.min(Math.floor(value), HARD_MAX_CHARS)
}

/** Cut text at the character budget. */
function clip(text, maxChars) {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n\n[truncated at ${maxChars} characters; request a smaller range]`
}

/** Keep only well-formed outline rows. */
function normalizeOutline(value) {
  if (!Array.isArray(value)) return []
  const rows = []
  for (const entry of value.slice(0, MAX_OUTLINE_ROWS)) {
    if (entry === null || typeof entry !== 'object') continue
    const title = typeof entry.title === 'string' ? entry.title.trim().slice(0, 300) : ''
    if (title === '') continue
    rows.push({
      title,
      page: typeof entry.page === 'number' && Number.isFinite(entry.page) ? entry.page : null,
      depth: typeof entry.depth === 'number' && Number.isFinite(entry.depth) ? Math.max(0, Math.floor(entry.depth)) : 0,
    })
  }
  return rows
}

/** One JSON response on the API route. */
function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** Whether one stored index row is usable. */
function isIndexRow(value) {
  return value !== null && typeof value === 'object'
    && typeof value.id === 'string' && typeof value.name === 'string'
}

/**
 * Document store: `index.json` lists metadata, `<id>.json` holds the page texts.
 * Writes are serialized so two concurrent uploads cannot lose one another.
 * @param dir - absolute store directory.
 */
function createStore(dir) {
  let queue = Promise.resolve()
  const serialize = (task) => {
    const run = queue.then(task, task)
    queue = run.then(() => undefined, () => undefined)
    return run
  }
  const indexPath = join(dir, INDEX_FILE)
  const pagesPath = (id) => join(dir, `${id}.json`)
  const pdfPath = (id) => join(dir, `${id}.pdf`)

  const readIndex = async () => {
    try {
      const parsed = JSON.parse(await readFile(indexPath, 'utf8'))
      return Array.isArray(parsed) ? parsed.filter(isIndexRow) : []
    } catch {
      return []
    }
  }

  const writeIndex = async (rows) => {
    await mkdir(dir, { recursive: true })
    const temp = `${indexPath}.${process.pid}.tmp`
    await writeFile(temp, JSON.stringify(rows), { mode: 0o600 })
    await rename(temp, indexPath)
  }

  /** Drop expired and overflowing rows, deleting their page files. */
  const pruneRows = async (rows) => {
    const now = Date.now()
    const kept = rows.filter(row => now - (row.addedAt ?? 0) < MAX_AGE_MS).slice(0, MAX_DOCUMENTS)
    const keep = new Set(kept.map(row => row.id))
    for (const row of rows) {
      if (keep.has(row.id)) continue
      await rm(pagesPath(row.id), { force: true })
      await rm(pdfPath(row.id), { force: true })
    }
    return kept
  }

  const nextId = async (rows) => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const id = randomBytes(4).toString('hex')
      if (!rows.some(row => row.id === id)) return id
    }
    return randomBytes(8).toString('hex')
  }

  return {
    async save({ name, pages, outline, figures, hash }) {
      return serialize(async () => {
        const rows = await readIndex()
        // The same file content always keeps one row and one id: a re-index
        // rewrites the text in place and leaves an already-uploaded PDF alone.
        const existing = hash === undefined ? undefined : rows.find(row => row.hash === hash)
        await mkdir(dir, { recursive: true })
        const id = existing?.id ?? await nextId(rows)
        await writeFile(pagesPath(id), JSON.stringify(pages), { mode: 0o600 })
        const row = {
          id,
          name,
          pageCount: pages.length,
          outline,
          figures,
          ...(hash === undefined ? {} : { hash }),
          indexVersion: INDEX_VERSION,
          addedAt: Date.now(),
        }
        const kept = await pruneRows([row, ...rows.filter(entry => entry.id !== id)])
        await writeIndex(kept)
        return id
      })
    },
    /** Absolute path of the uploaded PDF bytes, whether or not they exist yet. */
    pdfPath,
    /** Absolute store directory. */
    directory: () => dir,
    /** Whether one id is still registered. */
    async has(id) {
      return (await readIndex()).some(row => row.id === id)
    },
    async rows() {
      return readIndex()
    },
    async pages(id) {
      try {
        const parsed = JSON.parse(await readFile(pagesPath(id), 'utf8'))
        return Array.isArray(parsed) ? parsed : undefined
      } catch {
        return undefined
      }
    },
    async prune() {
      return serialize(async () => {
        const rows = await readIndex()
        const kept = await pruneRows(rows)
        if (kept.length !== rows.length) await writeIndex(kept)
      })
    },
  }
}
