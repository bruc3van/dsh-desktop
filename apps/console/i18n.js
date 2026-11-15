// Console language: Chinese source strings, English from a dictionary.
// The choice is remembered per browser; switching reloads the page so module-level labels follow.
import { EN } from './i18n-en.js'

const STORAGE_KEY = 'dsh-console-lang'

function initial() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved === 'zh' || saved === 'en') return saved
  } catch { /* storage unavailable: follow the browser */ }
  return (navigator.language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

export const lang = initial()
document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'

/** A Chinese source string in the current language. */
export function t(text) {
  return lang === 'en' ? EN[text] ?? text : text
}

/** A template with {name} placeholders, translated first, then filled in. */
export function tf(template, values) {
  return t(template).replace(/\{(\w+)\}/g, (match, key) => (values[key] === undefined ? match : String(values[key])))
}

export function setLang(next) {
  try { localStorage.setItem(STORAGE_KEY, next) } catch { /* the reload still applies it for this visit */ }
  location.reload()
}
