"""OpenAI-compatible steering LLM — ADR-0009 layer 2.

Fills the `show.SteeringLLM` slot with a real model over any
/chat/completions endpoint (Ollama serves localhost:11434/v1 on the
reference box; vLLM/llama.cpp/NIM all speak the same shape).

Stdlib only (urllib.request) — no dependencies. The model must answer in
`Speaker: text` form; parsing is lenient and falls back to a round-robin
speaker (with a stderr note) rather than killing the show. Transport
failures — timeout, unreachable, malformed envelope — raise `SteeringError`;
callers (the repl) catch it and keep the show alive.

Config via env (read at construction, never at import):
  LANE_C_LLM_BASE_URL    default http://localhost:11434/v1
  LANE_C_LLM_MODEL       default llama3.1
  LANE_C_LLM_TIMEOUT     default 30 (seconds)
  LANE_C_LLM_TEMPERATURE default 0.8
"""
from __future__ import annotations

import json
import os
import re
import socket
import sys
import urllib.error
import urllib.request

from show import SteeringLLM

DEFAULT_BASE_URL = "http://localhost:11434/v1"
DEFAULT_MODEL = "llama3.1"
DEFAULT_TIMEOUT = 30.0
DEFAULT_TEMPERATURE = 0.8
MAX_TOKENS = 120  # short turns (1-3 sentences) per the show bible


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
    """Parse the mandated 'Speaker: text' shape, leniently.

    Split on the first colon; strip both sides. Returns None when there is
    no usable speaker prefix (no colon, empty/newline-bearing speaker) —
    callers then fall back to a round-robin speaker with the raw text.
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

    # Polish pass (2026-10-29 live-show warts):
    # 1) strip a duplicated "[Speaker]" bracket prefix from the text
    import re as _re
    rest = _re.sub(rf"^\s*\[{_re.escape(speaker)}\]\s*", "", rest)
    # 2) drop parenthetical stage directions — "( Jason can respond ... )"
    #    is direction to other cast members, not dialogue
    if rest.startswith("("):
        close = rest.find(")")
        if close != -1:
            rest = rest[close + 1 :].lstrip()
    return speaker, rest.strip()


def extract_model_ids(body: bytes) -> list[str] | None:
    """Pull model ids/names out of a /models payload, leniently.

    Returns None when the body is not JSON we recognize; [] means the
    endpoint answered but lists no models (nothing pulled yet).
    """
    try:
        data = json.loads(body.decode("utf-8", "replace"))
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict):
        return None
    for key in ("data", "models"):
        if key in data:
            val = data[key]
            if not isinstance(val, list):
                return []
            return [
                m.get("id", m.get("name", "?")) if isinstance(m, dict) else str(m)
                for m in val
            ]
    return None


class OpenAICompatLLM(SteeringLLM):
    """SteeringLLM over an OpenAI-shaped /chat/completions endpoint."""

    def __init__(
        self,
        base_url: str | None = None,
        model: str | None = None,
        timeout: float | None = None,
        temperature: float | None = None,
    ) -> None:
        self.base_url = (
            base_url or _env("LANE_C_LLM_BASE_URL", DEFAULT_BASE_URL, str)
        ).rstrip("/")
        self.model = model or _env("LANE_C_LLM_MODEL", DEFAULT_MODEL, str)
        self.timeout = (
            timeout if timeout is not None else _env("LANE_C_LLM_TIMEOUT", DEFAULT_TIMEOUT, float)
        )
        self.temperature = (
            temperature
            if temperature is not None
            else _env("LANE_C_LLM_TEMPERATURE", DEFAULT_TEMPERATURE, float)
        )
        self.calls = 0
        self.last_models: list[str] | None = None  # filled by probe()
        self._fallback_speakers = ["Mia", "Jason"]
        self._fallback_i = 0

    # ------------------------------------------------------------- transport

    def probe(self, timeout: float | None = None) -> bool:
        """One-shot GET {base}/models. True if the endpoint answers at all.

        Records the model list in `self.last_models` (None = unrecognized
        body, [] = answered with no models).
        """
        url = f"{self.base_url}/models"
        try:
            req = urllib.request.Request(url, headers={"Accept": "application/json"})
            t = timeout if timeout is not None else min(self.timeout, 5.0)
            with urllib.request.urlopen(req, timeout=t) as resp:
                body = resp.read()
        except OSError:
            self.last_models = None
            return False
        self.last_models = extract_model_ids(body)
        return True

    def _complete(self, prompt: str) -> str:
        """POST chat/completions (stream=false); return message.content.

        Raises SteeringError on timeout / unreachable / HTTP error /
        malformed envelope.
        """
        url = f"{self.base_url}/chat/completions"
        body = json.dumps(
            {
                "model": self.model,
                "messages": [{"role": "user", "content": prompt}],
                "stream": False,
                "max_tokens": MAX_TOKENS,
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
            raise SteeringError(
                f"steering LLM timed out after {self.timeout:g}s ({url})"
            ) from e
        except urllib.error.HTTPError as e:
            detail = ""
            try:
                detail = e.read()[:200].decode("utf-8", "replace")
            except OSError:
                pass
            raise SteeringError(
                f"steering LLM HTTP {e.code} from {url}: {detail or e.reason}"
            ) from e
        except urllib.error.URLError as e:
            if isinstance(e.reason, (socket.timeout, TimeoutError)):
                raise SteeringError(
                    f"steering LLM timed out after {self.timeout:g}s ({url})"
                ) from e
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
            raise SteeringError(
                f"chat-completions content is {type(content).__name__}, not str ({url})"
            )
        return content

    # ------------------------------------------------------------ SteeringLLM

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
            f"[llm] warning: response did not match 'Speaker: text' — "
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
