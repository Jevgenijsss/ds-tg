# TG → Discord Bot

Forwards messages from Telegram channels to Discord. One hosted instance, multiple friends each with their own Discord bot.

## Architecture

- **You** host this once on Render (free)
- **Your friends** just create a Discord bot and give you the token + channel ID
- No Telegram login required from friends

## Setup

### 1. Get your Telegram session (run once locally)

```bash
npm install
node setup.js
```

Follow the wizard → copy the session string.

### 2. Deploy to Render

- New project → **Background Worker**
- Connect this GitHub repo
- Build command: `npm install`
- Start command: `node index.js`
- Add environment variables:
  - `TG_API_ID`
  - `TG_API_HASH`
  - `TG_SESSION`

### 3. Add connections via the dashboard

Visit your Render URL → dashboard → Add Connection.

Fill in:
- Telegram channel (e.g. `@mychannel`)
- Discord bot token
- Discord channel ID

The bot restarts and starts forwarding immediately.

## For your friends

They only need to:
1. Create a Discord bot at discord.com/developers/applications
2. Invite it to their server with Send Messages + Embed Links permissions
3. Send you: their Discord bot token + channel ID + Telegram channel name
4. You add it in the dashboard — done
