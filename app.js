import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { NewMessage } from "telegram/events/index.js";
import { Client, GatewayIntentBits, EmbedBuilder } from "discord.js";
import * as dotenv from "dotenv";
import input from "input";

dotenv.config();

// ── Telegram ──────────────────────────────────────────────
const tgClient = new TelegramClient(
  new StringSession(process.env.TG_SESSION || ""),
  Number(process.env.TG_API_ID),
  process.env.TG_API_HASH,
  { connectionRetries: 5 }
);

// ── Discord ───────────────────────────────────────────────
const discord = new Client({ intents: [GatewayIntentBits.Guilds] });

async function postToDiscord(message) {
  const channel = await discord.channels.fetch(process.env.DISCORD_CHANNEL_ID);

  const embed = new EmbedBuilder()
    .setColor(0x0088cc)                          // Telegram blue
    .setTitle("📢 New Telegram Announcement")
    .setDescription(message.text || "*[No text — may be media]*")
    .setTimestamp(new Date(message.date * 1000))
    .setFooter({ text: `From: ${process.env.TG_CHANNEL}` });

  await channel.send({ embeds: [embed] });
}

// ── Main ──────────────────────────────────────────────────
async function main() {
  // 1. Connect Discord
  await discord.login(process.env.DISCORD_TOKEN);
  console.log("✅ Discord connected");

  // 2. Connect Telegram
  await tgClient.start({
    phoneNumber: async () => await input.text("Phone: "),
    password:    async () => await input.text("2FA password: "),
    phoneCode:   async () => await input.text("Code: "),
    onError:     (err) => console.error(err),
  });
  console.log("✅ Telegram connected");

  // Save session on first run — paste it into .env as TG_SESSION
  if (!process.env.TG_SESSION) {
    console.log("🔑 Save this session string in .env:\n", tgClient.session.save());
  }

  // 3. Listen for new messages in the channel
  tgClient.addEventHandler(async (event) => {
    const msg = event.message;
    try {
      await postToDiscord(msg);
      console.log(`📨 Forwarded message ${msg.id}`);
    } catch (err) {
      console.error("Failed to forward:", err);
    }
  }, new NewMessage({ chats: [process.env.TG_CHANNEL] }));

  console.log(`👂 Listening to ${process.env.TG_CHANNEL}...`);
}

main().catch(console.error);