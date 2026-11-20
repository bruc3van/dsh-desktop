/** Selection controls share the host palette, matching SegmentedControl and Checkbox. */
export function choiceControlsCss(scope: string, selectedClass: string): string {
  const group = `${scope} [role="radiogroup"]`
  const radio = `${group}>button`
  const check = `${scope} button[data-smart-runtime]`
  return `${group}{display:inline-flex;max-width:100%;gap:2px;padding:4px;border-radius:var(--dsw-radius-md,12px);background:var(--choice-surface);border:0}`
    + `${radio}{display:inline-flex;align-items:center;justify-content:center;height:28px;min-height:28px;padding:0 12px;border:0;border-radius:var(--dsw-radius-sm,8px);background:transparent;color:var(--choice-muted);font-size:13px;line-height:20px;font-weight:400;box-shadow:none;transition:background var(--ds-transition-duration-fast,.1s) var(--ds-ease-in-out,ease),color var(--ds-transition-duration-fast,.1s) var(--ds-ease-in-out,ease)}`
    + `@media(hover:hover){${radio}:hover:not(:disabled){background:transparent;color:var(--choice-text)}}`
    + `${radio}:active:not(:disabled){background:transparent;color:var(--choice-text);opacity:1}`
    + `${radio}.${selectedClass}{background:var(--choice-inverse);color:var(--choice-text);font-weight:500;box-shadow:0 0 0 .5px var(--choice-border),0 1px 2px rgba(0,0,0,.06);opacity:1}`
    + `@media(hover:hover){${radio}.${selectedClass}:hover:not(:disabled){background:var(--choice-inverse);color:var(--choice-text)}}`
    + `${radio}.${selectedClass}:active:not(:disabled){background:var(--choice-inverse);color:var(--choice-text);box-shadow:0 0 0 .5px var(--choice-border),0 1px 2px rgba(0,0,0,.06);opacity:1}`
    + `${radio}::before,${radio}::after{content:none}`
    + `${check},${check}.${selectedClass}{position:relative;display:inline-flex;align-items:center;gap:8px;height:auto;min-height:28px;padding:4px 8px;border:0;border-radius:var(--dsw-radius-sm,8px);background:transparent;color:var(--choice-text);font-size:13px;line-height:20px;font-weight:400;box-shadow:none;opacity:1}`
    + `@media(hover:hover){${check}:hover:not(:disabled),${check}.${selectedClass}:hover:not(:disabled){background:var(--choice-hover,var(--choice-surface));box-shadow:none}}`
    + `${check}:active:not(:disabled),${check}.${selectedClass}:active:not(:disabled){background:var(--choice-hover,var(--choice-surface));color:var(--choice-text);box-shadow:none;opacity:1}`
    + `${check}::before{content:"";box-sizing:border-box;width:16px;height:16px;flex:0 0 16px;border:.5px solid var(--choice-border);border-radius:var(--dsw-radius-xs,4px);background:var(--choice-check-bg,transparent)}`
    + `${check}.${selectedClass}::before{background:var(--choice-text);border-color:var(--choice-text)}`
    + `${check}.${selectedClass}::after{content:"";position:absolute;left:14px;top:50%;width:4px;height:8px;border:solid var(--choice-check-fg,var(--choice-inverse));border-width:0 1.5px 1.5px 0;transform:translateY(-65%) rotate(45deg)}`
    + `${radio}:focus-visible,${check}:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-alias-state-business-primary,rgb(65,118,230));outline-offset:2px}`
    + `${radio}:disabled,${check}:disabled{opacity:.4;cursor:not-allowed}`
}
