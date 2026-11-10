# Voice fixtures

Seven short synthetic Indonesian utterances for the voice detector and the turn-taking tests
(`packages/host/src/voice/vad.test.ts`, `turns.test.ts`).

**No real person's voice is in this folder, and none may ever be added.** Not a teammate's, not a customer's,
not a recording of anyone. These clips are spoken by the gateway's own speech model and nothing else.

## Where they came from

- Spoken by model `qwen3.5-omni-flash`, voice Tina, made 2026-11-10.
- Format: 24 kHz, mono, 16-bit PCM, in a plain 44-byte-header WAV file. That is the format the voice protocol
  carries (`packages/core/src/voice/protocol.ts`), so a test can feed the samples straight into the detector.
- Each clip opens with about 80 ms of digital silence and ends within about 20 ms of its last sound.

| File | Text | Length |
| --- | --- | --- |
| `fact.wav` | Berapa total penjualan saya bulan lalu? | 2.16 s |
| `smalltalk.wav` | Halo, apa kabar hari ini? | 1.84 s |
| `task.wav` | Tolong buatkan deck dari riset kemarin. | 2.16 s |
| `unfinished.wav` | Saya mau pesan yang | 1.28 s |
| `backchannel.wav` | Iya | 0.64 s |
| `stop.wav` | Stop, tunggu dulu. | 1.52 s |
| `long.wav` | Jadi begini, kemarin saya sudah kirim laporan ke klien, tapi mereka minta revisi di bagian anggaran dan jadwal, bisa bantu saya cek apa saja yang perlu diubah? | 9.76 s |

## What the tests rely on

- `long.wav` has clause pauses inside the sentence, and the tests measure them: by an independent 5 ms
  measure at 0.01 RMS they are 290, 385, 360 and 140 ms long. The detector sees one or two of them as longer
  than its 300 ms hangover, depending on where its 10 ms window grid falls.
- `stop.wav` has a 265 ms pause after "Stop," (at the same 0.01 RMS measure), so the detector must carry
  across it to hear one utterance.
- `backchannel.wav` is about 0.55 s of speech and `stop.wav` about 1.41 s, which bracket
  `TURN_TIMING.interruptAfterMs` (700 ms).
- The tests treat these files as binary. They must not be edited, resampled or re-encoded: the numbers
  above and the onset and end limits in `vad.test.ts` are measured on exactly these bytes.
