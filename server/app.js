// The HTTP and WebSocket surface.
//
// Plain node:http rather than a framework: five routes, one WebSocket path, and
// nothing here that a framework would make shorter.
//
// Dependencies (speech-to-text, speech, translation) are passed in. index.js
// passes the real ones; the tests pass fakes, so the whole room can be exercised
// without a network or a key.

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { createRoom, getRoom, seatFor, partnerSeat, setLanguages, setVoice, hasVoice, LANGUAGES } from './rooms.js';
import { addDocument, keyterms, MAX_DOC_BYTES } from './docs.js';
import { createPipeline } from './pipeline.js';
import { MIC_SAMPLE_RATE } from './voice.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
// A sentence is a few kilobytes of PCM; a frame bigger than this is not microphone audio.
const MAX_AUDIO_FRAME = 64 * 1024;

/**
 * What this server can do right now, as one description of the whole capability.
 * A status that said only "ElevenLabs: ok" would hide that translation is the
 * half that is missing; the missing list names the variable to set for each.
 */
export function describeStatus(env) {
  const missing = [];
  if (!(env.ELEVENLABS_API_KEY || '').trim()) missing.push('ELEVENLABS_API_KEY (speech-to-text and the translated voice)');
  if (!(env.ANTHROPIC_API_KEY || '').trim()) missing.push('ANTHROPIC_API_KEY (the translation itself)');
  // Creating a room spends the owner's ElevenLabs and Anthropic credit, so it is
  // closed unless the owner chose how: a code, or "none" to let anyone. Unset is
  // refused rather than treated as open, so a forgotten variable on the server cannot
  // quietly leave the door open.
  const code = (env.ROOM_ACCESS_CODE || '').trim();
  if (!code) missing.push('ROOM_ACCESS_CODE (any word you choose; or "none" to let anyone create rooms)');
  return { ready: !missing.length, missing, needsCode: Boolean(code) && code.toLowerCase() !== 'none', languages: LANGUAGES, voiceLanguages: Object.keys(LANGUAGES).filter((c) => hasVoice(c, env)) };
}

const sha = (text) => crypto.createHash('sha256').update(String(text)).digest();

// Wrong guesses per client, so a code cannot be found by trying them all: 8 misses
// in 10 minutes and that client waits out the window. The address is the last
// X-Forwarded-For entry, the one the hosting proxy itself appended; earlier entries
// are whatever the client claimed.
const MISS_LIMIT = 8;
const MISS_WINDOW_MS = 10 * 60_000;

