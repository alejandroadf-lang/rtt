// The page. Two states: no room in the address (make one), or /r/<room>#<token>
// (be in one). The token lives in the fragment because a fragment is never sent to a
// server, so it is not in anyone's access log or a Referer header.
//
// Text is only ever written with textContent: what the other person said, and the
// names of files they attached, are not markup.

const $ = (id) => document.getElementById(id);
const roomId = location.pathname.startsWith('/r/') ? location.pathname.slice(3) : null;
const token = decodeURIComponent(location.hash.slice(1));

async function api(path, options = {}, authToken = token) {
  const res = await fetch(path, { ...options, headers: { 'content-type': 'application/json', 'x-room-token': authToken, ...options.headers } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `The server answered ${res.status}.`);
  return body;
}

if (roomId && token) enterRoom();
else showCreate();

// ── Making a room ─────────────────────────────────────────────────────────────

async function showCreate() {
  $('create').hidden = false;
  const status = await api('/api/status').catch((e) => ({ ready: false, missing: [e.message] }));
  if (!status.ready) {
    const msg = document.createElement('p');
    msg.textContent = `Rooms cannot start yet: the server needs ${status.missing.join(' and ')}.`;
    msg.style.color = 'var(--warn)';
    $('create').append(msg);
    $('start').disabled = true;
  }
  $('codeBox').hidden = !status.needsCode;
  $('start').addEventListener('click', async () => {
    $('start').disabled = true;
    try {
      const made = await api('/api/rooms', { method: 'POST', body: '{}', headers: { 'x-access-code': $('code').value } }, '');
      const base = `${location.origin}/r/${made.roomId}`;
      const mine = `${base}#${made.hostToken}`;
      const theirs = `${base}#${made.guestToken}`;
      $('links').hidden = false;
      $('links').replaceChildren();
      const open = document.createElement('a');
      open.href = mine;
      open.textContent = 'Open my side';
      const share = document.createElement('div');
      share.className = 'link';
      share.textContent = theirs;
      const copy = document.createElement('button');
      copy.className = 'quiet';
      copy.textContent = 'Copy the link for them';
      copy.addEventListener('click', () => navigator.clipboard.writeText(theirs).then(() => { copy.textContent = 'Copied'; }));
      const note = document.createElement('p');
      note.textContent = 'Send them the second link. Anyone with a link joins as that person, so share it privately.';
      $('links').append(open, share, copy, note);
    } catch (err) {
      alert(err.message);
      $('start').disabled = false;
    }
  });
}

// ── In a room ─────────────────────────────────────────────────────────────────

let ws = null;
let micContext = null;
let micStream = null;
let playContext = null;
let playAt = 0;
let leftover = null;
const turns = new Map();

function setStatus(text, bad = false) {
  $('status').textContent = text;
  $('status').className = bad ? 'bad' : '';
}

async function enterRoom() {
  let info;
  let status;
  try {
    [info, status] = await Promise.all([api(`/api/rooms/${encodeURIComponent(roomId)}`), api('/api/status')]);
  } catch (err) {
    $('create').hidden = true;
    $('room').hidden = false;
    $('mic').hidden = true;
    $('mine').parentElement.parentElement.hidden = true;
    setStatus(err.message, true);
    return;
  }
  $('room').hidden = $('transcript').hidden = $('docs').hidden = false;
  fillLanguages(status.languages, status.voiceLanguages);
  // First visit: what you speak is your browser's language, and you hear the same.
  // Coming back (or reloading) keeps what the room already has for you.
  const guess = (navigator.language || 'en').slice(0, 2);
  $('mine').value = info.yourInput || (guess in status.languages ? guess : 'en');
  $('hear').value = info.yourOutput || $('mine').value;
  showTheirs(info.theirInput, info.theirOutput);
  renderDocs(info.documents);
  setStatus(info.partnerHere ? 'They are here.' : 'Waiting for them to open their link.');

  // Both are saved before the socket opens, because speech-to-text starts in the
  // language you speak. A later change is saved the same way and the server
  // restarts listening itself.
  await saveLanguages();
  connect();
  $('mine').addEventListener('change', saveLanguages);
  $('hear').addEventListener('change', saveLanguages);

  $('file').addEventListener('change', async (e) => {
    for (const file of e.target.files) {
      try {
        const out = await api(`/api/rooms/${encodeURIComponent(roomId)}/docs`, { method: 'POST', body: JSON.stringify({ name: file.name, text: await file.text() }) });
        renderDocs(out.documents);
      } catch (err) {
        setStatus(err.message, true);
      }
    }
    e.target.value = '';
  });
  $('mic').addEventListener('click', () => (micStream ? stopMic() : startMic()));
}

const names = new Intl.DisplayNames(['en'], { type: 'language' });
const label = (code) => (code ? names.of(code) : 'not chosen yet');

function fillLanguages(languages, voiceLanguages) {
  $('mine').replaceChildren(...Object.keys(languages).map((code) => new Option(`${label(code)} (${code})`, code)));
  // A language without a spoken voice can still be read: it is offered, and marked.
  $('hear').replaceChildren(...Object.keys(languages).map((code) => new Option(`${label(code)} (${code})${voiceLanguages.includes(code) ? '' : ' - text only'}`, code)));
}

async function saveLanguages() {
  try {
    await api(`/api/rooms/${encodeURIComponent(roomId)}/me`, { method: 'PUT', body: JSON.stringify({ input: $('mine').value, output: $('hear').value }) });
  } catch (err) {
    setStatus(err.message, true);
  }
}

function showTheirs(input, output) {
  $('theirs').textContent = input ? `They speak ${label(input)} and hear ${label(output)}.` : 'They have not chosen their languages yet.';
}

function renderDocs(names) {
  $('doclist').replaceChildren(...names.map((n) => Object.assign(document.createElement('li'), { textContent: n })));
}

function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?room=${encodeURIComponent(roomId)}&token=${encodeURIComponent(token)}`);
  ws.binaryType = 'arraybuffer';
  ws.onmessage = (e) => (typeof e.data === 'string' ? onMessage(JSON.parse(e.data)) : playPcm(e.data));
  ws.onclose = (e) => {
    stopMic();
    setStatus(e.code === 4000 ? 'This room is open in another tab.' : e.code === 4002 ? 'This room has used its time. Start a new one.' : 'Disconnected. Reload to rejoin.', true);
  };
}

function onMessage(m) {
  if (m.type === 'ready') setStatus(m.partnerHere ? 'They are here.' : 'Waiting for them to open their link.');
  else if (m.type === 'partner') setStatus(m.here ? 'They are here.' : 'They left.');
  else if (m.type === 'partner_languages') showTheirs(m.input, m.output);
  else if (m.type === 'text_only') setStatus(`There is no spoken voice for ${label(m.language)} with this voice model, so it arrives as text only.`);
  else if (m.type === 'partial') $('partial').textContent = m.text;
  else if (m.type === 'turn') showTurn(m);
  else if (m.type === 'translation') {
    const row = turns.get(m.id);
    if (row) row.small.textContent = `They hear: ${m.translated}`;
  } else if (m.type === 'error') setStatus(m.message, true);
}

function showTurn(m) {
  $('partial').textContent = '';
  let row = turns.get(m.id);
  if (!row) {
    const el = document.createElement('div');
    const big = document.createElement('span');
    const small = document.createElement('span');
    small.className = 'small';
    el.append(big, small);
    $('log').append(el);
    row = { el, big, small };
    turns.set(m.id, row);
  }
  // The server sends a turn to the speaker with translated: null and to the listener
  // with the translation; whichever arrives here, what is shown first is what this
  // person understands.
  if (m.translated !== null && m.translated !== undefined) {
    row.el.className = 'turn them';
    row.big.textContent = m.translated;
    row.small.textContent = `Original: ${m.original}`;
  } else if (m.error) {
    row.el.className = 'turn them';
    row.big.textContent = m.original;
    row.small.textContent = m.error;
    row.small.className = 'small bad';
  } else if (!row.el.className) {
    row.el.className = 'turn you';
    row.big.textContent = m.original;
  }
  $('log').scrollTop = $('log').scrollHeight;
}

// ── Microphone ───────────────────────────────────────────────────────────────

async function startMic() {
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
  } catch {
    setStatus('The microphone is blocked. Allow it for this site and try again.', true);
    return;
  }
  micContext = new AudioContext();
  await micContext.audioWorklet.addModule('/worklet.js');
  const source = micContext.createMediaStreamSource(micStream);
  const node = new AudioWorkletNode(micContext, 'downsampler');
  node.port.onmessage = (e) => ws?.readyState === 1 && ws.send(e.data);
  source.connect(node);
  // Playback needs a user gesture to start; this click is it.
  playContext ??= new AudioContext({ sampleRate: 24000 });
  playContext.resume();
  $('mic').textContent = 'Stop talking';
  $('mic').setAttribute('aria-pressed', 'true');
}

function stopMic() {
  micStream?.getTracks().forEach((t) => t.stop());
  micContext?.close();
  micStream = micContext = null;
  $('mic').textContent = 'Start talking';
  $('mic').setAttribute('aria-pressed', 'false');
}

// ── The other person's voice ─────────────────────────────────────────────────

function playPcm(buffer) {
  playContext ??= new AudioContext({ sampleRate: 24000 });
  // A network chunk can end in the middle of a 16-bit sample; the odd byte waits for
  // the next chunk.
  let bytes = new Uint8Array(buffer);
  if (leftover !== null) {
    const joined = new Uint8Array(bytes.length + 1);
    joined[0] = leftover;
    joined.set(bytes, 1);
    bytes = joined;
    leftover = null;
  }
  if (bytes.length % 2) {
    leftover = bytes[bytes.length - 1];
    bytes = bytes.subarray(0, bytes.length - 1);
  }
  const samples = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.length / 2);
  if (!samples.length) return;
  const audio = playContext.createBuffer(1, samples.length, 24000);
  const channel = audio.getChannelData(0);
  for (let i = 0; i < samples.length; i += 1) channel[i] = samples[i] / 0x8000;
  const source = playContext.createBufferSource();
  source.buffer = audio;
  source.connect(playContext.destination);
  // Scheduled back to back, so chunks arriving in bursts play without gaps or overlap.
  playAt = Math.max(playAt, playContext.currentTime + 0.05);
  source.start(playAt);
  playAt += audio.duration;
}
