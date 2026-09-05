/** Measure our local document after temporarily releasing its minimum height. */
export function mainContentHeightScript(fallbackHeight: number): string {
  return '(() => {'
    + 'const main=document.querySelector("main");if(!(main instanceof HTMLElement))return ' + JSON.stringify(fallbackHeight) + ';'
    + 'document.body.style.minHeight="0";main.style.minHeight="0";'
    + 'const height=Math.ceil(main.getBoundingClientRect().height);'
    + 'document.body.style.removeProperty("min-height");main.style.removeProperty("min-height");return height})()'
}
