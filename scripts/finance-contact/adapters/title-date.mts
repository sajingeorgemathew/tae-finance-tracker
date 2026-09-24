/**
 * Reading a date out of a table title, exactly as written.
 *
 * Titles in the master rosters state a day, a month and a four-digit year in
 * either order ("17th March 2025", "January 12, 2026", "April 27,2026",
 * "06th October 2025"). Only a title stating all three becomes an ISO date; a
 * title stating a month and year alone yields a label but no date, and a
 * two-digit year is never expanded.
 */

const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
}

export interface TitleDate {
  /** `YYYY-MM-DD` when the text states day, month and year. */
  isoDate: string | null
  /** `YYYY-MM` when at least month and year are stated. */
  yearMonth: string | null
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function valid(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

export function parseTitleDate(text: string): TitleDate {
  const cleaned = text.replace(/\s+/g, ' ').trim()

  // "17th March 2025", "06th October 2025", "1st Dec 2025"
  let match = /(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\.?,?\s+(\d{4})/.exec(cleaned)
  if (match) {
    const month = MONTHS[match[2].toLowerCase()]
    const day = Number(match[1])
    const year = Number(match[3])
    if (month !== undefined && valid(year, month, day)) {
      return { isoDate: `${year}-${pad(month)}-${pad(day)}`, yearMonth: `${year}-${pad(month)}` }
    }
  }

  // "January 12, 2026", "April 27,2026", "June 1 2026"
  match = /([A-Za-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?\s*,?\s*(\d{4})/.exec(cleaned)
  if (match) {
    const month = MONTHS[match[1].toLowerCase()]
    const day = Number(match[2])
    const year = Number(match[3])
    if (month !== undefined && valid(year, month, day)) {
      return { isoDate: `${year}-${pad(month)}-${pad(day)}`, yearMonth: `${year}-${pad(month)}` }
    }
  }

  // "Dec 2025", "August 2026" — month and year only.
  match = /\b([A-Za-z]+)\.?\s+(\d{4})\b/.exec(cleaned)
  if (match) {
    const month = MONTHS[match[1].toLowerCase()]
    if (month !== undefined) return { isoDate: null, yearMonth: `${match[2]}-${pad(month)}` }
  }

  return { isoDate: null, yearMonth: null }
}
