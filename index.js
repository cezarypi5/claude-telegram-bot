require('dotenv').config({ override: true });
const { Telegraf } = require('telegraf');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  fs.appendFileSync('bot.log', line);
}

// ─── Validation ──────────────────────────────────────────────────────────────
if (!process.env.TELEGRAM_BOT_TOKEN) {
  console.error('❌ Missing TELEGRAM_BOT_TOKEN in .env file');
  process.exit(1);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('❌ Missing ANTHROPIC_API_KEY in .env file');
  process.exit(1);
}

// ─── Clients ─────────────────────────────────────────────────────────────────
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Conversation History Store ───────────────────────────────────────────────
const conversationHistory = new Map();
const MAX_HISTORY = parseInt(process.env.MAX_HISTORY || '20');
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';

// ─── Helper: Get or create conversation history for a user ────────────────────
function getHistory(userId) {
  if (!conversationHistory.has(userId)) {
    conversationHistory.set(userId, []);
  }
  return conversationHistory.get(userId);
}

// ─── Helper: Send message to Claude and get response ──────────────────────────
async function askClaude(userId, userMessage) {
  const history = getHistory(userId);

  // Add user message to history
  history.push({ role: 'user', content: userMessage });

  // Trim history if too long (keep last MAX_HISTORY pairs)
  if (history.length > MAX_HISTORY * 2) {
    history.splice(0, history.length - MAX_HISTORY * 2);
  }

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 8096,
    system: `You are Claude, Anthropic's most capable AI assistant, accessed via Telegram by Cezary. You have the full power of Claude — expert-level knowledge across coding, software engineering, mathematics, science, writing, analysis, research, planning, debugging, architecture, and any other domain.

BEHAVIOUR:
- Give thorough, complete, expert-level answers. Never water down or oversimplify unless asked.
- Write full working code when asked — no placeholders, no "add your logic here", no truncation.
- Think step by step for complex problems. Show your reasoning when it helps.
- Be direct and confident. Don't hedge unnecessarily.
- Match the depth of the question: short questions can get short answers, complex questions get full detailed answers.
- Proactively point out issues, edge cases, or better approaches when you spot them.

FORMATTING FOR TELEGRAM:
- Use plain text. No markdown headers (# ## ###).
- Use code blocks with triple backticks for all code.
- Use line breaks and spacing to organise long responses.
- For lists, use • or numbers.
- If a response is very long, structure it clearly with labelled sections using ALL CAPS or dashes.`,
    messages: history,
  });

  const assistantMessage = response.content[0].text;

  // Add Claude's response to history
  history.push({ role: 'assistant', content: assistantMessage });

  return assistantMessage;
}

// ─── Commands ─────────────────────────────────────────────────────────────────
bot.command('start', (ctx) => {
  ctx.reply(
    `👋 Hello Cezary! I'm CM_bot, your AI assistant.\n\n` +
    `Just send me any message and I'll respond.\n\n` +
    `Available commands:\n` +
    `/help - Show this help message\n` +
    `/clear - Clear our conversation history\n` +
    `/status - Check bot status`
  );
});

bot.command('help', (ctx) => {
  ctx.reply(
    `🤖 CM_bot - Help\n\n` +
    `Just type any message to chat with Claude.\n\n` +
    `Commands:\n` +
    `/start - Welcome message\n` +
    `/clear - Clear conversation history and start fresh\n` +
    `/status - Check if bot is running correctly\n` +
    `/help - Show this message\n\n` +
    `I can help you with:\n` +
    `• Writing and editing\n` +
    `• Coding and debugging\n` +
    `• Research and analysis\n` +
    `• Planning and brainstorming\n` +
    `• Answering questions\n` +
    `• And much more!`
  );
});

bot.command('clear', (ctx) => {
  const userId = ctx.from.id.toString();
  conversationHistory.set(userId, []);
  ctx.reply('🗑️ Conversation history cleared. Starting fresh!');
});

bot.command('status', (ctx) => {
  const userId = ctx.from.id.toString();
  const history = getHistory(userId);
  const messageCount = history.length;
  ctx.reply(
    `✅ Bot is running\n` +
    `Model: ${MODEL}\n` +
    `Messages in history: ${messageCount}\n` +
    `Max history: ${MAX_HISTORY * 2} messages`
  );
});

// ─── Main Message Handler ──────────────────────────────────────────────────────
bot.on('text', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userMessage = ctx.message.text;

  log(`MSG from ${userId}: ${userMessage}`);

  // Show typing indicator
  await ctx.sendChatAction('typing');

  try {
    log('Calling Claude API...');
    const response = await askClaude(userId, userMessage);
    log(`Claude replied: ${response.substring(0, 80)}`);

    // Telegram has a 4096 character limit per message
    if (response.length > 4000) {
      // Split long responses into chunks
      const chunks = response.match(/.{1,4000}/gs) || [];
      for (const chunk of chunks) {
        await ctx.reply(chunk);
      }
    } else {
      await ctx.reply(response);
    }

  } catch (error) {
    console.error('Error calling Claude API:', error);

    if (error.status === 401) {
      ctx.reply('❌ Invalid Anthropic API key. Please check your .env file.');
    } else if (error.status === 429) {
      ctx.reply('⏳ Rate limit reached. Please wait a moment and try again.');
    } else {
      ctx.reply('❌ Something went wrong. Please try again.');
    }
  }
});

// ─── Error Handler ────────────────────────────────────────────────────────────
bot.catch((err, ctx) => {
  console.error('Bot error:', err);
  ctx.reply('❌ An unexpected error occurred.');
});

// ─── Launch ───────────────────────────────────────────────────────────────────
log('Bot launching...');
bot.launch().then(() => {
  log('Bot stopped.');
});

// Graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
