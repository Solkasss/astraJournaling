/** A single journal entry — rendered as one star in the sky. */
export interface JournalEntry {
  id: string;
  text: string;
  /** Normalized hashtags without the leading '#'. */
  tags: string[];
  createdAt: number;
}

export type StarHue = 'lavender' | 'gold' | 'cyan';
