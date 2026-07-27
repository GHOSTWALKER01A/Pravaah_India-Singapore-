import { Injectable } from '@nestjs/common'

/**
 * Reconciles the name across every source (PAN, Aadhaar/OKYC, bank penny-drop,
 * Myinfo). This is the single highest-value edge-case in real-world KYC: names
 * legitimately differ by order, honorifics, initials and transliteration, so we
 * NEVER hard-reject on name — low scores route to human review.
 */
@Injectable()
export class NameMatchService {
  private readonly HONORIFICS = ['mr', 'mrs', 'ms', 'dr', 'shri', 'smt', 'kum']

  /** Lowercase, strip honorifics/punctuation, collapse whitespace. */
  private normalize(raw: string): string[] {
    return raw
      .toLowerCase()
      .replace(/[^a-z\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t && !this.HONORIFICS.includes(t))
  }

  /** Order-independent token-set ratio, tolerant of initials. */
  private tokenSetRatio(a: string, b: string): number {
    const A = new Set(this.normalize(a))
    const B = new Set(this.normalize(b))
    if (!A.size || !B.size) return 0

    const bTokens = [...B]
    const matches = [...A].filter(
      (x) =>
        B.has(x) ||
        bTokens.some(
          (y) =>
            (x.length === 1 && y.startsWith(x)) ||
            (y.length === 1 && x.startsWith(y)),
        ),
    ).length

    return (2 * matches) / (A.size + B.size)
  }

  /**
   * Returns the MINIMUM pairwise score across all present sources (all sources
   * must plausibly agree) plus the canonical (most complete) name. A single
   * source scores 1 (nothing to disagree with); zero sources scores 0.
   */
  reconcile(names: Array<string | null | undefined>): {
    score: number
    canonical: string
  } {
    const present = names.filter(
      (n): n is string => !!n && n.trim().length > 0,
    )
    if (present.length < 2) {
      return {
        score: present.length === 1 ? 1 : 0,
        canonical: present[0] ?? '',
      }
    }

    let min = 1
    for (let i = 0; i < present.length; i++) {
      for (let j = i + 1; j < present.length; j++) {
        min = Math.min(min, this.tokenSetRatio(present[i], present[j]))
      }
    }

    const canonical = [...present].sort((a, b) => b.length - a.length)[0]
    return { score: Number(min.toFixed(3)), canonical }
  }
}
