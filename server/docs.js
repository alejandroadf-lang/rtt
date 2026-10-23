// The documents attached to a room, and which parts of them matter right now.
//
// The point of the room's documents is that "the Munich contract" is translated
// the way the contract calls it, and a product name is left alone. Two ways they
// are used, and they are different on purpose:
//
//   - RETRIEVAL, per utterance: the few passages that share the most words with
//     what was just said (and the last turn, so a follow-up like "and the penalty?"
//     still finds the contract) go into the translator's prompt. Never the whole
//     pile: a long room would put every document in front of every sentence, which
//     is slow, costs tokens on every turn, and buries the passage that matters.
//   - KEY TERMS, once per room: the proper nouns and acronyms that recur in the
//     documents, handed to speech-to-text so it hears "Kübler" and "GmbH" rather
//     than the nearest common word. ElevenLabs accepts at most 50 terms of 20
//     characters.
//
// Word overlap, not embeddings. Embeddings would be better and would add a model
// call per document and per sentence; for a handful of uploaded files the overlap
// finds the right passage, and a miss costs one sentence of terminology rather
// than a wrong answer.

export const MAX_DOC_BYTES = 200_000;
export const MAX_DOCS_PER_ROOM = 20;
const CHUNK_CHARS = 700;

// Only text is read. A PDF or Word file is refused by name rather than decoded as
// garbage: a translator told that a contract says "%PDF-1.7 obj stream" would use it.
const TEXT_TYPE = /\.(txt|md|markdown|csv|json|html?)$/i;

const STOP = new Set(['the', 'and', 'for', 'that', 'with', 'this', 'from', 'are', 'was', 'were', 'will', 'shall', 'have', 'has', 'not', 'but', 'you', 'your', 'our', 'their', 'der', 'die', 'das', 'und', 'les', 'des', 'una', 'los', 'las', 'que', 'por', 'con']);

const words = (text) => String(text || '').toLowerCase().match(/[\p{L}\p{N}]{3,}/gu)?.filter((w) => !STOP.has(w)) || [];

/**
 * Splits a document at paragraph breaks into passages of about CHUNK_CHARS, never
 * cutting a paragraph in the middle unless one alone is longer than that.
 */
export function chunk(text) {
  const out = [];
  let current = '';
  for (const para of String(text || '').split(/\n\s*\n/)) {
    const p = para.trim();
    if (!p) continue;
    if (current && current.length + p.length > CHUNK_CHARS) {
      out.push(current);
      current = '';
    }
    if (p.length > CHUNK_CHARS * 2) {
      for (let i = 0; i < p.length; i += CHUNK_CHARS) out.push(p.slice(i, i + CHUNK_CHARS));
    } else {
      current = current ? `${current}\n\n${p}` : p;
    }
  }
  if (current) out.push(current);
  return out;
}

/** Adds one document to a room, or says why not. Returns { ok, reason? }. */
export function addDocument(room, { name, text }) {
  const label = String(name || '').trim().slice(0, 120);
  if (!label) return { ok: false, reason: 'The document needs a file name.' };
  if (!TEXT_TYPE.test(label)) return { ok: false, reason: `"${label}" is not a text file. Upload .txt, .md, .csv, .json or .html; export a PDF or Word file to text first.` };
  if (typeof text !== 'string' || !text.trim()) return { ok: false, reason: `"${label}" is empty.` };
  if (Buffer.byteLength(text) > MAX_DOC_BYTES) return { ok: false, reason: `"${label}" is larger than ${MAX_DOC_BYTES / 1000} KB. Split it, or upload the part this conversation needs.` };
  if (room.docs.length >= MAX_DOCS_PER_ROOM) return { ok: false, reason: `This room already has ${MAX_DOCS_PER_ROOM} documents.` };
  // Replacing a file of the same name keeps the room from filling with versions.
  room.docs = room.docs.filter((d) => d.name !== label);
  room.docs.push({ name: label, chunks: chunk(text), text });
  return { ok: true };
}

/**
 * The passages most relevant to `query`, best first, each labelled with its file.
 * A passage that shares no word with the query is never returned.
 */
export function retrieve(room, query, limit = 5) {
  const want = new Set(words(query));
  if (!want.size) return [];
  const scored = [];
  for (const doc of room.docs) {
    doc.chunks.forEach((passage, index) => {
      const have = new Set(words(passage));
      let shared = 0;
      for (const w of want) if (have.has(w)) shared += 1;
      if (shared) scored.push({ doc: doc.name, index, text: passage, score: shared / Math.sqrt(have.size || 1) });
    });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

/**
 * Proper nouns and acronyms that recur in the documents, for speech-to-text.
 * Capitalised words not at the start of a sentence, and ALL-CAPS words, ranked by
 * how often they appear; at most 50, each at most 20 characters.
 */
export function keyterms(room, max = 50) {
  const counts = new Map();
  for (const doc of room.docs) {
    for (const m of doc.text.matchAll(/(?<![.!?]\s)(?<!^)\b(\p{Lu}[\p{L}\p{N}&-]{2,19})\b/gmu)) {
      counts.set(m[1], (counts.get(m[1]) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([term]) => !STOP.has(term.toLowerCase()))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([term]) => term);
}
