"""skald voice daemon v0 — OpenAI-compatible bridge in front of the Riva HTTP server.

Lane A contract per docs/architecture.md. Speed is a client-side concern
(playbackRate) per design; the daemon passes nothing synthetic to Riva.
"""
from __future__ import annotations

from dataclasses import asdict
from typing import Literal

import httpx
from fastapi import FastAPI, HTTPException, WebSocket
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, Field

import config
import show_api
import voices

app = FastAPI(title="skald daemon", version="0.1.0")


class SpeechRequest(BaseModel):
    model: str = "skald-default"
    input: str
    voice: str | None = None
    response_format: str = "wav"
    language_code: str | None = Field(default=None, alias="language")
    sample_rate_hz: int = 22050

    class Config:
        populate_by_name = True


@app.get("/")
@app.get("/v1/health")
async def health():
    upstream = False
    try:
        async with httpx.AsyncClient(timeout=3) as client:
            r = await client.get(f"{config.RIVA_HTTP_URI}/v1/health")
            upstream = r.status_code == 200
    except httpx.HTTPError:
        pass
    return {
        "status": "ok" if upstream else "degraded",
        "service": "skald-daemon",
        "version": app.version,
        "upstream": {"riva_http": config.RIVA_HTTP_URI, "reachable": upstream},
    }


@app.post("/v1/audio/speech/stream")
async def speech_stream(req: SpeechRequest):
    """Streaming variant: proxies Riva's chunked-PCM endpoint so clients can
    play while synthesizing (never-wait). Returns raw 16-bit PCM chunks
    (22.05 kHz mono) — NOT WAV; wrap client-side if you need a container."""
    if not req.input.strip():
        raise HTTPException(400, "input must be non-empty")
    voice = await voices.resolve_voice(req.voice)
    lang = req.language_code or "en-US"

    async def gen():
        async with httpx.AsyncClient(timeout=None) as client:
            async with client.stream(
                "POST",
                f"{config.RIVA_HTTP_URI}/v1/audio/synthesize_online",
                data={
                    "text": req.input,
                    "language": lang,
                    "voice": voice,
                    "sample_rate_hz": str(req.sample_rate_hz),
                    "encoding": "LINEAR_PCM",
                },
            ) as r:
                if r.status_code != 200:
                    raise HTTPException(r.status_code, f"upstream: {await r.aread()}")
                async for chunk in r.aiter_bytes():
                    if chunk:
                        yield chunk

    return StreamingResponse(
        gen(),
        media_type="audio/pcm;rate=22050",
        headers={"X-Skald-Voice": voice, "Cache-Control": "no-store"},
    )


@app.get("/v1/voices")
async def list_voices():
    return {"voices": await voices.get_voices(), "aliases": voices.ALIASES}


@app.post("/v1/audio/speech")
async def speech(req: SpeechRequest):
    if not req.input.strip():
        raise HTTPException(400, "input must be non-empty")
    if len(req.input) > 1900:
        # Riva server caps a request at 2000 chars; Lane A clients stream
        # sentence-by-sentence anyway, but be forgiving at the edge.
        raise HTTPException(413, "input too long for one request; chunk client-side (<1900 chars)")
    voice = await voices.resolve_voice(req.voice)
    lang = req.language_code or "en-US"
    async with httpx.AsyncClient(timeout=60) as client:
        r = await client.post(
            f"{config.RIVA_HTTP_URI}/v1/audio/synthesize",
            data={
                "text": req.input,
                "language": lang,
                "voice": voice,
                "sample_rate_hz": str(req.sample_rate_hz),
                "encoding": "LINEAR_PCM",
            },
        )
    if r.status_code != 200:
        raise HTTPException(r.status_code, f"upstream: {r.text[:200]}")
    return Response(
        content=r.content,
        media_type="audio/wav",
        headers={
            "X-Skald-Voice": voice,
            "Content-Disposition": 'inline; filename="speech.wav"',
        },
    )


