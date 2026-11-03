/**
 * Figure index: captions recovered from text lines, plus exact boxes from a
 * tagged PDF's structure tree.
 *
 * A PDF has no standard "figure id" or title. Tagged PDFs carry `/Figure`
 * structure elements with an `/Alt` description and a `/BBox`; everything else
 * only offers a caption line such as "Figure 3.2: ...". Both paths produce the
 * same row shape so the host tool never has to know which one won.
 */

/** A caption line starts with a label; in-text references usually continue with a verb. */
const CAPTION = /^\s*(fig(?:ure)?\.?|table|图|表)\s*([A-Za-z]?\d+(?:[.\-–]\d+)?)\s*([:：.。、\-–—]?)\s*(.*)$/iu

/** Longest line still considered a caption rather than body text. */
const MAX_CAPTION_CHARS = 240

/**
 * Collect captions from one page's text items.
 * @param {Array<object>} items - `getTextContent()` items.
 * @param {number} pageNumber - 1-based page.
 * @param {object} viewport - `page.getViewport({ scale: 1 })`.
 * @returns {Array<object>} rows with `bbox: null` and a private normalized `top`.
 */
export function collectCaptionFigures(items, pageNumber, viewport) {
  const figures = []
  for (const line of groupLines(items, viewport)) {
    const match = CAPTION.exec(line.text)
    if (match === null || line.text.length > MAX_CAPTION_CHARS) continue
    const kind = kindOf(match[1])
    const number = match[2]
    const separator = match[3]
    const title = match[4].trim()
    // A caption either separates its label from the text or starts the title with
    // a capital; "Figure 3.2 shows ..." is a reference in the middle of prose.
    if (separator === '' && title !== '' && !/^[A-Z\u4e00-\u9fff]/u.test(title)) continue
    figures.push({
      id: `${kind === 'table' ? 'tab' : 'fig'}-${number.toLowerCase()}`,
      label: `${kind === 'table' ? 'Table' : 'Figure'} ${number}`,
      title: title === '' ? `${kind === 'table' ? 'Table' : 'Figure'} ${number}` : title,
      page: pageNumber,
      bbox: null,
      source: 'caption',
      top: line.top,
    })
  }
  return figures
}

/**
 * Replace caption-only rows with tagged structure boxes where the PDF has them.
 * @param {object} page - PDF page proxy.
 * @param {number} pageNumber - 1-based page.
 * @param {object} viewport - `page.getViewport({ scale: 1 })`.
 * @param {Array<object>} captions - rows from {@link collectCaptionFigures}.
 * @returns {Promise<Array<object>>} tagged rows first, then unmatched captions.
 */
export async function collectTaggedFigures(page, pageNumber, viewport, captions) {
  let tree
  try {
    tree = await page.getStructTree()
  } catch {
    return captions
  }
  if (tree === null || typeof tree !== 'object') return captions
  const nodes = []
  walkFigures(tree, 0, node => { nodes.push(node) })
  if (nodes.length === 0) return captions
  const unmatched = [...captions]
  const figures = []
  for (const node of nodes) {
    const bbox = boxOf(node, viewport)
    if (bbox === null) continue
    const caption = takeCaption(unmatched, bbox)
    const alt = typeof node.alt === 'string' ? node.alt.trim() : ''
    const label = caption?.label ?? `Figure on page ${pageNumber}`
    figures.push({
      id: caption?.id ?? `fig-p${pageNumber}-${figures.length + 1}`,
      label,
      title: caption?.title ?? (alt === '' ? label : alt),
      page: pageNumber,
      bbox,
      source: 'tagged',
    })
  }
  return [...figures, ...unmatched.map(stripTop)]
}

/** One page's lines with normalized tops, so captions can sit next to a tagged box. */
function groupLines(items, viewport) {
  const lines = []
  let text = ''
  let first = null
  const flush = () => {
    const normalized = text.replace(/\s+/gu, ' ').trim()
    if (normalized !== '') lines.push({ text: normalized, top: first === null ? 0 : lineTop(first, viewport) })
    text = ''
    first = null
  }
  for (const item of items) {
    if (item === null || typeof item !== 'object' || typeof item.str !== 'string') continue
    if (first === null && item.str.trim() !== '') first = item
    text += item.str
    if (item.hasEOL) flush()
  }
  flush()
  return lines
}

/** One text origin in normalized viewport coordinates, moved up to the line's top. */
function lineTop(item, viewport) {
  const transform = item.transform
  if (!Array.isArray(transform) || transform.length !== 6) return 0
  const [, y] = viewport.convertToViewportPoint(transform[4], transform[5])
  const height = typeof item.height === 'number' ? item.height : 0
  const top = (y - height) / viewport.height
  return Number.isFinite(top) ? Math.min(Math.max(top, 0), 1) : 0
}

/** Normalized box of one tagged figure node, or null when it has no usable `/BBox`. */
function boxOf(node, viewport) {
  const rect = node.bbox
  if (!Array.isArray(rect) || rect.length !== 4 || !rect.every(value => Number.isFinite(value))) return null
  const [x0, y0] = viewport.convertToViewportPoint(rect[0], rect[1])
  const [x1, y1] = viewport.convertToViewportPoint(rect[2], rect[3])
  const left = Math.min(x0, x1)
  const right = Math.max(x0, x1)
  const top = Math.min(y0, y1)
  const bottom = Math.max(y0, y1)
  const bbox = {
    x: clamp01(left / viewport.width),
    y: clamp01(top / viewport.height),
    w: clamp01((right - left) / viewport.width),
    h: clamp01((bottom - top) / viewport.height),
  }
  return bbox.w < 0.02 || bbox.h < 0.02 ? null : bbox
}

/** The caption closest below one figure box, removing it from the pool. */
function takeCaption(captions, bbox) {
  const bottom = bbox.y + bbox.h
  let best = -1
  let bestDistance = Infinity
  for (let index = 0; index < captions.length; index += 1) {
    const distance = captions[index].top - bottom
    if (distance < -0.02 || distance > 0.4) continue
    if (distance < bestDistance) {
      bestDistance = distance
      best = index
    }
  }
  return best === -1 ? undefined : captions.splice(best, 1)[0]
}

/** Depth-first walk over structure nodes that actually carry children. */
function walkFigures(node, depth, visit) {
  if (depth > 20 || node === null || typeof node !== 'object') return
  visit(node)
  const children = Array.isArray(node.children) ? node.children : []
  for (const child of children) {
    if (child !== null && typeof child === 'object' && Array.isArray(child.children)) {
      walkFigures(child, depth + 1, visit)
    }
  }
}

/** One row's kind word, normalizing `Fig.`/`Figure`/`图`. */
function kindOf(raw) {
  const word = raw.replace(/\.$/u, '')
  return /^fig/iu.test(word) ? 'figure' : /^table/iu.test(word) ? 'table' : word === '表' ? 'table' : 'figure'
}

/** Drop the private positioning field before upload. */
function stripTop({ top: _top, ...row }) {
  return row
}

/** Clamp one normalized coordinate. */
function clamp01(value) {
  return Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : 0
}
