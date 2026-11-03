/** Composer entry that reveals the PDF reader tab in the right Sidebar. */
import { BookIcon } from './icons.jsx'

/**
 * One compact composer control, matching the host's 28px circular add button.
 * @param props.t - locale lookup supplied by the `pdfReader` namespace.
 * @param props.open - reveals the reader tab for the current Session.
 */
export function ReaderLauncher({ t, open }) {
  const label = typeof t === 'function' ? t('openReader') : 'PDF reader'
  return (
    <button
      type="button"
      className="pdfr-launch"
      aria-label={label}
      title={label}
      onClick={open}
    >
      <BookIcon size={15} />
    </button>
  )
}
