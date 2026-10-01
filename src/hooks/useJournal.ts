import { useCallback, useEffect, useMemo, useState } from 'react';
import type { JournalEntry } from '@/lib/journalTypes';
import { createId, loadEntries, saveEntries } from '@/lib/journalStore';
import { buildGraph, getConstellations } from '@/lib/constellation';

export function useJournal() {
  const [entries, setEntries] = useState<JournalEntry[]>(() => loadEntries());

  useEffect(() => {
    saveEntries(entries);
  }, [entries]);

  const addEntry = useCallback((text: string, tags: string[]): JournalEntry => {
    const entry: JournalEntry = { id: createId(), text, tags: [...new Set(tags)], createdAt: Date.now() };
    setEntries((prev) => [...prev, entry]);
    return entry;
  }, []);

  const deleteEntry = useCallback((id: string) => {
    setEntries((prev) => prev.filter((e) => e.id !== id));
  }, []);

  const graph = useMemo(() => buildGraph(entries), [entries]);
  const constellations = useMemo(() => getConstellations(entries), [entries]);
  const knownTags = useMemo(
    () => [...graph.tagCounts.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t),
    [graph],
  );

  return { entries, graph, constellations, knownTags, addEntry, deleteEntry };
}
