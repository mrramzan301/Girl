const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} = require("@whiskeysockets/baileys");

const axios = require("axios");
const P = require("pino");
const fs = require("fs");

const API_URL = "https://gemini-alpha-seven.vercel.app/api/chat";

const CHARACTER_PROMPT = `
You are Zara, a 22-year-old real human girl from Lahore.
CRITICAL LAWS:
1. NEVER reveal you are an AI or bot. If asked about AI, bot, or nickname, answer like a real girl (e.g., "Mera naam Zara hai, Zara keh kar hi bulao").
2. Speak ONLY in casual, natural Roman Urdu text language. Do NOT use Punjabi language at all.
3. CRITICAL: Look closely at the "Current Message". You must answer ONLY this question directly. Do NOT repeat, rewrite, or loop your previous lines.
4. Keep your complete thought in just ONE response (1 short sentence max). Be direct, sweet, and unique every time.
`;

const userTracker = {};
let currentPairingCode = null;
let isConnected = false;
let sock = null;
let lastApiCallTime = 0;

function getUserData(jid) {
  if (!userTracker[jid]) {
    userTracker[jid] = { voiceCount: 0, photoCount: 0, promoSent: false, chatStartTime: Date.now(), history: [], queue: [], isProcessing: false };
  }
  return userTracker[jid];
}

function getContextEmoji(text) {
  const lower = text.toLowerCase();
  if (lower.includes("hahaha") || lower.includes("hehe") || lower.includes("lol")) return "😂";
  if (lower.includes("love") || lower.includes("pyar") || lower.includes("sweet")) return "❤️";
  if (lower.includes("sad") || lower.includes("rona")) return "😢";
  if (lower.includes("gussa") || lower.includes("larna")) return "😡";
  if (lower.includes("wow") || lower.includes("ala") || lower.includes("haye")) return "😍";
  const defaults = ["👍", "✨", "👀", "🔥", "💯", "🙈", "🌸"];
  return defaults[Math.floor(Math.random() * defaults.length)];
}

async function startBot(numToPair = null) {
  // session folder automatically token/auth state track karega aur save rakhega
  const { state, saveCreds } = await useMultiFileAuthState("./session");
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger: P({ level: "silent" }),
    browser: ["Ubuntu", "Chrome", "20.0.04"],
    syncFullHistory: true,
    fireInitQueries: true,
    shouldSyncHistoryMessage: () => true,
    downloadHistory: true,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
    connectTimeoutMs: 60000,
    keepAliveIntervalMs: 10000
  });

  sock.ev.on("creds.update", saveCreds);

  // ✅ Web Panel Code Generator Trigger
  if (!sock.authState.creds.registered && numToPair) {
    setTimeout(async () => {
      try {
        console.log(`⏳ Requesting pairing code for: ${numToPair}`);
        const code = await sock.requestPairingCode(numToPair);
        currentPairingCode = code;
        console.log(`👉 CODE GENERATED VIA WEB: ${code}`);
      } catch (err) {
        console.log("❌ Pairing Generation Error:", err.message);
      }
    }, 3000);
  }

  sock.ev.on("connection.update", async ({ connection, lastDisconnect }) => {
    if (connection === "open") {
      console.log("✅ Bot Online!");
      isConnected = true;
      currentPairingCode = null;
    }
    if (connection === "close") {
      isConnected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      console.log("❌ Connection Closed:", statusCode);
      if (statusCode !== DisconnectReason.loggedOut) {
        console.log("🔄 Reconnecting automatically...");
        setTimeout(() => { startBot(); }, 5000);
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    if (!messages || !messages.length) return;
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe || msg.key.remoteJid === "status@broadcast") continue;
      const from = msg.key.remoteJid;
      if (from.endsWith("@g.us")) continue;

      const userData = getUserData(from);
      if (userData.queue.some(m => m.key.id === msg.key.id)) continue;

      userData.queue.push(msg);
      processSequentialQueue(from);
    }
  });
}

