<p align="center">
  <img src="assets/icon.png" alt="qq-bridge" width="120">
</p>

<h1 align="center">QQ ↔ DeepSeek Harness Bridge</h1>

<p align="center">
  <b>Give DSH agents a life in QQ groups</b> · group messages become prompts; replies, questions and tool approvals go back to QQ<br>
  See &amp; send images · speak on its own · idle and wake · Bilibili browsing · web search · access control
</p>

<p align="center">
  <img alt="Node" src="https://img.shields.io/badge/Node-%E2%89%A522.13-339933?logo=node.js&logoColor=white&style=flat-square">
  <img alt="Platform" src="https://img.shields.io/badge/Platform-Windows-0078D4?logo=windows&logoColor=white&style=flat-square">
  <img alt="Tests" src="https://img.shields.io/badge/tests-152%20scripts-2ea44f?style=flat-square">
  <img alt="DSH" src="https://img.shields.io/badge/DSH-0.1.1--rc.2-6f42c1?style=flat-square">
  <img alt="License" src="https://img.shields.io/badge/License-MIT-blue?style=flat-square">
</p>

<p align="center">
  <a href="README.md">中文</a> ·
  <a href="docs/FEATURES.md">Features</a> ·
  <a href="docs/CONFIGURATION.md">Configuration</a> ·
  <a href="docs/MODEL_SETUP.md">Model setup</a> ·
  <a href="docs/DEPENDENCIES.md">Dependencies</a> ·
  <a href="docs/CHANGELOG.md">Changelog</a>
</p>

---

## What it is

A bridge process that puts **QQ** in front of **DeepSeek Harness (DSH)**:

```
QQ messages ──► SnowLuma (OneBot v11 WS) ──► qq-bridge ──► DSH Web API (127.0.0.1:3080/api)
                                                    ▲                      │
                                                    └── agent replies / questions / approvals ┘
```

In `reserved2` mode the DSH model decides **through MCP tools** which messages to read, what to say and when to dive — the bridge supplies real group state (who is calling you, unread count, what you just said) and enforces the safety boundary.

## Features at a glance

| Area | Capability |
| --- | --- |
| **Messaging** | Group/private messages ↔ DSH sessions (including inbound voice transcription); question forwarding, tool approvals, slash commands; in-group `/wl` whitelist management |
| **Context** | Quote parsing (including quoted images), merged-forward reading, `latest` symbolic replies, episodic and long-term memory |
| **Images** | Viewing, super-resolution upscale, multi-source library (safebooru / pixiv / yande.re), style scoring, re-pick on negative feedback, reverse search, source restriction |
| **Parsing** | WeChat articles, QQ share cards (Bilibili / Xiaohongshu / music / location) |
| **Bilibili** | Self-browsing, watch memory, taste summary, proactive sharing, subtitle-to-text |
| **Web** | Pluggable search engines (including keyless weather), SSRF-guarded `web_fetch`, view image by URL |
| **Scheduling** | Wake priorities, priority-based backfill, pre-dive observation window, split sending |
| **Interaction** | Message reactions, sticker library, GIF frame tiling, slang learning, long-term memory, comply dice, auto-@ |
| **Extras** | GitHub repo screenshots, self-image, feature menu image, on-demand X (Twitter) lookup |
| **Safety** | Three private-chat admission modes, owner-only error reporting, secret redaction, tool allowlist |

Full details (implementation notes and edge cases): **[docs/FEATURES.md](docs/FEATURES.md)** (Chinese).

## Quick start

The goal: from a clean Windows machine to a reply in your QQ group. Full dependency list and versions: **[docs/DEPENDENCIES.md](docs/DEPENDENCIES.md)**.

> Default ports: DSH `3080`, SnowLuma HTTP `3000`, OneBot WebSocket `3001`, console `3100`.
> Keep the defaults and the config needs no port edits.

### Step 0 · What you need

