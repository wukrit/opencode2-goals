/**
 * Verdict parsing + capped file reads for graph-mode completion gating
 * (issue #6).
 *
 * The verifier's `verdict.md` is the only artifact the plugin trusts: the
 * parser is strict-but-forgiving (required verdict/gate lines and a Node
 * acceptance section; drift-tolerant findings sections). Pure except for the
 * file reader, which is capped and scope-checked by the caller.
 */

export const MAX_VERDICT_BYTES = 64 * 1024

export type ParsedVerdict =
  | {
      ok: true
      verdict: "pass" | "fail"
      gate: string
      gateGreen: boolean
      p1: number
      p2: number
      p3: number
      unproven: string[]
    }
  | { ok: false; error: string }

const VERDICT_LINE = /^\s*verdict\s*:\s*(pass|fail)\b/im
const GATE_LINE = /^\s*gate\s*:\s*(.+?)\s*$/im
const SECTION_LINE = /^(#{1,4})\s*(.+?)\s*$/

const RED_TOKENS = /\b(fail|failed|failing|failure|failures|red|error|errors|exit [1-9]|panic)\b/i
const GREEN_TOKENS = /\b(pass|passed|passing|green|exit 0|0 fail|all green)\b/i
const OK_WORD = /\bok\b/i

function countBullets(lines: string[]): number {
  let count = 0
  for (const line of lines) {
    if (!/^\s*[-*]\s+\S/.test(line)) continue
    if (/^\s*[-*]\s+(no findings|none\b|n\/a)/i.test(line)) continue
    count++
  }
  return count
}

/**
 * Split markdown into sections keyed by lowercase heading text. Content before
 * the first heading is ignored (the `# Verdict — <run>` title carries no fields).
 */
function sections(text: string): Array<{ level: number; title: string; lines: string[] }> {
  const out: Array<{ level: number; title: string; lines: string[] }> = []
  let current: { level: number; title: string; lines: string[] } | undefined
  for (const line of text.split("\n")) {
    const match = SECTION_LINE.exec(line)
    if (match) {
      current = { level: match[1]!.length, title: match[2]!.toLowerCase(), lines: [] }
      out.push(current)
      continue
    }
    current?.lines.push(line)
  }
  return out
}

function sectionLines(all: ReturnType<typeof sections>, wants: (title: string) => boolean): string[] {
  const found = all.filter((s) => wants(s.title))
  return found.flatMap((s) => s.lines)
}

const isP1 = (t: string): boolean => /^p1\b/.test(t)
const isP2 = (t: string): boolean => /^p2\b/.test(t)
const isP3 = (t: string): boolean => /^p3\b/.test(t)

export function parseVerdict(text: string): ParsedVerdict {
  const verdictMatch = VERDICT_LINE.exec(text)
  if (!verdictMatch) return { ok: false, error: "no `verdict: pass|fail` line" }
  const gateMatch = GATE_LINE.exec(text)
  if (!gateMatch) return { ok: false, error: "no `gate: <command + result>` line" }
  const gate = gateMatch[1]!.trim()
  if (!gate) return { ok: false, error: "empty gate result" }
  // Zero-counts ("0 failed", "0 errors") are green signals, not red ones.
  const redScan = gate.replace(/\b0\s+(fail\w*|error\w*)/gi, "")
  const green = (GREEN_TOKENS.test(gate) || OK_WORD.test(gate)) && !RED_TOKENS.test(redScan)
  const all = sections(text)
  const acceptance = sectionLines(all, (t) => t.startsWith("node acceptance"))
  if (acceptance.length === 0 || acceptance.every((l) => !l.trim())) {
    return { ok: false, error: "no `Node acceptance` section" }
  }
  const unproven: string[] = []
  for (const line of acceptance) {
    const match = /^\s*[-*]\s*N(\d+)\s*:\s*(.+?)\s*$/.exec(line)
    if (!match) continue
    if (/not proven/i.test(match[2]!)) unproven.push(`N${match[1]}`)
  }
  return {
    ok: true,
    verdict: verdictMatch[1]!.toLowerCase() as "pass" | "fail",
    gate,
    gateGreen: green,
    p1: countBullets(sectionLines(all, isP1)),
    p2: countBullets(sectionLines(all, isP2)),
    p3: countBullets(sectionLines(all, isP3)),
    unproven,
  }
}

/** Capped UTF-8 read; never throws (errors become values for the caller to route). */
export async function readVerdictFile(absPath: string): Promise<{ text: string } | { error: string }> {
  try {
    const fs = await import("node:fs/promises")
    const handle = await fs.open(absPath, "r")
    try {
      const stat = await handle.stat()
      if (!stat.isFile()) return { error: "not a file" }
      const size = Math.min(stat.size, MAX_VERDICT_BYTES)
      const buffer = Buffer.alloc(Math.max(size, 0))
      await handle.read(buffer, 0, size, 0)
      return { text: buffer.toString("utf8") }
    } finally {
      await handle.close()
    }
  } catch {
    return { error: "not readable" }
  }
}
