import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { NewMessage } from "telegram/events/index.js";
import { Client, GatewayIntentBits, EmbedBuilder, AttachmentBuilder } from "discord.js";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
import * as dotenv from "dotenv";
import express from "express";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { randomUUID } from "crypto";

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = existsSync("/app/data") ? "/app/data" : "./data";
const CONFIGS_PATH = `${DATA_DIR}/configs.json`;

// ── Ensure data dir exists ────────────────────────────────
mkdirSync(DATA_DIR, { recursive: true });
if (!existsSync(CONFIGS_PATH)) writeFileSync(CONFIGS_PATH, "[]");

function loadConfigs() {
  try {
    return JSON.parse(readFileSync(CONFIGS_PATH, "utf-8"));
  } catch {
    return [];
  }
}

function saveConfigs(configs) {
  writeFileSync(CONFIGS_PATH, JSON.stringify(configs, null, 2));
}

function markMessageForwarded(configId, messageId) {
  const configs = loadConfigs();
  const config = configs.find((item) => item.id === configId);
  if (!config || Number(config.lastForwardedMessageId || 0) >= Number(messageId)) return;

  config.lastForwardedMessageId = Number(messageId);
  saveConfigs(configs);
}

// ── Telegram ──────────────────────────────────────────────
const tgClient = new TelegramClient(
  new StringSession(process.env.TG_SESSION || ""),
  Number(process.env.TG_API_ID),
  process.env.TG_API_HASH,
  { connectionRetries: 5 }
);

// ── Discord clients map: token → Client ───────────────────
const discordClients = new Map();
const forwardingMessages = new Set();

async function getDiscordClient(token) {
  if (discordClients.has(token)) return discordClients.get(token);
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  await client.login(token);
  discordClients.set(token, client);
  return client;
}

// ── Media helpers ─────────────────────────────────────────
function getMediaInfo(media) {
  if (!media) return null;
  const type = media.className;
  if (type === "MessageMediaPhoto") return { ext: "jpg", emoji: "🖼️", label: "Photo" };
  if (type === "MessageMediaDocument") {
    const mime = media.document?.mimeType || "";
    if (mime.startsWith("video/")) return { ext: "mp4", emoji: "🎬", label: "Video" };
    if (mime.startsWith("audio/")) return { ext: "mp3", emoji: "🎵", label: "Audio" };
    if (mime.includes("pdf"))      return { ext: "pdf", emoji: "📄", label: "PDF" };
    return { ext: "bin", emoji: "📎", label: "File" };
  }
  return null;
}

