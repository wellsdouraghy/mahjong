# Deploying the mahjong game online (free, with Render)

The app is a single Node server (static files + WebSocket, no database), so hosting is
straightforward. These steps put it on **Render's free tier** — a permanent
`https://<your-app>.onrender.com` link you can share. The free tier sleeps after ~15 min
idle and takes ~30–50s to wake on the first visit, then it's fast. Rooms live in memory,
so they reset if the server sleeps/redeploys — fine for casual play.

## One-time setup

### 1. Put the code on GitHub
This folder is already a git repo with an initial commit. Create an empty GitHub repo
(github.com → New repository → name it e.g. `mahjong`, no README/gitignore), then run:

```bash
cd ~/Desktop/Mahjong
git remote add origin https://github.com/<your-username>/mahjong.git
git branch -M main
git push -u origin main
```

### 2. Create the Render service
1. Sign up / log in at https://render.com (you can log in with GitHub).
2. Click **New → Web Service** and connect your GitHub, then pick the `mahjong` repo.
3. Render reads `render.yaml` automatically. If it asks, confirm:
   - **Runtime**: Node
   - **Build command**: `npm install`
   - **Start command**: `npm start`
   - **Instance type**: Free
4. Click **Create Web Service**. First build takes a couple of minutes.
5. When it's live, Render shows your URL: `https://<your-app>.onrender.com`. Open it,
   pick a name, **Create a room**, and share the room **code** with friends — they open
   the same URL, choose **Join by code**, and enter it.

That's it. WebSockets work over Render's HTTPS automatically (the client uses `wss://`
when served over HTTPS).

## Updating later
Push to `main` and Render auto-redeploys:
```bash
git add -A && git commit -m "update" && git push
```

## Alternative: instant tunnel (no signup, your Mac stays on)
For a one-off session without deploying, run the server locally and expose it:
```bash
npm start                 # serves on http://localhost:3000
# in another terminal, one of:
npx cloudflared tunnel --url http://localhost:3000   # Cloudflare (free, no account)
# or
ngrok http 3000                                      # ngrok (free tier)
```
Share the printed `https://…` URL. Your Mac must stay awake running `npm start`.
