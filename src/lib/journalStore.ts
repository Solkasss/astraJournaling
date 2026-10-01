import type { JournalEntry } from './journalTypes';

const STORAGE_KEY = 'astrajournal.entries.v1';
const DAY = 24 * 60 * 60 * 1000;

export const MAX_TAGS = 8;

export function createId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Lowercase, strip '#', keep letters/numbers/dash/underscore. */
export function normalizeTag(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/^#+/, '')
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 24);
}

/** First-visit sky so the constellation engine has something to show. */
function seedEntries(): JournalEntry[] {
  const seeds: Array<[string, string[]]> = [
    ['Walked the long way home under a thin moon. Didn’t check my phone once. The quiet felt like a room I’d forgotten I owned.', ['night-walks', 'calm', 'reflections']],
    ['Dreamt of a lighthouse that hummed instead of shining. Woke up oddly rested.', ['dreams', 'calm']],
    ['Mom called just to read me a recipe. I wrote it down even though I’ll never make it.', ['family', 'gratitude']],
    ['Shipped the thing at work. Relief more than pride. I want to notice that.', ['work', 'reflections']],
    ['Swam at dusk. The water held everything I couldn’t say out loud.', ['ocean', 'calm', 'gratitude']],
    ['The recurring dream again — the train with no stations. This time I wasn’t afraid.', ['dreams', 'reflections']],
    ['Three small good things: warm bread, an unexpected message, the cat asleep on my notes.', ['gratitude', 'calm']],
    ['Hard meeting. Breathed through it. I said the true thing, gently.', ['work', 'calm']],
    ['Grandpa’s old watch stopped at 4:12. I like thinking that’s when he’s thinking of me.', ['family', 'reflections']],
    ['The night tide was loud tonight. Walked until it wasn’t.', ['ocean', 'night-walks']],
    ['Dreamt my brother and I were kids again, building a fort out of stars.', ['dreams', 'family']],
  ];
  const now = Date.now();
  return seeds.map(([text, tags], i) => ({
    id: createId(),
    text,
    tags,
    createdAt: now - (seeds.length - i) * 2 * DAY,
  }));
}

export function loadEntries(): JournalEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) {
      const seeded = seedEntries();
      saveEntries(seeded);
      return seeded;
    }
    const parsed = JSON.parse(raw) as JournalEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveEntries(entries: JournalEntry[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    /* storage full or unavailable — keep in memory */
  }
}
