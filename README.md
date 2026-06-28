# Fireboy & Watergirl Online

A true remote co-op wrapper for the original Flash SWF.

The public Vercel site is only the viewer/controller. The actual game runs once in a persistent cloud host service, where a Playwright/Chromium page loads the SWF through Ruffle. Both players connect to that one hosted game session, watch the same frame stream, and send controls for their chosen character.

## Architecture

- Frontend: Vite + TypeScript, deployed on Vercel.
- Game host: Node + Playwright + WebSocket. It needs an **always-on** home; the default below is your own PC exposed through a Cloudflare Tunnel, with Fly.io as a paid alternative.
- One room creates one server-side Chromium page; room state and Chromium pages live in memory, so the host is a single long-lived process.
- Frames are streamed with CDP screencast (`Page.startScreencast`), which pushes JPEG frames as the page renders instead of polling screenshots. A watchdog restarts the screencast on a transient stall and only recreates the page after repeated strikes.
- Fireboy controls: ArrowLeft / ArrowUp / ArrowRight.
- Watergirl controls: A / W / D.
- Pointer events on the streamed game view are forwarded to the hosted game so players can click the in-game menu.

### Host tuning (env vars)

The host reads these at startup; defaults are sensible for a typical desktop:

- `FRAME_INTERVAL_MS` (150) - minimum gap between frames sent to clients; raise to cut bandwidth, lower for smoother motion.
- `MAX_FRAMES_IN_FLIGHT` (2) - primary backpressure. The host sends a client at most this many frames before that client acks (decodes) them, so the producer self-clocks to each client's real end-to-end speed and a slow downlink can't build an unbounded backlog. Lower (1) for the tightest latency on slow links; raise for smoother motion on fast ones. This is the knob that keeps the latency readout from climbing.
- `FRAME_ACK_TIMEOUT_MS` (1500) - if a client's outstanding frame goes unacked this long, the host assumes the ack was lost and resumes sending so the stream can't freeze.
- `MAX_FRAME_BUFFER_BYTES` (512000) - secondary safety valve only. Skips a client whose local socket buffer is backed up. Note this is blind behind a tunnel that drains the host socket over loopback (e.g. cloudflared), which is why `MAX_FRAMES_IN_FLIGHT` is the real control.
- `FRAME_QUALITY` (60) - JPEG quality, 1-100.
- `SCREENCAST_NTH` (1) - capture every Nth rendered frame; raise to reduce host CPU on weaker machines.
- `FRAME_TIMEOUT_MS` (8000) - how long without a frame counts as a stall.
- `FRAME_MAX_STRIKES` (4) - consecutive stalls before the page is recreated.
- `WATCHDOG_INTERVAL_MS` (2000) - how often the stall check runs.

## Local Setup

Install frontend dependencies:

```bash
npm install
```

Install host dependencies:

```bash
npm install --prefix server
```

Copy `.env.example` to `.env` for production-style config, or use this for local development:

```bash
VITE_GAME_SERVER_URL=ws://127.0.0.1:8080
```

Run the host service:

```bash
npm run server:dev
```

Run the frontend in another terminal:

```bash
npm run dev
```

Open the same room URL from two browsers/devices.

## Verification

Frontend build:

```bash
npm run build
```

Host TypeScript build:

```bash
npm run server:build
```

End-to-end host smoke test:

```bash
npm run smoke:host
```

## Deployment

The frontend stays on Vercel. The game host needs an always-on backend. Pick one of the two options below, then point Vercel at it.

### Option A - Your own PC + Cloudflare Tunnel (default, free)

Runs the host on this machine and exposes it at a stable `https://`/`wss://` hostname through Cloudflare. Your PC must stay on while people play.

1. Install the tunnel client: `winget install --id Cloudflare.cloudflared`
2. One-time tunnel setup (needs a free Cloudflare account with a domain on Cloudflare DNS):

   ```bash
   cloudflared tunnel login
   cloudflared tunnel create fireboy-watergirl
   cloudflared tunnel route dns fireboy-watergirl game.YOURDOMAIN.com
   ```

3. Copy `cloudflared/config.example.yml` to `cloudflared/config.yml` and fill in the tunnel UUID, credentials path, and hostname.
4. Start the host, then the tunnel (two terminals):

   ```bash
   npm run server:dev
   ```

   ```powershell
   pwsh scripts/tunnel.ps1
   ```

5. Set the Vercel env var to your tunnel hostname and redeploy:

   ```bash
   VITE_GAME_SERVER_URL=wss://game.YOURDOMAIN.com
   ```

For 24/7 hosting, install cloudflared as a Windows service (`cloudflared service install`) so the tunnel survives reboots, and keep the host process running (e.g. via a startup task or `pm2`).

**No domain yet?** Run `pwsh scripts/tunnel.ps1 -Quick` for an ephemeral `*.trycloudflare.com` URL - no account or domain needed, but the URL changes every run, so update `VITE_GAME_SERVER_URL` and redeploy each time. Good for testing, not for a stable link.

### Option B - Fly.io (paid, always-on)

The repo ships a `fly.toml` and `server/Dockerfile`. Fly organizations require a payment method (the free trial stops machines after 5 minutes), and `shared-cpu-1x` is marginal for Chromium + Ruffle - bump to `shared-cpu-2x`/`4x` (or `performance-1x`) in `fly.toml` before relying on it.

```bash
fly launch --copy-config
fly deploy
```

```bash
VITE_GAME_SERVER_URL=wss://fireboy-watergirl-game-host.fly.dev
```

Then redeploy Vercel.
