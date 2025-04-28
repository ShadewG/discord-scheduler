// Script to completely rebuild the index.js file with proper syntax
const fs = require('fs');
const path = require('path');

// Read the index.js file
const indexPath = path.join(__dirname, 'index.js');
let content = fs.readFileSync(indexPath, 'utf8');

// Create a new file with just the essential parts and proper structure
const newContent = `// Discord Bot for Insanity
require('dotenv').config();
const { Client, GatewayIntentBits, Partials, EmbedBuilder } = require('discord.js');
const { OpenAI } = require('openai');
const { Client: NotionClient } = require('@notionhq/client');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

// Load environment variables
const TOKEN = process.env.DISCORD_TOKEN;
const NOTION_KEY = process.env.NOTION_KEY;
const DB = process.env.NOTION_DATABASE_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GUILD_ID = process.env.GUILD_ID;

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
const notion = new NotionClient({
  auth: NOTION_KEY
});

// Utility function for logging
function logToFile(message) {
  const timestamp = new Date().toISOString();
  const logMessage = \`[\${timestamp}] \${message}\\n\`;
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
  logToFile(\`Error: \${error.message}\`);
});

// Get Notion page URL
function getNotionPageUrl(pageId) {
  if (!pageId) return null;
  // Format is: https://www.notion.so/{workspace}/{page-id}
  return \`https://www.notion.so/\${pageId.replace(/-/g, '')}\`;
}

// Function to find a project by query
async function findProjectByQuery(query) {
  if (!query) return null;
  
  try {
    // Case 1: Direct ID lookup
    if (query.match(/^[a-zA-Z0-9-]+$/)) {
      try {
        const page = await notion.pages.retrieve({ page_id: query });
        return page;
      } catch (error) {
        // Not a valid ID, continue to search
      }
    }
    
    // Case 2: Search by name or partial match
    const response = await notion.databases.query({
      database_id: DB,
      filter: {
        or: [
          {
            property: "Name",
            title: {
              contains: query
            }
          },
          {
            property: "Code",
            rich_text: {
              contains: query
            }
          }
        ]
      }
    });
    
    if (response.results.length > 0) {
      return response.results[0];
    }
    
    return null;
  } catch (error) {
    logToFile(\`Error finding project: \${error.message}\`);
    return null;
  }
}

// When the client is ready, run this code
client.once('ready', () => {
  console.log('Bot is ready!');
  logToFile('Bot started successfully');
  
  // Register commands on startup
  try {
    const { registerCommands } = require('./auto-register-commands');
    registerCommands();
    console.log('Commands registered successfully');
  } catch (error) {
    console.error('Error registering commands:', error);
    logToFile(\`Error registering commands: \${error.message}\`);
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
        
        const query = interaction.options.getString('project');
        if (!query) {
          await interaction.editReply('Please provide a project name or code.');
          return;
        }
        
        const project = await findProjectByQuery(query);
        if (!project) {
          await interaction.editReply(\`❌ Could not find a project matching "\${query}"\`);
          return;
        }
        
        // Get project properties
        const properties = project.properties;
        const name = properties.Name?.title?.[0]?.plain_text || 'Unnamed Project';
        const code = properties.Code?.rich_text?.[0]?.plain_text || 'No Code';
        const status = properties.Status?.select?.name || 'No Status';
        const dueDate = properties['Due Date']?.date?.start || 'No Due Date';
        const lead = properties.Lead?.select?.name || 'No Lead';
        const editors = properties.Editor?.multi_select?.map(e => e.name).join(', ') || 'None';
        
        // Create embed
        const embed = new EmbedBuilder()
          .setTitle(\`Project: \${name} (\${code})\`)
          .setColor(0x0099FF)
          .addFields(
            { name: 'Status', value: status, inline: true },
            { name: 'Due Date', value: dueDate, inline: true },
            { name: 'Lead', value: lead, inline: true },
            { name: 'Editors', value: editors, inline: true }
          )
          .setURL(getNotionPageUrl(project.id))
          .setFooter({ text: 'Notion Database' });
        
        await interaction.editReply({ embeds: [embed] });
      } catch (error) {
        logToFile(\`Error in /where command: \${error.message}\`);
        if (hasResponded) {
          await interaction.editReply(\`❌ Error finding project: \${error.message}\`);
        } else {
          await interaction.reply({ content: \`❌ Error finding project: \${error.message}\`, ephemeral: true });
        }
      }
    }
    
    // Handle other commands here
    // ...
    
  } catch (error) {
    // Global error handling
    logToFile(\`Uncaught error in command \${commandName}: \${error.message}\`);
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
      logToFile(\`Failed to notify user about error: \${notifyError.message}\`);
    }
  }
});

// Log in to Discord
client.login(TOKEN).catch(error => {
  console.error('Failed to log in to Discord:', error);
  logToFile(\`Login error: \${error.message}\`);
  process.exit(1);
});

// Export the client for testing
module.exports = { client, notion, findProjectByQuery, getNotionPageUrl };
`;

// Write the new content to the file
fs.writeFileSync(indexPath, newContent);
console.log('Successfully rebuilt index.js with proper syntax');

// Create a backup of the original file
fs.writeFileSync(path.join(__dirname, 'index.js.backup'), content);
console.log('Created backup of original index.js as index.js.backup');
