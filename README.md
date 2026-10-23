# Interpreter Room

Two people, two languages, one conversation. Each person speaks and hears their own language, live. The documents attached to the room (a contract, a product sheet, a glossary) decide how names and terms are translated.

```
mic → ElevenLabs Scribe v2 Realtime → sentence → translate (Claude, with the room's documents) → ElevenLabs Flash v2.5 → the other person's speaker
                                                      └→ text of both versions on both screens
```

## Run it

```
npm install
cp .env.example .env   # set ELEVENLABS_API_KEY and ANTHROPIC_API_KEY, never commit them
node --env-file=.env server/index.js
```

Open `http://localhost:3000`, pick the two languages, create the room, and send the second link to the other person. Use headphones: with speakers the microphone hears the other person's translated voice and translates it again.

## How the documents are used

- **Attach** `.txt .md .csv .json .html` files in the room (200 KB each, 20 per room). PDFs and Word files are refused by name; export them to text first.
- **Per sentence**, the few passages that share the most words with what was just said (and the sentence before it) go into the translator's prompt, fenced as reference data, never as instructions.
- **Once per room**, the proper nouns and acronyms that recur in the documents are given to speech-to-text as key terms, so it hears "Kübler GmbH" rather than the nearest common words.

## What it does not do yet

- PDF/Word extraction, and per-person voices (everyone hears the one configured voice).
- Accounts: access is by link. Anyone holding a link is that person; rooms expire after four hours and live only in memory. No audio, transcript or document is written to disk.
- Streaming the translation word by word: a sentence is translated whole, then spoken.
- It has **not been run against live ElevenLabs or Anthropic keys**. The ElevenLabs calls follow the official SDK's own types (v2.74); the tests use fakes for the three network services. Expect to tune `vadSilenceThresholdSecs` in `server/voice.js` on the first real conversation.

## Cost and privacy

Speech-to-text is billed per hour of audio sent, text-to-speech per character, translation per token. `ROOM_MAX_MINUTES` caps one room. The Stop talking button stops sending audio. Audio and text go to ElevenLabs and Anthropic: check their current terms before using it for confidential or health conversations.

## Tests

`npm test`: the room end to end with fakes (who hears what, in order, and what is said when translation or speech fails), document retrieval, access, the WebSocket upgrade, and the static server.