# ---------------------------------------------------------------- lane C shows
# ADR-0009 layer 3: the live-show endpoint. Semantics come from lane_c (the
# vendored lane-c-sim reference); sessions, the driver task, and WS broadcast
# live in show_api. The WS stream is read-only — producer input is REST
# (POST .../interject), which keeps the event protocol broadcast-only.


class ShowCastMember(BaseModel):
    name: str
    persona: str
    voice_slot: str


class ShowCreateRequest(BaseModel):
    article: str
    cast: list[ShowCastMember] | None = None  # default: the sim's Mia + Jason
    llm: Literal["scripted", "openai"] = "scripted"
    dial: Literal["cut_now", "wrap_thought", "let_finish"] | None = None


class ShowInterjectRequest(BaseModel):
    text: str
    address: str | None = None  # character name to address, e.g. "Mia"
    dial: Literal["cut_now", "wrap_thought", "let_finish"] | None = None


class ShowDialRequest(BaseModel):
    dial: Literal["cut_now", "wrap_thought", "let_finish"]


@app.post("/v1/shows")
async def create_show(req: ShowCreateRequest):
    """Start a live show about `article`. Steering is the deterministic
    scripted fixture unless llm="openai" (LANE_C_LLM_* env). Returns the
    show id and its WebSocket event-stream URL."""
    if not req.article.strip():
        raise HTTPException(400, "article must be non-empty")
    cast = (
        [
            show_api.CharacterSheet(name=m.name, persona=m.persona, voice_slot=m.voice_slot)
            for m in req.cast
        ]
        if req.cast
        else None
    )
    try:
        session = await show_api.manager.create(req.article, llm=req.llm, cast=cast, dial=req.dial)
    except show_api.SessionLimitError as e:
        raise HTTPException(422, str(e))
    return {"show_id": session.id, "ws_url": f"/v1/shows/{session.id}/ws"}


@app.get("/v1/shows/{show_id}")
async def show_status(show_id: str):
    """Status snapshot: ledger counts (heard/pending/discarded), show metrics
    + prompt-token economics, and the current interrupt dial."""
    session = show_api.manager.get(show_id)
    if session is None:
        raise HTTPException(404, f"no such show: {show_id}")
    return {
        "show_id": session.id,
        "article_id": session.article_id,
        "created_at": session.created_at,
        "cast": [asdict(m) for m in session.cast],
        **(await session.status()),
    }


@app.post("/v1/shows/{show_id}/interject")
async def show_interject(show_id: str, req: ShowInterjectRequest):
    """Producer interjection — the one input channel. An optional `dial`
    applies to THIS interjection (cut_now discards the buffer immediately;
    wrap_thought lets the current turn complete first; let_finish queues)."""
    session = show_api.manager.get(show_id)
    if session is None:
        raise HTTPException(404, f"no such show: {show_id}")
    if not req.text.strip():
        raise HTTPException(400, "text must be non-empty")
    await session.interject(req.text.strip(), address=req.address, dial=req.dial)
    return JSONResponse(status_code=202, content={"ok": True})


@app.post("/v1/shows/{show_id}/dial")
async def show_dial(show_id: str, req: ShowDialRequest):
    """Set the interrupt dial for future interjections."""
    session = show_api.manager.get(show_id)
    if session is None:
        raise HTTPException(404, f"no such show: {show_id}")
    await session.set_dial(req.dial)
    return {"ok": True, "dial": req.dial}


@app.delete("/v1/shows/{show_id}")
async def delete_show(show_id: str):
    """Stop the show's driver task and close every WS client."""
    if not await show_api.manager.stop(show_id):
        raise HTTPException(404, f"no such show: {show_id}")
    return {"ok": True, "show_id": show_id}


@app.websocket("/v1/shows/{show_id}/ws")
async def show_ws(ws: WebSocket, show_id: str):
    """Event stream (many clients allowed). On connect: a snapshot of the
    said-aloud transcript + prefetch buffer; then turn_heard on every
    playhead advance and status every ~5s. Read-only: anything a client
    sends is ignored."""
    session = show_api.manager.get(show_id)
    if session is None:
        await ws.accept()
        await ws.close(code=4404, reason="no such show")
        return
    await session.add_client(ws)
