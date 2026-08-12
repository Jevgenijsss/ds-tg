# Telegram → Discord Forwarder

Forwards new posts from Telegram channels to Discord channels. A single Telegram
user session can serve multiple Discord bot connections managed through the web
dashboard.

## What it forwards

- Text posts and captions
- Photos, videos, audio, PDFs, and other documents up to 8 MB
- A link to the original Telegram post when media is too large for Discord

Posts are forwarded once. The app listens for Telegram updates and also polls
configured channels every 30 seconds as a fallback.

## Requirements

- A Telegram API ID and API hash from [my.telegram.org](https://my.telegram.org)
- A Telegram **user-account** session string
- A Discord bot for every Discord destination
- The Discord bot invited to its server with **Send Messages**, **Embed Links**,
  and **Attach Files** permissions

The Telegram account represented by `TG_SESSION` must be a member of every
source channel. You do not need to own those channels: public channels can be
added by username, such as `@ru2ch`.

## Local setup

Install dependencies and create a Telegram session:

```bash
npm install
npm run setup
```

Copy the generated values into a local `.env` file:

```env
TG_API_ID=123456
TG_API_HASH=your_api_hash
TG_SESSION=your_telegram_session_string
```

Start the dashboard:

```bash
npm start
```

Open `http://localhost:3001` and add a connection. For a public source channel,
enter its username as `@channelname` (not `https://t.me/channelname`).

## Deploy to Fly.io

Install and sign in to the Fly CLI, then create the app if needed:

```bash
fly launch
```

Set the Telegram credentials as Fly secrets:

```bash
fly secrets set TG_API_ID=123456 TG_API_HASH=your_api_hash TG_SESSION=your_telegram_session_string
```

Deploy:

```bash
fly deploy
```

Open the dashboard with:

```bash
fly open
```

The `fly.toml` configuration includes a persistent volume at `/app/data` for
dashboard connections. Do not store secrets in Git: `.env` and
`data/configs.json` are intentionally ignored.

## Logging and troubleshooting

On a healthy startup, logs include:

```text
✅ Telegram connected
👂 Listening to ... channel(s)
```

When a post is received, the app logs the source channel and number of matching
forwarding connections. For Fly logs:

```bash
fly logs
```

For an external channel, confirm the exact Telegram account that created
`TG_SESSION` is still subscribed to it. Only future posts are forwarded; the
first polling check establishes a baseline and does not replay channel history.
