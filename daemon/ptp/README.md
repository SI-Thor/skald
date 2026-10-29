# PTP score clock (LinuxPTP)

The score clock for cross-machine turn scheduling (last-mile "words timed
against tone tracks"). Two regimes on this Thor:

| Link | Mode | Accuracy | Status |
|---|---|---|---|
| **MGBE Ethernet** (mgbe0_0, cable to ProArt) | hardware PTP (`ptp4l-mgbe0.conf`, PHC 1) | sub-µs typical | ready — needs cable |
| WiFi (wlP1p1s0, current link) | ptp4l **cannot run** (driver lacks timestamping) | — | use chrony/systemd-timesyncd (~1–10 ms) |

## Bring-up (once cabled)

```bash
sudo ptp4l -f daemon/ptp/ptp4l-mgbe0.conf          # both ends
sudo phc2sys -s mgbe0_0 -c CLOCK_REALTIME -w       # share PHC → system clock
```

ProArt end: same config + `clientOnly 1` in the interface section (or
`-s`/`-c` swapped per direction). Verify: `pmc -u -b 0 'GET TIME_STATUS_NP'`
→ `master_offset` in the hundreds of ns…low µs.

## Fallback (WiFi, today)

systemd-timesyncd is active; chrony is the better fallback if sub-ms matters
over WiFi (it usually doesn't for turn scheduling — score clocks run at
10–100 ms granularity; sample-accurate audio alignment is an application-layer
concern (RTP/render clocks), not PTP's job).