// ── Send to Discord ───────────────────────────────────────
async function forwardToDiscord(matching, msg, channelName) {
  const text = msg.text || msg.caption || "";
  const mediaInfo = getMediaInfo(msg.media);
  const publicChannel = channelName.startsWith("@") ? channelName.slice(1) : null;
  const postLink = publicChannel && msg.id
    ? `https://t.me/${publicChannel}/${msg.id}`
    : null;

  const embed = new EmbedBuilder()
    .setColor(0x2aabee)
    .setTitle("📢 New Announcement")
    .setTimestamp(new Date(msg.date * 1000))
    .setFooter({ text: `From: ${channelName}` });

  if (text) embed.setDescription(text);

  let attachment = null;
  let mediaTooLarge = false;

  if (mediaInfo && msg.media) {
    try {
      const buffer = await tgClient.downloadMedia(msg.media, {});
      if (buffer && buffer.length < 8 * 1024 * 1024) {
        attachment = new AttachmentBuilder(buffer, { name: `media.${mediaInfo.ext}` });
        console.log(`📎 Downloaded ${mediaInfo.label} (${(buffer.length / 1024).toFixed(1)} KB)`);
      } else if (buffer) {
        mediaTooLarge = true;
        console.log(`⚠️ Media too large (${(buffer.length / 1024 / 1024).toFixed(1)} MB), skipping`);
      }
    } catch (err) {
      console.error("Failed to download media:", err.message);
    }
  }

  if (mediaTooLarge) {
    const linkText = postLink ? `\n[Open the original Telegram post](${postLink})` : "";
    embed.setDescription(
      (text || "") +
      `\n\n${mediaInfo.emoji} *${mediaInfo.label} too large to forward (over 8MB).*` +
      linkText
    );
  } else if (mediaInfo && !attachment) {
    embed.setDescription((text || "") + `\n\n${mediaInfo.emoji} *${mediaInfo.label}*`);
  }

  for (const config of matching) {
    const forwardingKey = `${config.id}:${msg.id}`;
    const savedConfig = loadConfigs().find((item) => item.id === config.id);

    // A live update and the polling fallback can discover the same Telegram
    // post at nearly the same time. Only one of them may send it to Discord.
    if (
      forwardingMessages.has(forwardingKey) ||
      Number(savedConfig?.lastForwardedMessageId || 0) >= Number(msg.id)
    ) {
      console.log(`⏭️ Skipped duplicate message ${msg.id} for config: ${config.id}`);
      continue;
    }

    forwardingMessages.add(forwardingKey);
    try {
      const discord = await getDiscordClient(config.discordToken);
      const channel = await discord.channels.fetch(config.discordChannelId);

      if (attachment && mediaInfo.ext === "jpg") {
        embed.setImage("attachment://media.jpg");
        await channel.send({ embeds: [embed], files: [attachment] });
      } else if (attachment) {
        await channel.send({ embeds: [embed], files: [attachment] });
      } else {
        await channel.send({ embeds: [embed] });
      }

      markMessageForwarded(config.id, msg.id);
      console.log(`📨 Forwarded to config: ${config.id}`);
    } catch (err) {
      console.error(`Failed to forward for config ${config.id}:`, err.message);
    } finally {
      forwardingMessages.delete(forwardingKey);
    }
  }
}

// Polling is a fallback for channel updates that Telegram does not push to the
// running client. It also lets us check every configured source consistently.
async function pollChannels() {
  const configs = loadConfigs().filter((config) => config.active);

  for (const config of configs) {
    try {
      const messages = await tgClient.getMessages(config.tgChannel, { limit: 20 });
      const latest = messages.find((message) => message?.id);
      if (!latest) continue;

      // On first poll, establish a baseline so existing channel history is not
      // forwarded as if it were new.
      if (!config.lastForwardedMessageId) {
        markMessageForwarded(config.id, latest.id);
        console.log(`📍 Polling baseline for ${config.tgChannel}: message ${latest.id}`);
        continue;
      }

      const newMessages = messages
        .filter((message) => message?.id && Number(message.id) > Number(config.lastForwardedMessageId))
        .sort((a, b) => Number(a.id) - Number(b.id));

      for (const message of newMessages) {
        await forwardToDiscord([config], message, config.tgChannel);
      }
    } catch (err) {
      console.error(`Polling failed for ${config.tgChannel}:`, err.message);
    }
  }
}

// ── Dynamic listener — no restart needed ─────────────────
let currentHandler = null;

function refreshListener() {
  if (currentHandler) {
    tgClient.removeEventHandler(currentHandler);
    currentHandler = null;
  }

  const handler = async (event) => {
    try {
      const msg = event.message;
      const chat = await msg.getChat();

      // Match by username OR numeric ID
      const username = chat.username ? `@${chat.username}` : null;
      const chatId = String(chat.id);

      const configs = loadConfigs();
      const matching = configs.filter(c => {
        if (!c.active) return false;
        if (username && c.tgChannel.toLowerCase() === username.toLowerCase()) return true;
        if (c.tgChannel === chatId || c.tgChannel === `-100${chatId}`) return true;
        return false;
      });

      console.log(
        `📨 Incoming Telegram message from ${username || chatId} ` +
        `(ID: ${chatId}); ${matching.length} active forwarding match(es)`
      );

      if (matching.length === 0) return;

      await forwardToDiscord(matching, msg, username || chatId);
    } catch (err) {
      console.error("Error handling message:", err.message);
    }
  };

  // Listen to ALL messages — filter manually above
  // This is more reliable than relying on GramJS channel filter
  tgClient.addEventHandler(handler, new NewMessage({}));

  currentHandler = handler;

  const configs = loadConfigs();
  const channels = [...new Set(configs.filter(c => c.active).map(c => c.tgChannel))];
  console.log(`👂 Listening to ${channels.length} channel(s):`, channels.join(", ") || "none yet");
}

