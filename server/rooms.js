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

export const LANGUAGES = {
  ar: 'Arabic', bg: 'Bulgarian', cs: 'Czech', da: 'Danish', de: 'German', el: 'Greek', en: 'English',
  es: 'Spanish', fi: 'Finnish', fil: 'Filipino', fr: 'French', hi: 'Hindi', hr: 'Croatian', hu: 'Hungarian',
  id: 'Indonesian', it: 'Italian', ja: 'Japanese', ko: 'Korean', ms: 'Malay', nl: 'Dutch', no: 'Norwegian',
  pl: 'Polish', pt: 'Portuguese', ro: 'Romanian', ru: 'Russian', sk: 'Slovak', sv: 'Swedish', ta: 'Tamil',
  tr: 'Turkish', uk: 'Ukrainian', vi: 'Vietnamese', zh: 'Chinese',
};

const ROOM_TTL_MS = 4 * 3_600_000;
const rooms = new Map();

const id = (bytes) => crypto.randomBytes(bytes).toString('base64url');

export function languageName(code) {
  return LANGUAGES[code] || null;
}

/** A new room. `hostLanguage` is validated; returns the room with both tokens. */
export function createRoom({ hostLanguage, guestLanguage }, now = Date.now()) {
  for (const code of [hostLanguage, guestLanguage]) {
    if (!LANGUAGES[code]) throw new Error(`"${code}" is not a language this app speaks. Use one of: ${Object.keys(LANGUAGES).join(', ')}.`);
  }
  sweep(now);
  const room = {
    id: id(9),
    createdAt: now,
    docs: [],
    // Two seats, each with its own token and language, filled when someone connects.
    seats: {
      host: { token: id(18), language: hostLanguage, socket: null },
      guest: { token: id(18), language: guestLanguage, socket: null },
    },
    history: [],
    secondsUsed: 0,
  };
  rooms.set(room.id, room);
  return room;
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
