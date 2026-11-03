/** The reader tab body: file intake, page list, outline navigation, selection quoting, and text indexing. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { formatQuotedText } from './citation.js'
import { BookIcon, CloseIcon, OutlineIcon, QuoteIcon } from './icons.jsx'
import { md5 } from './hash.js'
import { closeDocument, indexDocument, lookupDocument, registerDocument, uploadPdf } from './indexer.js'
import { PdfPage } from './PdfPage.jsx'
import { flattenOutline, loadOutline } from './outline.js'
import { disposeTask, loadPdf } from './pdf.js'

/**
 * Open a PDF from disk inside the right Sidebar, move through its outline, and
 * quote selected text into the composer of the Session owning this tab.
 *
 * The browser holds the bytes (a file picker never reveals a path), so the
 * reader also extracts every page's text and registers it with the Host under
 * one document id. Quotes carry that id, and the agent's `pdf_read` tool serves
 * the text back on demand.
 * @param props.t - locale lookup supplied by the `pdfReader` namespace.
 * @param props.inputActions - composer actions for this Session; `insertQuote` inserts the atomic quote.
 */
export function ReaderBody({ t, inputActions, sessionId }) {
  const [file, setFile] = useState(null)
  const [doc, setDoc] = useState(null)
  const [status, setStatus] = useState('empty')
  const [failure, setFailure] = useState(null)
  const [base, setBase] = useState(null)
  const [scale, setScale] = useState(1)
  const [quote, setQuote] = useState(null)
  const [notice, setNotice] = useState(null)
  const [attempt, setAttempt] = useState(0)
  const [outline, setOutline] = useState(null)
  const [outlineOpen, setOutlineOpen] = useState(false)
  const [activePage, setActivePage] = useState(1)
  const [indexState, setIndexState] = useState('idle')
  const [indexError, setIndexError] = useState(null)
  const [imageError, setImageError] = useState(null)
  const rootRef = useRef(null)
  const scrollRef = useRef(null)
  const outlineRef = useRef(null)
  const pickRef = useRef(null)
  const taskRef = useRef(null)
  const pointerRef = useRef(null)
  const draggingRef = useRef(false)
  const fileRef = useRef(file)
  fileRef.current = file
  const hashRef = useRef(null)
  const openIdRef = useRef(null)

  // Load the chosen file, and release its loading task whenever it is replaced or the tab closes.
  useEffect(() => {
    if (file === null) {
      setDoc(null)
      setStatus('empty')
      return undefined
    }
    let disposed = false
    let task = null
    const lifetime = new AbortController()
    setDoc(null)
    hashRef.current = null
    setStatus('loading')
    setFailure(null)
    setQuote(null)
    setOutlineOpen(false)
    const run = async () => {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer())
        if (disposed) return
        hashRef.current = md5(bytes)
        task = loadPdf(bytes)
        taskRef.current = task
        const document = await task.promise
        if (disposed) {
          disposeTask(task)
          return
        }
        const first = await document.getPage(1)
        const viewport = first.getViewport({ scale: 1 })
        try {
          first.cleanup()
        } catch {
          // The page is released with its document in any case.
        }
        if (disposed) return
        setBase({ width: viewport.width, height: viewport.height })
        setDoc(document)
        setStatus('ready')
        setActivePage(1)
        scrollRef.current?.scrollTo({ top: 0 })
      } catch (error) {
        if (disposed) return
        disposeTask(task)
        setStatus('failed')
        setFailure(error)
      }
    }
    void run()
    return () => {
      disposed = true
      lifetime.abort()
      disposeTask(taskRef.current)
      taskRef.current = null
    }
  }, [file, attempt])

  // Extract the text once the document is ready and register it with the Host,
  // so the agent can read any page through `pdf_read` later.
  useEffect(() => {
    if (doc === null) {
      setIndexState('idle')
      setIndexError(null)
      setImageError(null)
      return undefined
    }
    const controller = new AbortController()
    setIndexState('running')
    setIndexError(null)
    setImageError(null)
    const name = fileRef.current?.name ?? 'document.pdf'
    void (async () => {
      try {
        // The same file content was indexed before: reuse its text, figures, and
        // PDF bytes instead of scanning and uploading them again.
        const hash = hashRef.current
        const hit = hash === null ? null : await lookupDocument(hash, sessionId, controller.signal).catch(() => null)
        if (controller.signal.aborted) return
        if (hit !== null) {
          openIdRef.current = hit.id
          if (hit.needsPdf) {
            await uploadPdf(hit.id, fileRef.current, controller.signal).catch((error) => {
              if (!controller.signal.aborted) setImageError(error instanceof Error ? error.message : String(error))
            })
          }
          if (controller.signal.aborted) return
          setIndexState('ready')
          return
        }
        const { pages, figures } = await indexDocument(doc, controller.signal)
        const outlineRows = flattenOutline(await loadOutline(doc))
          .map(row => ({ title: row.title, page: row.page, depth: row.depth }))
        const registered = await registerDocument(
          { sessionId, hash, name, pages, outline: outlineRows, figures },
          controller.signal,
        )
        if (controller.signal.aborted) return
        openIdRef.current = registered.id
        if (!registered.hasPdf) {
          // The PDF bytes let the host render figures; text is already usable if this fails.
          await uploadPdf(registered.id, fileRef.current, controller.signal).catch((error) => {
            if (!controller.signal.aborted) setImageError(error instanceof Error ? error.message : String(error))
          })
        }
        if (controller.signal.aborted) return
        setIndexState('ready')
      } catch (error) {
        if (controller.signal.aborted) return
        setIndexError(error instanceof Error ? error.message : String(error))
        setIndexState('failed')
      }
    })()
    return () => {
      controller.abort()
      const openId = openIdRef.current
      openIdRef.current = null
      if (openId !== null) closeDocument(sessionId, openId)
    }
  }, [doc, sessionId])

  // Read the outline for the navigation panel.
  useEffect(() => {
    if (doc === null) {
      setOutline([])
      return undefined
    }
    let cancelled = false
    setOutline(null)
    void loadOutline(doc).then((items) => {
      if (!cancelled) setOutline(items)
    }, () => {
      if (!cancelled) setOutline([])
    })
    return () => { cancelled = true }
  }, [doc])

  const entries = useMemo(() => flattenOutline(outline ?? []), [outline])
  const hasOutline = entries.length > 0
  const activeId = useMemo(() => {
    let best = null
    for (const entry of entries) {
      if (entry.page === null || entry.page > activePage) continue
      if (best === null || entry.page >= best.page) best = entry
    }
    return best === null ? null : best.id
  }, [entries, activePage])

  // Fit the first page's width into the scrollport, and follow later resizes.
  useEffect(() => {
    const node = scrollRef.current
    if (node === null || base === null || base.width <= 0) return undefined
    const update = () => {
      const width = node.clientWidth - 24
      if (width <= 0) return
      const next = Math.min(3, Math.max(0.2, width / base.width))
      setScale(previous => (Math.abs(previous - next) < 0.005 ? previous : next))
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(node)
    return () => observer.disconnect()
  }, [base, status])

  // Follow this reader's browser selection. A gesture in progress stays quiet;
  // the pointer-up position decides which selected line the action attaches to.
  useEffect(() => {
    const root = rootRef.current
    if (root === null) return undefined
    const document_ = root.ownerDocument
    const read = () => {
      const selection = document_.getSelection()
      if (selection === null || selection.isCollapsed || selection.rangeCount === 0) {
        setQuote(null)
        return
      }
      const range = selection.getRangeAt(0)
      if (!root.contains(range.commonAncestorContainer)) {
        setQuote(null)
        return
      }
      const text = selection.toString().replace(/\u00a0/gu, ' ').replace(/\s+/gu, ' ').trim()
      if (text === '') {
        setQuote(null)
        return
      }
      const rects = [...range.getClientRects()]
        .filter(rect => rect.width > 0 && rect.height > 0)
        .map(rect => ({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }))
      if (rects.length === 0) {
        const rect = range.getBoundingClientRect()
        if (rect.width === 0 && rect.height === 0) {
          setQuote(null)
          return
        }
        rects.push({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom })
      }
      const element = range.startContainer.nodeType === 1
        ? range.startContainer
        : range.startContainer.parentElement
      const pageNode = element?.closest('[data-pdf-page]') ?? null
      const page = pageNode === null ? null : Number(pageNode.getAttribute('data-pdf-page'))
      setQuote({
        text,
        page: Number.isFinite(page) ? page : null,
        rects,
        pointer: pointerRef.current,
      })
    }
    const pointerDown = (event) => {
      if (event.button !== 0) return
      const target = event.target
      if (!(target instanceof Node) || !root.contains(target)) return
      draggingRef.current = true
      pointerRef.current = { x: event.clientX, y: event.clientY }
    }
    const pointerUp = (event) => {
      if (!draggingRef.current) return
      draggingRef.current = false
      pointerRef.current = { x: event.clientX, y: event.clientY }
      read()
    }
    const selectionChange = () => {
      if (!draggingRef.current) read()
    }
    const pointerCancel = () => { draggingRef.current = false }
    document_.addEventListener('pointerdown', pointerDown, true)
    document_.addEventListener('pointerup', pointerUp)
    document_.addEventListener('pointercancel', pointerCancel)
    document_.addEventListener('selectionchange', selectionChange)
    return () => {
      document_.removeEventListener('pointerdown', pointerDown, true)
      document_.removeEventListener('pointerup', pointerUp)
      document_.removeEventListener('pointercancel', pointerCancel)
      document_.removeEventListener('selectionchange', selectionChange)
    }
  }, [])

  // Track the page at the top of the scrollport for the outline, and drop the quote action on scroll.
  useEffect(() => {
    const node = scrollRef.current
    if (node === null || doc === null) return undefined
    let frame
    const measure = () => {
      frame = undefined
      const top = node.getBoundingClientRect().top
      let current = 1
      for (const element of node.querySelectorAll('[data-pdf-page]')) {
        if (element.getBoundingClientRect().top - top <= 16) current = Number(element.getAttribute('data-pdf-page'))
        else break
      }
      setActivePage(previous => (previous === current ? previous : current))
    }
    const onScroll = () => {
      setQuote(null)
      if (frame === undefined) frame = requestAnimationFrame(measure)
    }
    measure()
    node.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      node.removeEventListener('scroll', onScroll)
      if (frame !== undefined) cancelAnimationFrame(frame)
    }
  }, [doc])

  useEffect(() => {
    if (!outlineOpen) return undefined
    const onKey = (event) => {
      if (event.key === 'Escape') setOutlineOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [outlineOpen])

  // Bring the chapter being read into view without moving the page behind the panel.
  useEffect(() => {
    if (!outlineOpen) return
    const list = outlineRef.current
    if (list === null) return
    const active = list.querySelector('.pdfr-outlineRowActive')
    if (active === null) return
    const shift = active.getBoundingClientRect().top - list.getBoundingClientRect().top - list.clientHeight / 2
    list.scrollTop += shift
  }, [outlineOpen])

  useEffect(() => {
    if (notice === null) return undefined
    const timer = setTimeout(() => { setNotice(null) }, 2600)
    return () => clearTimeout(timer)
  }, [notice])

  // Closing or refreshing the page must not leave the document marked as open.
  useEffect(() => {
    const onHide = (event) => {
      if (event.persisted === false && openIdRef.current !== null) closeDocument(sessionId, openIdRef.current)
    }
    window.addEventListener('pagehide', onHide)
    return () => window.removeEventListener('pagehide', onHide)
  }, [sessionId])

  const accept = useCallback((candidate) => {
    if (candidate === null || candidate === undefined) return
    const isPdf = candidate.type === 'application/pdf' || /\.pdf$/iu.test(candidate.name)
    if (!isPdf) {
      setNotice(t('notPdf'))
      return
    }
    setIndexState('idle')
    setIndexError(null)
    setImageError(null)
    setFailure(null)
    setAttempt(0)
    setFile(candidate)
  }, [t])

  const openLocal = useCallback(() => { pickRef.current?.click() }, [])
  const picked = useCallback((event) => {
    const candidate = event.target.files?.[0] ?? null
    event.target.value = ''
    accept(candidate)
  }, [accept])
  const dropped = useCallback((event) => {
    event.preventDefault()
    accept(event.dataTransfer?.files?.[0] ?? null)
  }, [accept])
  const backToIntake = useCallback(() => {
    setFile(null)
    setIndexState('idle')
    setIndexError(null)
    setImageError(null)
    setFailure(null)
    setAttempt(0)
  }, [])
  const blocked = useCallback((event) => { event.preventDefault() }, [])
  const retry = useCallback(() => { setAttempt(value => value + 1) }, [])

  const insertQuote = useCallback(() => {
    if (quote === null) return
    const text = formatQuotedText(file?.name ?? null, quote.page, quote.text)
    const inserted = inputActions?.insertQuote?.(text) ?? false
    if (!inserted) {
      setNotice(t('blocked'))
      return
    }
    setQuote(null)
    rootRef.current?.ownerDocument.getSelection()?.removeAllRanges()
  }, [quote, file, inputActions, t])

  const jumpTo = useCallback((page) => {
    setOutlineOpen(false)
    setQuote(null)
    const node = scrollRef.current
    if (node === null) return
    setActivePage(page)
    const target = node.querySelector(`[data-pdf-page="${page}"]`)
    if (target === null) return
    const top = target.getBoundingClientRect().top - node.getBoundingClientRect().top + node.scrollTop - 8
    node.scrollTo({ top })
  }, [])

  const toggleOutline = useCallback(() => {
    setQuote(null)
    setOutlineOpen(open => !open)
  }, [])

  const floating = quote === null || outlineOpen ? null : placeQuote(quote, rootRef.current)
  const fileName = file === null ? null : file.name
  const outlineTitle = hasOutline ? t('outline') : outline === null ? t('outlineLoading') : t('outlineEmpty')
  const indexTitle = indexState === 'running'
    ? t('indexing')
    : indexState === 'failed'
      ? t('indexFailedTitle', { message: indexError ?? '' })
      : t('imageFailedTitle', { message: imageError ?? '' })
  const indexLabel = indexState === 'running'
    ? t('indexingShort')
    : indexState === 'failed' ? t('indexFailed') : t('imageFailed')

  return (
    <div
      ref={rootRef}
      className="pdfr-root"
      onDragOver={blocked}
      onDrop={dropped}
    >
      <header className="pdfr-header">
        <span className="pdfr-name" title={fileName ?? ''}>{fileName ?? t('title')}</span>
        {doc !== null && (indexState === 'running' || indexState === 'failed' || imageError !== null) && (
          <span
            className={indexState === 'failed' || imageError !== null ? 'pdfr-index pdfr-indexFailed' : 'pdfr-index'}
            title={indexTitle}
          >
            {indexLabel}
          </span>
        )}
        {doc !== null && <span className="pdfr-count">{t('pageCount', { count: doc.numPages })}</span>}
        {doc !== null && (
          <button
            type="button"
            className="pdfr-iconButton"
            aria-label={t('outline')}
            aria-expanded={outlineOpen}
            title={outlineTitle}
            disabled={!hasOutline}
            onClick={toggleOutline}
          >
            <OutlineIcon size={15} />
          </button>
        )}
        <button type="button" className="pdfr-button" onClick={backToIntake}>{t('open')}</button>
        <input ref={pickRef} type="file" accept="application/pdf,.pdf" hidden onChange={picked} />
      </header>

      {status === 'empty' && (
        <div className="pdfr-intake">
          <div className="pdfr-emptyIcon"><BookIcon size={44} /></div>
          <p className="pdfr-emptyTitle">{t('emptyTitle')}</p>
          <p className="pdfr-emptyHint">{t('emptyHint')}</p>
          <button type="button" className="pdfr-primary" onClick={openLocal}>{t('choose')}</button>
        </div>
      )}

      {status === 'loading' && <div className="pdfr-state" role="status">{t('loading')}</div>}

      {status === 'failed' && (
        <div className="pdfr-state" role="alert">
          <span className="pdfr-stateTitle">{t('failed')}</span>
          <span className="pdfr-stateDetail">{describeFailure(failure, t)}</span>
          <div className="pdfr-stateActions">
            <button type="button" className="pdfr-button" onClick={retry}>{t('retry')}</button>
            <button type="button" className="pdfr-button" onClick={backToIntake}>{t('back')}</button>
          </div>
        </div>
      )}

      {doc !== null && (
        <div className="pdfr-scroll" ref={scrollRef}>
          <div className="pdfr-pages">
            {Array.from({ length: doc.numPages }, (_, index) => (
              <PdfPage
                key={index}
                pdf={doc}
                number={index + 1}
                scale={scale}
                estimate={base}
                scrollRoot={scrollRef}
                t={t}
              />
            ))}
          </div>
        </div>
      )}

      {outlineOpen && (
        <div className="pdfr-outline" role="region" aria-label={t('outline')}>
          <div className="pdfr-outlineHead">
            <span>{t('outline')}</span>
            <button
              type="button"
              className="pdfr-iconButton"
              aria-label={t('outlineClose')}
              title={t('outlineClose')}
              onClick={() => { setOutlineOpen(false) }}
            >
              <CloseIcon size={14} />
            </button>
          </div>
          {outline === null && <div className="pdfr-state" role="status">{t('outlineLoading')}</div>}
          {outline !== null && outline.length === 0 && <div className="pdfr-state">{t('outlineEmpty')}</div>}
          {outline !== null && outline.length > 0 && (
            <div className="pdfr-outlineList" ref={outlineRef}>
              <OutlineRows items={outline} activeId={activeId} onJump={jumpTo} />
            </div>
          )}
        </div>
      )}

      {floating !== null && (
        <button
          type="button"
          className="pdfr-quote"
          style={{ left: `${floating.left}px`, top: `${floating.top}px` }}
          onPointerDown={blocked}
          onClick={insertQuote}
        >
          <QuoteIcon size={14} />
          <span>{quote.page === null ? t('quote') : t('quotePage', { page: quote.page })}</span>
        </button>
      )}

      {notice !== null && <div className="pdfr-notice" role="status">{notice}</div>}
    </div>
  )
}

/** One outline level; children render under their parent with an extra indent step. */
function OutlineRows({ items, activeId, onJump }) {
  return items.map(item => (
    <div key={item.id}>
      <button
        type="button"
        className={item.id === activeId ? 'pdfr-outlineRow pdfr-outlineRowActive' : 'pdfr-outlineRow'}
        style={{ paddingLeft: `${12 + item.depth * 12}px` }}
        disabled={item.page === null}
        title={item.title}
        onClick={() => { if (item.page !== null) onJump(item.page) }}
      >
        <span className="pdfr-outlineText">{item.title}</span>
        {item.page !== null && <span className="pdfr-outlinePage">{item.page}</span>}
      </button>
      {item.children.length > 0 && (
        <OutlineRows items={item.children} activeId={activeId} onJump={onJump} />
      )}
    </div>
  ))
}

/**
 * Place the quote action in the reader's own coordinate space, next to the
 * selected line nearest the pointer that ended the gesture. Working in local
 * coordinates keeps the action aligned when an ancestor scales the pane.
 * @param quote - captured selection text, page, line rects, and pointer.
 * @param root - the reader root that owns the action's positioning.
 * @returns local `left`/`top`, or null while the root has no box.
 */
function placeQuote(quote, root) {
  if (root === null) return null
  const rootRect = root.getBoundingClientRect()
  if (rootRect.width === 0 || rootRect.height === 0) return null
  const scaleX = root.offsetWidth === 0 ? 1 : rootRect.width / root.offsetWidth
  const scaleY = root.offsetHeight === 0 ? 1 : rootRect.height / root.offsetHeight
  const anchor = nearestRect(quote.rects, quote.pointer)
  if (anchor === undefined) return null
  const width = root.offsetWidth
  const height = root.offsetHeight
  const center = (anchor.left + anchor.right) / 2
  const left = Math.min(Math.max((center - rootRect.left) / scaleX, 56), Math.max(56, width - 56))
  const below = (anchor.bottom - rootRect.top) / scaleY + 8
  const above = (anchor.top - rootRect.top) / scaleY - 38
  // Stay below the 38px header and above the bottom edge.
  const raw = below + 30 > height ? above : below
  const top = Math.min(Math.max(raw, 44), Math.max(44, height - 36))
  return { left, top }
}

/** The selected line closest to the pointer, so a multi-line selection anchors where the drag ended. */
function nearestRect(rects, pointer) {
  if (rects.length === 0) return undefined
  if (pointer === null || pointer === undefined) return rects[rects.length - 1]
  let best = rects[0]
  let bestDistance = Infinity
  for (const rect of rects) {
    const dx = Math.max(rect.left - pointer.x, 0, pointer.x - rect.right)
    const dy = Math.max(rect.top - pointer.y, 0, pointer.y - rect.bottom)
    const distance = dx * dx + dy * dy
    if (distance < bestDistance) {
      bestDistance = distance
      best = rect
    }
  }
  return best
}

/** Turn a load failure into one localized line. */
function describeFailure(error, t) {
  if (error !== null && typeof error === 'object' && error.name === 'PasswordException') return t('password')
  const message = error instanceof Error ? error.message : String(error)
  return t('failedDetail', { message })
}