export function createApp({ env = process.env, translator, listen, speak, check, voices }) {
  const maxSeconds = (Number(env.ROOM_MAX_MINUTES) || 60) * 60;

  const checks = {};
  const voiceCache = {};
  const misses = new Map(); // client -> [timestamps of wrong codes]
  const sockets = new Map(); // seat object -> { transcriber }
  const sendTo = (room, seatName, message) => {
    const ws = room.seats[seatName].socket;
    if (ws?.readyState === 1) ws.send(JSON.stringify(message));
  };
  const pipeline = createPipeline({
    translator,
    speak,
    canSpeak: (code) => hasVoice(code, env),
    send: sendTo,
    sendAudio: (room, seatName, audio) => {
      const ws = room.seats[seatName].socket;
      if (ws?.readyState === 1) ws.send(audio, { binary: true });
    },
  });
  const runTurn = (room, seatName, text) => pipeline.committed(room, seatName, text);

  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  async function readJson(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_DOC_BYTES * 2) throw Object.assign(new Error('That request is too large.'), { status: 413 });
      chunks.push(chunk);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch {
      throw Object.assign(new Error('The request body is not valid JSON.'), { status: 400 });
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (req.method === 'GET' && url.pathname === '/api/status') {
        const status = describeStatus(env);
        // ?check=1 also asks each provider whether its key works. Cached for a minute:
        // the page is public, and it must not be a way to hammer someone else's API.
        if (url.searchParams.get('check') && status.ready && check) {
          if (!checks.at || Date.now() - checks.at > 60_000) Object.assign(checks, { at: Date.now(), value: await check() });
          status.checks = checks.value;
        }
        return json(res, 200, status);
      }

      if (req.method === 'POST' && url.pathname === '/api/rooms') {
        const status = describeStatus(env);
        if (!status.ready) return json(res, 503, { error: `Rooms cannot start: set ${status.missing.join(' and ')} on the server.` });
        if (status.needsCode) {
          const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').pop().trim();
          const client = forwarded || req.socket.remoteAddress || 'unknown';
          const recent = (misses.get(client) || []).filter((t) => Date.now() - t < MISS_WINDOW_MS);
          if (recent.length >= MISS_LIMIT) return json(res, 429, { error: 'Too many wrong access codes. Wait ten minutes and try again.' });
          // Hashed first so the comparison is over equal-length values and takes the
          // same time whichever character differs.
          const given = sha(req.headers['x-access-code'] || '');
          if (!crypto.timingSafeEqual(given, sha(env.ROOM_ACCESS_CODE.trim()))) {
            misses.set(client, [...recent, Date.now()]);
            return json(res, 401, { error: req.headers['x-access-code'] ? 'Wrong access code.' : 'This server needs an access code to create a room.' });
          }
        }
        const room = createRoom();
        return json(res, 201, { roomId: room.id, hostToken: room.seats.host.token, guestToken: room.seats.guest.token });
      }

      if (req.method === 'GET' && url.pathname === '/api/voices') {
        // Only for someone holding a room token: the list is fetched with the server's key.
        const room = getRoom(url.searchParams.get('room'));
        if (!room || !seatFor(room, req.headers['x-room-token'])) return json(res, 404, { error: 'No such room, or the link is wrong or has expired.' });
        if (!voices) return json(res, 503, { error: 'Voices are not available on this server.' });
        if (!voiceCache.at || Date.now() - voiceCache.at > 600_000) Object.assign(voiceCache, { at: Date.now(), list: await voices() });
        return json(res, 200, { voices: voiceCache.list });
      }

      const match = url.pathname.match(/^\/api\/rooms\/([\w-]+)(\/docs|\/me)?$/);
      if (match) {
        const room = getRoom(match[1]);
        const seat = room && seatFor(room, req.headers['x-room-token']);
        // The same answer for "no such room" and "wrong token": a guess learns nothing.
        if (!room || !seat) return json(res, 404, { error: 'No such room, or the link is wrong or has expired.' });

        if (req.method === 'GET' && !match[2]) {
          const other = room.seats[partnerSeat(seat)];
          return json(res, 200, {
            you: seat,
            yourInput: room.seats[seat].input,
            yourOutput: room.seats[seat].output,
            yourVoice: room.seats[seat].voice,
            theirInput: other.input,
            theirOutput: other.output,
            documents: room.docs.map((d) => d.name),
            partnerHere: Boolean(other.socket),
          });
        }
        if (req.method === 'PUT' && match[2] === '/me') {
          try {
            const body = await readJson(req);
            const { changedInput } = setLanguages(room, seat, { input: body.input, output: body.output });
            if (body.voice !== undefined) setVoice(room, seat, body.voice);
            // What the person speaks is what speech-to-text listens for, so changing it
            // restarts listening; changing only what they hear takes effect on the next sentence.
            if (changedInput && room.seats[seat].socket) await startListening(room, seat);
            const mine = room.seats[seat];
            sendTo(room, partnerSeat(seat), { type: 'partner_languages', input: mine.input, output: mine.output });
            return json(res, 200, { input: mine.input, output: mine.output, voice: mine.voice });
          } catch (err) {
            return json(res, err.status || 400, { error: err.message });
          }
        }
        if (req.method === 'POST' && match[2] === '/docs') {
          const result = addDocument(room, await readJson(req));
          return json(res, result.ok ? 201 : 400, result.ok ? { documents: room.docs.map((d) => d.name) } : { error: result.reason });
        }
      }

      if (req.method === 'GET') {
        const name = url.pathname === '/' || url.pathname.startsWith('/r/') ? 'index.html' : url.pathname.slice(1);
        const file = path.join(PUBLIC_DIR, name);
        // Resolved and checked: "/../.env" must not leave the public folder.
        if (file.startsWith(PUBLIC_DIR + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
          res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
          return fs.createReadStream(file).pipe(res);
        }
      }
      json(res, 404, { error: 'Not found.' });
    } catch (err) {
      json(res, err.status || 500, { error: err.message });
    }
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_AUDIO_FRAME });

  // An upgrade this server does not handle must destroy the socket. A bare return
  // leaves the connection open and idle, forever, once per request.
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    const room = url.pathname === '/ws' ? getRoom(url.searchParams.get('room')) : null;
    const seatName = room && seatFor(room, url.searchParams.get('token'));
    if (!seatName || !describeStatus(env).ready) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => attach(ws, room, seatName));
  });

  // Forgets a seat's session BEFORE closing it: the session's close event is how a
  // drop is noticed, and a close we asked for must not look like one.
  function dropListener(seat) {
    const current = sockets.get(seat)?.transcriber;
    sockets.delete(seat);
    current?.close();
  }

  // (Re)opens speech-to-text for a seat in the language it speaks now. Used when
  // someone connects and when they change what they speak mid-conversation.
  async function startListening(room, seatName) {
    const seat = room.seats[seatName];
    dropListener(seat);
    const fail = (err) => sendTo(room, seatName, { type: 'error', message: err.message });
    const mine = {};
    try {
      mine.transcriber = await listen({
        language: seat.input,
        keyterms: keyterms(room),
        onPartial: (text) => sendTo(room, seatName, { type: 'partial', text }),
        onCommitted: (text) => runTurn(room, seatName, text),
        onError: fail,
        // ElevenLabs closed its side. If this is still the seat's current session and the
        // person is still connected, open a fresh one; at most three times a minute, so a
        // session that keeps dying is reported instead of retried forever.
        onClose: () => {
          if (sockets.get(seat)?.transcriber !== mine.transcriber || seat.socket?.readyState !== 1) return;
          const now = Date.now();
          seat.restarts = [...(seat.restarts || []).filter((t) => now - t < 60_000), now];
          if (seat.restarts.length > 3) return fail(new Error('Speech-to-text keeps disconnecting. Reload the page to try again.'));
          sendTo(room, seatName, { type: 'status', message: 'Speech-to-text reconnected.' });
          startListening(room, seatName);
        },
      });
      sockets.set(seat, { transcriber: mine.transcriber });
      return true;
    } catch (err) {
      fail(new Error(`Could not start listening: ${err.message}`));
      return false;
    }
  }

  async function attach(ws, room, seatName) {
    const seat = room.seats[seatName];
    const partnerName = partnerSeat(seatName);
    const fail = (err) => sendTo(room, seatName, { type: 'error', message: err.message });
    if (!seat.input || !seat.output) {
      // The page sets these before it connects; a connection without them is not one of ours.
      ws.send(JSON.stringify({ type: 'error', message: 'Choose what you speak and what you hear first.' }));
      return ws.close(4003, 'Languages not chosen');
    }
    // One connection per seat: a second tab replaces the first rather than both
    // streaming audio into the same speech-to-text bill.
    if (seat.socket && seat.socket !== ws) seat.socket.close(4000, 'Opened somewhere else');
    seat.socket = ws;
    sendTo(room, partnerName, { type: 'partner', here: true });
    sendTo(room, seatName, { type: 'ready', partnerHere: Boolean(room.seats[partnerName].socket) });

    if (!(await startListening(room, seatName))) return ws.close(4001, 'Speech-to-text unavailable');

    ws.on('message', (data, isBinary) => {
      if (!isBinary) return;
      // Counted from the audio itself (16-bit mono), not from a clock a client could
      // slow down: this is what the speech-to-text bill is made of.
      room.secondsUsed += data.length / 2 / MIC_SAMPLE_RATE;
      if (room.secondsUsed > maxSeconds) {
        fail(new Error(`This room has used its ${maxSeconds / 60} minutes of speech. Start a new room to keep talking (ROOM_MAX_MINUTES sets the limit).`));
        return ws.close(4002, 'Room time used');
      }
      // Not sent means ElevenLabs' side is closed; the close handler is already
      // opening a new session, and this chunk of audio is simply dropped.
      try {
        sockets.get(seat)?.transcriber.send(data);
      } catch {
        // An adapter that throws must not take the server down with it.
      }
    });
    ws.on('close', () => {
      if (seat.socket !== ws) return;
      dropListener(seat);
      seat.socket = null;
      sendTo(room, partnerName, { type: 'partner', here: false });
    });
  }

  return { server, wss };
}
