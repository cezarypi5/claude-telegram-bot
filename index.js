require('dotenv').config({ override: true });
const { Telegraf } = require('telegraf');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

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
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN, { handlerTimeout: 600_000 });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Config ───────────────────────────────────────────────────────────────────
const conversationHistory = new Map();
const MAX_HISTORY = parseInt(process.env.MAX_HISTORY || '20');
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
const GITHUB_USER = 'cezarypi5';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const PROJECTS_DIR = path.join('C:', 'Users', 'Cezary', 'Documents', 'telegram-projects');

// ─── Helper: Get or create conversation history ───────────────────────────────
function getHistory(userId) {
  if (!conversationHistory.has(userId)) {
    conversationHistory.set(userId, []);
  }
  return conversationHistory.get(userId);
}

// ─── Helper: Extract code blocks from Claude response ────────────────────────
function extractCodeBlocks(text) {
  const blocks = [];
  const regex = /```(\w+)?\n([\s\S]*?)```/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    blocks.push({
      lang: match[1] || 'txt',
      code: match[2].trim()
    });
  }
  return blocks;
}

// ─── Helper: Get file extension from language ─────────────────────────────────
function getExtension(lang) {
  const map = {
    html: 'html', css: 'css', javascript: 'js', js: 'js',
    typescript: 'ts', ts: 'ts', python: 'py', py: 'py',
    json: 'json', bash: 'sh', sh: 'sh', sql: 'sql',
    markdown: 'md', md: 'md', yaml: 'yml', yml: 'yml'
  };
  return map[lang.toLowerCase()] || lang.toLowerCase() || 'txt';
}

// ─── Helper: Slugify a project name ───────────────────────────────────────────
function slugify(text) {
  return text.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 50);
}

// ─── Helper: GitHub API request ───────────────────────────────────────────────
function githubApi(method, path, body) {
  const https = require('https');
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : '';
    const req = https.request({
      hostname: 'api.github.com',
      path,
      method,
      headers: {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'User-Agent': 'cm-bot',
        'Content-Type': 'application/json',
        'Accept': 'application/vnd.github.v3+json',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {})
      }
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch { resolve(d); }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ─── Helper: Create GitHub repo via API ──────────────────────────────────────
async function createGitHubRepo(repoName, description) {
  const r = await githubApi('POST', '/user/repos', { name: repoName, description, private: false, auto_init: false });
  if (r.html_url) return r.html_url;
  if (r.errors && r.errors[0].message.includes('already exists')) return `https://github.com/${GITHUB_USER}/${repoName}`;
  throw new Error(JSON.stringify(r));
}

// ─── Helper: Enable GitHub Pages ─────────────────────────────────────────────
async function enableGitHubPages(repoName) {
  await githubApi('POST', `/repos/${GITHUB_USER}/${repoName}/pages`, {
    source: { branch: 'main', path: '/' }
  });
  return `https://${GITHUB_USER}.github.io/${repoName}`;
}

// ─── Helper: Save files, init repo, commit, push, enable Pages ───────────────
async function saveAndPush(projectName, files, description) {
  const repoName = slugify(projectName);
  const projectDir = path.join(PROJECTS_DIR, repoName);

  fs.mkdirSync(projectDir, { recursive: true });

  const hasHtml = files.some(f => f.name.endsWith('.html'));

  // Save all files
  for (const file of files) {
    fs.writeFileSync(path.join(projectDir, file.name), file.content, 'utf8');
    log(`Saved: ${file.name}`);
  }

  // Create GitHub repo
  const repoUrl = await createGitHubRepo(repoName, description || projectName);
  const remoteUrl = `https://${GITHUB_USER}:${GITHUB_TOKEN}@github.com/${GITHUB_USER}/${repoName}.git`;

  // Git init, commit, push
  const gitCmds = [
    `cd "${projectDir}" && git init`,
    `cd "${projectDir}" && git config user.email "cezarypi5@users.noreply.github.com"`,
    `cd "${projectDir}" && git config user.name "Cezary"`,
    `cd "${projectDir}" && git add -A`,
    `cd "${projectDir}" && git commit -m "Add ${projectName}"`,
    `cd "${projectDir}" && git branch -M main`,
    `cd "${projectDir}" && git remote add origin ${remoteUrl}`,
    `cd "${projectDir}" && git push -u origin main`
  ];

  for (const cmd of gitCmds) {
    execSync(cmd, { stdio: 'pipe' });
  }

  // Enable GitHub Pages for HTML projects
  let pagesUrl = null;
  if (hasHtml) {
    try {
      pagesUrl = await enableGitHubPages(repoName);
    } catch (e) {
      log(`Pages enable error: ${e.message}`);
    }
  }

  return { repoUrl, pagesUrl, projectDir };
}

// ─── Helper: Ask Claude ───────────────────────────────────────────────────────
async function askClaude(userId, userMessage) {
  const history = getHistory(userId);
  history.push({ role: 'user', content: userMessage });

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
    `/clear - Clear conversation history\n` +
    `/status - Check bot status\n` +
    `/save <name> - Save last code to GitHub`
  );
});

