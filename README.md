# Interpreter Room

Two people, two languages, one conversation. Each person speaks and hears their own language, live. The documents attached to the room (a contract, a product sheet, a glossary) decide how names and terms are translated.

```
mic → ElevenLabs Scribe v2 Realtime → sentence → translate (Claude, with the room's documents) → ElevenLabs Flash v2.5 → the other person's speaker
                                                      └→ text of both versions on both screens
```

## Run it

```
npm install
cp .env.example .env   # set ELEVENLABS_API_KEY, ANTHROPIC_API_KEY and ROOM_ACCESS_CODE; never commit them
node --env-file=.env server/index.js
```

Open `http://localhost:3000`, create the room, and send the second link to the other person. Each of you then chooses **I speak** and **I hear** (usually the same language; they can differ, and either can be changed mid-conversation). The page shows what the other person chose. Use headphones: with speakers the microphone hears the other person's translated voice and translates it again.

## Who can create rooms

Creating a room spends your ElevenLabs and Anthropic credit, so it needs `ROOM_ACCESS_CODE` (a word you choose, asked for on the create page; `none` lets anyone). With it unset, rooms are refused and the page says which variable to set. People you invite join through the link you send them and never need the code. Eight wrong guesses from one client lock that client out for ten minutes.

## Languages

Speech-to-text hears more languages than the voice model can speak. Flash v2.5 speaks 32 (no Thai, Hebrew, Bengali, Persian or Urdu); choosing one of those under **I hear** still works, the sentence arrives as text and the page says there is no voice. `ELEVENLABS_VOICE_LANGUAGES` widens the list when you configure a model with more voices.

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

## Checking a deployment

Open `/api/status` on your URL: `ready: true` means both keys are set. `/api/status?check=1` also asks ElevenLabs and Anthropic whether each key is accepted, and says why not (a wrong region is the usual cause for a workspace address containing "residency"; set `ELEVENLABS_REGION`).
