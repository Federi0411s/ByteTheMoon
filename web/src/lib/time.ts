/**
 * ISO 8601 date/time formatting and parsing, always UTC and locale-independent:
 *   CCYY-MM-DD, CCYY-MM-DDTHH:MM:SS, CCYY-MM-DDTHH:MM:SS.sss
 * (Native date inputs follow the OS locale, e.g. gg/mm/aaaa on an Italian PC, so the app avoids them.)
 */

/** CCYY-MM-DD */
export const fmtDate = (ms: number) => new Date(ms).toISOString().slice(0, 10)

/** CCYY-MM-DDTHH:MM:SS, or CCYY-MM-DDTHH:MM:SS.sss when the milliseconds are not zero. */
export function fmtDateTime(ms: number, withMs: boolean | 'auto' = 'auto') {
  const iso = new Date(ms).toISOString() // CCYY-MM-DDTHH:MM:SS.sssZ
  const showMs = withMs === true || (withMs === 'auto' && ms % 1000 !== 0)
  return iso.slice(0, showMs ? 23 : 19)
}

const ISO_RE = /^\s*(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?\s*Z?\s*$/i

/**
 * Parse CCYY-MM-DD, CCYY-MM-DDTHH:MM, CCYY-MM-DDTHH:MM:SS or CCYY-MM-DDTHH:MM:SS.sss as UTC.
 * Returns undefined for anything else (including impossible dates such as 2027-02-30).
 */
export function parseIso(text: string): number | undefined {
  const m = ISO_RE.exec(text)
  if (!m) return undefined
  const [y, mo, d, h = '0', mi = '0', s = '0', frac = '0'] = m.slice(1)
  const ms = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s, +frac.padEnd(3, '0'))
  const back = new Date(ms)
  if (back.getUTCFullYear() !== +y || back.getUTCMonth() !== +mo - 1 || back.getUTCDate() !== +d || +h > 23 || +mi > 59 || +s > 59) return undefined
  return ms
}

export const ISO_PLACEHOLDER = 'YYYY-MM-DDTHH:MM:SS'
