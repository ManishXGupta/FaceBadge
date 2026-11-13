# FaceBadge

Proof of concept for the paper **"FaceBadge: Your Face, Your Consent, a Trustworthy AI Framework for Face-Based Contact Exchange at Professional Events"** (Manish Gupta, 2026).

Point your phone at another attendee, like scanning a badge, and open their LinkedIn profile to connect. It only works for people who registered with consent, every scan is visible to the person scanned, and all face data is deleted when the event ends.

## The design in one paragraph

Attendees give consent **once, at registration**: a selfie (turned into a 128-number template on the phone), their LinkedIn URL, and a sharing choice: *everyone registered*, *my AI agent decides using my plain-English rule*, or *name only*. At the event, any **registered** attendee can scan another registered attendee and see the result at once. People who did not register are never matched. Every scan is tied to the scanner's registered identity and appears in the scanned person's **Who scanned me** log, where they can block the scanner or withdraw consent, which deletes their template immediately.

| Rule | How the code enforces it |
|------|--------------------------|
| Only registered people can be found | The gallery holds only self-registered templates. Anyone else returns `no_match` and the probe template is discarded. |
| Only registered people can scan | `/api/match` needs the scanner's registration token (`401 register_to_scan` otherwise). |
| Photos stay on the phone | Detection and template creation run in the browser. Only one template is sent. |
| Bystanders are ignored | Only the largest, closest face gets a template. Other faces are masked and never processed. |
| Sharing set at registration | `everyone` (tier 3), `name` (tier 1) or `agent`, where a Claude agent applies the owner's rule at scan time, clamped in code. |
| Transparency | Every scan is logged for the scanned person with the scanner's registered name, role, organization and stated purpose. |
| Block and withdraw | Blocked scanners get tier 0. Withdrawal deletes the template and the log at once. |
| Nothing is kept | Templates live in server memory only and are wiped at event end, on organizer close, or on restart. |
| Safe when unsure | If two registered faces are too close, the result is `ambiguous` and nothing is shown. |

## Two ways to run it

1. **Live app (hosted on claude.ai)**: `live/index.html`. Uses the viewer's claude.ai account as the verified identity, a shared document store for registrations and the scan log, and Claude for the agent. This is the version used for the author's self-test.
2. **Self-hosted reference server**: `server.js` + `public/`. Node.js only, no npm packages. Use this to run a real conference on your own HTTPS server.

## Quick start (self-hosted)

```bash
npm start              # http://localhost:3000
```

1. **Phone A, "1. Register":** fill in your details, choose who sees your LinkedIn, tick both consent boxes and capture your face.
2. **Phone B, "1. Register":** a second attendee registers the same way.
3. **Phone B, "2. Scan":** point the camera at Phone A's owner. The profile and an "Open LinkedIn and connect" button appear at once.
4. **Phone A, "3. Who scanned me":** see who scanned you, and block them if you want.

Phone cameras need `https://` or `localhost`.

## Use Claude as the agent (self-hosted)

```bash
export ANTHROPIC_API_KEY=sk-ant-...
export CLAUDE_MODEL=claude-sonnet-5-5   # optional
npm start
```

Without a key, `agent` mode falls back to sharing the name only.

## Configuration

| Variable | Default | Meaning |
|----------|---------|---------|
| `PORT` | 3000 | HTTP port |
| `EVENT_NAME` | Demo Conference 2026 | Shown in the app |
| `EVENT_ENDS_AT` | none | ISO time. All data is wiped after this and registration closes. |
| `ADMIN_KEY` | random | Key for `/api/admin/close` and `/api/admin/eval.csv` |
| `MATCH_THRESHOLD` | 0.5 | Max template distance for a match |
| `MATCH_MARGIN` | 0.05 | Best match must beat the second best by this much |
| `ANTHROPIC_API_KEY` | none | Enables the Claude agent |
| `CLAUDE_MODEL` | claude-sonnet-5-5 | Model for the agent |

## Tests