// ── Main ──────────────────────────────────────────────────
async function main() {
  const configs = loadConfigs();

  // Connect Discord clients upfront
  for (const config of configs.filter(c => c.active)) {
    try {
      await getDiscordClient(config.discordToken);
      console.log(`✅ Discord connected for: ${config.name || config.id}`);
    } catch (err) {
      console.error(`❌ Discord failed for ${config.id}:`, err.message);
    }
  }

  // A saved StringSession should already be authorized. Using `start()` here
  // can wait forever for interactive login input after a container restart.
  if (!process.env.TG_SESSION) {
    throw new Error("TG_SESSION is missing");
  }

  await tgClient.connect();
  if (!(await tgClient.checkAuthorization())) {
    throw new Error("TG_SESSION is no longer authorized; create a new session with node setup.js");
  }
  console.log("✅ Telegram connected");

  refreshListener();

  await pollChannels();
  setInterval(pollChannels, 30 * 1000);

  console.log("🌐 Dashboard running at http://localhost:3001");

  // Self-ping every 5 min to prevent Fly.io sleeping
  const APP_URL = process.env.APP_URL;
  if (APP_URL) {
    setInterval(async () => {
      try {
        await fetch(`${APP_URL}/health`);
        console.log("🏓 Self-ping OK");
      } catch (err) {
        console.error("Self-ping failed:", err.message);
      }
    }, 5 * 60 * 1000);
  }
}

main().catch((err) => {
  console.error("Telegram startup failed:", err.message || err);
  process.exit(1);
});

// ── Dashboard API ─────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, "public")));

// Health check
app.get("/health", (req, res) => res.json({ ok: true, uptime: process.uptime() }));

// Get all configs (mask tokens)
app.get("/api/configs", (req, res) => {
  const configs = loadConfigs().map(c => ({
    ...c,
    discordToken: c.discordToken.slice(0, 10) + "...",
  }));
  res.json(configs);
});

// Add new config
app.post("/api/configs", async (req, res) => {
  const { name, tgChannel, discordToken, discordChannelId } = req.body;

  if (!tgChannel || !discordToken || !discordChannelId) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  // Validate Discord token
  try {
    await getDiscordClient(discordToken);
  } catch {
    return res.status(400).json({ error: "Invalid Discord token — could not connect" });
  }

  const normalizedChannel = tgChannel.startsWith("@") ? tgChannel : `@${tgChannel}`;

  // Auto-join the Telegram channel
  try {
    await tgClient.invoke(new Api.channels.JoinChannel({ channel: normalizedChannel }));
    console.log(`✅ Joined TG channel: ${normalizedChannel}`);
  } catch (err) {
    console.log(`ℹ️ Could not join (may already be member): ${err.message}`);
  }

  const configs = loadConfigs();
  const newConfig = {
    id: randomUUID(),
    name: name || normalizedChannel,
    tgChannel: normalizedChannel,
    discordToken,
    discordChannelId,
    active: true,
    lastForwardedMessageId: null,
    createdAt: new Date().toISOString(),
  };

  configs.push(newConfig);
  saveConfigs(configs);

  refreshListener();

  res.json({ ok: true, id: newConfig.id });
});

// Toggle active/inactive
app.patch("/api/configs/:id", (req, res) => {
  const configs = loadConfigs();
  const idx = configs.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Not found" });
  configs[idx] = { ...configs[idx], ...req.body };
  saveConfigs(configs);
  refreshListener();
  res.json({ ok: true });
});

// Delete config
app.delete("/api/configs/:id", (req, res) => {
  let configs = loadConfigs();
  configs = configs.filter(c => c.id !== req.params.id);
  saveConfigs(configs);
  refreshListener();
  res.json({ ok: true });
});

app.listen(3001, "0.0.0.0");
