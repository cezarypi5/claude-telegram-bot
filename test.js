const https = require('https');

const TOKEN = '8773213235:AAFkLToOOMwvBP6gDiUFu0-G_gPM5p_DBns';
let offset = 0;

function sendMessage(chatId, text) {
  const body = JSON.stringify({ chat_id: chatId, text });
  const req = https.request({
    hostname: 'api.telegram.org',
    path: `/bot${TOKEN}/sendMessage`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  }, (res) => {
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => console.log('Send result:', d.substring(0, 100)));
  });
  req.on('error', e => console.error('Send error:', e.message));
  req.write(body);
  req.end();
}

function poll() {
  console.log('Polling... offset=' + offset);
  https.get(`https://api.telegram.org/bot${TOKEN}/getUpdates?timeout=10&offset=${offset}`, (res) => {
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => {
      try {
        const data = JSON.parse(d);
        if (!data.ok) { console.error('Telegram error:', d); setTimeout(poll, 3000); return; }
        for (const update of data.result) {
          offset = update.update_id + 1;
          if (update.message && update.message.text) {
            console.log('Got message:', update.message.text, 'from:', update.message.from.id);
            sendMessage(update.message.chat.id, 'Test reply: I got your message: ' + update.message.text);
          }
        }
      } catch(e) { console.error('Parse error:', e.message); }
      poll();
    });
  }).on('error', e => { console.error('Poll error:', e.message); setTimeout(poll, 3000); });
}

console.log('Starting test bot...');
poll();
