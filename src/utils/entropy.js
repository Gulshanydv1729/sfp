/**
 * Stage A (deterministic regex) + Stage B (Shannon entropy) detection.
 *
 * Every entity returned here is a *detection*: a range in the original text
 * plus metadata. Alias assignment and overlap resolution happen in `vault.js`.
 */

import { mergeEntities, resolveOverlaps } from './vault.js'

/**
 * Ordered regex table. The regex bodies are fixed by the plan — do not edit
 * without a spec change. Array order is the precedence order; `priority` marks
 * the Regex source tier used by the overlap resolver.
 *
 * @type {Array<{type: string, regex: RegExp, priority: number}>}
 */
export const SECRET_PATTERNS = [
  {
    type: 'JWT_TOKEN',
    regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]{10,}\.[A-Za-z0-9._-]{10,}\b/g,
    priority: 3,
  },
  {
    type: 'AWS_KEY',
    regex: /\bAKIA[0-9A-Z]{16}\b/g,
    priority: 3,
  },
  {
    type: 'API_SECRET',
    regex: /\b(sk_live_[0-9a-zA-Z]{16,}|ghp_[0-9a-zA-Z]{20,}|xox[baprs]-[0-9a-zA-Z-]{10,})\b/g,
    priority: 3,
  },
  {
    type: 'DB_URI',
    regex: /\b(postgres|postgresql|mongodb(?:\+srv)?|mysql|redis):\/\/[^\s"']+/gi,
    priority: 3,
  },
  {
    type: 'EMAIL',
    regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    priority: 3,
  },
  {
    type: 'PRIVATE_IP',
    regex:
      /\b(?:(?:10|127)(?:\.\d{1,3}){3}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|192\.168(?:\.\d{1,3}){2})\b/g,
    priority: 3,
  },
  {
    // Requires at least one real separator → won't eat timestamps or bare IDs.
    type: 'PHONE',
    regex: /(?<![\d.])(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}(?![\d.])/g,
    priority: 3,
  },
]

