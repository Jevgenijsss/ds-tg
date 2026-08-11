import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { NewMessage } from "telegram/events/index.js";
import { Client, GatewayIntentBits, EmbedBuilder } from "discord.js";
import { readFileSync, existsSync } from "fs";
import * as dotenv from "dotenv";

dotenv.config();

const CONFIGS_PATH = "./data/configs.json";

function loadConfigs() {
  if (!existsSync(CONFIGS_PATH)) return [];
  try {
    return JSON.parse(readFileSync(CONFIGS_PATH, "utf-8"));
  } catch {
    return [];
  }
}

// ── Telegram (your account, one connection) ───────────────
const tgClient = new TelegramClient(
  new StringSession(process.env.TG_SESSION || ""),
  Number(process.env.TG_API_ID),
  process.env.TG_API_HASH,
  { connectionRetries: 5 }
);

// ── Discord clients map: token → Client ───────────────────
const discordClients = new Map();

async function getDiscordClient(token) {
  if (discordClients.has(token)) return discordClients.get(token);

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  await client.login(token);
  discordClients.set(token, client);
  return client;
}

// ── Forward a Telegram message to all matching configs ────
async function forwardMessage(tgChannel, messageText, messageDate) {
  const configs = loadConfigs();
  const matching = configs.filter(
    (c) => c.tgChannel.toLowerCase() === tgChannel.toLowerCase() && c.active
  );

  for (const config of matching) {
    try {
      const discord = await getDiscordClient(config.discordToken);
      const channel = await discord.channels.fetch(config.discordChannelId);

      const embed = new EmbedBuilder()
        .setColor(0x2aabee)
        .setTitle("📢 New Announcement")
        .setDescription(messageText || "*[No text — may be media]*")
        .setTimestamp(new Date(messageDate * 1000))
        .setFooter({ text: `From: ${tgChannel}` });

      await channel.send({ embeds: [embed] });
      console.log(`📨 Forwarded to Discord for config: ${config.id}`);
    } catch (err) {
      console.error(`Failed to forward for config ${config.id}:`, err.message);
    }
  }
}

// ── Main ──────────────────────────────────────────────────
async function main() {
  const configs = loadConfigs();
  const channels = [...new Set(configs.filter(c => c.active).map(c => c.tgChannel))];

  // Connect all Discord clients upfront
  for (const config of configs.filter(c => c.active)) {
    try {
      await getDiscordClient(config.discordToken);
      console.log(`✅ Discord connected for: ${config.name || config.id}`);
    } catch (err) {
      console.error(`❌ Discord failed for ${config.id}:`, err.message);
    }
  }

  // Connect Telegram
  await tgClient.start({
    botAuthToken: undefined,
    onError: (err) => console.error("TG error:", err),
  });
  console.log("✅ Telegram connected");

  // Listen for new messages
  tgClient.addEventHandler(async (event) => {
    const msg = event.message;
    const chat = await msg.getChat();
    const username = chat.username ? `@${chat.username}` : String(chat.id);

    await forwardMessage(username, msg.text, msg.date);
  }, new NewMessage({ chats: channels.length > 0 ? channels : undefined }));

  console.log(`👂 Listening to ${channels.length} channel(s):`, channels.join(", ") || "none yet");
  console.log("🌐 Dashboard running at http://localhost:3001");
}

main().catch(console.error);

// ── Dashboard server (for adding/removing configs) ────────
import express from "express";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { writeFileSync } from "fs";
import { randomUUID } from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, "public")));

function saveConfigs(configs) {
  writeFileSync(CONFIGS_PATH, JSON.stringify(configs, null, 2));
}

// Get all configs (hide sensitive tokens partially)
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

  // Validate Discord token by trying to connect
  try {
    await getDiscordClient(discordToken);
  } catch {
    return res.status(400).json({ error: "Invalid Discord token — could not connect" });
  }

  const configs = loadConfigs();
  const newConfig = {
    id: randomUUID(),
    name: name || tgChannel,
    tgChannel: tgChannel.startsWith("@") ? tgChannel : `@${tgChannel}`,
    discordToken,
    discordChannelId,
    active: true,
    createdAt: new Date().toISOString(),
  };

  configs.push(newConfig);
  saveConfigs(configs);

  // Restart listener to include new channel
  process.exit(0); // PM2/Render will restart automatically

  res.json({ ok: true, id: newConfig.id });
});

// Toggle active/inactive
app.patch("/api/configs/:id", (req, res) => {
  const configs = loadConfigs();
  const idx = configs.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Not found" });

  configs[idx] = { ...configs[idx], ...req.body };
  saveConfigs(configs);
  res.json({ ok: true });
});

// Delete config
app.delete("/api/configs/:id", (req, res) => {
  let configs = loadConfigs();
  configs = configs.filter(c => c.id !== req.params.id);
  saveConfigs(configs);
  res.json({ ok: true });
});

app.listen(3001);
