"""skald voice daemon v0 — OpenAI-compatible bridge in front of the Riva HTTP server.

Lane A contract per docs/architecture.md. Speed is a client-side concern
(playbackRate) per design; the daemon passes nothing synthetic to Riva.
"""
from __future__ import annotations

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field

import config
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
