"""Voice registry: live Riva voices parsed into skald metadata + friendly aliases."""
import re
import time

import httpx

from config import RIVA_HTTP_URI, VOICES_CACHE_SECONDS

# friendly aliases -> canonical Riva voice ids (canonical names always win too)
ALIASES: dict[str, str] = {
    "mia": "Magpie-Multilingual.EN-US.Mia",
    "jason": "Magpie-Multilingual.EN-US.Jason",
    "aria": "Magpie-Multilingual.EN-US.Aria",
}

_VOICE_RE = re.compile(
    r"^Magpie-Multilingual\.(?P<locale>[A-Z]{2}-[A-Z]{2})\."
    r"(?P<speaker>[A-Za-z]+)(?:\.(?P<style>Neutral|Calm|Angry|Happy|Sad))?$"
)

_cache: tuple[float, list[dict], dict[str, str]] | None = None  # (ts, voices, aliases_resolved)


def _parse(raw_voices: list[str]) -> list[dict]:
    out = []
    for v in raw_voices:
        m = _VOICE_RE.match(v)
        if not m:
            continue
        out.append(
            {
                "voice_id": v,
                "locale": m.group("locale"),
                "speaker": m.group("speaker"),
                "style": m.group("style") or "Default",
                "source": "riva",
            }
        )
    return out


async def get_voices(force: bool = False) -> list[dict]:
    global _cache
    if not force and _cache and time.time() - _cache[0] < VOICES_CACHE_SECONDS:
        return _cache[1]
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.get(f"{RIVA_HTTP_URI}/v1/audio/list_voices")
        r.raise_for_status()
        data = r.json()
    raw = []
    for _langs, blob in data.items():
        raw.extend(blob.get("voices", []))
    voices = _parse(raw)
    _cache = (time.time(), voices, ALIASES)
    return voices


async def resolve_voice(name: str | None) -> str:
    """Canonical Riva voice id from a canonical id, friendly alias, or None."""
    if not name:
        return ALIASES["mia"]
    if name.lower() in ALIASES:
        return ALIASES[name.lower()]
    return name
