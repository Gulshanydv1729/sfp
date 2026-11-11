/**
 * Ephemeral vault: overlap resolution, alias assignment, offset-slice
 * sanitization and re-hydration.
 *
 * The vault is deliberately in-memory only (volatile React state). Nothing is
 * ever persisted; the only artifact on disk is the cached model weights, which
 * contain no user text.
 *
 * Aliases are format-preserving so code/SQL surrounding a redacted secret stays
 * syntactically valid, and deterministic: counters live at module scope, so one
 * session always yields the same alias sequence, with one shared counter per
 * alias family (all token-style secrets share `SYNTH_SECRET_TOKEN_N`).
 */

/** Collision priority for the overlap resolver (higher wins). */
const SOURCE_PRIORITY = {
  Manual: 4,
  Regex: 3,
  Entropy: 2,
  'BERT-NER': 1,
}

const ORG_NAMES = [
  'Alpha',
  'Beta',
  'Gamma',
  'Delta',
  'Epsilon',
  'Zeta',
  'Eta',
  'Theta',
  'Iota',
  'Kappa',
  'Lambda',
  'Mu',
]

// Per-session alias counters. Never reset: aliases stay unique for the whole
// session, so a re-hydrated reply can never collide with a newer vault entry.
const counters = {
  EMAIL: 0,
  PRIVATE_IP: 0,
  DB_URI: 0,
  PER: 0,
  ORG: 0,
  LOC: 0,
  MISC: 0,
  PHONE: 0,
  SECRET: 0, // shared by AWS_KEY / API_SECRET / JWT_TOKEN / HIGH_ENTROPY_SECRET
  CUSTOM: 0,
}

function letterName(n) {
  let out = ''
  while (n > 0) {
    const remainder = (n - 1) % 26
    out = String.fromCharCode(65 + remainder) + out
    n = Math.floor((n - 1) / 26)
  }
  return out
}

function greekName(n) {
  const base = ORG_NAMES[(n - 1) % ORG_NAMES.length]
  const cycle = Math.floor((n - 1) / ORG_NAMES.length)
  return cycle === 0 ? base : `${base}${cycle + 1}`
}

/**
 * Deterministic, format-preserving alias for a detection type.
 *
 * @param {string} type
 * @returns {string}
 */
function assignAlias(type) {
  switch (type) {
    case 'EMAIL':
      return `user_${++counters.EMAIL}@example-safe.org`
    case 'PRIVATE_IP':
      return `10.0.0.${101 + counters.PRIVATE_IP++}`
    case 'DB_URI': {
      const n = ++counters.DB_URI
      return `postgres://synth_user_${n}:synth_pass_${n}@db.internal.example:5432/app_db`
    }
    case 'PER':
    case 'PERSON': // defensive: some NER taggers emit the long label
      return `Person_${letterName(++counters.PER)}`
    case 'ORG':
      return `Org_${greekName(++counters.ORG)}`
    case 'LOC':
      return `Location_${letterName(++counters.LOC)}`
    case 'MISC':
      return `Misc_${letterName(++counters.MISC)}`
    case 'PHONE':
      return `+1-555-${String(100 + counters.PHONE++).padStart(4, '0')}`
    case 'CUSTOM':
      return `REDACTED_${++counters.CUSTOM}`
    default:
      // AWS_KEY and any unknown type land in the generic token family.
      return `SYNTH_SECRET_TOKEN_${++counters.SECRET}`
  }
}

/** Validated `[start, end)` spans for an entity (`ranges` if present, else its own span). */
function getRanges(entity) {
  const raw =
    Array.isArray(entity.ranges) && entity.ranges.length > 0
      ? entity.ranges
      : [[entity.start, entity.end]]
  const out = []
  for (const range of raw) {
    const [start, end] = Array.isArray(range) ? range : []
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) out.push([start, end])
  }
  return out
}

/** Sort by start and drop exact duplicates (same span found by two patterns). */
function dedupeRanges(ranges) {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const out = []
  for (const range of sorted) {
    const last = out[out.length - 1]
    if (last && last[0] === range[0] && last[1] === range[1]) continue
    out.push(range)
  }
  return out
}

/**
 * Dedupe detections by `(type, value)`, merging their spans into one entity so
 * a secret that appears several times shares a single alias (one vault row,
 * every occurrence replaced). The first occurrence's metadata is kept.
 *
 * @param {Array<object>} entities
 * @returns {Array<object>}
 */
export function mergeEntities(entities) {
  const byKey = new Map()
  for (const entity of entities ?? []) {
    if (!entity || typeof entity.value !== 'string' || entity.value === '') continue
    const ranges = getRanges(entity)
    if (!ranges.length) continue
    const key = `${entity.type}|${entity.value}`
    const existing = byKey.get(key)
    if (!existing) {
      byKey.set(key, { ...entity, ranges: dedupeRanges(ranges) })
    } else {
      existing.ranges = dedupeRanges([...existing.ranges, ...ranges])
    }
  }

  const merged = []
  for (const entity of byKey.values()) {
    merged.push({ ...entity, start: entity.ranges[0][0], end: entity.ranges[0][1] })
  }
  merged.sort((a, b) => a.start - b.start)
  return merged
}

