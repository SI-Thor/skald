"""Engine interface and implementations for the benchmark harness.

An engine streams raw PCM audio chunks for a text. The harness derives all
timing from the outside: TTFA is the time to the first yielded chunk, wall
time is the time to the last, and audio duration comes from the byte count
at the engine's declared sample format (assumed 16-bit signed PCM, mono).
"""

from __future__ import annotations

import abc
import array
import hashlib
import math
import time
import typing


class Engine(abc.ABC):
    """A streaming TTS engine the harness can measure."""

    name: str = "engine"
    voice: str = ""
    language_code: str = "en-US"
    sample_rate_hz: int = 22050
    channels: int = 1
    bytes_per_sample: int = 2
    # Free-form engine-specific settings echoed into the result JSON.
    params: dict = {}

    @abc.abstractmethod
    def synthesize_stream(self, text: str) -> typing.Iterator[bytes]:
        """Yield chunks of raw 16-bit signed PCM audio for ``text``.

        The first chunk must not be yielded until audio is actually
        available (TTFA is measured against it). One-time setup (model
        load, gRPC connect) may happen lazily inside the first call; the
        harness times that call separately as the "cold" phase.
        """

    def audio_duration(self, total_bytes: int) -> float:
        return total_bytes / (self.sample_rate_hz * self.channels * self.bytes_per_sample)


class MockEngine(Engine):
    """Deterministic sine-wave stand-in used to test the harness itself.

    Audio duration models a reading pace (default 150 wpm); artificial
    latencies simulate one-time load, per-request time-to-first-chunk and
    per-chunk streaming overhead. The waveform frequency is derived from a
    stable hash of the voice name, so identical (voice, text) inputs are
    byte-identical across processes and runs — the long-doc stability check
    relies on that determinism.
    """

    def __init__(
        self,
        voice: str = "sine",
        *,
        language_code: str = "en-US",
        sample_rate_hz: int = 16000,
        words_per_minute: float = 150.0,
        load_delay_s: float = 0.30,
        first_chunk_delay_s: float = 0.05,
        chunk_delay_s: float = 0.001,
        chunk_samples: int = 4000,
    ) -> None:
        self.name = "mock"
        self.voice = voice
        self.language_code = language_code
        self.sample_rate_hz = sample_rate_hz
        self.words_per_minute = words_per_minute
        self.load_delay_s = load_delay_s
        self.first_chunk_delay_s = first_chunk_delay_s
        self.chunk_delay_s = chunk_delay_s
        self.chunk_samples = chunk_samples
        self.params = {
            "words_per_minute": words_per_minute,
            "load_delay_s": load_delay_s,
            "first_chunk_delay_s": first_chunk_delay_s,
            "chunk_delay_s": chunk_delay_s,
            "chunk_samples": chunk_samples,
        }
        self._loaded = False
        self._pattern: array.array | None = None

    def _tone_pattern(self) -> array.array:
        """One seamless loop of the voice's tone (whole number of cycles)."""
        if self._pattern is None:
            digest = hashlib.sha256(self.voice.encode()).digest()
            freq = 110 + (int.from_bytes(digest[:4], "big") % 660)  # 110-769 Hz
            rate = self.sample_rate_hz
            loop_len = rate // math.gcd(freq, rate)
            pattern = array.array(
                "h",
                (
                    int(0.3 * 32767 * math.sin(2 * math.pi * freq * i / rate))
                    for i in range(loop_len)
                ),
            )
            self._pattern = pattern
        return self._pattern

    def synthesize_stream(self, text: str) -> typing.Iterator[bytes]:
        if not self._loaded:
            time.sleep(self.load_delay_s)  # simulated model load (cold phase)
            self._loaded = True

        words = len(text.split())
        total_samples = int(words / self.words_per_minute * 60.0 * self.sample_rate_hz)
        pattern = self._tone_pattern()
        full = pattern * (total_samples // len(pattern))
        full += pattern[: total_samples % len(pattern)]

        delay = self.first_chunk_delay_s
        for offset in range(0, len(full), self.chunk_samples):
            time.sleep(delay)
            delay = self.chunk_delay_s
            yield full[offset : offset + self.chunk_samples].tobytes()


class RivaEngine(Engine):
    """gRPC adapter for NVIDIA Riva TTS (``nvidia-riva-client`` package).

    UNVERIFIED — written against the documented Riva 2.x
    ``SpeechSynthesisService`` API; no live server was available when this
    was written (Riva is not yet deployed on the Thor). Every call shape
    marked "UNVERIFIED" below follows the riva-client 2.x documentation and
    must be smoke-tested against a real server at localhost:50051.

    The dependency is optional (pyproject extra ``[riva]``) and imported
    lazily so the rest of the harness runs without it.
    """

    DEFAULT_URI = "localhost:50051"
    DEFAULT_VOICE = "English-US.Female-1"

    def __init__(
        self,
        voice: str = DEFAULT_VOICE,
        *,
        language_code: str = "en-US",
        uri: str = DEFAULT_URI,
        sample_rate_hz: int = 22050,
        use_ssl: bool = False,
    ) -> None:
        try:
            import riva.client  # availability check; actual use is lazy below
        except ImportError as exc:
            raise RuntimeError(
                "riva engine requires the optional dependency "
                "'nvidia-riva-client' — install with: "
                "python3 -m pip install -e './benchmark[riva]'"
            ) from exc

        self.name = "riva"
        self.voice = voice
        self.language_code = language_code
        self.uri = uri
        self.sample_rate_hz = sample_rate_hz
        self.use_ssl = use_ssl
        self.params = {"uri": uri, "use_ssl": use_ssl}
        self._service = None  # lazily connected on first synthesis (cold phase)

    def _connect(self) -> None:
        import riva.client

        # UNVERIFIED: riva.client.Auth(uri=..., use_ssl=...)
        auth = riva.client.Auth(uri=self.uri, use_ssl=self.use_ssl)
        # UNVERIFIED: riva.client.SpeechSynthesisService(auth)
        self._service = riva.client.SpeechSynthesisService(auth)

    def synthesize_stream(self, text: str) -> typing.Iterator[bytes]:
        if self._service is None:
            self._connect()
        # Chunk at sentence-ish boundaries under the server's max_input_length
        # (2000 chars on our Magpie deployment; the preprocessor enforces it
        # server-side and rejects whole-request overflows). This mirrors how
        # Lane A clients must stream anyway.
        chunks: list[str] = []
        remaining = text
        limit = 350  # ~400-token max_sequence_length on the server (chars≈tokens after IPA)
        while remaining:
            if len(remaining) <= limit:
                chunks.append(remaining)
                break
            cut = max(remaining.rfind(". ", 0, limit), remaining.rfind(" ", 0, limit))
            if cut < limit // 2:
                cut = limit - 1
            chunks.append(remaining[: cut + 1])
            remaining = remaining[cut + 1 :]
        for chunk in chunks:
            responses = self._service.synthesize_online(
                text=chunk,
                voice_name=self.voice,
                language_code=self.language_code,
                sample_rate_hz=self.sample_rate_hz,
            )
            for response in responses:
                if response.audio:
                    yield response.audio


ENGINE_NAMES = ("mock", "riva")