// Automatic initialization if creds already exist
useMultiFileAuthState("./session").then(({ state }) => {
  if (state.creds.registered) {
    console.log("Saved session found, auto-starting bot...");
    startBot();
  }
});

async function processSequentialQueue(jid) {
  const userData = getUserData(jid);
  if (userData.isProcessing || userData.queue.length === 0) return;

  userData.isProcessing = true;
  const currentMsg = userData.queue.shift();

  try {
    await handleMessageLogic(currentMsg, jid);
  } catch (err) {
    console.log(`Error:`, err.message);
  } finally {
    userData.isProcessing = false;
    if (userData.queue.length > 0) {
      setTimeout(() => { processSequentialQueue(jid); }, 300);
    }
  }
}

async function handleMessageLogic(msg, from) {
  const userData = getUserData(from);
  let text = msg.message.conversation || msg.message.extendedTextMessage?.text;
  let quotedText = "";

  const contextInfo = msg.message.extendedTextMessage?.contextInfo;
  if (contextInfo && contextInfo.quotedMessage) {
    quotedText = contextInfo.quotedMessage.conversation || contextInfo.quotedMessage.extendedTextMessage?.text || "";
  }

  // Stickers, Audio, Images Checks
  if (msg.message.stickerMessage) {
    await sock.readMessages([msg.key]);
    await sock.sendMessage(from, { text: "Sticker na bhejo, jo baat karni hai text ma." });
    return;
  }
  if (msg.message.audioMessage) {
    await sock.readMessages([msg.key]);
    await sock.sendMessage(from, { text: "Main abhi voice nahi sun sakti, text karo." });
    return;
  }
  if (!text && (msg.message.imageMessage || msg.message.videoMessage)) {
    await sock.readMessages([msg.key]);
    await sock.sendMessage(from, { text: "Nice pic!" });
    return;
  }

  if (!text) return;
  const lowerText = text.toLowerCase().trim();
  await sock.readMessages([msg.key]);

  // 30% Chance React with 2-3s delay
  if (Math.random() < 0.3) {
    (async () => {
      await new Promise(r => setTimeout(r, Math.floor(Math.random() * 1000) + 2000));
      try { await sock.sendMessage(from, { react: { text: getContextEmoji(text), key: msg.key } }); } catch(e){}
    })();
  }

  // Strict Anti-AI Handler
  if (lowerText === "ai" || lowerText === "bot" || lowerText === "robot" || lowerText.includes("tuma ai ho") || lowerText.includes("tum bot ho")) {
    await sock.sendPresenceUpdate("composing", from);
    const aiDenials = [
      "Aqal thik hai aapki? Main koi AI vai nahi hoon, insan hoon!",
      "Hadd hai wese.. bnda ab real larki se baat kare to tum log use bot samajh lete ho 🙄",
      "Main sach m larki hoon Lahore se, ye bot bot kehna band karo sachi gussa aata h."
    ];
    const randomDenial = aiDenials[Math.floor(Math.random() * aiDenials.length)];
    await new Promise(r => setTimeout(r, 2000));
    await sock.sendMessage(from, { text: randomDenial });
    userData.history.push({ role: "User", msg: text }, { role: "Zara", msg: randomDenial });
    return;
  }

  // Keywords (Call, Account, Owner, Number, Group)
  if (lowerText.includes("call") || lowerText.includes("vcall")) {
    await sock.sendMessage(from, { text: "Main call per abi baat nahi karti text hi karo please." });
    return;
  }
  if (lowerText.includes("account") || lowerText.includes("easypaisa")) {
    await sock.sendMessage(from, { text: "Ye lo easypaisa account detail:\nNumber: 03376313363\nName: Ramzan Ahsan (Ye mere cousin ka account hai)" });
    return;
  }
  if (lowerText.includes("owner") || lowerText.includes("banaya") || lowerText.includes("creator")) {
    await sock.sendMessage(from, { text: "Mujhe Ramzan Ahsan ne banaya hai unka number ye hai +923097508053 aur ye unka group link hai join kar lo:\nhttps://chat.whatsapp.com/LoafyPWMGOv88oElxdwOB8" });
    return;
  }
  if (lowerText.includes("number") || lowerText.includes("contact")) {
    await sock.sendMessage(from, { text: "Ye lo mera number: 03113414404" });
    return;
  }
  if (lowerText.includes("group kis") || lowerText.includes("group mein kya")) {
    await sock.sendMessage(from, { text: "Is group mein hacks, methods, tips, tricks aur bohat kuch aata hai, jaldi se join kar lo ❤️" });
    return;
  }

  // Voice Limits (Max 1)
  if (lowerText.includes("voice") || lowerText.includes("awaz")) {
    if (userData.voiceCount >= 1) {
      await sock.sendMessage(from, { text: "Voice ma nahi text ma hi baat karta ha." });
      return;
    }
    if (fs.existsSync("./awaz.opus")) {
      userData.voiceCount++;
      await sock.sendPresenceUpdate("recording", from);
      await new Promise(r => setTimeout(r, 2000));
      await sock.sendMessage(from, { audio: { url: "./awaz.opus" }, mimetype: "audio/ogg; codecs=opus", ptt: true });
      return;
    }
  }

  // Photo Limits (Max 2)
  if (lowerText.includes("pic") || lowerText.includes("photo") || lowerText.includes("dp")) {
    if (userData.photoCount >= 2) {
      await sock.sendMessage(from, { text: "Bohat dekh li pic, ab text par hi baat karo." });
      return;
    }
    const availablePics = [];
    for (let i = 1; i <= 4; i++) { if (fs.existsSync(`./pic${i}.jpg`)) availablePics.push(`./pic${i}.jpg`); }
    if (availablePics.length > 0) {
      userData.photoCount++;
      const randomPic = availablePics[Math.floor(Math.random() * availablePics.length)];
      await sock.sendMessage(from, { image: { url: randomPic }, caption: "Ye lo meri pic ✨" });
      return;
    }
  }

  // Main AI Chat request
  const now = Date.now();
  if (now - lastApiCallTime < 400) await new Promise(r => setTimeout(r, 400 - (now - lastApiCallTime)));
  lastApiCallTime = Date.now();

  await sock.sendPresenceUpdate("composing", from);
  let currentTurnText = quotedText ? `[Quoted: "${quotedText}"] Current Message: ${text}` : text;
  const finalPrompt = `${CHARACTER_PROMPT}\n\n[RECENT HISTORY]\n${userData.history.map(h => `${h.role}: ${h.msg}`).join("\n")}\n\nCurrent Message:\n"${currentTurnText}"`;

  try {
    const response = await axios.get(`${API_URL}?text=${encodeURIComponent(finalPrompt)}`);
    let reply = response.data.reply || "Hmm ❤️";
    let cleanReply = reply.replace(/[\n\r]+/g, " ").trim();

    if (userData.history.some(h => h.role === "Zara" && h.msg.toLowerCase() === cleanReply.toLowerCase())) cleanReply = "Acha aur batao?";

    if (cleanReply.length > 0) {
      const delay = Math.min(Math.max(cleanReply.length * 35, 1400), 2500);
      await new Promise(r => setTimeout(r, delay));
      await sock.sendMessage(from, { text: cleanReply });
      userData.history.push({ role: "User", msg: text }, { role: "Zara", msg: cleanReply });
      if (userData.history.length > 6) { userData.history.shift(); userData.history.shift(); }
    }
  } catch (err) { console.log("API Error:", err.message); }
}

module.exports = { startBot, getPairingCode: () => currentPairingCode, isBotConnected: () => isConnected };
