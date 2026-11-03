/** Browser-side indexing: page text, figure captions, and the PDF bytes the host renders. */
import { collectCaptionFigures, collectTaggedFigures } from './figures.js'

/** Figures kept for one document; the host enforces the same bound. */
const MAX_FIGURES = 500

/**
 * Extract every page's text and build the figure index.
 *
 * The agent needs text, not layout, and the browser already owns the bytes; a
 * tagged PDF also yields exact figure boxes, which the host later uses to crop
 * a rendered page.
 * @param pdf - loaded PDF document proxy.
 * @param signal - lifetime of the current document; aborts between pages.
 * @returns `{ pages, figures }`, both in page order.
 */
export async function indexDocument(pdf, signal) {
  const pages = []
  const figures = []
  let marked = false
  try {
    marked = (await pdf.getMarkInfo())?.Marked === true
  } catch {
    marked = false
  }
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    signal?.throwIfAborted()
    const page = await pdf.getPage(pageNumber)
    try {
      const viewport = page.getViewport({ scale: 1 })
      const content = await page.getTextContent()
      pages.push(itemsToText(content.items))
      let pageFigures = collectCaptionFigures(content.items, pageNumber, viewport)
      if (marked) {
        try {
          pageFigures = await collectTaggedFigures(page, pageNumber, viewport, pageFigures)
        } catch {
          // A malformed structure tree leaves the caption rows in place.
        }
      }
      figures.push(...pageFigures)
    } finally {
      try {
        page.cleanup()
      } catch {
        // The page is released with its document in any case.
      }
    }
  }
  return { pages, figures: figures.slice(0, MAX_FIGURES) }
}

/**
 * Join PDF.js text items into one page's text, keeping line breaks.
 * @param items - `getTextContent()` items.
 * @returns normalized page text.
 */
function itemsToText(items) {
  let text = ''
  for (const item of items) {
    if (item === null || typeof item !== 'object' || typeof item.str !== 'string') continue
    text += item.str
    if (item.hasEOL) text += '\n'
  }
  return text.replace(/[ \t]+$/gmu, '').trim()
}

/**
 * Ask whether this file content was indexed before.
 * @param hash - MD5 of the file bytes.
 * @param sessionId - Session owning the reader tab; a hit marks it open.
 * @param signal - aborts with the document.
 * @returns `{ id, needsPdf }` on a hit, or null on a miss or a network error.
 */
export async function lookupDocument(hash, sessionId, signal) {
  const response = await fetch(new URL('api/pdf-reader/lookup', document.baseURI), {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hash, sessionId }),
    cache: 'no-store',
    signal,
  })
  if (!response.ok) return null
  let value
  try {
    value = await response.json()
  } catch {
    return null
  }
  if (value === null || typeof value !== 'object' || value.miss === true || typeof value.id !== 'string') return null
  return { id: value.id, needsPdf: value.needsPdf === true }
}

/**
 * Register one indexed document with the Host.
 * @param payload - `{ sessionId, hash, name, pages, outline, figures }`.
 * @param signal - aborts the upload when the document is replaced.
 * @returns `{ id, hasPdf }`; `hasPdf` is true when the bytes are already stored.
 * @throws when the Host refuses the upload.
 */
export async function registerDocument(payload, signal) {
  const response = await fetch(new URL('api/pdf-reader/register', document.baseURI), {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    cache: 'no-store',
    signal,
  })
  const text = await response.text()
  let value
  try {
    value = JSON.parse(text)
  } catch {
    value = undefined
  }
  if (!response.ok || value === null || typeof value !== 'object' || typeof value.id !== 'string') {
    const reason = value !== null && typeof value === 'object' && typeof value.error === 'string'
      ? value.error
      : `HTTP ${response.status}`
    throw new Error(reason)
  }
  return { id: value.id, hasPdf: value.hasPdf === true }
}

/**
 * Upload the PDF itself, so the host can render a figure or a page on demand.
 * @param id - document id returned by {@link registerDocument}.
 * @param file - the opened file.
 * @param signal - aborts with the document.
 */
export async function uploadPdf(id, file, signal) {
  if (file === null || file === undefined) return
  const url = new URL('api/pdf-reader/binary', document.baseURI)
  url.searchParams.set('id', id)
  // A stalled upload must not leave the reader on "indexing" forever.
  const timeout = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(120_000) : undefined
  const combined = timeout === undefined || typeof AbortSignal.any !== 'function'
    ? signal
    : AbortSignal.any([signal, timeout])
  const response = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/pdf' },
    body: file,
    cache: 'no-store',
    signal: combined,
  })
  if (response.ok) return
  const text = await response.text().catch(() => '')
  let reason = `HTTP ${response.status}`
  try {
    const value = JSON.parse(text)
    if (typeof value?.error === 'string') reason = value.error
  } catch {
    // A non-JSON body keeps the status text.
  }
  throw new Error(reason)
}

/**
 * Tell the Host that one reader tab no longer shows this document.
 *
 * Uses `keepalive` so the notice still leaves a page that is being closed or
 * refreshed; the Host ignores an id it no longer tracks.
 * @param sessionId - Session owning the reader tab.
 * @param id - document id returned by {@link registerDocument}.
 */
export function closeDocument(sessionId, id) {
  if (typeof sessionId !== 'string' || sessionId === '' || typeof id !== 'string' || id === '') return
  try {
    void fetch(new URL('api/pdf-reader/close', document.baseURI), {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, id }),
      cache: 'no-store',
      keepalive: true,
    }).catch(() => {})
  } catch {
    // A page already tearing down has no usable fetch.
  }
}
