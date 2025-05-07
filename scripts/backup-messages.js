// Script to backup Discord messages for the Knowledge Assistant
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, Partials } = require('discord.js');

// Setup directories
const BACKUPS_DIR = path.join(__dirname, '..', 'backups');
if (!fs.existsSync(BACKUPS_DIR)) {
  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  console.log(`Created backups directory: ${BACKUPS_DIR}`);
}

// Setup logging
const LOGS_DIR = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

function log(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}\n`;
  fs.appendFileSync(path.join(LOGS_DIR, 'backup-messages.log'), logMessage);
  console.log(message);
}

// Initialize Discord client with necessary intents
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Message, Partials.Channel]
});

// Settings
const MAX_MESSAGES_PER_CHANNEL = 100; // Number of messages to fetch per channel
const IMPORTANT_CHANNELS = []; // Add specific channel IDs to prioritize

// Fetch messages from a channel
async function fetchMessages(channel) {
  try {
    if (!channel.isTextBased() || channel.isDMBased()) return [];
    
    log(`Fetching messages from #${channel.name} (${channel.id})...`);
    
    // Fetch messages
    const messages = await channel.messages.fetch({ limit: MAX_MESSAGES_PER_CHANNEL });
    
    // Convert messages to a simpler format for storage
    const formattedMessages = Array.from(messages.values()).map(msg => ({
      id: msg.id,
      content: msg.content,
      author: {
        id: msg.author.id,
        username: msg.author.username, 
        tag: msg.author.tag
      },
      channelId: channel.id,
      channelName: channel.name,
      guildId: channel.guild.id,
      guildName: channel.guild.name,
      timestamp: msg.createdAt.toISOString(),
      attachments: Array.from(msg.attachments.values()).map(a => a.url)
    }));
    
    log(`Fetched ${formattedMessages.length} messages from #${channel.name}`);
    return formattedMessages;
  } catch (error) {
    log(`Error fetching messages from #${channel.name}: ${error.message}`);
    return [];
  }
}

// Main backup process
async function backupMessages() {
  try {
    // Get the current date for the filename
    const now = new Date();
    const dateString = now.toISOString().split('T')[0]; // YYYY-MM-DD
    
    // Process each guild the bot is in
    client.guilds.cache.forEach(async (guild) => {
      log(`Processing guild: ${guild.name} (${guild.id})`);
      let allMessages = [];
      
      // Fetch channels
      await guild.channels.fetch();
      
      // First process important channels if specified
      if (IMPORTANT_CHANNELS.length > 0) {
        for (const channelId of IMPORTANT_CHANNELS) {
          const channel = guild.channels.cache.get(channelId);
          if (channel) {
            const messages = await fetchMessages(channel);
            allMessages = allMessages.concat(messages);
          }
        }
      }
      
      // Then process all text channels
      const textChannels = Array.from(guild.channels.cache.values())
        .filter(channel => channel.isTextBased() && !channel.isDMBased());
      
      // Skip channels already processed
      const remainingChannels = textChannels.filter(channel => 
        !IMPORTANT_CHANNELS.includes(channel.id));
      
      // Process remaining channels
      for (const channel of remainingChannels) {
        const messages = await fetchMessages(channel);
        allMessages = allMessages.concat(messages);
      }
      
      // Save to file if we have messages
      if (allMessages.length > 0) {
        const filename = `${guild.name.replace(/[^a-z0-9]/gi, '_')}-${dateString}.json`;
        const filePath = path.join(BACKUPS_DIR, filename);
        
        const backupData = {
          guildId: guild.id,
          guildName: guild.name,
          backupDate: now.toISOString(),
          messageCount: allMessages.length,
          messages: allMessages
        };
        
        fs.writeFileSync(filePath, JSON.stringify(backupData, null, 2));
        log(`Saved ${allMessages.length} messages from ${guild.name} to ${filename}`);
      } else {
        log(`No messages found in ${guild.name}`);
      }
    });
    
    log('Backup process completed');
  } catch (error) {
    log(`Error in backup process: ${error.message}`);
  } finally {
    // Properly close the client connection
    client.destroy();
  }
}

// Event handlers
client.once('ready', () => {
  log(`Logged in as ${client.user.tag}`);
  backupMessages();
});

// Handle errors
client.on('error', (error) => {
  log(`Client error: ${error.message}`);
});

// Login to Discord
if (!process.env.DISCORD_TOKEN) {
  log('Error: DISCORD_TOKEN not found in environment variables');
  process.exit(1);
}

log('Starting Discord message backup process...');
client.login(process.env.DISCORD_TOKEN)
  .catch(error => {
    log(`Login error: ${error.message}`);
    process.exit(1);
  }); 