/**
 * Range-based overlap resolution (R5).
 *
 * Instances are sorted by `start` asc, then span length desc, then source
 * priority, then confidence. An occupied-range walk accepts an instance only if
 * it does not collide; on collision the winner is decided by source priority
 * (`Regex > Entropy > BERT-NER`, with `Manual` above all), then higher
 * confidence, then the longer span — so a Regex span starting slightly later
 * can still evict an Entropy span that contains it.
 *
 * @param {Array<object>} entities
 * @returns {Array<object>} non-overlapping entities; spans kept on `ranges`,
 *   with `start`/`end` set to the first surviving span
 */
export function resolveOverlaps(entities) {
  const instances = []
  ;(entities ?? []).forEach((entity, entityIndex) => {
    for (const [start, end] of getRanges(entity)) {
      instances.push({ entity, entityIndex, start, end })
    }
  })
  if (!instances.length) return []

  const rank = (entity) => SOURCE_PRIORITY[entity?.source] ?? 0
  instances.sort(
    (a, b) =>
      a.start - b.start ||
      b.end - b.start - (a.end - a.start) ||
      rank(b.entity) - rank(a.entity) ||
      (b.entity.confidence ?? 0) - (a.entity.confidence ?? 0) ||
      a.entityIndex - b.entityIndex,
  )

  /** Lexicographic collision winner: priority, then confidence, then length. */
  const beats = (candidate, incumbent) => {
    const byRank = rank(candidate.entity) - rank(incumbent.entity)
    if (byRank !== 0) return byRank > 0
    const byConfidence = (candidate.entity.confidence ?? 0) - (incumbent.entity.confidence ?? 0)
    if (byConfidence !== 0) return byConfidence > 0
    return candidate.end - candidate.start > incumbent.end - incumbent.start
  }

  const accepted = []
  for (const instance of instances) {
    const conflicts = accepted.filter(
      (other) =>
        other.entity !== instance.entity && instance.start < other.end && other.start < instance.end,
    )
    if (conflicts.length === 0) {
      accepted.push(instance)
    } else if (conflicts.every((other) => beats(instance, other))) {
      for (const other of conflicts) accepted.splice(accepted.indexOf(other), 1)
      accepted.push(instance)
    }
  }

  const byEntity = new Map()
  for (const instance of accepted) {
    if (!byEntity.has(instance.entity)) byEntity.set(instance.entity, [])
    byEntity.get(instance.entity).push([instance.start, instance.end])
  }

  const resolved = []
  for (const [entity, ranges] of byEntity) {
    ranges.sort((a, b) => a[0] - b[0])
    resolved.push({ ...entity, start: ranges[0][0], end: ranges[0][1], ranges })
  }
  resolved.sort((a, b) => a.start - b.start)
  return resolved
}

/**
 * Spans to redact for one entity. Normal detections carry their own offsets;
 * manual entries made by `makeCustomEntry` carry `start: -1` and are expanded
 * to every (case-insensitive) occurrence of the word in the text.
 */
function occurrencesFor(entity, text) {
  if (Array.isArray(entity.ranges) && entity.ranges.length > 0) {
    return getRanges(entity)
  }
  const { start, end } = entity
  if (
    Number.isFinite(start) &&
    Number.isFinite(end) &&
    start >= 0 &&
    end > start &&
    end <= text.length
  ) {
    return [[start, end]]
  }

  const word = typeof entity.value === 'string' ? entity.value.trim() : ''
  if (!word || !text) return []
  const haystack = text.toLowerCase()
  const needle = word.toLowerCase()
  const ranges = []
  let from = 0
  for (;;) {
    const index = haystack.indexOf(needle, from)
    if (index === -1) break
    ranges.push([index, index + word.length])
    from = index + word.length
  }
  return ranges
}

/**
 * Build the sanitized prompt and the vault entries.
 *
 * Pipeline: drop disabled entities → expand spans → dedupe by `(type, value)`
 * → resolve overlaps → assign aliases → slice-replace by offsets (output is
 * assembled from segments; `String.replace` by value is never used, so repeated
 * values and regex metacharacters cannot corrupt the result).
 *
 * @param {string} rawText
 * @param {Array<object>} entities detections `{ type, value, source, confidence, start, end }`
 * @returns {{ sanitizedText: string, vaultEntries: Array<object>, segments: Array<object> }}
 *   `segments` are the alias spans inside `sanitizedText`, for `<mark>` styling.
 */
