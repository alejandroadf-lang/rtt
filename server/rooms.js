// Rooms: two people, one document shelf, in memory.
//
// In memory on purpose. A room is a conversation, not a record: when the server
// restarts the conversation is over, and nothing about it (audio, transcript,
// documents) is written to disk. That is also the privacy answer: there is
// nothing stored to leak or to delete.
//
// Access is by link. The creator gets a token for the room; the guest link is the
// same room with the guest token. Anyone holding a token is that participant, so
// tokens are random and long, and a room expires on its own.

import crypto from 'node:crypto';

// Languages a person may speak or read. Speech-to-text hears many more languages
// than the voice model can speak, so the two lists differ on purpose: choosing
// Thai to READ works (the other person's sentence arrives as Thai text), it just
// has no spoken voice with Flash v2.5, and the page says so rather than hiding Thai.
export const VOICE_LANGUAGES = {
  ar: 'Arabic', bg: 'Bulgarian', cs: 'Czech', da: 'Danish', de: 'German', el: 'Greek', en: 'English',
  es: 'Spanish', fi: 'Finnish', fil: 'Filipino', fr: 'French', hi: 'Hindi', hr: 'Croatian', hu: 'Hungarian',
  id: 'Indonesian', it: 'Italian', ja: 'Japanese', ko: 'Korean', ms: 'Malay', nl: 'Dutch', no: 'Norwegian',
  pl: 'Polish', pt: 'Portuguese', ro: 'Romanian', ru: 'Russian', sk: 'Slovak', sv: 'Swedish', ta: 'Tamil',
  tr: 'Turkish', uk: 'Ukrainian', vi: 'Vietnamese', zh: 'Chinese',
};
export const LANGUAGES = {
  ...VOICE_LANGUAGES,
  th: 'Thai', he: 'Hebrew', bn: 'Bengali', fa: 'Persian', ur: 'Urdu',
};

/**
 * Whether the voice model can speak this language. ELEVENLABS_VOICE_LANGUAGES
 * (comma-separated codes) replaces the default when a different voice model is
 * configured: a model with more languages should not need a code change.
 */
export function hasVoice(code, env = process.env) {
  const override = (env.ELEVENLABS_VOICE_LANGUAGES || '').split(',').map((c) => c.trim()).filter(Boolean);
  return override.length ? override.includes(code) : code in VOICE_LANGUAGES;
}

// ElevenLabs' own premade voices, which every account has. Two different ones, so the
// two people in a room sound different from the first sentence; each can choose
// another. `voice` is how the OTHER person hears you when your words are translated.
export const DEFAULT_VOICES = { host: 'JBFqnCBsd6RMkjVDRZzb', guest: 'EXAVITQu4vr4xnSDxMaL' };
const VOICE_ID = /^[A-Za-z0-9]{10,40}$/;

const ROOM_TTL_MS = 4 * 3_600_000;
const rooms = new Map();

const id = (bytes) => crypto.randomBytes(bytes).toString('base64url');

export function languageName(code) {
  return LANGUAGES[code] || null;
}

/**
 * A new room. Languages are not part of making it: each person chooses their own
 * (what they speak, what they hear) from inside, and can change them mid-conversation.
 */
export function createRoom(now = Date.now()) {
  sweep(now);
  const room = {
    id: id(9),
    createdAt: now,
    docs: [],
    // Two seats, each with its own token, filled when someone connects. `input` is the
    // language the person speaks; `output` the one they want to hear and read. They are
    // usually the same, and null until the person has chosen.
    seats: {
      host: { token: id(18), input: null, output: null, voice: DEFAULT_VOICES.host, socket: null },
      guest: { token: id(18), input: null, output: null, voice: DEFAULT_VOICES.guest, socket: null },
    },
    history: [],
    // What happened in this room, newest last, for the "copy diagnostics" button.
    // Memory only, like everything else here, and gone with the room.
    log: [],
    secondsUsed: 0,
  };
  rooms.set(room.id, room);
  return room;
}

/** Sets one seat's languages, or throws a sentence that says which one is wrong. */
export function setLanguages(room, seatName, { input, output }) {
  for (const [label, code] of [['speak', input], ['hear', output]]) {
    if (!LANGUAGES[code]) throw new Error(`"${code}" is not a language this app can ${label}. Use one of: ${Object.keys(LANGUAGES).join(', ')}.`);
  }
  const seat = room.seats[seatName];
  const changedInput = seat.input !== input;
  seat.input = input;
  seat.output = output;
  return { changedInput };
}

/** Sets the voice this person is heard in, or throws a sentence saying why not. */
export function setVoice(room, seatName, voiceId) {
  if (!VOICE_ID.test(String(voiceId || ''))) throw new Error('That is not a voice id. Pick one from the list.');
  room.seats[seatName].voice = voiceId;
}

/** Records one event for the room's diagnostics. The newest 200 are kept. */
export function logEvent(room, event) {
  room.log.push({ at: new Date().toISOString(), ...event });
  if (room.log.length > 200) room.log.splice(0, room.log.length - 200);
}

export function getRoom(roomId, now = Date.now()) {
  const room = rooms.get(roomId);
  if (!room) return null;
  if (now - room.createdAt > ROOM_TTL_MS) {
    rooms.delete(roomId);
    return null;
  }
  return room;
}

/** Which seat a token opens, or null. Compared in constant time. */
export function seatFor(room, token) {
  const given = Buffer.from(String(token || ''));
  for (const [name, seat] of Object.entries(room.seats)) {
    const real = Buffer.from(seat.token);
    if (given.length === real.length && crypto.timingSafeEqual(given, real)) return name;
  }
  return null;
}

export const partnerSeat = (name) => (name === 'host' ? 'guest' : 'host');

function sweep(now) {
  for (const [roomId, room] of rooms) if (now - room.createdAt > ROOM_TTL_MS) rooms.delete(roomId);
}

export const __clearRoomsForTests = () => rooms.clear();
