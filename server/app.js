// The HTTP and WebSocket surface.
//
// Plain node:http rather than a framework: five routes, one WebSocket path, and
// nothing here that a framework would make shorter.
//
// Dependencies (speech-to-text, speech, translation) are passed in. index.js
// passes the real ones; the tests pass fakes, so the whole room can be exercised
// without a network or a key.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { createRoom, getRoom, seatFor, partnerSeat, languageName, LANGUAGES } from './rooms.js';
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
  return { ready: !missing.length, missing, languages: LANGUAGES };
}

export function createApp({ env = process.env, translator, listen, speak }) {
  const maxSeconds = (Number(env.ROOM_MAX_MINUTES) || 60) * 60;

  const sockets = new Map(); // seat object -> { transcriber }
  const sendTo = (room, seatName, message) => {
    const ws = room.seats[seatName].socket;
    if (ws?.readyState === 1) ws.send(JSON.stringify(message));
  };
  const pipeline = createPipeline({
    translator,
    speak,
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
      if (req.method === 'GET' && url.pathname === '/api/status') return json(res, 200, describeStatus(env));

      if (req.method === 'POST' && url.pathname === '/api/rooms') {
        const status = describeStatus(env);
        if (!status.ready) return json(res, 503, { error: `Rooms cannot start: set ${status.missing.join(' and ')} on the server.` });
        const body = await readJson(req);
        const room = createRoom({ hostLanguage: body.hostLanguage, guestLanguage: body.guestLanguage });
        return json(res, 201, { roomId: room.id, hostToken: room.seats.host.token, guestToken: room.seats.guest.token });
      }

      const match = url.pathname.match(/^\/api\/rooms\/([\w-]+)(\/docs)?$/);
      if (match) {
        const room = getRoom(match[1]);
        const seat = room && seatFor(room, req.headers['x-room-token']);
        // The same answer for "no such room" and "wrong token": a guess learns nothing.
        if (!room || !seat) return json(res, 404, { error: 'No such room, or the link is wrong or has expired.' });

        if (req.method === 'GET' && !match[2]) {
          return json(res, 200, {
            you: seat,
            yourLanguage: room.seats[seat].language,
            theirLanguage: room.seats[partnerSeat(seat)].language,
            theirLanguageName: languageName(room.seats[partnerSeat(seat)].language),
            documents: room.docs.map((d) => d.name),
            partnerHere: Boolean(room.seats[partnerSeat(seat)].socket),
          });
        }
        if (req.method === 'POST' && match[2]) {
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

  async function attach(ws, room, seatName) {
    const seat = room.seats[seatName];
    // One connection per seat: a second tab replaces the first rather than both
    // streaming audio into the same speech-to-text bill.
    if (seat.socket && seat.socket !== ws) {
      seat.socket.close(4000, 'Opened somewhere else');
      sockets.get(seat)?.transcriber?.close();
    }
    seat.socket = ws;
    const partnerName = partnerSeat(seatName);
    sendTo(room, partnerName, { type: 'partner', here: true });
    sendTo(room, seatName, { type: 'ready', partnerHere: Boolean(room.seats[partnerName].socket) });

    let transcriber = null;
    let seconds = 0;
    const fail = (err) => sendTo(room, seatName, { type: 'error', message: err.message });
    try {
      transcriber = await listen({
        language: seat.language,
        keyterms: keyterms(room),
        onPartial: (text) => sendTo(room, seatName, { type: 'partial', text }),
        onCommitted: (text) => runTurn(room, seatName, text),
        onError: fail,
      });
    } catch (err) {
      fail(new Error(`Could not start listening: ${err.message}`));
      return ws.close(4001, 'Speech-to-text unavailable');
    }
    sockets.set(seat, { transcriber });

    ws.on('message', (data, isBinary) => {
      if (!isBinary) return;
      // Counted from the audio itself (16-bit mono), not from a clock a client could
      // slow down: this is what the speech-to-text bill is made of.
      seconds += data.length / 2 / MIC_SAMPLE_RATE;
      room.secondsUsed += data.length / 2 / MIC_SAMPLE_RATE;
      if (room.secondsUsed > maxSeconds) {
        fail(new Error(`This room has used its ${maxSeconds / 60} minutes of speech. Start a new room to keep talking (ROOM_MAX_MINUTES sets the limit).`));
        return ws.close(4002, 'Room time used');
      }
      transcriber.send(data);
    });
    ws.on('close', () => {
      transcriber.close();
      if (seat.socket === ws) {
        seat.socket = null;
        sendTo(room, partnerName, { type: 'partner', here: false });
      }
    });
  }

  return { server, wss };
}