| Type | Component | Purpose | Required |
| --- | --- | --- | --- |
| Runtime | **Node.js ≥ 22.13** + npm | bridge, MCP, tests | ✅ |
| Tool | **Git** | clone / update | ✅ |
| Service | **DeepSeek Harness Web (DSH)** | model and agent runtime, `127.0.0.1:3080` | ✅ |
| Service | **SnowLuma** | QQ OneBot v11 gateway, WebSocket + HTTP API | ✅ |
| Model | A provider configured in DSH (DeepSeek API or local OpenAI-compatible gateway) | generates replies | ✅ |
| Media | **ffmpeg / ffprobe** | image resizing, GIF/video frames, audio conversion | ⭐ strongly recommended |
| Browser | **Chrome or Edge** | feature menu, token report, GitHub screenshots | ⭐ for screenshot features |
| Voice | **Python 3.10+** + GPT-SoVITS | text-to-speech | optional |
| Voice | **Python 3.10+** + faster-whisper | speech-to-text / Bilibili subtitle fallback | optional |
| Image | **Upscayl** ([download](https://upscayl.pro/cn/download.html), use `upscayl-bin.exe`) | super-resolution | optional |
| Network | HTTP proxy | pixiv / GitHub / some overseas sites | optional |

### Step 1 · Install and start the external services

1. Install **Node.js ≥ 22.13** from [nodejs.org](https://nodejs.org/) and verify:

   ```bash
   node -v
   npm -v
   ```

2. Install and start **DSH Web**; confirm it responds:

   ```bash
   curl http://127.0.0.1:3080
   ```

3. Install and start **SnowLuma**, log in to QQ, then in its OneBot settings:
   - enable **WebSocket** (default `3001`) and **HTTP API** (default `3000`);
   - use the same `accessToken` on both (or leave empty);
   - note the actual ports for Step 3.

4. (Recommended) install **ffmpeg** (`winget install Gyan.FFmpeg` on Windows) and verify `ffmpeg -version` / `ffprobe -version`.

5. (Optional) Chrome/Edge: Windows ships Edge; set `CHROME_PATH` if it lives elsewhere.

### Step 2 · Clone and install

```bash
git clone https://github.com/群友U/qq-bridge.git
cd qq-bridge
npm install
```

`postinstall` patches the `@snowluma/sdk` ESM packaging bug automatically. Seeing `修补了 N 个文件` means it worked.

> The project can live in any directory. Scripts locate the repo relative to themselves.
> If you move the directory later, re-run `node scripts/setup-dsh.mjs`.

### Step 3 · Create the config

```bash
cp config.example.json config.json      # Windows CMD: copy config.example.json config.json
```

Edit these four blocks:

```jsonc
{
  // ① QQ side: copy SnowLuma's ports and token
  "snowluma": { "wsUrl": "ws://127.0.0.1:3001", "httpUrl": "http://127.0.0.1:3000", "accessToken": "" },

  // ② You: your QQ number, so you can use admin commands
  "ownerQQ": 123456789,

  // ③ Who may use it: group IDs; keep private chat to yourself at first
  "allow": { "groups": [123456789], "private": [123456789], "privateMode": "friends" },

  // ④ Console password: leave empty to auto-generate (printed in the startup log)
  "consoleToken": ""
}
```

Common mistakes:

- ⚠️ `wsUrl` is the WebSocket port and `httpUrl` the HTTP API port. Using the same one returns HTTP 426.
- ⚠️ `ownerQQ` is **your** QQ number, not the bot's.
- ⚠️ If the group is not in `allow.groups`, the bot will only watch and never speak.

Everything else has safe defaults. Full field reference: [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

### Step 4 · Install the DSH side

```bash
node scripts/setup-dsh.mjs          # default profile: web
# other profile: node scripts/setup-dsh.mjs <profile>
```

This installs the `qq-chat` / `qq-chat-v2` presets, mounts three MCP servers and registers the `qq-mode-console` plugin. **Restart DSH afterwards.** Verification: [docs/DSH_SETUP.md](docs/DSH_SETUP.md).

### Step 5 · Start and verify

```bash
npm start
```

You should see:

```
[bridge] SnowLuma 已连接：ws://127.0.0.1:3001
[bridge] 桥接已启动。按 Ctrl+C 退出。
```

Open `http://127.0.0.1:3100` and log in with the console token from the startup log, then @ the bot in your group.

To stop:

```powershell
scripts/stop-all.ps1                    # bridge only, keeps QQ logged in
scripts/stop-all.ps1 -IncludeDsh        # also stop DSH / MCP
```

### Step 6 · Enable optional capabilities

| Capability | Extra dependency | How to enable |
| --- | --- | --- |
| Images / image library | none (SauceNAO key and pixiv cookie optional) | `socialV2.images.enabled: true` |
| Text-to-speech | Python 3.10+, GPT-SoVITS + voice weights | `node scripts/setup-tts.mjs --check` then `node scripts/setup-tts.mjs`; set `socialV2.tts.enabled: true` |
| Speech-to-text / Bilibili subtitles | Python 3.10+, faster-whisper model | configure `socialV2.bili.asr`; set `FASTER_WHISPER_MODEL` |
| Super-resolution | Upscayl ([download](https://upscayl.pro/cn/download.html)) | `socialV2.upscale.enabled: true`, set `binDir` |
| Feature menu / token report / GitHub shots | Chrome or Edge | enabled by default; set `CHROME_PATH` if needed |
| Web search / weather | none (Open-Meteo needs no key) | enabled by default |
| Bilibili self-browsing | ffmpeg; optional Bilibili cookie | `socialV2.bili.enabled: true` |
| X (Twitter) lookup | proxy + credentials | see [docs/CONFIGURATION.md](docs/CONFIGURATION.md) |

### Step 7 · Upgrade or move to another machine

```bash
git pull
npm install
node scripts/setup-dsh.mjs
# restart DSH, then restart the bridge
```

When moving, also carry these local files (all git-ignored): `config.json`, `state/`, `roles/*.md`, `assets/deepseek娘.png`. Do **not** copy `node_modules/`.

### Stuck?

| Symptom | Likely cause |
| --- | --- |
| HTTP 426 on startup | `wsUrl` and `httpUrl` point to the same port |
| Bot ignores @ in a group | group not in `allow.groups`, or DSH is down (`curl http://127.0.0.1:3080`) |
| HTTP 401 / unauthorized when sending | `snowluma.accessToken` does not match SnowLuma's token |
| Console returns 401 | use the `consoleToken` printed in the startup log |
| ffmpeg missing errors | install ffmpeg and add its `bin` directory to `PATH` |
| screenshot tools cannot find a browser | install Chrome/Edge or set `CHROME_PATH` |
| moved the project directory | re-run `node scripts/setup-dsh.mjs` and restart DSH |

More: [docs/DSH_SETUP.md](docs/DSH_SETUP.md) · [docs/CONFIGURATION.md](docs/CONFIGURATION.md) · [docs/DEPENDENCIES.md](docs/DEPENDENCIES.md)

---

## Documentation

| Document | Contents |
| --- | --- |
| [docs/FEATURES.md](docs/FEATURES.md) | Feature deep-dive: implementation notes and edge cases |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | Config reference, run modes, operations, testing, layout |
| [docs/DEPENDENCIES.md](docs/DEPENDENCIES.md) | Dependency list: required/optional components, ports, disk, env vars |
| [docs/MODEL_SETUP.md](docs/MODEL_SETUP.md) | Model providers: local gateway vs. DeepSeek official API |
| [docs/DSH_SETUP.md](docs/DSH_SETUP.md) | DSH-side installation and troubleshooting |
| [docs/DESIGN.md](docs/DESIGN.md) | Design principles, architecture, MCP server split |
| [docs/CHANGELOG.md](docs/CHANGELOG.md) | Changelog (entry by entry) |
| [docs/DEVLOG.md](docs/DEVLOG.md) | Development log (chronological narrative) |
| [docs/COMPLEXITY.md](docs/COMPLEXITY.md) | Complexity assessment (size, coupling, risks, metrics) |
| [AGENTS.md](AGENTS.md) | Development conventions (read before changing code) |
| [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) | Third-party licenses, SnowLuma boundaries, data egress |

## Origin and license

This project is a modified derivative of **[Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge)** (MIT), heavily refactored since the fork; the upstream copyright and permission notice is preserved in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) §0.

The original copyright notice is in [LICENSE](LICENSE) (MIT — **kept verbatim, do not remove**).
Third-party attribution, their respective licenses, SnowLuma usage boundaries and the data-egress list are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

> **Compliance**: SnowLuma is an independent third-party project and is not affiliated with Tencent/QQ.
> This project is for learning and technical research only; follow its EULA and the QQ User Agreement.
