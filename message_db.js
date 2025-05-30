const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, 'messages.db');

function initDatabase() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, '');
  }
}

function logMessageToDB(message) {
  try {
    const line = JSON.stringify(message);
    fs.appendFileSync(DB_FILE, line + '\n');
  } catch (error) {
    console.error(`Failed to log message: ${error.message}`);
  }
}

function loadAllMessages() {
  try {
    if (!fs.existsSync(DB_FILE)) return [];
    const data = fs.readFileSync(DB_FILE, 'utf8');
    if (!data.trim()) return [];
    return data.trim().split('\n').map(line => {
      try {
        const msg = JSON.parse(line);
        if (!msg.url && msg.guildId && msg.channelId && msg.id) {
          msg.url = `https://discord.com/channels/${msg.guildId}/${msg.channelId}/${msg.id}`;
        }
        return msg;
      } catch {
        return null;
      }
    }).filter(Boolean);
  } catch (error) {
    console.error(`Failed to load all messages: ${error.message}`);
    return [];
  }
}

function ensureMessages(messages = []) {
  const existing = new Set(loadAllMessages().map(m => m.id));
  let added = 0;
  for (const msg of messages) {
    if (msg && !existing.has(msg.id)) {
      logMessageToDB(msg);
      existing.add(msg.id);
      added++;
    }
  }
  return added;
}

function importBackups(backupsDir = path.join(__dirname, 'backups')) {
  if (!fs.existsSync(backupsDir)) return 0;
  const files = fs.readdirSync(backupsDir).filter(f => f.endsWith('.json'));
  let totalAdded = 0;
  for (const file of files) {
    const filePath = path.join(backupsDir, file);
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (Array.isArray(data.messages)) {
        totalAdded += ensureMessages(data.messages);
      }
    } catch (error) {
      console.error(`Failed to import ${file}: ${error.message}`);
    }
  }
  return totalAdded;
}

function loadRecentMessages(limit = 500) {
  try {
    if (!fs.existsSync(DB_FILE)) return [];
    const data = fs.readFileSync(DB_FILE, 'utf8');
    if (!data.trim()) return [];
    const lines = data.trim().split('\n');
    const slice = lines.slice(-limit);
    return slice.map(line => {
      try {
        const msg = JSON.parse(line);
        if (!msg.url && msg.guildId && msg.channelId && msg.id) {
          msg.url = `https://discord.com/channels/${msg.guildId}/${msg.channelId}/${msg.id}`;
        }
        return msg;
      } catch {
        return null;
      }
    }).filter(Boolean);
  } catch (error) {
    console.error(`Failed to load messages: ${error.message}`);
    return [];
  }
}

module.exports = {
  initDatabase,
  logMessageToDB,
  loadRecentMessages,
  loadAllMessages,
  ensureMessages,
  importBackups
};
