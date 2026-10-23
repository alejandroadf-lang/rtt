import Anthropic from '@anthropic-ai/sdk';
import { createApp, describeStatus } from './app.js';
import { createTranslator } from './translate.js';
import { listen, speak, checkElevenLabs, listVoices } from './voice.js';

const status = describeStatus(process.env);
if (!status.ready) {
  // Starts anyway: the page and /api/status explain what is missing, which is more
  // useful than a process that exits and leaves a hosting dashboard saying "crashed".
  console.warn(`Rooms are disabled until you set: ${status.missing.join('; ')}.`);
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || 'unset' });

const translator = createTranslator({
  anthropic,
  // Haiku: a sentence at a time, spoken aloud as soon as it is ready, so speed matters
  // more than depth. TRANSLATE_MODEL moves it without a code change.
  model: (process.env.TRANSLATE_MODEL || '').trim() || 'claude-haiku-5-5',
});

// What /api/status?check=1 reports: does each key work, not just is it set.
const check = async () => {
  const claude = await anthropic.models.list({ limit: 1 }).then(
    () => ({ ok: true, detail: 'Anthropic accepted the key.' }),
    (err) => ({ ok: false, detail: `Anthropic refused the key: ${String(err?.message || err).slice(0, 200)}` })
  );
  return { elevenlabs: await checkElevenLabs(), anthropic: claude };
};

const { server } = createApp({ env: process.env, translator, listen, speak, check, voices: listVoices });
const port = Number(process.env.PORT) || 3000;
server.listen(port, () => console.log(`Interpreter Room on :${port}`));
