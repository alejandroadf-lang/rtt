// The page. Two states: no room in the address (make one), or /r/<room>#<token>
// (be in one). The token lives in the fragment because a fragment is never sent to a
// server, so it is not in anyone's access log or a Referer header.
//
// Text is only ever written with textContent: what the other person said, and the
// names of files they attached, are not markup.

const $ = (id) => document.getElementById(id);
// What this browser saw, kept for "Copy diagnostics": connection changes, errors and
// how much audio arrived. No audio and no microphone data is stored.
const clientLog = [];
const note = (event) => {
  clientLog.push({ at: new Date().toISOString().slice(11, 23), ...event });
  if (clientLog.length > 80) clientLog.shift();
};
const audioStats = { chunks: 0, bytes: 0 };

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
  await fillVoices(info.yourVoice);
  setStatus(info.partnerHere ? 'They are here.' : 'Waiting for them to open their link.');

  // Both are saved before the socket opens, because speech-to-text starts in the
  // language you speak. A later change is saved the same way and the server
  // restarts listening itself.
  await saveLanguages();
  connect();
  let lastSpoken = $('mine').value;
  $('mine').addEventListener('change', () => {
    // Most people hear what they speak, so changing one moves the other with it.
    if ($('hear').value === lastSpoken) $('hear').value = $('mine').value;
    lastSpoken = $('mine').value;
    saveLanguages();
  });
  $('hear').addEventListener('change', saveLanguages);
  $('voice').addEventListener('change', saveLanguages);
  $('listen').addEventListener('click', listenToVoice);

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
  $('sound').addEventListener('click', unlockSound);
  $('diag').hidden = false;
  $('copyDiag').addEventListener('click', copyDiagnostics);
  // Any first touch anywhere on the page also turns sound on.
  document.addEventListener('pointerdown', unlockSound, { once: true });
  updateSoundButton();
}

// The voice the other person hears when your words are translated. The sample is a
// short recording ElevenLabs hosts for each voice, so listening costs nothing.
let voiceList = [];

async function fillVoices(current) {
  try {
    voiceList = (await api(`/api/voices?room=${encodeURIComponent(roomId)}`)).voices;
  } catch (err) {
    voiceList = [];
    setStatus(`The voice list is unavailable (${err.message}). The default voice is used.`, true);
  }
  const options = voiceList.map((v) => new Option(`${v.name}${v.description ? ` - ${v.description}` : ''}`, v.id));
  // A voice the account's list does not show (the default) is still the current one.
  if (current && !voiceList.some((v) => v.id === current)) options.unshift(new Option('Default voice', current));
  $('voice').replaceChildren(...options);
  if (current) $('voice').value = current;
}

function listenToVoice() {
  const voice = voiceList.find((v) => v.id === $('voice').value);
  if (!voice?.previewUrl) return setStatus('There is no sample for this voice.', true);
  unlockSound();
  new Audio(voice.previewUrl).play().catch(() => setStatus('The sample could not be played. Tap the page once, then try again.', true));
}

async function copyDiagnostics() {
  let server = {};
  try {
    server = await api(`/api/rooms/${encodeURIComponent(roomId)}/diagnostics`);
  } catch (err) {
    server = { error: err.message };
  }
  const report = JSON.stringify({
    when: new Date().toISOString(),
    browser: navigator.userAgent,
    sound: { state: playContext?.state ?? 'not started', sampleRate: playContext?.sampleRate ?? null, ...audioStats },
    microphoneOn: Boolean(micStream),
    socket: ws ? ['connecting', 'open', 'closing', 'closed'][ws.readyState] : 'none',
    pageSettings: { speak: $('mine').value, hear: $('hear').value, voice: $('voice').value },
    server,
    browserEvents: clientLog.slice(-40),
  }, null, 1);
  $('diagText').hidden = false;
  $('diagText').value = report;
  try {
    await navigator.clipboard.writeText(report);
    setStatus('Diagnostics copied. Paste them into your message.');
  } catch {
    // Some phones refuse clipboard writes: the text is in the box below to select and copy.
    $('diagText').select();
    setStatus('Select the text in the box below and copy it.');
  }
}

const names = new Intl.DisplayNames(['en'], { type: 'language' });
const label = (code) => (code ? names.of(code) : 'not chosen yet');

function fillLanguages(languages, voiceLanguages) {
  $('mine').replaceChildren(...Object.keys(languages).map((code) => new Option(`${label(code)} (${code})`, code)));
  // A language without a spoken voice can still be read: it is offered, and marked.
  $('hear').replaceChildren(...Object.keys(languages).map((code) => new Option(`${label(code)} (${code})${voiceLanguages.includes(code) ? '' : ' - text only'}`, code)));
}