/** Quoted literals: "…", '…', `…`. */
const QUOTED_VALUE_PATTERNS = [
  /"([^"\n]{20,})"/g,
  /'([^'\n]{20,})'/g,
  /`([^`\n]{20,})`/g,
]

/** KEY="…" / KEY: "…" / KEY=unquoted-token assignments (.env, JSON, crash logs). */
const ASSIGNMENT_VALUE_PATTERNS = [
  /\b[A-Za-z_][A-Za-z0-9_]*\s*[:=]\s*["']([^"'\n]{20,})["']/g,
  /\b[A-Za-z_][A-Za-z0-9_]*\s*=\s*([A-Za-z0-9+/=_-]{20,})\b/g,
]

const HIGH_ENTROPY_MIN_LENGTH = 20
const HIGH_ENTROPY_MIN_BITS = 4.2

/**
 * Shannon entropy H(X) = -Σ P(xᵢ)·log₂ P(xᵢ), in bits per character.
 *
 * @param {string} str
 * @returns {number}
 */
export function calculateShannonEntropy(str) {
  if (!str) return 0
  const counts = new Map()
  for (const ch of str) counts.set(ch, (counts.get(ch) ?? 0) + 1)
  let entropy = 0
  for (const count of counts.values()) {
    const p = count / str.length
    entropy -= p * Math.log2(p)
  }
  return entropy
}

/**
 * A DB_URI often sits inside prose ("…/prod_users."), where the greedy
 * `[^\s"']+` swallows trailing punctuation. The regex is fixed by the plan, so
 * trim the value afterwards instead. The trimmed value is a suffix-trimmed
 * prefix of the raw match, so `indexOf` recovers its true offset.
 */
function trimRegexMatch(raw) {
  let value = raw
  while (value.length > 0 && /[.,;:]$/.test(value)) value = value.slice(0, -1)
  return value
}

/**
 * Stage A: run every deterministic pattern and return detections.
 *
 * @param {string} text
 * @returns {Array<{type: string, value: string, start: number, end: number,
 *   source: 'Regex', confidence: number}>}
 */
function runRegexPass(text) {
  const entities = []
  if (!text) return entities

  for (const { type, regex } of SECRET_PATTERNS) {
    regex.lastIndex = 0
    for (const match of text.matchAll(regex)) {
      const value = trimRegexMatch(match[0])
      if (!value) continue
      const start = match.index + match[0].indexOf(value)
      entities.push({
        type,
        value,
        start,
        end: start + value.length,
        source: 'Regex',
        confidence: 1,
      })
    }
  }

  return entities
}

/**
 * Stage B: quoted literals and KEY=value assignments with length ≥ 20, no
 * whitespace and Shannon entropy > 4.2. Candidates already covered by a regex
 * match span are excluded. Nested candidates yield to the longest one.
 *
 * @param {string} text
 * @param {Array<[number, number]>} [regexSpans] spans already claimed by Stage A
 * @returns {Array<{type: 'HIGH_ENTROPY_SECRET', value: string, start: number, end: number,
 *   source: 'Entropy', confidence: number, entropy: number}>}
 */
export function scanHighEntropyStrings(text, regexSpans) {
  const entities = []
  if (!text) return entities

  const claimed = regexSpans ?? runRegexPass(text).map((entity) => [entity.start, entity.end])
  const overlapsAny = (start, end, spans) =>
    spans.some((span) => start < span[1] && span[0] < end)

  const candidates = []
  const seen = new Set()
  const pushCandidate = (value, start) => {
    const key = `${start}:${value}`
    if (seen.has(key)) return
    seen.add(key)
    candidates.push({ value, start, end: start + value.length })
  }

  for (const pattern of QUOTED_VALUE_PATTERNS) {
    pattern.lastIndex = 0
    for (const match of text.matchAll(pattern)) {
      pushCandidate(match[1], match.index + match[0].indexOf(match[1]))
    }
  }
  for (const pattern of ASSIGNMENT_VALUE_PATTERNS) {
    pattern.lastIndex = 0
    for (const match of text.matchAll(pattern)) {
      pushCandidate(match[1], match.index + match[0].lastIndexOf(match[1]))
    }
  }

  // Longest first so a nested short candidate does not shadow a longer secret.
  candidates.sort((a, b) => b.value.length - a.value.length)
  const accepted = []
  for (const candidate of candidates) {
    const { value, start, end } = candidate
    if (value.length < HIGH_ENTROPY_MIN_LENGTH) continue
    if (/\s/.test(value)) continue
    if (overlapsAny(start, end, claimed)) continue
    if (overlapsAny(start, end, accepted)) continue

    const entropy = calculateShannonEntropy(value)
    if (entropy <= HIGH_ENTROPY_MIN_BITS) continue

    // Monotone in entropy, capped so Stage B never claims certainty.
    const confidence = Math.min(0.97, 0.55 + (entropy - HIGH_ENTROPY_MIN_BITS) * 0.16)
    accepted.push([start, end])
    entities.push({
      type: 'HIGH_ENTROPY_SECRET',
      value,
      start,
      end,
      source: 'Entropy',
      confidence: Number(confidence.toFixed(2)),
      entropy: Number(entropy.toFixed(2)),
    })
  }

  return entities.sort((a, b) => a.start - b.start)
}

/**
 * Fast pass = Stage A + Stage B, deduped by `(type, value)` and
 * range-resolved. This is the entity list the worker posts immediately, before
 * (or instead of) the neural pass.
 *
 * @param {string} text
 * @returns {Array<object>}
 */
export function runFastPass(text) {
  if (!text) return []

  const regexEntities = runRegexPass(text)
  const regexSpans = regexEntities.map((entity) => [entity.start, entity.end])
  const entropyEntities = scanHighEntropyStrings(text, regexSpans)
  return resolveOverlaps(mergeEntities([...regexEntities, ...entropyEntities]))
}
