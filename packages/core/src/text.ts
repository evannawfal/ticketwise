const STOPWORDS = new Set(
  (
    "a an and are as at be but by can could did do does for from had has have how i if in into is it its " +
    "me my of on or our so that the their them then there these they this to up was we were what when where " +
    "which who why will with would you your yours i'm i've it's don't can't please hi hello thanks thank just"
  ).split(" "),
);

/** Very small suffix stemmer, enough to match "refunds"/"refunded"/"refund". */
export function stem(word: string): string {
  if (word.length <= 4) return word;
  for (const suffix of ["ations", "ation", "ings", "ing", "ied", "ies", "ed", "es", "ly", "s"]) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 3) {
      const base = word.slice(0, -suffix.length);
      return suffix === "ied" || suffix === "ies" ? `${base}y` : base;
    }
  }
  return word;
}

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9'_-]*/g) ?? [])
    .map((t) => t.replace(/'s$/, "").replace(/^-+|-+$/g, ""))
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .map(stem);
}

export function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"(])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function truncate(text: string, n: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= n ? t : `${t.slice(0, n - 1).trimEnd()}…`;
}