export function applySanitization(rawText, entities) {
  const text = rawText ?? ''
  const prepared = []
  for (const entity of entities ?? []) {
    if (!entity || entity.enabled === false) continue
    const ranges = occurrencesFor(entity, text)
    if (!ranges.length) continue
    prepared.push({ ...entity, ranges })
  }

  const resolved = resolveOverlaps(mergeEntities(prepared))

  const vaultEntries = []
  const replacements = []
  resolved.forEach((entity, index) => {
    const alias = entity.alias ?? assignAlias(entity.type)
    vaultEntries.push({
      id: `auto-${index}`,
      original: entity.value,
      alias,
      type: entity.type,
      source: entity.source,
      confidence: entity.confidence ?? 1,
      start: entity.start,
      end: entity.end,
      ranges: entity.ranges,
      enabled: true,
    })
    for (const [start, end] of entity.ranges) {
      replacements.push({ start, end, alias, type: entity.type })
    }
  })

  replacements.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start))

  let sanitizedText = ''
  const segments = []
  let cursor = 0
  for (const replacement of replacements) {
    if (replacement.start < cursor) continue // defensive: resolved spans never overlap
    sanitizedText += text.slice(cursor, replacement.start)
    const segmentStart = sanitizedText.length
    sanitizedText += replacement.alias
    segments.push({
      start: segmentStart,
      end: sanitizedText.length,
      alias: replacement.alias,
      type: replacement.type,
    })
    cursor = replacement.end
  }
  sanitizedText += text.slice(cursor)

  return { sanitizedText, vaultEntries, segments }
}

/**
 * Re-insert originals into an LLM reply. Only enabled vault entries take part.
 * Aliases are sorted by length DESC (so `SYNTH_SECRET_TOKEN_1` can never eat
 * the prefix of `SYNTH_SECRET_TOKEN_10`) and replaced with
 * `split(alias).join(original)` — literal replacement, no regex-escaping
 * pitfalls. Restored ranges are tracked across passes so the UI can highlight
 * the restored segments in the final text.
 *
 * @param {string} llmResponseText
 * @param {Array<object>} vaultEntries
 * @returns {{ restoredText: string, restoredRanges: Array<{start: number, end: number, value: string, alias: string}> }}
 */
export function rehydrateText(llmResponseText, vaultEntries) {
  const text = llmResponseText ?? ''
  if (!text) return { restoredText: '', restoredRanges: [] }

  const aliasMap = new Map()
  for (const entry of vaultEntries ?? []) {
    if (entry?.enabled === true && entry.alias && entry.original) {
      if (!aliasMap.has(entry.alias)) aliasMap.set(entry.alias, entry.original)
    }
  }
  const aliases = [...aliasMap.keys()].sort((a, b) => b.length - a.length)
  if (!aliases.length) return { restoredText: text, restoredRanges: [] }

  const restoredRanges = []
  let current = text
  for (const alias of aliases) {
    const parts = current.split(alias)
    if (parts.length === 1) continue // alias not present in the reply

    const original = aliasMap.get(alias)
    const shift = original.length - alias.length

    // Offsets of this alias's occurrences in the pre-pass text.
    const occurrences = []
    let position = 0
    for (let i = 0; i < parts.length - 1; i++) {
      position += parts[i].length
      occurrences.push(position)
      position += alias.length
    }

    // Previously restored ranges live in pre-pass coordinates: shift the ones
    // sitting after an occurrence of this alias.
    for (const range of restoredRanges) {
      let before = 0
      for (const occurrence of occurrences) {
        if (occurrence + alias.length <= range.start) before += 1
        else break
      }
      if (before > 0) {
        range.start += before * shift
        range.end += before * shift
      }
    }

    // Output offset of the j-th occurrence = its input offset + j * shift.
    occurrences.forEach((occurrence, j) => {
      const start = occurrence + j * shift
      restoredRanges.push({ start, end: start + original.length, value: original, alias })
    })

    current = parts.join(original)
  }

  restoredRanges.sort((a, b) => a.start - b.start)
  return { restoredText: current, restoredRanges }
}

/**
 * Manual redaction entry for a user-chosen word. The entry carries `start: -1`;
 * `applySanitization` expands it to every (case-insensitive) occurrence of the
 * word, all sharing this one alias. `value` mirrors `original` so the object
 * can be pushed straight into the entity list consumed by `applySanitization`.
 *
 * @param {string} word
 * @returns {object|null} null for blank input
 */
export function makeCustomEntry(word) {
  const clean = typeof word === 'string' ? word.trim() : ''
  if (!clean) return null

  const alias = `REDACTED_${++counters.CUSTOM}`
  return {
    id: `manual-${counters.CUSTOM}`,
    type: 'CUSTOM',
    original: clean,
    value: clean,
    alias,
    source: 'Manual',
    confidence: 1,
    start: -1,
    end: -1,
    enabled: true,
  }
}
