"""ADR-0009 layer 3: the Lane C live-show session manager.

The state machine is `lane_c` — the vendored reference implementation — so
the pinned invariants hold unchanged (unheard turns never enter memory,
cut_now discards the prefetch buffer at interject(), wrap_thought completes
exactly one turn first, prompt prefix stays byte-stable).

A ShowSession owns one Show plus a SteeringLLM chosen at create time:
  - "scripted" (default): deterministic fixture, never fails
  - "openai": any OpenAI-shaped /chat/completions endpoint, configured via
    env (LANE_C_LLM_BASE_URL / _MODEL / _TIMEOUT / _TEMPERATURE)

A background asyncio task drives the show: every tick_interval it ticks one
turn past the playhead and broadcasts the event to WebSocket clients. LLM
calls are blocking urllib — they run in a thread executor and never block
the event loop. Steering failures back off and retry (the show survives),
matching the repl's semantics; the last error rides along on status events.

Concurrency model: one event loop; a per-session asyncio.Lock serializes
Show mutations (ticks run on executor threads, REST mutations on the loop),
and the manager lock guards the sessions dict. The WebSocket stream is
read-only by design — producer input goes through POST /interject only.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import socket
import sys
import time
import urllib.error
import urllib.request
import uuid
from contextlib import suppress
from datetime import datetime, timezone

from fastapi import WebSocket, WebSocketDisconnect

import lane_c
from lane_c import CharacterSheet, ScriptedLLM, SteeringLLM

TICK_INTERVAL_S = 1.5  # one heard turn per tick
STATUS_EVERY_S = 5.0  # status broadcast cadence
MAX_SESSIONS = 8
DEFAULT_PREFETCH = 2  # planned turns ahead of the playhead (sim default)
MAX_STEER_BACKOFF_S = 5.0  # repl parity: backoff cap when steering fails

DEFAULT_BIBLE = (
    "Two hosts, warm and curious. Short turns (1-3 sentences). Disagree politely. "
    "Refer back to earlier points. Never read the article verbatim."
)


def default_cast() -> list[CharacterSheet]:
    """Fresh copies of the sim's default two-host cast (Mia + Jason)."""
    return [
        CharacterSheet("Mia", "Analytical, skeptical of hype, loves methodology details.", "riva:mia"),
        CharacterSheet("Jason", "Energetic connector, jumps to practical takeaways.", "riva:jason"),
    ]


# ---------------------------------------------------------------- steering


class SteeringError(RuntimeError):
    """The steering LLM call failed (timeout, unreachable, bad envelope)."""


def _env(name: str, default, cast):
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return cast(raw)
    except ValueError as e:
        raise ValueError(f"bad {name}={raw!r}: {e}") from e


def parse_speaker_text(raw: str) -> tuple[str, str] | None:
    """Parse the mandated 'Speaker: text' shape, leniently: split on the
    first colon. None when there is no usable prefix — the caller then falls
    back to a round-robin speaker with the raw text (sim llm.py parity).

    Polish pass (2026-10-29 live-show warts, same as llm.py @ HEAD):
    1) strip a duplicated "[Speaker]" bracket prefix from the text;
    2) drop a leading parenthetical stage direction — "( Jason can respond
       with a counterpoint )" is direction to other cast, not dialogue.
    """
    if not raw:
        return None
    text = raw.strip()
    if ":" not in text:
        return None
    speaker, _, rest = text.partition(":")
    speaker = speaker.strip()
    if not speaker or "\n" in speaker:
        return None
    # models sometimes echo "[Mia] ..." after the "Mia: " prefix
    rest = re.sub(rf"^\s*\[{re.escape(speaker)}\]\s*", "", rest)
    # parentheticals are direction to other cast members, not dialogue
    if rest.startswith("("):
        close = rest.find(")")
        if close != -1:
            rest = rest[close + 1 :].lstrip()
    return speaker, rest.strip()


