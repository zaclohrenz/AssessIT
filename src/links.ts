// Pulls clickable web links out of the free-text "Source URL(s)" box, which holds whatever the AI or
// the person typed. Only https links are returned: that's all the app is allowed to open.

const URL_RE = /https:\/\/[^\s<>"'`]+/gi;

/** Distinct https links in `text`, in order, without the punctuation that trails them in prose. */
export function extractUrls(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(URL_RE)) {
    const raw = m[0].replace(/[.,;:!?)\]}]+$/, "");
    try {
      const u = new URL(raw);
      if (u.protocol === "https:" && u.hostname.includes(".") && !out.includes(u.href)) out.push(u.href);
    } catch {
      /* not a link */
    }
  }
  return out;
}

/** "https://www.example.com/a/b?x=1" → "example.com/a/b…": short enough to read in a list. */
export function linkLabel(url: string): string {
  const u = new URL(url);
  const rest = (u.pathname + u.search).replace(/^\/$/, "");
  const label = u.hostname.replace(/^www\./, "") + rest;
  return label.length > 60 ? label.slice(0, 57) + "…" : label;
}
