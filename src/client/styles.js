/**
 * The reader's own stylesheet, injected as one host-owned style tag.
 *
 * Only `--dsw-*` theme tokens and layout dimensions are used, so light and dark
 * themes follow the host. PDF.js positions text-layer runs with the
 * `--total-scale-factor`, `--scale-round-*`, `--font-height`, `--rotate`, and
 * `--scale-x` variables that its own TextLayer writes on these nodes; those
 * rules are reproduced from the shipped viewer stylesheet, renamed under the
 * `pdfr-` prefix.
 */
export const CSS_TEXT = `
.pdfr-root {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  min-width: 0;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
}

.pdfr-header {
  display: flex;
  flex: none;
  align-items: center;
  gap: 8px;
  box-sizing: border-box;
  height: 38px;
  padding: 0 8px 0 16px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l3);
}

.pdfr-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pdfr-count {
  flex: none;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
}

.pdfr-button {
  flex: none;
  height: 24px;
  padding: 0 10px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
}

.pdfr-button:hover {
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
}

.pdfr-primary {
  height: 28px;
  padding: 0 14px;
  border: none;
  border-radius: 999px;
  background: var(--dsw-alias-brand-primary);
  color: #ffffff;
  font: inherit;
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
}

.pdfr-primary:hover {
  filter: brightness(1.06);
}

.pdfr-intake {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  min-height: 0;
  overflow: auto;
  padding: 24px;
  text-align: center;
}

.pdfr-emptyIcon {
  color: var(--dsw-alias-label-tertiary);
}

.pdfr-emptyTitle {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}

.pdfr-emptyHint {
  margin: 0 0 6px;
  max-width: 260px;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
}

.pdfr-state {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 24px;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
  text-align: center;
}

.pdfr-index {
  flex: none;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  white-space: nowrap;
}

.pdfr-indexFailed {
  color: var(--dsw-alias-state-error-primary);
}

.pdfr-stateActions {
  display: flex;
  gap: 8px;
}

.pdfr-stateTitle {
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
}

.pdfr-stateDetail {
  max-width: 280px;
  overflow-wrap: anywhere;
  color: var(--dsw-alias-label-tertiary);
}

.pdfr-scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
  background: var(--dsw-alias-bg-layer-1);
}

.pdfr-pages {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  padding: 16px 12px 24px;
}

.pdfr-page {
  position: relative;
  flex: none;
  overflow: hidden;
  background: #ffffff;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.16);
}

.pdfr-canvas {
  display: block;
  width: 100%;
  height: 100%;
}

.pdfr-pageState {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
}

.pdfr-link {
  padding: 0;
  border: none;
  background: transparent;
  color: var(--dsw-alias-brand-primary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.pdfr-launch {
  display: grid;
  place-items: center;
  flex: none;
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  border-radius: 999px;
  background: var(--dsw-specific-selector);
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
}

@media (hover: hover) {
  .pdfr-launch:hover {
    background: var(--dsw-alias-interactive-bg-hover-solid);
  }
}

.pdfr-quote {
  position: absolute;
  z-index: 20;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 12px;
  transform: translateX(-50%);
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 999px;
  background: var(--dsw-alias-bg-overlay);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 12px;
  white-space: nowrap;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18);
  cursor: pointer;
}

.pdfr-quote:hover {
  background: var(--dsw-alias-bg-layer-2);
}

.pdfr-iconButton {
  display: grid;
  place-items: center;
  flex: none;
  width: 24px;
  height: 24px;
  padding: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
}

.pdfr-iconButton:hover:not(:disabled) {
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
}

.pdfr-iconButton:disabled {
  opacity: 0.4;
  cursor: default;
}

.pdfr-outline {
  position: absolute;
  inset: 38px 0 0;
  z-index: 10;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--dsw-alias-bg-base);
}

.pdfr-outlineHead {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: space-between;
  height: 36px;
  padding: 0 8px 0 16px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l1);
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
}

.pdfr-outlineList {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  padding: 6px 6px 16px;
}

.pdfr-outlineRow {
  display: flex;
  align-items: baseline;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 12.5px;
  line-height: 18px;
  text-align: left;
  cursor: pointer;
}

.pdfr-outlineRow:hover:not(:disabled) {
  background: var(--dsw-alias-bg-layer-2);
}

.pdfr-outlineRow:disabled {
  color: var(--dsw-alias-label-secondary);
  cursor: default;
}

.pdfr-outlineRowActive {
  color: var(--dsw-alias-brand-primary);
}

.pdfr-outlineText {
  flex: 1 1 auto;
  min-width: 0;
  overflow-wrap: anywhere;
}

.pdfr-outlinePage {
  flex: none;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.pdfr-notice {
  position: absolute;
  left: 50%;
  bottom: 16px;
  z-index: 5;
  max-width: calc(100% - 32px);
  padding: 8px 12px;
  transform: translateX(-50%);
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-overlay);
  color: var(--dsw-alias-label-primary);
  font-size: 12px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.16);
}

.pdfr-textLayer {
  --min-font-size: 1;
  --text-scale-factor: calc(var(--total-scale-factor) * var(--min-font-size));
  --min-font-size-inv: calc(1 / var(--min-font-size));
  position: absolute;
  inset: 0;
  overflow: clip;
  opacity: 1;
  color-scheme: only light;
  text-align: initial;
  line-height: 1;
  letter-spacing: normal;
  word-spacing: normal;
  text-size-adjust: none;
  forced-color-adjust: none;
  transform-origin: 0 0;
  caret-color: CanvasText;
  z-index: 0;
}

.pdfr-textLayer span,
.pdfr-textLayer br {
  position: absolute;
  color: transparent;
  white-space: pre;
  cursor: text;
  transform-origin: 0% 0%;
  user-select: text;
}

.pdfr-textLayer > :not(.markedContent),
.pdfr-textLayer .markedContent span:not(.markedContent) {
  z-index: 1;
  --font-height: 0;
  --scale-x: 1;
  --rotate: 0deg;
  font-size: calc(var(--text-scale-factor) * var(--font-height));
  transform: rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv));
}

.pdfr-textLayer .markedContent {
  display: contents;
}

.pdfr-textLayer ::selection {
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 32%, transparent);
  color: transparent;
}
`