bot.command('help', (ctx) => {
  ctx.reply(
    `🤖 CM_bot - Help\n\n` +
    `Just type any message to chat with Claude.\n\n` +
    `Commands:\n` +
    `/start - Welcome message\n` +
    `/clear - Clear conversation history\n` +
    `/status - Check bot status\n` +
    `/save <name> - Save last generated code to a new GitHub repo\n\n` +
    `AUTO-SAVE:\n` +
    `If your message contains the word "build", "create" or "make", any code Claude generates is automatically saved to GitHub!\n\n` +
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
  ctx.reply(
    `✅ Bot is running\n` +
    `Model: ${MODEL}\n` +
    `Messages in history: ${history.length}\n` +
    `Max history: ${MAX_HISTORY * 2} messages\n` +
    `GitHub: ${GITHUB_TOKEN ? '✅ Connected' : '❌ No token'}\n` +
    `Projects dir: ${PROJECTS_DIR}`
  );
});

// /save <project-name> — manually save last response to GitHub
bot.command('save', async (ctx) => {
  const userId = ctx.from.id.toString();
  const history = getHistory(userId);
  const projectName = ctx.message.text.replace('/save', '').trim() || 'my-project';

  const lastAssistant = [...history].reverse().find(m => m.role === 'assistant');
  if (!lastAssistant) {
    return ctx.reply('❌ No previous response to save. Ask me to build something first.');
  }

  const blocks = extractCodeBlocks(lastAssistant.content);
  if (blocks.length === 0) {
    return ctx.reply('❌ No code blocks found in the last response.');
  }

  await ctx.reply(`💾 Saving "${projectName}" to GitHub...`);

  try {
    const files = blocks.map((b, i) => ({
      name: blocks.length === 1 ? `index.${getExtension(b.lang)}` : `file${i + 1}.${getExtension(b.lang)}`,
      content: b.code
    }));

    const { repoUrl, pagesUrl } = await saveAndPush(projectName, files, projectName);
    const liveMsg = pagesUrl ? `\n🌐 Live app (ready in ~60s):\n${pagesUrl}` : '';
    ctx.reply(`✅ Saved to GitHub!\n\n📦 Repo: ${repoUrl}${liveMsg}`);
    log(`Saved project: ${projectName} -> ${repoUrl}`);
  } catch (err) {
    log(`Save error: ${err.message}`);
    ctx.reply(`❌ Failed to save: ${err.message}`);
  }
});

// ─── Main Message Handler ──────────────────────────────────────────────────────
bot.on('text', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userMessage = ctx.message.text;

  log(`MSG from ${userId}: ${userMessage}`);
  await ctx.sendChatAction('typing');

  try {
    log('Calling Claude API...');
    const response = await askClaude(userId, userMessage);
    log(`Claude replied: ${response.substring(0, 80)}`);

    // Send response in chunks if needed
    if (response.length > 4000) {
      const chunks = response.match(/.{1,4000}/gs) || [];
      for (const chunk of chunks) {
        await ctx.reply(chunk);
      }
    } else {
      await ctx.reply(response);
    }

    // Auto-save if message is a build request and response has code
    const isBuildRequest = /\b(build|create|make|generate|write me)\b/i.test(userMessage);
    if (isBuildRequest && GITHUB_TOKEN) {
      const blocks = extractCodeBlocks(response);
      if (blocks.length > 0) {
        const projectName = slugify(userMessage.substring(0, 50));
        await ctx.reply(`🔄 Auto-saving to GitHub...`);
        try {
          const files = blocks.map((b, i) => ({
            name: blocks.length === 1 ? `index.${getExtension(b.lang)}` : `file${i + 1}.${getExtension(b.lang)}`,
            content: b.code
          }));
          const { repoUrl, pagesUrl } = await saveAndPush(projectName, files, userMessage.substring(0, 100));
          const liveMsg = pagesUrl ? `\n🌐 Live app (ready in ~60s):\n${pagesUrl}` : '';
          await ctx.reply(`✅ Auto-saved to GitHub!\n\n📦 Repo: ${repoUrl}${liveMsg}`);
          log(`Auto-saved: ${projectName} -> ${repoUrl}`);
        } catch (err) {
          log(`Auto-save error: ${err.message}`);
          await ctx.reply(`⚠️ Code generated but auto-save failed. Use /save <name> to retry.`);
        }
      }
    }

  } catch (error) {
    log(`Error: ${error.message}`);
    if (error.status === 401) ctx.reply('❌ Invalid Anthropic API key.');
    else if (error.status === 429) ctx.reply('⏳ Rate limit reached. Please wait.');
    else ctx.reply('❌ Something went wrong. Please try again.');
  }
});

// ─── Error Handler ────────────────────────────────────────────────────────────
bot.catch((err, ctx) => {
  console.error('Bot error:', err);
  ctx.reply('❌ An unexpected error occurred.');
});

// ─── Launch ───────────────────────────────────────────────────────────────────
if (!fs.existsSync(PROJECTS_DIR)) {
  fs.mkdirSync(PROJECTS_DIR, { recursive: true });
}

log('Bot launching...');
bot.launch().then(() => {
  log('Bot stopped.');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
