// Discord Bot for Insanity
require('dotenv').config();
const { Client, GatewayIntentBits, Partials, EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder } = require('discord.js');
const { OpenAI } = require('openai');
const { Client: NotionClient } = require('@notionhq/client');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

// Load environment variables
const TOKEN = process.env.DISCORD_TOKEN;
const NOTION_KEY = process.env.NOTION_TOKEN || process.env.NOTION_KEY; // Support both naming conventions
const DB = process.env.NOTION_DB_ID || process.env.NOTION_DATABASE_ID; // Support both naming conventions
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GUILD_ID = process.env.GUILD_ID;

// Validate required environment variables
if (!TOKEN) {
  console.error('❌ ERROR: DISCORD_TOKEN is required but not provided in .env file');
  process.exit(1);
}

// Initialize Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.Channel]
});

// Initialize Notion client
let notion = null;
try {
  if (NOTION_KEY && DB) {
    notion = new NotionClient({
      auth: NOTION_KEY
    });
    console.log('✅ Notion client initialized successfully');
  } else {
    console.warn('⚠️ NOTION_KEY or NOTION_DATABASE_ID not provided. Notion features will be disabled.');
  }
} catch (error) {
  console.warn('⚠️ Failed to initialize Notion client: ' + error.message + '. Notion features will be disabled.');
}

// Utility function for logging
function logToFile(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}\n`;
  fs.appendFileSync(path.join(__dirname, 'bot.log'), logMessage);
}

// Initialize OpenAI client if API key is provided
let openai = null;
try {
  if (OPENAI_API_KEY) {
    openai = new OpenAI({ apiKey: OPENAI_API_KEY });
    console.log('✅ OpenAI client initialized successfully');
  } else {
    console.warn('⚠️ OPENAI_API_KEY not provided. AI features will be disabled.');
  }
} catch (error) {
  console.warn('⚠️ Failed to initialize OpenAI: ' + error.message + '. AI features will be disabled.');
}

// Error handler
client.on('error', (error) => {
  console.error('Error:', error);
  logToFile(`Error: ${error.message}`);
});

// Get Notion page URL
function getNotionPageUrl(pageId) {
  if (!pageId) return null;
  // Format is: https://www.notion.so/{workspace}/{page-id}
  return `https://www.notion.so/${pageId.replace(/-/g, '')}`;
}

// Function to find a project by query
async function findProjectByQuery(query) {
  if (!query) return null;
  
  // Check if Notion client is initialized
  if (!notion) {
    logToFile('❌ Cannot search for projects: Notion client is not initialized');
    throw new Error('Notion client is not initialized. Please check your environment variables.');
  }
  
  try {
    // Case 1: Direct ID lookup
    if (query.match(/^[a-zA-Z0-9-]+$/)) {
      try {
        const page = await notion.pages.retrieve({ page_id: query });
        return page;
      } catch (error) {
        // Not a valid ID, continue to search
        logToFile(`Not a valid page ID: ${query}. Continuing to search by name.`);
      }
    }
    
    // Case 2: Search by name or partial match
    const response = await notion.databases.query({
      database_id: DB,
      filter: {
        property: "Project name",
        title: {
          contains: query
        }
      }
    });
    
    if (response.results.length > 0) {
      // Return both the page and the code for reference
      const page = response.results[0];
      
      // Extract code from the beginning of the project name (usually something like IB23, CL45, etc.)
      const projectName = page.properties["Project name"]?.title?.[0]?.plain_text || '';
      const codeMatch = projectName.match(/^([A-Z]{2}\d{2})/);
      const code = codeMatch ? codeMatch[0] : query;
      
      return { page, code };
    }
    
    return null;
  } catch (error) {
    logToFile(`Error finding project: ${error.message}`);
    throw error;
  }
}

