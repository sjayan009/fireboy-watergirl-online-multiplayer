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

- `FRAME_INTERVAL_MS` (50) - minimum gap between frames sent to clients, i.e. the frame-rate ceiling (~20 fps). Flow control (below) drops, never queues, frames a client can't keep up with, so this is just a ceiling: fast links approach it, slow links self-limit. Raise to cut bandwidth, lower for smoother motion.
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

The frontend stays on Vercel. The game host needs an always-on backend. Pick one of the three options below, then point Vercel at it. **Option C is recommended** - a dedicated VPS close to your players gives the smoothest, lowest-latency experience for the least money.

### Option C - Hetzner VPS in Ashburn, VA (recommended, ~$10-16/mo)

The host is CPU-bound (Chromium + Ruffle + JPEG encoding) and latency-bound (every keypress round-trips through it), so the two things that matter are **a dedicated CPU** and **a location close to your players**. For US East Coast players (e.g. Connecticut + Georgia), **Ashburn, Virginia** is the equidistant sweet spot (~15-25 ms to both). Hetzner has a datacenter there with strong AMD CPUs at hobby prices.

This runs the existing `server/Dockerfile` plus a [Caddy](https://caddyserver.com) reverse proxy (automatic Let's Encrypt TLS) via `docker-compose.yml`, using a free [DuckDNS](https://www.duckdns.org) hostname for `wss://`.

1. **Provision** a Hetzner Cloud server in **Ashburn, VA** - `CPX31` (4 vCPU / 8 GB, smoothest) or `CPX21` (3 vCPU / 4 GB, cheapest), Ubuntu 24.04. Note its static IPv4. In the Hetzner firewall, allow only ports **22, 80, 443**.
2. **DuckDNS** (free): create a subdomain at https://www.duckdns.org and set its IP to the server's IPv4. The VPS IP is static, so no updater is needed.
3. **Run the VPS setup helper** on the server. Replace the hostname and repo URL with yours:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/YOUR_GITHUB_USER/YOUR_REPO/main/scripts/vps-setup.sh | SITE_ADDRESS=your-name.duckdns.org REPO_URL=https://github.com/YOUR_GITHUB_USER/YOUR_REPO.git bash
   ```

   The helper installs Docker if needed, clones or updates the repo, writes `.env`, starts the Compose stack, and checks `https://your-name.duckdns.org/health`.

   If you already cloned the repo manually, run this from the repo instead:

   ```bash
   SITE_ADDRESS=your-name.duckdns.org bash scripts/vps-setup.sh
   ```

4. Or do the same steps manually: install Docker on the VPS (`curl -fsSL https://get.docker.com | sh`), then `git clone` this repo.
5. Create a `.env` file next to `docker-compose.yml`:

   ```bash
   SITE_ADDRESS=your-name.duckdns.org
   ```

6. **Launch:**

   ```bash
   docker compose up -d --build
   ```

   Caddy fetches the TLS certificate on first start (give it ~30 s). Verify: `curl -I https://your-name.duckdns.org/health` returns `200`.
7. Point Vercel at it and redeploy:

   ```bash
   VITE_GAME_SERVER_URL=wss://your-name.duckdns.org
   ```

Frame-rate/quality are pre-tuned for a 4-vCPU box in `docker-compose.yml` (`FRAME_INTERVAL_MS`, `FRAME_QUALITY`); see **Host tuning** above to adjust. To update later: `git pull && docker compose up -d --build`.

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
