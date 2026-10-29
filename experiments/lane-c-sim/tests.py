"""Tests for the lane-c-sim hard semantics. Plain asserts, python3 tests.py."""
import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from show import Ledger, PromptAssembler, ScriptedLLM, Show, CharacterSheet, est_tokens
from llm import OpenAICompatLLM, SteeringError, extract_model_ids, parse_speaker_text
from repl import parse_command


def test_ledger_excludes_unheard_after_cut():
    led = Ledger()
    led.add("Mia", "one")
    led.add("Jason", "two")
    led.advance_playhead(1)  # heard 'one'
    led.add("Mia", "three-planned")
    dropped = led.discard_pending()
    assert [t.text for t in dropped] == ["two", "three-planned"]
    mem = led.memory()
    assert [t.text for t in mem] == ["one"], "unheard turns leaked into memory!"
    assert led.discarded_count == 2


def test_cut_now_drops_buffer_and_lands_interjection():
    llm = ScriptedLLM()
    asm = PromptAssembler("ARTICLE", [CharacterSheet("Mia", "p", "v")], "bible")
    show = Show(llm, asm, prefetch=3)
    list(show.tick(1))  # hear one turn
    assert len(show.ledger.pending) == show.prefetch - 1  # generate fills, then playhead consumed one
    show.interject("what about the methodology?")
    assert show.metrics["cuts"] == 1
    # pending dropped; next generate must react to the interjection
    t = next(show.tick(1))
    assert "methodology" in t.text.lower(), f"interjection lost: {t.text}"
    assert show.interjection is None


def test_wrap_thought_completes_then_injects():
    llm = ScriptedLLM()
    asm = PromptAssembler("A", [CharacterSheet("Mia", "p", "v")], "b")
    show = Show(llm, asm, prefetch=3)
    list(show.tick(1))
    show.dial = "wrap_thought"
    show.interject("redirect me")
    # tick: current pending turn completes (heard), interjection lands after
    heard = list(show.tick(2))
    assert len(heard) >= 1
    assert any("redirect" in t.text.lower() for t in show.ledger.turns), "wrap lost the interjection"


def test_token_economics_shape():
    asm = PromptAssembler("word " * 400, [CharacterSheet("Mia", "p", "v")], "b")
    llm = ScriptedLLM()
    show = Show(llm, asm, prefetch=1)
    for _ in range(6):
        list(show.tick(1))
    e = asm.economics()
    assert e["prefix_tokens"] >= 100
    assert e["suffix_tokens_total"] > 0
    assert 0 < e["cache_ratio"] < 1, e
    # design claim: prefix dominates for long articles
    assert e["cache_ratio"] > 0.5, f"prefix not dominant: {e}"


def test_prefetch_refill():
    led = Ledger()
    llm = ScriptedLLM()
    asm = PromptAssembler("A", [CharacterSheet("Mia", "p", "v")], "b")
    show = Show(llm, asm, ledger=led, prefetch=2)
    list(show.tick(2))
    assert len(led.pending) == show.prefetch - 2, "prefetch semantics: prefetch minus listened"


# ---------------------------------------------------------------- layer 2: steering LLM over HTTP


