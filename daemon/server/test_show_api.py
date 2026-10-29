"""Show endpoint test (ADR-0009 layer 3): run against a live daemon.

Verifies the Lane C surface end-to-end on the scripted steering default:
create -> WS snapshot + turn stream -> interject with dial=cut_now -> the
next heard turn references the interjection (scripted reaction) and the
prefetch buffer was discarded -> status -> dial route -> delete.

Usage: python test_show_api.py [base_url]   (default http://localhost:8001)
"""
import asyncio
import json
import sys
import urllib.error
import urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8001"
WS_BASE = BASE.replace("http", "ws", 1)

ARTICLE = (
    "Researchers announced a new on-device speech system today, claiming "
    "sub-200-millisecond response times on embedded hardware. Critics note "
    "that benchmark numbers without power context are meaningless on "
    "battery-constrained devices."
)
INTERJECTION = "does the sub-200ms claim survive real thermals?"


def request(method: str, path: str, body: dict | None = None) -> tuple[int, dict]:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        BASE + path, data=data, method=method, headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


async def recv_event(ws, timeout: float = 15.0) -> dict:
    return json.loads(await asyncio.wait_for(ws.recv(), timeout=timeout))


async def collect_turns(ws, n: int) -> list[dict]:
    """Read events until n turn_heard arrived (status events skipped)."""
    turns = []
    while len(turns) < n:
        msg = await recv_event(ws)
        if msg["type"] == "turn_heard":
            turns.append(msg["turn"])
            print(f"  heard [{msg['turn']['speaker']}] {msg['turn']['text']}")
    return turns


async def main() -> None:
    import websockets

    # 1. create a scripted show
    status, created = request("POST", "/v1/shows", {"article": ARTICLE, "llm": "scripted"})
    assert status == 200 and "show_id" in created and "ws_url" in created, (status, created)
    show_id, ws_path = created["show_id"], created["ws_url"]
    print(f"create OK: show {show_id} at {ws_path}")

    try:
        # 2. connect the event stream: snapshot first
        async with websockets.connect(WS_BASE + ws_path, open_timeout=10) as ws:
            snap = await recv_event(ws)
            assert snap["type"] == "snapshot", snap
            assert isinstance(snap["heard"], list) and isinstance(snap["pending"], list), snap
            print(f"snapshot OK: {len(snap['heard'])} heard, {len(snap['pending'])} pending")

            # 3. at least three turns play past the head, in ledger order
            turns = await collect_turns(ws, 3)
            seqs = [t["seq"] for t in turns]
            assert seqs == sorted(seqs) and len(set(seqs)) == len(seqs), seqs
            last_seq_before_cut = seqs[-1]

            # 4. producer interjects with dial=cut_now (REST — WS is read-only)
            status, r = await asyncio.to_thread(
                request,
                "POST",
                f"/v1/shows/{show_id}/interject",
                {"text": INTERJECTION, "dial": "cut_now"},
            )
            assert status == 202 and r.get("ok"), (status, r)
            print(f"interject OK (202): {INTERJECTION!r} with dial=cut_now")

            # 5. the next heard turn after the cut must reference the interjection
            #    (ScriptedLLM reacts with "Good push — on '<quote>': ...")
            reaction = None
            while reaction is None:
                msg = await recv_event(ws)
                if msg["type"] == "turn_heard" and "good push" in msg["turn"]["text"].lower():
                    reaction = msg["turn"]
            assert reaction["seq"] > last_seq_before_cut, (reaction, last_seq_before_cut)
            assert INTERJECTION[:20] in reaction["text"], reaction
            print(
                "INTERJECTION-VERIFIED: turn after cut_now quotes the producer — "
                f"[{reaction['speaker']}] {reaction['text']}"
            )

        # 6. status: the cut really discarded unheard buffer turns
        status, st = request("GET", f"/v1/shows/{show_id}")
        assert status == 200, (status, st)
        assert st["heard_turns"] >= 4, st
        assert st["discarded_count"] >= 1, st
        assert st["metrics"]["interjections"] == 1 and st["metrics"]["cuts"] == 1, st
        print(
            f"status OK: heard {st['heard_turns']}, pending {st['pending']}, "
            f"discarded {st['discarded_count']}, dial {st['dial']}, "
            f"metrics {st['metrics']}"
        )

        # 7. the dial route round-trips
        status, r = request("POST", f"/v1/shows/{show_id}/dial", {"dial": "let_finish"})
        assert status == 200 and r == {"ok": True, "dial": "let_finish"}, (status, r)
        _, st = request("GET", f"/v1/shows/{show_id}")
        assert st["dial"] == "let_finish", st
        print("dial OK: interrupt dial is now let_finish")
    finally:
        # 8. delete; the session must be gone afterwards
        status, r = request("DELETE", f"/v1/shows/{show_id}")
        assert status == 200 and r.get("ok"), (status, r)
        status, _ = request("GET", f"/v1/shows/{show_id}")
        assert status == 404, f"expected 404 after delete, got {status}"
        print("delete OK: session gone (404 on GET)")

    print("SHOW-API-OK")


if __name__ == "__main__":
    asyncio.run(main())
