/** PDF.js runtime owned by the reader: one shared Worker, document loading, text layers. */
import { GlobalWorkerOptions, TextLayer, getDocument } from 'pdfjs-dist/build/pdf.min.mjs'
import workerSource from 'pdfjs-dist/build/pdf.worker.min.mjs?raw'

let workerUrl

/**
 * Point PDF.js at a Worker built from the worker source bundled beside this
 * module. A blob URL keeps the bundle a single file; PDF.js falls back to its
 * main-thread fake worker if the browser refuses module workers.
 */
export function ensureWorker() {
  if (workerUrl !== undefined) return
  workerUrl = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }))
  GlobalWorkerOptions.workerSrc = workerUrl
}

/**
 * Start loading one PDF from complete bytes.
 * @param {Uint8Array} bytes - complete file content.
 * @returns {import('pdfjs-dist').PDFDocumentLoadingTask} the loading task, whose destroy() owns cleanup.
 */
export function loadPdf(bytes) {
  ensureWorker()
  return getDocument({
    data: bytes,
    useWorkerFetch: false,
    cMapPacked: true,
    enableXfa: false,
  })
}

export { TextLayer }

/** Destroy a loading task without surfacing teardown failures to the UI. */
export function disposeTask(task) {
  if (task === null || task === undefined) return
  try {
    void Promise.resolve(task.destroy()).catch(() => {})
  } catch {
    // A task already torn down by an aborted load throws synchronously.
  }
}