class _QuietServer(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        pass  # a timed-out client hanging up mid-response is expected in tests


def _fake_openai_server(content="Mia: canned line", delay=0.0, status=200, raw=None):
    """Stdlib chat-completions stand-in. Returns (server, base_url)."""

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def _send(self, payload: bytes, http_status=200):
            self.send_response(http_status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def do_GET(self):  # /models probe
            self._send(json.dumps({"object": "list", "data": [{"id": "test-model"}]}).encode())

        def do_POST(self):  # /chat/completions
            if delay:
                time.sleep(delay)
            n = int(self.headers.get("Content-Length") or 0)
            self.rfile.read(n)
            if status != 200:
                self._send(json.dumps({"error": {"message": "boom"}}).encode(), status)
            elif raw is not None:
                self._send(raw)
            else:
                self._send(
                    json.dumps(
                        {"choices": [{"index": 0, "message": {"role": "assistant", "content": content}}]}
                    ).encode()
                )

    server = _QuietServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}/v1"


# shaped like a real PromptAssembler prefix: '## Name' blocks at line start
PROMPT_WITH_CAST = (
    "# CHARACTERS\n"
    + CharacterSheet("Mia", "p", "v").prompt_block()
    + CharacterSheet("Jason", "p", "v").prompt_block()
    + "\n# CONVERSATION SO FAR\nsuffix"
)


def test_openai_llm_parse_success():
    server, base = _fake_openai_server(content="Jason: the data disagrees with the framing")
    try:
        llm = OpenAICompatLLM(base_url=base, model="test-model", timeout=5)
        assert llm.probe() is True
        assert llm.last_models == ["test-model"]
        speaker, text = llm.next_turn(PROMPT_WITH_CAST)
        assert (speaker, text) == ("Jason", "the data disagrees with the framing")
        assert llm.calls == 1
    finally:
        server.shutdown()
        server.server_close()


def test_openai_llm_malformed_falls_back():
    # content without a 'Speaker:' prefix -> round-robin speaker, raw text kept
    server, base = _fake_openai_server(content="no speaker prefix here at all")
    try:
        llm = OpenAICompatLLM(base_url=base, model="test-model", timeout=5)
        speaker, text = llm.next_turn(PROMPT_WITH_CAST)
        assert speaker in ("Mia", "Jason"), speaker
        assert text == "no speaker prefix here at all"
        # a second parse failure round-robins to the other cast member
        speaker2, _ = llm.next_turn(PROMPT_WITH_CAST)
        assert speaker2 != speaker, (speaker, speaker2)
    finally:
        server.shutdown()
        server.server_close()

    # malformed ENVELOPE (non-JSON body) is a transport failure, not a fallback
    server, base = _fake_openai_server(raw=b"<html>not json</html>")
    try:
        llm = OpenAICompatLLM(base_url=base, model="test-model", timeout=5)
        try:
            llm.next_turn(PROMPT_WITH_CAST)
            raise AssertionError("non-JSON envelope must raise SteeringError")
        except SteeringError as e:
            assert "shape" in str(e), e
    finally:
        server.shutdown()
        server.server_close()

    # HTTP error (e.g. model not pulled yet) is a SteeringError too
    server, base = _fake_openai_server(status=404, content="ignored")
    try:
        llm = OpenAICompatLLM(base_url=base, model="missing-model", timeout=5)
        try:
            llm.next_turn(PROMPT_WITH_CAST)
            raise AssertionError("HTTP 404 must raise SteeringError")
        except SteeringError as e:
            assert "404" in str(e), e
    finally:
        server.shutdown()
        server.server_close()

    # lenient parser unit checks
    assert parse_speaker_text("Mia: hi") == ("Mia", "hi")
    assert parse_speaker_text("  Jason :  padded  ") == ("Jason", "padded")
    assert parse_speaker_text("Mia:\nnext line") == ("Mia", "next line")
    assert parse_speaker_text("no colon at all") is None
    assert parse_speaker_text("") is None
    assert parse_speaker_text(": orphan colon") is None
    assert extract_model_ids(b'{"object":"list","data":null}') == []
    assert extract_model_ids(b"garbage") is None


def test_openai_llm_timeout_raises():
    server, base = _fake_openai_server(content="Mia: too slow", delay=2.0)
    try:
        llm = OpenAICompatLLM(base_url=base, model="test-model", timeout=0.25)
        try:
            llm.next_turn(PROMPT_WITH_CAST)
            raise AssertionError("expected SteeringError on timeout")
        except SteeringError as e:
            assert "timed out" in str(e), e
    finally:
        server.shutdown()
        server.server_close()


def test_parse_command_actions():
    assert parse_command("what about the methodology?") == {
        "kind": "ask_room",
        "text": "what about the methodology?",
    }
    assert parse_command("   \n") == {"kind": "none"}
    assert parse_command("") == {"kind": "none"}
    assert parse_command("@Mia: seriously?") == {"kind": "ask_char", "speaker": "Mia", "text": "seriously?"}
    assert parse_command("@Jason hmm") == {"kind": "ask_char", "speaker": "Jason", "text": "hmm"}
    assert parse_command("!wrap") == {"kind": "dial", "dial": "wrap_thought"}
    assert parse_command("!CUT") == {"kind": "dial", "dial": "cut_now"}
    assert parse_command("!pause") == {"kind": "pause"}
    assert parse_command("!resume") == {"kind": "resume"}
    assert parse_command("!state") == {"kind": "state"}
    assert parse_command("!metrics") == {"kind": "metrics"}
    assert parse_command("!quit") == {"kind": "quit"}
    assert parse_command("!bogus")["kind"] == "unknown"


def run_all():
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in fns:
        fn()
        print(f"PASS {fn.__name__}")
    print(f"{len(fns)}/{len(fns)} tests passed")
    return 0


if __name__ == "__main__":
    sys.exit(run_all())
