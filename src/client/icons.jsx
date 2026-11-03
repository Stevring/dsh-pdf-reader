/** Inline glyphs owned by this plugin; no Harness Client package is imported. */

/** Open book with a spine, used as the guide artwork and the composer entry. */
export function BookIcon({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M2.6 3.6c1.8-.6 3.6-.4 5.4.9 1.8-1.3 3.6-1.5 5.4-.9v8.3c-1.8-.6-3.6-.4-5.4.9-1.8-1.3-3.6-1.5-5.4-.9V3.6Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path d="M8 4.5v8.3" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  )
}

/** Quotation mark shown on the floating quote action. */
export function QuoteIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M6.4 4.2c-1.9.6-3 2-3 3.6 0 1 .5 1.7 1.4 2.2-.4 1-1.1 1.8-2.1 2.4l.6 1c2.3-1 3.6-2.8 3.6-4.9 0-.5-.1-.9-.2-1.3l-.3-3Zm6 0c-1.9.6-3 2-3 3.6 0 1 .5 1.7 1.4 2.2-.4 1-1.1 1.8-2.1 2.4l.6 1c2.3-1 3.6-2.8 3.6-4.9 0-.5-.1-.9-.2-1.3l-.3-3Z"
        fill="currentColor"
      />
    </svg>
  )
}

/** Contents glyph: three list rows with leading bullets. */
export function OutlineIcon({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M5.6 4h7.8M5.6 8h7.8M5.6 12h7.8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <circle cx="2.7" cy="4" r="0.9" fill="currentColor" />
      <circle cx="2.7" cy="8" r="0.9" fill="currentColor" />
      <circle cx="2.7" cy="12" r="0.9" fill="currentColor" />
    </svg>
  )
}

/** Close glyph for the contents panel. */
export function CloseIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}
