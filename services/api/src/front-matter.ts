/** Minimal `---` front matter reader for `key: value` pairs. */
export function parseFrontMatter(text: string): { meta: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, "");
  }
  return { meta, body: text.slice(m[0].length) };
}
