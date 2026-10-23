// ElevenLabs, in the two places the room uses it: ears and voice.
//
//   listen: Scribe v2 Realtime over a WebSocket. The browser's microphone frames
//           arrive here as 16 kHz mono PCM and are forwarded; ElevenLabs decides
//           where a sentence ends (voice-activity commit) and sends the committed
//           text back. The API key stays on this server: the browser never sees it.
//   speak:  Flash v2.5 over HTTP streaming, one translated sentence at a time. A
//           sentence is short, so there is nothing to gain from feeding it word by
//           word, and each request stays independent: one failing does not break
//           the next.
//
// Kept this thin on purpose, and behind two functions, so pipeline.js is tested
// without a network and a change of provider touches this file only.

import { ElevenLabsClient, ElevenLabsEnvironment, AudioFormat, CommitStrategy, RealtimeEvents } from '@elevenlabs/elevenlabs-js';

export const SPEECH_FORMAT = 'pcm_24000';
export const SPEECH_SAMPLE_RATE = 24000;
export const MIC_SAMPLE_RATE = 16000;

// "George", the voice ElevenLabs' own quickstart uses; a default so a first run
// works, not a recommendation. Each person should have a voice that fits them.
const DEFAULT_VOICE = 'JBFqnCBsd6RMkjVDRZzb';

// A key belongs to the region its workspace was created in: a workspace opened at
// eu.residency.elevenlabs.io has keys that the default api.elevenlabs.io rejects as
// invalid. This deployment's workspace is in the EU, so EU is the built-in default
// and the Railway variable is not needed. ELEVENLABS_REGION still overrides it
// (in, sg, us), and "default" selects the standard api.elevenlabs.io for an
// ordinary account, which is what anyone else deploying this repo will want.
const DEFAULT_REGION = 'eu';
const REGIONS = {
  eu: ElevenLabsEnvironment.ProductionEu,
  in: ElevenLabsEnvironment.ProductionIndia,
  sg: ElevenLabsEnvironment.ProductionSingapore,
  us: ElevenLabsEnvironment.ProductionUs,
  default: undefined,
};

export function voiceConfig(env = process.env) {
  const region = (env.ELEVENLABS_REGION || '').trim().toLowerCase() || DEFAULT_REGION;
  if (!(region in REGIONS)) throw new Error(`ELEVENLABS_REGION "${region}" is not one of: ${Object.keys(REGIONS).join(', ')}.`);
  return {
    apiKey: (env.ELEVENLABS_API_KEY || '').trim(),
    environment: REGIONS[region],
    voiceId: (env.ELEVENLABS_VOICE_ID || '').trim() || DEFAULT_VOICE,
    ttsModel: (env.ELEVENLABS_TTS_MODEL || '').trim() || 'eleven_flash_v2_5',
    sttModel: (env.ELEVENLABS_STT_MODEL || '').trim() || 'scribe_v2_realtime',
  };
}

let client = null;
// `config.client` lets a test pass a stand-in instead of the network.
const getClient = ({ apiKey, environment, client: given }) => given || (client ??= new ElevenLabsClient({ apiKey, ...(environment ? { environment } : {}) }));

/**
 * Opens a transcription session for one person. Resolves to { send, close }.
 * `send(pcm16Buffer)` forwards microphone audio. `onPartial(text)` is what is being
 * said now; `onCommitted(text)` is a finished sentence. Errors, including the
 * provider's own (quota, auth, rate limit), reach `onError` as a readable Error.
 */
export async function listen({ language, keyterms = [], onPartial, onCommitted, onError }, config = voiceConfig()) {
  const connection = await getClient(config).speechToText.realtime.connect({
    modelId: config.sttModel,
    audioFormat: AudioFormat.PCM_16000,
    sampleRate: MIC_SAMPLE_RATE,
    commitStrategy: CommitStrategy.VAD,
    // Without this a quiet pause between two clauses is cut into two sentences, and
    // each is translated without the other.
    vadSilenceThresholdSecs: 0.9,
    languageCode: language,
    keyterms: keyterms.slice(0, 50).map((t) => t.slice(0, 20)),
  });

  connection.on(RealtimeEvents.PARTIAL_TRANSCRIPT, (m) => onPartial?.(m.text ?? m.transcript ?? ''));
  connection.on(RealtimeEvents.COMMITTED_TRANSCRIPT, (m) => {
    const text = String(m.text ?? m.transcript ?? '').trim();
    if (text) onCommitted?.(text);
  });
  // Every error event carries `error`, and the event name says which kind: quota
  // and auth are the two a person can fix, so they are named as such.
  for (const [event, label] of [
    [RealtimeEvents.ERROR, 'Speech-to-text error'],
    [RealtimeEvents.AUTH_ERROR, 'ElevenLabs rejected ELEVENLABS_API_KEY'],
    [RealtimeEvents.QUOTA_EXCEEDED, 'The ElevenLabs quota is used up (add credit or wait for the reset)'],
    [RealtimeEvents.RATE_LIMITED, 'ElevenLabs is rate limiting speech-to-text'],
    [RealtimeEvents.INPUT_ERROR, 'ElevenLabs refused the audio'],
  ]) {
    connection.on(event, (m) => onError?.(new Error(`${label}${m?.error ? `: ${m.error}` : m?.message ? `: ${m.message}` : ''}`)));
  }

  return {
    send: (pcm) => connection.send({ audioBase64: Buffer.from(pcm).toString('base64'), sampleRate: MIC_SAMPLE_RATE }),
    close: () => {
      try {
        connection.close();
      } catch {
        // Already closed.
      }
    },
  };
}

/**
 * Speaks `text` in `language`. Calls `onAudio(buffer)` with 24 kHz mono 16-bit PCM
 * as it arrives, and resolves when the sentence is finished.
 */
export async function speak({ text, language, voiceId }, onAudio, config = voiceConfig()) {
  const stream = await getClient(config).textToSpeech.stream(voiceId || config.voiceId, {
    text,
    modelId: config.ttsModel,
    languageCode: language,
    outputFormat: SPEECH_FORMAT,
  });
  const reader = stream.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    if (value?.length) onAudio(Buffer.from(value));
  }
}

/**
 * Asks ElevenLabs whether the configured key and region are accepted, for the
 * status page. Never throws: the answer is what the page shows. A restricted key
 * may be refused this particular read while still allowed to transcribe and speak,
 * so a refusal is reported as what ElevenLabs said, with the likely causes, rather
 * than as a verdict.
 */
export async function checkElevenLabs(config = voiceConfig()) {
  // Always says which address was asked, success or not: "refused the key" is not
  // actionable until you can see whether the region setting reached the call.
  const host = config.environment || 'https://api.elevenlabs.io (the standard address, ELEVENLABS_REGION=default)';
  try {
    await getClient(config).user.get();
    return { ok: true, host, detail: `ElevenLabs accepted the key on ${host}.` };
  } catch (err) {
    const status = err?.statusCode ? ` (${err.statusCode})` : '';
    const said = String(err?.message || err).replace(/\s+/g, ' ').slice(0, 500);
    return {
      ok: false,
      host,
      detail: `ElevenLabs refused the key${status} on ${host}: ${said}`,
      causes: 'Most likely first: the region must match the workspace address (eu, in, sg or us, set as ELEVENLABS_REGION on this service, then redeployed); the key was copied wrongly; a restricted key lacks permission for this check even though speech may still work.',
    };
  }
}
