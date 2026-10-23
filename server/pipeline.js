// What happens when someone finishes a sentence.
//
//   committed text -> look up the room's documents -> translate -> speak it to the
//   other person -> show both of them both versions.
//
// Two rules decide most of this file:
//
//   1. Turns are processed in order, per speaker. Translation and speech take
//      different times for a short sentence and a long one, so without a queue the
//      second sentence can be spoken before the first. One promise chain per
//      speaker keeps order without blocking the other person.
//   2. A failure is said, not swallowed. If translation or speech fails the other
//      person gets the original text with the reason, because a silent gap in a
//      live conversation reads as the other person having stopped talking.

import { partnerSeat } from './rooms.js';
import { retrieve } from './docs.js';

const HISTORY_TURNS = 6;

/**
 * Binds the pipeline to its collaborators. `translator.translate`, `speak` and
 * `send(room, seat, message)` / `sendAudio(room, seat, buffer)` are passed in so the whole
 * thing runs in a test with no network.
 */
export function createPipeline({ translator, speak, send, sendAudio, canSpeak = () => true, log = () => {} }) {
  const queues = new Map();
  let turnCounter = 0;

  async function handleTurn(room, seatName, text) {
    const speaker = room.seats[seatName];
    const listenerName = partnerSeat(seatName);
    const listener = room.seats[listenerName];
    const id = ++turnCounter;
    const t0 = Date.now();
    const turn = { id, speaker: seatName, original: text, from: speaker.input, language: speaker.input };

    // The speaker sees their own sentence at once; it is also what the listener
    // falls back to if translation fails below.
    send(room, seatName, { type: 'turn', ...turn, translated: null });

    if (!listener.socket) {
      room.history.push({ speaker: seatName, original: text });
      return;
    }
    if (listener.output === speaker.input) {
      // Same language: nothing to translate, and speaking it back would be an echo.
      send(room, listenerName, { type: 'turn', ...turn, translated: text, language: listener.output });
      room.history.push({ speaker: seatName, original: text });
      return;
    }

    let translated;
    try {
      // The last turn is searched too: "and the penalty?" finds the contract
      // because the sentence before it said "contract".
      const last = room.history.at(-1)?.original || '';
      const passages = retrieve(room, `${last} ${text}`);
      translated = await translator.translate({
        text,
        from: speaker.input,
        to: listener.output,
        passages,
        history: room.history.slice(-HISTORY_TURNS),
      });
    } catch (err) {
      log(room, { type: 'turn_failed', id, stage: 'translate', from: speaker.input, to: listener.output, message: err.message, ms: Date.now() - t0 });
      send(room, listenerName, { type: 'turn', ...turn, translated: null, error: `Could not translate this sentence: ${err.message}` });
      send(room, seatName, { type: 'error', message: `The other person did not get your last sentence translated: ${err.message}` });
      return;
    }
    const translateMs = Date.now() - t0;
    room.history.push({ speaker: seatName, original: text });
    send(room, listenerName, { type: 'turn', ...turn, translated, language: listener.output });
    send(room, seatName, { type: 'translation', id, translated, language: listener.output });

    const event = { type: 'turn', id, from: speaker.input, to: listener.output, voice: speaker.voice, said: text.slice(0, 80), translated: translated.slice(0, 80), translateMs };
    if (!canSpeak(listener.output)) {
      log(room, { ...event, spoken: false, why: 'no voice for this language' });
      // The text is already on their screen. Said once per sentence, in the status
      // line, so the silence is explained instead of looking like a broken voice.
      send(room, listenerName, { type: 'text_only', language: listener.output });
      return;
    }
    let firstAudioMs = null;
    let bytes = 0;
    try {
      send(room, listenerName, { type: 'audio_start', id });
      await speak({ text: translated, language: listener.output, voiceId: speaker.voice }, (audio) => {
        // Time from the end of the sentence to the first sound is the delay a listener feels.
        firstAudioMs ??= Date.now() - t0;
        bytes += audio.length;
        sendAudio(room, listenerName, audio);
      });
      log(room, { ...event, spoken: true, firstAudioMs, totalMs: Date.now() - t0, audioBytes: bytes });
    } catch (err) {
      log(room, { ...event, spoken: false, stage: 'speak', message: err.message, firstAudioMs, audioBytes: bytes });
      // The text already arrived above, so the other person can still read it.
      send(room, listenerName, { type: 'error', message: `Could not speak the translation (shown as text): ${err.message}` });
    } finally {
      send(room, listenerName, { type: 'audio_end', id });
    }
  }

  return {
    /** Queues a finished sentence from `seatName`; resolves when it has been handled. */
    committed(room, seatName, text) {
      const key = `${room.id}:${seatName}`;
      const next = (queues.get(key) || Promise.resolve()).then(() => handleTurn(room, seatName, text)).catch((err) => {
        console.error(`Turn failed in room ${room.id}:`, err.message);
      });
      queues.set(key, next);
      return next;
    },
  };
}
