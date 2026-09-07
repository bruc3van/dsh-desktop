/** Selection controls share the host palette, while actions keep solid pills. */
export function choiceControlsCss(scope: string, selectedClass: string): string {
  const group = `${scope} [role="radiogroup"]`
  const radio = `${group}>button`
  const check = `${scope} button[data-smart-runtime]`
  return `${group}{display:inline-flex;max-width:100%;gap:2px;padding:3px;border-radius:10px;background:var(--choice-surface);border:1px solid var(--choice-border)}
${radio},${radio}:hover{min-height:30px;padding:4px 16px;border:1px solid transparent;border-radius:7px;background:transparent;color:var(--choice-muted);font-weight:400;box-shadow:none}
${radio}.${selectedClass},${radio}.${selectedClass}:hover{background:var(--choice-inverse);color:var(--choice-text);border-color:var(--choice-border);font-weight:500;box-shadow:0 1px 3px #0000000d;opacity:1}
${radio}::before,${radio}::after{content:none}
${check},${check}:hover,${check}.${selectedClass},${check}.${selectedClass}:hover{position:relative;display:inline-flex;align-items:center;gap:8px;min-height:32px;padding:5px 8px;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--choice-text);font-weight:400;opacity:1}
${check}:hover,${check}.${selectedClass}:hover{background:var(--choice-surface)}
${check}::before{content:"";box-sizing:border-box;width:16px;height:16px;flex:0 0 16px;border:1px solid var(--choice-border);border-radius:4px;background:var(--choice-inverse)}
${check}.${selectedClass}::before{background:var(--choice-text);border-color:var(--choice-text)}
${check}.${selectedClass}::after{content:"";position:absolute;left:14px;top:50%;width:4px;height:8px;border:solid var(--choice-inverse);border-width:0 1.5px 1.5px 0;transform:translateY(-65%) rotate(45deg)}
${radio}:focus-visible,${check}:focus-visible{outline:2px solid var(--choice-text);outline-offset:2px}
${radio}:disabled,${check}:disabled{opacity:.5;cursor:default}`
}