```bash
npm test          # 19 API and agent tests (Manish Gupta's public profile is the registered attendee)
npm run bench     # matching time vs gallery size
python3 test/e2e/browser_e2e.py --face face.y4m --noface noface.y4m   # full browser test with a fake camera
```

Make a fake-camera clip from a selfie of a consenting person (yourself):

```bash
ffmpeg -loop 1 -i selfie.png -t 6 -r 15 -vf scale=640:480 -pix_fmt yuv420p face.y4m
```

## Reproduce every result in the paper

```bash
npm run verify     # tests + matching cost + simulations + baselines; writes results/*.json and results/bench.csv
```

| Paper table | Command | Output |
|-------------|---------|--------|
| III. Baseline: QR code vs FaceBadge (KLM) | `npm run baselines` | `results/klm-baseline.json` |
| IV. Simulated event, 100 attendees, 1,000 scans | `npm run simulate` | `results/simulation.json` (partB) |
| Ambiguity margin check (text, Section VIII-C) | `npm run simulate` | `results/simulation.json` (partA) |
| Agent benchmark baselines (extra, not in paper) | `npm run baselines` | `results/agent-benchmark.json` |
| Agent on Claude | Live app, Self-test tab, "Run agent benchmark" | CSV export |
| Functional tests | `npm test` | 19 passing |
| End-to-end browser test | `python3 test/e2e/browser_e2e.py --face face.y4m --noface noface.y4m` | `E2E PASSED` |
| Matching cost | `npm run bench` | `results/bench.csv` |

Simulations are seeded, so `npm run simulate` and `npm run baselines` give the same numbers on every machine. Timing numbers vary with the computer.

## Self-test protocol (before a field study)

The live app has a **Self-test** tab. Register yourself, then run trials and export the CSV:

| Trial type | What to do | Suggested count |
|------------|------------|-----------------|
| Genuine | Photograph yourself in each condition (indoor 0.5 m, 1 m, 2 m; low light; backlight; head turned 30 degrees; glasses; cap; other people in frame) | 5 per condition |
| Impostor | Photograph faces of people who are not registered (for example news photos on a laptop screen) | 20 or more |
| No face | Photograph a scene with no face | 5 |

Report genuine match rate, false matches, median distances and median time on the phone. The same tab has a **Run agent benchmark** button that sends the 40 synthetic scanners from `results/agent-benchmark.json` through Claude and exports the scores. See [docs/evaluation-plan.md](docs/evaluation-plan.md) for the conference field study that follows.

## API (self-hosted)

| Method | Path | Who | Purpose |
|--------|------|-----|---------|
| GET | `/api/event` | anyone | Event name, count, agent mode |
| POST | `/api/enroll` | attendee | Register with consent and a sharing mode; returns a private token |
| POST | `/api/match` | registered attendee (Bearer token) | Send one template; returns the shared fields or `matched:false` |
| GET | `/api/scans` | attendee (Bearer token) | Who scanned me |
| POST | `/api/block` | attendee (Bearer token) | Block or unblock a scanner |
| DELETE | `/api/me` | attendee (Bearer token) | Withdraw consent and delete template and log now |
| POST | `/api/admin/close` | organizer | Wipe everything |
| GET | `/api/admin/eval.csv?key=` | organizer | Evaluation log (no names, no faces) |

## Limitations

- The template is sent to the server for matching. Production should use encrypted matching (for example homomorphic encryption).
- In the hosted live app, matching runs on the scanner's phone, so registered templates are readable by signed-in viewers of the app, and the scan log is stored in a shared collection. This is acceptable for a self-test, not for a public event; use the self-hosted server for that.
- No liveness check: a printed photo of a registered person can be matched. The scan is still logged and the person can block the scanner.
- Recognition accuracy can differ across demographic groups; this must be measured in the field study.
- Smart glasses are future work. The design keeps the same rules: deliberate trigger, visible indicator, registered people only.
- The match-rule sweep and event simulation use synthetic templates; they test the rules, not real-face accuracy.

## Credits

Face detection and recognition: [@vladmandic/face-api](https://github.com/vladmandic/face-api) (MIT). Agent: Anthropic Claude.

## License

MIT
