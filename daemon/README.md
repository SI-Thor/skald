# daemon/ — the skald voice & content daemon

> **Status (2026-10-29): Lane A RUNNING in production** — `server/` v0.1.0
> live as `skald-daemon.service` on :8000 (verified: `test_smoke.py` incl. the
> ASR intelligibility gate). Lane C layer 3 (show endpoint, ADR-0009) is
> implemented and verified (`test_show_api.py`); Lane B (podcast jobs) is
> designed (ADR-0003) but not implemented here yet.

`server/` — OpenAI-compatible bridge in front of Riva (see its README; env
overrides; options documented for LAN clients).

## Lane C: live shows (ADR-0009, scripted steering default)

`POST /v1/shows` starts a session that auto-plays a two-host show about an
article. Semantics are the lane-c-sim reference (vendored as
`server/lane_c.py`): said-aloud ledger, interrupt dial, prefetch buffer.
Steering is the deterministic scripted fixture unless `llm: "openai"` —
then an OpenAI-compatible endpoint is used, configured via env:

    LANE_C_LLM_BASE_URL     default http://localhost:11434/v1
    LANE_C_LLM_MODEL        default llama3.1
    LANE_C_LLM_TIMEOUT      default 30 (seconds)
    LANE_C_LLM_TEMPERATURE  default 0.8

Routes (max 8 concurrent shows; 422 over the cap):

    POST   /v1/shows                 {article, cast?, llm?, dial?} -> {show_id, ws_url}
    GET    /v1/shows/{id}            status {heard_turns, pending, discarded_count, metrics, dial}
    POST   /v1/shows/{id}/interject  {text, address?, dial?} -> 202 {ok}   (the one input channel)
    POST   /v1/shows/{id}/dial       {dial: cut_now|wrap_thought|let_finish}
    DELETE /v1/shows/{id}            stop the show
    WS     /v1/shows/{id}/ws         read-only event stream

WS protocol: on connect a `{"type":"snapshot", heard:[...], pending:[...]}`
(seqs are ledger-wide), then `{"type":"turn_heard", turn:{speaker,text,seq}}`
on every playhead advance (~1 tick/1.5s) and a status event every ~5s
(`{"type":"status", heard_turns, pending, discarded_count, metrics, dial,
error}`). Multiple simultaneous WS clients are supported; the stream is
broadcast-only — producer input goes through `POST .../interject`. A
`cut_now` interjection discards the unheard prefetch buffer immediately
(those turns never enter memory); steering-LLM failures back off and retry,
the show survives.

Planned next: TTS/voice-slot wiring for heard turns, the extension sidebar
(transcript, question box, interrupt dial, character cards).