async function saveLanguages() {
  checkSetup();
  try {
    await api(`/api/rooms/${encodeURIComponent(roomId)}/me`, { method: 'PUT', body: JSON.stringify({ input: $('mine').value, output: $('hear').value, voice: $('voice').value || undefined }) });
  } catch (err) {
    setStatus(err.message, true);
  }
}

let theirInput = null;
let theirOutput = null;

function showTheirs(input, output) {
  theirInput = input;
  theirOutput = output;
  $('theirs').textContent = input ? `They speak ${label(input)} and hear ${label(output)}.` : 'They have not chosen their languages yet.';
  checkSetup();
}

// The usual mistake: choosing to hear the OTHER person's language. Each side is then
// set to hear what the other already speaks, so nothing is translated and nothing is spoken.
function checkSetup() {
  const warnings = [];
  if (theirInput && $('hear').value === theirInput) warnings.push(`You are set to hear ${label(theirInput)}, which is what they speak, so their words are not translated for you. To hear them in your language, set "I hear" to the language you understand.`);
  if (theirOutput && $('mine').value === theirOutput) warnings.push(`They are set to hear ${label(theirOutput)}, which is what you speak, so nothing you say is translated for them.`);
  $('warn').textContent = warnings.join(' ');
  $('warn').hidden = !warnings.length;
}

function renderDocs(names) {
  $('doclist').replaceChildren(...names.map((n) => Object.assign(document.createElement('li'), { textContent: n })));
}

// A phone changes network, locks, or the server restarts: the socket drops without
// anyone doing anything. Reconnect quietly a few times before asking for a reload.
// Codes 4000 and up are the server saying "stop" on purpose (another tab, time used).
let attempts = 0;

function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?room=${encodeURIComponent(roomId)}&token=${encodeURIComponent(token)}`);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => { attempts = 0; note({ type: 'socket_open' }); };
  ws.onmessage = (e) => (typeof e.data === 'string' ? onMessage(JSON.parse(e.data)) : playPcm(e.data));
  ws.onclose = (e) => {
    note({ type: 'socket_closed', code: e.code });
    if (e.code >= 4000) {
      stopMic();
      setStatus(e.code === 4000 ? 'This room is open in another tab.' : e.code === 4002 ? 'This room has used its time. Start a new one.' : 'The room closed the connection.', true);
    } else if (attempts < 5) {
      attempts += 1;
      setStatus(`Connection lost. Reconnecting (${attempts} of 5)...`, true);
      setTimeout(connect, 1000 * attempts);
    } else {
      stopMic();
      setStatus('Disconnected. Reload to rejoin.', true);
    }
  };
}

function onMessage(m) {
  if (['status', 'error', 'text_only', 'audio_start', 'audio_end', 'partner', 'ready'].includes(m.type)) note({ type: m.type, message: m.message, id: m.id, language: m.language });
  if (m.type === 'ready') setStatus(m.partnerHere ? 'They are here.' : 'Waiting for them to open their link.');
  else if (m.type === 'partner') setStatus(m.here ? 'They are here.' : 'They left.');
  else if (m.type === 'partner_languages') showTheirs(m.input, m.output);
  else if (m.type === 'text_only') setStatus(`There is no spoken voice for ${label(m.language)} with this voice model, so it arrives as text only.`);
  else if (m.type === 'partial') $('partial').textContent = m.text;
  else if (m.type === 'turn') showTurn(m);
  else if (m.type === 'translation') {
    const row = turns.get(m.id);
    if (row) row.small.textContent = `They hear (${label(m.language)}): ${m.translated}`;
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
    row.small.textContent = `Original (${label(m.from)}): ${m.original}${m.language ? ` - spoken in ${label(m.language)}` : ''}`;
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
  unlockSound(); // this tap is the gesture playback needs
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

// Browsers keep sound off until the person touches the page, and a listener who only
// opened the link and waits has not. Without this the translation is spoken into a
// suspended audio context and nothing is heard. The button stays until sound is on.
function unlockSound() {
  playContext ??= new AudioContext({ sampleRate: 24000 });
  playContext.onstatechange = updateSoundButton;
  playContext.resume().then(updateSoundButton, updateSoundButton);
  // iOS only unlocks once something has actually been started in the gesture.
  const silent = playContext.createBufferSource();
  silent.buffer = playContext.createBuffer(1, 1, 24000);
  silent.connect(playContext.destination);
  silent.start();
  updateSoundButton();
}

function updateSoundButton() {
  $('sound').hidden = playContext?.state === 'running';
}

// ── The other person's voice ─────────────────────────────────────────────────

function playPcm(buffer) {
  audioStats.chunks += 1;
  audioStats.bytes += buffer.byteLength;
  if (audioStats.chunks === 1) note({ type: 'first_audio_chunk', soundState: playContext?.state ?? 'none' });
  playContext ??= new AudioContext({ sampleRate: 24000 });
  if (playContext.state !== 'running') {
    playContext.resume().catch(() => {});
    updateSoundButton();
  }
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
