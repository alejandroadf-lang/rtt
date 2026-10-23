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
// invalid. ELEVENLABS_REGION picks the matching API host.
const REGIONS = {
  eu: ElevenLabsEnvironment.ProductionEu,
  in: ElevenLabsEnvironment.ProductionIndia,
  sg: ElevenLabsEnvironment.ProductionSingapore,
  us: ElevenLabsEnvironment.ProductionUs,
};

export function voiceConfig(env = process.env) {
  const region = (env.ELEVENLABS_REGION || '').trim().toLowerCase();
  if (region && !REGIONS[region]) throw new Error(`ELEVENLABS_REGION "${region}" is not one of: ${Object.keys(REGIONS).join(', ')} (leave it empty for the default api.elevenlabs.io).`);
  return {
    apiKey: (env.ELEVENLABS_API_KEY || '').trim(),
    environment: REGIONS[region],
    voiceId: (env.ELEVENLABS_VOICE_ID || '').trim() || DEFAULT_VOICE,
    ttsModel: (env.ELEVENLABS_TTS_MODEL || '').trim() || 'eleven_flash_v2_5',
    sttModel: (env.ELEVENLABS_STT_MODEL || '').trim() || 'scribe_v2_realtime',
  };
}

let client = null;
const getClient = ({ apiKey, environment }) => (client ??= new ElevenLabsClient({ apiKey, ...(environment ? { environment } : {}) }));

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
  try {
    await getClient(config).user.get();
    return { ok: true, detail: `ElevenLabs accepted the key${config.environment ? ` on ${config.environment}` : ''}.` };
  } catch (err) {
    const status = err?.statusCode ? ` (${err.statusCode})` : '';
    return {
      ok: false,
      detail: `ElevenLabs refused the key${status}: ${String(err?.message || err).slice(0, 200)}. Causes, most likely first: a workspace address containing "residency" needs ELEVENLABS_REGION set to eu, in, sg or us; the key was copied wrongly; a restricted key lacks permission for this check even though speech may still work.`,
    };
  }
}