// When the client is ready, run this code
client.once('ready', () => {
  console.log('Bot is ready!');
  logToFile('Bot started successfully');
  
  // Register commands on startup
  try {
    const { registerCommandsOnStartup } = require('./auto-register-commands');
    registerCommandsOnStartup(client, TOKEN)
      .then(() => console.log('Commands registered successfully'))
      .catch(error => {
        console.error('Error registering commands:', error);
        logToFile(`Error registering commands: ${error.message}`);
      });
  } catch (error) {
    console.error('Error registering commands:', error);
    logToFile(`Error registering commands: ${error.message}`);
  }
});

// Handle slash command interactions
client.on('interactionCreate', async interaction => {
  if (!interaction.isCommand()) return;

  const { commandName } = interaction;
  
  // Add global error handling for all command interactions
  try {
    // Create a timeout to track if we're at risk of hitting Discord's 3-second limit
    let hasResponded = false;
    
    // Handle the /where command
    if (commandName === 'where') {
      try {
        await interaction.deferReply();
        hasResponded = true;
        
        // Check if Notion is configured
        if (!notion) {
          await interaction.editReply('❌ Notion integration is not configured. Please ask an administrator to set up the Notion API token and database ID.');
          return;
        }
        
        const query = interaction.options.getString('query');
        if (!query) {
          await interaction.editReply('Please provide a project name or code.');
          return;
        }
        
        const result = await findProjectByQuery(query);
        if (!result) {
          await interaction.editReply(`❌ Could not find a project matching "${query}"`);
          return;
        }
        
        // Get the page details from the result
        const project = result.page;
        
        // Get project properties
        const properties = project.properties;
        const projectName = properties["Project name"]?.title?.[0]?.plain_text || 'Unnamed Project';
        // Get code from the result or extract from project name
        const code = result.code || projectName.match(/^([A-Z]{2}\d{2})/)?.['0'] || 'Unknown';
        const status = properties.Status?.select?.name || 'No Status';
        const dueDate = properties.Date?.date?.start || 'No Due Date';
        const lead = properties.Lead?.people?.map(p => p.name).join(', ') || 'No Lead';
        const editors = properties.Editor?.multi_select?.map(e => e.name).join(', ') || 'None';
        const frameioUrl = properties["Frame.io"]?.url || '';
        const scriptUrl = properties.Script?.url || '';
        
        // Get Notion URL
        const notionUrl = getNotionPageUrl(project.id);
        
        // Look for Discord channels with this code
        const codePattern = code.toLowerCase();
        const guild = interaction.guild;
        const discordChannels = guild.channels.cache
          .filter(channel => channel.type === 0 && channel.name.includes(codePattern))
          .map(channel => ({ id: channel.id, channel }));
        
        // Create embed
        const embed = new EmbedBuilder()
          .setTitle(`Project: ${code}`)
          .setColor(0x0099FF)
          .setDescription(`Here's everything you need for project **${code}**:`)
          .setTimestamp();
        
        // Add Notion Card
        if (notionUrl) {
          embed.addFields({ name: '📋 Notion Card', value: notionUrl });
        }
        
        // Add Discord Channels if found
        if (discordChannels.length > 0) {
          embed.addFields({ 
            name: '💬 Discord Channel', 
            value: discordChannels.map(ch => `<#${ch.id}>`).join('\n') 
          });
        }
        
        // Add Frame.io link
        if (frameioUrl) {
          embed.addFields({ name: '🎬 Frame.io', value: frameioUrl });
        }
        
        // Add Status
        embed.addFields({ name: '📊 Status', value: status });
        
        // Add Due Date if present
        if (dueDate && dueDate !== 'No Due Date') {
          const formattedDate = new Date(dueDate).toLocaleDateString('en-US', {
            month: 'short', day: 'numeric', year: 'numeric'
          });
          embed.addFields({ name: '📅 Due Date', value: formattedDate, inline: true });
        }
        
        // If script URL not found in Notion, check Discord channel for Google Doc links
        let foundScriptInDiscord = false;
        if (!scriptUrl && discordChannels.length > 0) {
          try {
            // Look at the first matching Discord channel
            const channel = discordChannels[0].channel;
            logToFile(`Looking for Google Doc links in channel #${channel.name}`);
            
            // Fetch last 100 messages
            const messages = await channel.messages.fetch({ limit: 100 });
            
            // Find messages with Google Doc links
            const docMessages = messages.filter(msg => {
              const content = msg.content.toLowerCase();
              return content.includes('docs.google.com') || 
                     content.includes('drive.google.com/document');
            });
            
            if (docMessages.size > 0) {
              // Sort by timestamp to get the most recent one
              const sortedMessages = [...docMessages.values()]
                .sort((a, b) => b.createdTimestamp - a.createdTimestamp);
              
              // Get the most recent message with a Google Doc link
              const recentDocMessage = sortedMessages[0];
              
              // Extract the URL from the message
              const msgContent = recentDocMessage.content;
              const urlMatch = msgContent.match(/(https?:\/\/docs\.google\.com\S+|https?:\/\/drive\.google\.com\/document\S+)/i);
              
              if (urlMatch && urlMatch[0]) {
                scriptUrl = urlMatch[0];
                foundScriptInDiscord = true;
                logToFile(`Found script URL in Discord: ${scriptUrl}`);
              }
            }
          } catch (discordError) {
            logToFile(`Error searching Discord for script links: ${discordError.message}`);
            // Continue with the rest of the function, don't throw
          }
        }
        
        // Add Script URL if present (from Notion or Discord)
        if (scriptUrl) {
          const fieldName = foundScriptInDiscord ? 
            '📝 Script (from Discord)' : 
            '📝 Script';
          embed.addFields({ name: fieldName, value: scriptUrl });
        }
        
        // Add People info
        if (lead !== 'No Lead') {
          embed.addFields({ name: '🎬 Lead', value: lead, inline: true });
        }
        
        if (editors !== 'None') {
          embed.addFields({ name: '✂️ Editors', value: editors, inline: true });
        }
        
        // Create buttons for links
        const buttons = [];
        
        if (notionUrl) {
          buttons.push(
            new ButtonBuilder()
              .setLabel('Open in Notion')
              .setStyle(ButtonStyle.Link)
              .setURL(notionUrl)
          );
        }
        
        if (frameioUrl) {
          buttons.push(
            new ButtonBuilder()
              .setLabel('Open Frame.io')
              .setStyle(ButtonStyle.Link)
              .setURL(frameioUrl)
          );
        }
        
        if (scriptUrl) {
          const buttonLabel = foundScriptInDiscord ? 'Open Script (Discord)' : 'Open Script';
          buttons.push(
            new ButtonBuilder()
              .setLabel(buttonLabel)
              .setStyle(ButtonStyle.Link)
              .setURL(scriptUrl)
          );
        }
        
        // Add buttons if we have any
        const components = [];
        if (buttons.length > 0) {
          const row = new ActionRowBuilder().addComponents(...buttons);
          components.push(row);
        }
        
        await interaction.editReply({ 
          embeds: [embed],
          components: components.length > 0 ? components : undefined
        });
      } catch (error) {
        logToFile(`Error in /where command: ${error.message}`);
        if (hasResponded) {
          await interaction.editReply(`❌ Error finding project: ${error.message}`);
        } else {
          await interaction.reply({ content: `❌ Error finding project: ${error.message}`, ephemeral: true });
        }
      }
    }
    
    // Handle other commands here
    // ...
    
  } catch (error) {
    // Global error handling
    logToFile(`Uncaught error in command ${commandName}: ${error.message}`);
    logToFile(error.stack);
    
    try {
      // Try to notify the user if possible
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ 
          content: '❌ An unexpected error occurred. Please try again later.',
          ephemeral: true 
        });
      } else {
        await interaction.followUp({ 
          content: '❌ An unexpected error occurred. Please try again later.',
          ephemeral: true 
        });
      }
    } catch (notifyError) {
      logToFile(`Failed to notify user about error: ${notifyError.message}`);
    }
  }
});

// Log in to Discord
client.login(TOKEN).catch(error => {
  console.error('Failed to log in to Discord:', error);
  logToFile(`Login error: ${error.message}`);
  process.exit(1);
});

// Export the client for testing
module.exports = { client, notion, findProjectByQuery, getNotionPageUrl };