class OpenAICompatLLM(SteeringLLM):
    """Minimal SteeringLLM over an OpenAI-shaped /chat/completions endpoint.

    Stdlib only (urllib.request) — blocking calls, so the session task runs
    them in a thread executor. Parse failures degrade to a round-robin
    speaker (stderr note); transport failures raise SteeringError and the
    show survives (backoff + retry in the session loop).
    """

    DEFAULT_BASE_URL = "http://localhost:11434/v1"
    DEFAULT_MODEL = "llama3.1"
    DEFAULT_TIMEOUT = 30.0
    DEFAULT_TEMPERATURE = 0.8
    MAX_TOKENS = 120  # short turns (1-3 sentences) per the show bible

    def __init__(self) -> None:
        self.base_url = _env("LANE_C_LLM_BASE_URL", self.DEFAULT_BASE_URL, str).rstrip("/")
        self.model = _env("LANE_C_LLM_MODEL", self.DEFAULT_MODEL, str)
        self.timeout = _env("LANE_C_LLM_TIMEOUT", self.DEFAULT_TIMEOUT, float)
        self.temperature = _env("LANE_C_LLM_TEMPERATURE", self.DEFAULT_TEMPERATURE, float)
        self.calls = 0
        self._fallback_speakers = ["Mia", "Jason"]
        self._fallback_i = 0

    def _complete(self, prompt: str) -> str:
        """POST chat/completions (stream=false); return message.content.
        Raises SteeringError on timeout / unreachable / HTTP / bad shape."""
        url = f"{self.base_url}/chat/completions"
        body = json.dumps(
            {
                "model": self.model,
                "messages": [{"role": "user", "content": prompt}],
                "stream": False,
                "max_tokens": self.MAX_TOKENS,
                "temperature": self.temperature,
            }
        ).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=body,
            headers={"Content-Type": "application/json", "Accept": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                payload = resp.read()
        except (socket.timeout, TimeoutError) as e:  # 3.10+: same class
            raise SteeringError(f"steering LLM timed out after {self.timeout:g}s ({url})") from e
        except urllib.error.HTTPError as e:
            detail = ""
            with suppress(OSError):
                detail = e.read()[:200].decode("utf-8", "replace")
            raise SteeringError(f"steering LLM HTTP {e.code} from {url}: {detail or e.reason}") from e
        except urllib.error.URLError as e:
            if isinstance(e.reason, (socket.timeout, TimeoutError)):
                raise SteeringError(f"steering LLM timed out after {self.timeout:g}s ({url})") from e
            raise SteeringError(f"steering LLM unreachable at {url}: {e.reason}") from e
        except OSError as e:  # http.client leftovers (RemoteDisconnected etc.)
            raise SteeringError(f"steering LLM request failed ({url}): {e}") from e

        try:
            data = json.loads(payload.decode("utf-8", "replace"))
            content = data["choices"][0]["message"]["content"]
        except (json.JSONDecodeError, KeyError, IndexError, TypeError) as e:
            raise SteeringError(
                f"unexpected chat-completions shape from {url}: "
                f"{payload[:200].decode('utf-8', 'replace')!r}"
            ) from e
        if not isinstance(content, str):
            raise SteeringError(f"chat-completions content is {type(content).__name__}, not str ({url})")
        return content

    def next_turn(self, prompt: str) -> tuple[str, str]:
        """One steering call -> (speaker, text). Transport failures raise
        SteeringError; a parse failure only degrades to round-robin."""
        self.calls += 1
        content = self._complete(prompt)
        parsed = parse_speaker_text(content)
        if parsed is not None:
            return parsed
        speaker = self._fallback_speaker(prompt)
        print(
            f"[show] warning: response did not match 'Speaker: text' — "
            f"assigning {speaker}; raw: {content.strip()[:80]!r}",
            file=sys.stderr,
        )
        return speaker, content.strip()

    def _fallback_speaker(self, prompt: str) -> str:
        speakers = self._speakers_from_prompt(prompt)
        speaker = speakers[self._fallback_i % len(speakers)]
        self._fallback_i += 1
        return speaker

    @staticmethod
    def _speakers_from_prompt(prompt: str) -> list[str]:
        """Character names from the assembled prefix ('## Name' blocks)."""
        names = re.findall(r"^## (.+)$", prompt, re.MULTILINE)
        return names or ["Mia", "Jason"]


# ---------------------------------------------------------------- sessions


def _turn_dict(t: lane_c.Turn) -> dict:
    return {"speaker": t.speaker, "text": t.text, "seq": t.seq}


class ShowSession:
    """One live show: the Show state machine + its driver task + WS clients."""

    def __init__(
        self,
        article: str,
        llm: SteeringLLM,
        cast: list[CharacterSheet] | None = None,
        dial: str | None = None,
        tick_interval: float = TICK_INTERVAL_S,
    ) -> None:
        self.id = uuid.uuid4().hex[:8]
        self.created_at = datetime.now(timezone.utc).isoformat()
        self.article_id = hashlib.sha256(article.encode("utf-8")).hexdigest()[:12]
        self.article = article
        self.cast = cast if cast is not None else default_cast()
        self.tick_interval = tick_interval
        self.asm = lane_c.PromptAssembler(article, self.cast, DEFAULT_BIBLE)
        self.show = lane_c.Show(llm, self.asm, prefetch=DEFAULT_PREFETCH)
        if dial is not None:
            self.show.dial = dial
        self.last_error: str | None = None
        self.lock = asyncio.Lock()  # serializes Show access (executor ticks vs REST)
        self._clients: set[WebSocket] = set()
        self._task: asyncio.Task | None = None
        self._stopped = False

    # ------------------------------------------------------------- lifecycle

    def start(self) -> None:
        self._task = asyncio.create_task(self._run(), name=f"show-{self.id}")

    async def stop(self) -> None:
        self._stopped = True
        if self._task is not None:
            self._task.cancel()
            with suppress(asyncio.CancelledError):
                await self._task
            self._task = None
        for ws in list(self._clients):
            with suppress(Exception):
                await ws.close(code=1001, reason="show ended")
        self._clients.clear()

    # ------------------------------------------------------------- driver

    async def _run(self) -> None:
        loop = asyncio.get_running_loop()
        consecutive_errors = 0
        last_status = time.monotonic()
        while not self._stopped:
            delay = self.tick_interval
            try:
                # tick(1) materialized on a thread: _generate_into_buffer makes
                # blocking LLM calls; the lock keeps REST mutations out meanwhile.
                async with self.lock:
                    heard = await loop.run_in_executor(None, lambda: list(self.show.tick(1)))
            except SteeringError as e:
                consecutive_errors += 1
                self.last_error = str(e)
                delay = min(MAX_STEER_BACKOFF_S, self.tick_interval * consecutive_errors)
                self._broadcast(await self.status_event())
                await asyncio.sleep(delay)
                continue
            consecutive_errors = 0
            self.last_error = None
            for t in heard:
                self._broadcast({"type": "turn_heard", "turn": _turn_dict(t)})
            now = time.monotonic()
            if now - last_status >= STATUS_EVERY_S:
                self._broadcast(await self.status_event())
                last_status = now
            await asyncio.sleep(delay)

    # ------------------------------------------------------------- views

    def _status_locked(self) -> dict:
        led = self.show.ledger
        return {
            "heard_turns": led.playhead,
            "pending": len(led.pending),
            "discarded_count": led.discarded_count,
            "metrics": {**self.show.metrics, "tokens": self.asm.economics()},
            "dial": self.show.dial,
        }

    async def status(self) -> dict:
        async with self.lock:
            return self._status_locked()

    async def status_event(self) -> dict:
        async with self.lock:
            return {"type": "status", **self._status_locked(), "error": self.last_error}

    async def snapshot(self) -> dict:
        """The connect-time view: full heard transcript + prefetch buffer."""
        async with self.lock:
            led = self.show.ledger
            return {
                "type": "snapshot",
                "heard": [_turn_dict(t) for t in led.turns if t.heard],
                "pending": [_turn_dict(t) for t in led.pending],
            }

    # ------------------------------------------------------------- control

    async def interject(self, text: str, address: str | None = None, dial: str | None = None) -> None:
        if address:
            text = f"@{address}: {text}" if text else f"@{address}?"
        async with self.lock:
            if dial is not None:
                self.show.dial = dial  # applies to THIS interjection (repl parity)
            self.show.interject(text)
        self._broadcast(await self.status_event())

    async def set_dial(self, dial: str) -> None:
        async with self.lock:
            self.show.dial = dial
        self._broadcast(await self.status_event())

    # ------------------------------------------------------------- ws

    async def add_client(self, ws: WebSocket) -> None:
        """Accept, snapshot, then hold the connection open. The stream is
        read-only: anything a client sends is ignored (producer input is REST)."""
        await ws.accept()
        self._clients.add(ws)
        try:
            await ws.send_json(await self.snapshot())
            while True:
                await ws.receive_text()  # disconnect surfaces as WebSocketDisconnect
        except (WebSocketDisconnect, RuntimeError):
            pass
        finally:
            self._clients.discard(ws)

    def _broadcast(self, message: dict) -> None:
        for ws in list(self._clients):
            asyncio.create_task(self._send(ws, message))

    async def _send(self, ws: WebSocket, message: dict) -> None:
        try:
            await ws.send_json(message)
        except Exception:
            self._clients.discard(ws)  # dropped mid-show; the rest keep playing


class SessionLimitError(RuntimeError):
    """Too many concurrent shows (manager cap)."""


class ShowManager:
    """Sessions dict + create/stop, guarded by an asyncio.Lock."""

    def __init__(self) -> None:
        self._sessions: dict[str, ShowSession] = {}
        self._lock = asyncio.Lock()

    async def create(
        self,
        article: str,
        llm: str = "scripted",
        cast: list[CharacterSheet] | None = None,
        dial: str | None = None,
        tick_interval: float = TICK_INTERVAL_S,
    ) -> ShowSession:
        engine: SteeringLLM
        if llm == "scripted":
            engine = ScriptedLLM()
        elif llm == "openai":
            engine = OpenAICompatLLM()
        else:
            raise ValueError(f"unknown llm kind: {llm!r}")
        async with self._lock:
            if len(self._sessions) >= MAX_SESSIONS:
                raise SessionLimitError(f"max {MAX_SESSIONS} concurrent shows")
            session = ShowSession(article, engine, cast=cast, dial=dial, tick_interval=tick_interval)
            self._sessions[session.id] = session
        session.start()
        return session

    def get(self, show_id: str) -> ShowSession | None:
        return self._sessions.get(show_id)

    async def stop(self, show_id: str) -> bool:
        async with self._lock:
            session = self._sessions.pop(show_id, None)
        if session is None:
            return False
        await session.stop()
        return True


manager = ShowManager()
