import type { JournalEntry, StarHue } from './journalTypes';

/**
 * Hashtag Gravity engine.
 *
 * - Every pair of entries that shares ≥1 tag gets a gravity edge.
 * - Edge weight = Jaccard similarity of the tag sets, boosted when the shared
 *   tags also co-occur frequently elsewhere in the journal.
 * - All gravity edges pull stars together in the force layout; only the
 *   strongest few per star are drawn as visible constellation lines.
 */

export interface ConstellationEdge {
  source: string;
  target: string;
  /** Normalized 0..1 */
  weight: number;
  shared: string[];
  /** Drawn as an ambient constellation line. */
  visible: boolean;
}

export interface ConstellationGraph {
  edges: ConstellationEdge[];
  tagCounts: Map<string, number>;
}

export interface Constellation {
  tag: string;
  entryIds: string[];
  hue: StarHue;
}

const HUES: StarHue[] = ['lavender', 'cyan', 'gold'];

export function tagHue(tag?: string): StarHue {
  if (!tag) return 'lavender';
  let h = 0;
  for (let i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) >>> 0;
  return HUES[h % HUES.length];
}

const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

export function buildGraph(
  entries: JournalEntry[],
  maxLinesPerStar = 3,
  minVisibleWeight = 0.15,
): ConstellationGraph {
  const tagCounts = new Map<string, number>();
  const cooccurrence = new Map<string, number>();

  for (const entry of entries) {
    const tags = [...new Set(entry.tags)];
    for (const t of tags) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
    for (let i = 0; i < tags.length; i++) {
      for (let j = i + 1; j < tags.length; j++) {
        const key = pairKey(tags[i], tags[j]);
        cooccurrence.set(key, (cooccurrence.get(key) ?? 0) + 1);
      }
    }
  }

  const raw: Omit<ConstellationEdge, 'visible'>[] = [];
  let maxWeight = 0;

  for (let i = 0; i < entries.length; i++) {
    const a = new Set(entries[i].tags);
    for (let j = i + 1; j < entries.length; j++) {
      const shared = [...new Set(entries[j].tags)].filter((t) => a.has(t));
      if (shared.length === 0) continue;

      const union = new Set([...entries[i].tags, ...entries[j].tags]).size;
      const jaccard = shared.length / union;

      // Pairs of shared tags that also co-occur in *other* entries strengthen the bond.
      let pairBoost = 0;
      for (let x = 0; x < shared.length; x++) {
        for (let y = x + 1; y < shared.length; y++) {
          pairBoost += Math.max(0, (cooccurrence.get(pairKey(shared[x], shared[y])) ?? 0) - 1);
        }
      }

      const weight = jaccard * (1 + Math.log1p(pairBoost));
      maxWeight = Math.max(maxWeight, weight);
      raw.push({ source: entries[i].id, target: entries[j].id, weight, shared });
    }
  }

  // Normalize, then prune to the strongest lines per star for a constellation (not hairball) look.
  const sorted = raw
    .map((e) => ({ ...e, weight: maxWeight > 0 ? e.weight / maxWeight : 0 }))
    .sort((a, b) => b.weight - a.weight);

  const degree = new Map<string, number>();
  const edges: ConstellationEdge[] = sorted.map((e) => {
    const ds = degree.get(e.source) ?? 0;
    const dt = degree.get(e.target) ?? 0;
    const visible = e.weight >= minVisibleWeight && ds < maxLinesPerStar && dt < maxLinesPerStar;
    if (visible) {
      degree.set(e.source, ds + 1);
      degree.set(e.target, dt + 1);
    }
    return { ...e, visible };
  });

  return { edges, tagCounts };
}

/** A constellation is any tag shared by at least two stars. */
export function getConstellations(entries: JournalEntry[]): Constellation[] {
  const byTag = new Map<string, string[]>();
  for (const entry of entries) {
    for (const tag of new Set(entry.tags)) {
      const list = byTag.get(tag) ?? [];
      list.push(entry.id);
      byTag.set(tag, list);
    }
  }
  return [...byTag.entries()]
    .filter(([, ids]) => ids.length >= 2)
    .sort((a, b) => b[1].length - a[1].length)
    .map(([tag, entryIds]) => ({ tag, entryIds, hue: tagHue(tag) }));
}
