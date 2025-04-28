// Discord Bot for Insanity
require('dotenv').config();
const { Client, GatewayIntentBits, Partials, EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder } = require('discord.js');
const { OpenAI } = require('openai');
const { Client: NotionClient } = require('@notionhq/client');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const moment = require('moment-timezone');

// Import availability module
const { STAFF_AVAILABILITY, isStaffActive, getTimeLeftInShift, createTimeProgressBar, formatWorkingHours } = require('./availability');

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
        
        // Status could be under different property names, try them all
        let status = 'No Status';
        if (properties.Status?.select?.name) {
          status = properties.Status.select.name;
        } else if (properties['Status']?.select?.name) {
          status = properties['Status'].select.name;
        } else if (properties.status?.select?.name) {
          status = properties.status.select.name;
        } else {
          // Log all property names for debugging
          logToFile(`Available properties for ${code}: ${Object.keys(properties).join(', ')}`);
        }
        
        const dueDate = properties.Date?.date?.start || 'No Due Date';
        const lead = properties.Lead?.people?.map(p => p.name).join(', ') || 'No Lead';
        const editors = properties.Editor?.multi_select?.map(e => e.name).join(', ') || 'None';
        
        // Check for script URL in multiple possible property names
        let scriptUrl = '';
        if (properties.Script?.url) {
          scriptUrl = properties.Script.url;
        } else if (properties['Script']?.url) {
          scriptUrl = properties['Script'].url;
        } else if (properties.script?.url) {
          scriptUrl = properties.script.url;
        }
        
        // Check for Frame.io URL
        let frameioUrl = '';
        if (properties["Frame.io"]?.url) {
          frameioUrl = properties["Frame.io"].url;
        } else if (properties['Frame.io']?.url) {
          frameioUrl = properties['Frame.io'].url;
        }
        
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
        embed.addFields({ name: '📊 Status', value: status || 'Not Set' });
        
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
            
            // Log how many messages we found for debugging
            logToFile(`Found ${messages.size} messages in channel #${channel.name}`);
            
            // Find messages with Google Doc links
            const docMessages = messages.filter(msg => {
              const content = msg.content.toLowerCase();
              return content.includes('docs.google.com') || 
                     content.includes('drive.google.com/document');
            });
            
            // Log how many doc messages we found
            logToFile(`Found ${docMessages.size} messages with Google Doc links`);
            
            if (docMessages.size > 0) {
              // Sort by timestamp to get the most recent one
              const sortedMessages = [...docMessages.values()]
                .sort((a, b) => b.createdTimestamp - a.createdTimestamp);
              
              // Get the most recent message with a Google Doc link
              const recentDocMessage = sortedMessages[0];
              
              // Extract the URL from the message
              const msgContent = recentDocMessage.content;
              logToFile(`Found message with content: ${msgContent}`);
              
              // More comprehensive regex to catch all sorts of Google links
              const urlMatch = msgContent.match(/(https?:\/\/docs\.google\.com\S+|https?:\/\/drive\.google\.com\S+)/i);
              
              if (urlMatch && urlMatch[0]) {
                scriptUrl = urlMatch[0];
                foundScriptInDiscord = true;
                logToFile(`Found script URL in Discord: ${scriptUrl}`);
              } else {
                logToFile(`Regex did not match any Google Doc links in: ${msgContent}`);
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
    
    // Handle the /availability command
    else if (commandName === 'availability') {
      try {
        // Check if ephemeral flag is set
        const ephemeral = interaction.options.getBoolean('ephemeral') !== false; // Default to true
        
        await interaction.deferReply({ ephemeral });
        hasResponded = true;
        
        // Current Berlin time
        const berlinTime = moment().tz('Europe/Berlin').format('dddd, MMMM D, YYYY HH:mm:ss');
        
        // Create the embed
        const embed = new EmbedBuilder()
          .setTitle('Team Availability')
          .setDescription(`Current time in Berlin: **${berlinTime}**\nStaff currently working are highlighted below:`)
          .setColor(0x00AAFF)
          .setTimestamp();
        
        // Group staff by availability status
        const activeStaff = [];
        const inactiveStaff = [];
        
        // Process each staff member
        STAFF_AVAILABILITY.forEach(staff => {
          const isActive = isStaffActive(staff);
          const timeLeft = getTimeLeftInShift(staff);
          const workingHours = formatWorkingHours(staff);
          
          const staffInfo = {
            name: staff.name,
            isActive,
            timeLeft,
            workingHours
          };
          
          if (isActive) {
            activeStaff.push(staffInfo);
          } else {
            inactiveStaff.push(staffInfo);
          }
        });
        
        // Add active staff field with inline status
        if (activeStaff.length > 0) {
          const activeStaffText = activeStaff.map(staff => 
            `**${staff.name}** (${staff.timeLeft}) - ${staff.workingHours}`
          ).join('\n');
          
          embed.addFields({ name: '🟢 Currently Working', value: activeStaffText });
        } else {
          embed.addFields({ name: '🟢 Currently Working', value: 'No team members are currently working.' });
        }
        
        // Add inactive staff field
        if (inactiveStaff.length > 0) {
          const inactiveStaffText = inactiveStaff.map(staff => 
            `${staff.name} - ${staff.workingHours}`
          ).join('\n');
          
          embed.addFields({ name: '⚪ Not Working', value: inactiveStaffText });
        }
        
        embed.setFooter({ text: 'All times are in Europe/Berlin timezone' });
        
        // Send the embed
        await interaction.editReply({ embeds: [embed] });
        
      } catch (error) {
        logToFile(`Error in /availability command: ${error.message}`);
        if (hasResponded) {
          await interaction.editReply(`❌ Error displaying availability: ${error.message}`);
        } else {
          await interaction.reply({ content: `❌ Error displaying availability: ${error.message}`, ephemeral: true });
        }
      }
    }
    
    // Handle the /analyze command
    else if (commandName === 'analyze') {
      try {
        // Get command options with defaults
        const messageCount = interaction.options.getInteger('messages') || 100;
        const dryRun = interaction.options.getBoolean('dry_run') || false;
        const ephemeral = interaction.options.getBoolean('ephemeral') !== false; // Default to true
        
        await interaction.deferReply({ ephemeral });
        hasResponded = true;
        
        // Check if channel is linked to a Notion page
        const channel = interaction.channel;
        if (!channel) {
          await interaction.editReply('❌ This command can only be used in a text channel.');
          return;
        }
        
        // Check permissions
        const permissions = channel.permissionsFor(interaction.client.user);
        if (!permissions || !permissions.has('ReadMessageHistory')) {
          await interaction.editReply('❌ I don\'t have permission to read message history in this channel. Please give me the "Read Message History" permission and try again.');
          return;
        }
        
        // Log the command
        logToFile(`/analyze command used in #${channel.name} for ${messageCount} messages by ${interaction.user.tag}`);
        
        // Check if Notion is configured
        if (!notion) {
          await interaction.editReply('❌ Notion integration is not configured. Please ask an administrator to set up the Notion API token and database ID.');
          return;
        }
        
        // Check if the channel name contains a project code (IB##, CL##, BC##)
        const channelName = channel.name.toLowerCase();
        const codeMatch = channelName.match(/(ib|cl|bc)\d{2}/i);
        
        if (!codeMatch) {
          await interaction.editReply('❌ This channel does not appear to be linked to a project. Channel name should contain a project code like IB23, CL45, etc.');
          return;
        }
        
        const projectCode = codeMatch[0].toUpperCase();
        
        // Find the project in Notion
        const project = await findProjectByQuery(projectCode);
        if (!project) {
          await interaction.editReply(`❌ Could not find project with code "${projectCode}" in Notion database.`);
          return;
        }
        
        // Get the page
        const page = project.page;
        
        // Fetch messages
        let messages;
        try {
          messages = await channel.messages.fetch({ limit: Math.min(messageCount, 100) });
          logToFile(`Fetched ${messages.size} messages from #${channel.name}`);
        } catch (fetchError) {
          await interaction.editReply(`❌ Error fetching messages: ${fetchError.message}`);
          return;
        }
        
        // If OpenAI is not configured, we can't analyze messages
        if (!openai) {
          await interaction.editReply('❌ OpenAI API is not configured. Please ask an administrator to set up the OpenAI API key.');
          return;
        }
        
        // Prepare messages for analysis
        const messageTexts = [...messages.values()]
          .sort((a, b) => a.createdTimestamp - b.createdTimestamp) // Sort chronologically
          .map(msg => `${msg.author.tag}: ${msg.content}`)
          .join('\n');
        
        // Add context about what we're looking for
        const systemPrompt = `
          You are analyzing Discord messages from a video production project. 
          Extract the following properties from the conversation:
          
          1. Project status (e.g., Writing, Writing Review, VA Render, Ready for Editing, Clip Selection, MGX)
          2. Script link (Google Docs URL)
          3. Frame.io link
          4. Key dates mentioned (filming dates, delivery dates)
          5. Editor assignment
          6. Lead assignment
          7. Progress updates
          
          Format your response as a JSON object with these properties.
          Only include properties that are clearly mentioned in the messages.
        `;
        
        // Complete the prompt with extracted context
        let gptResponse;
        try {
          gptResponse = await openai.chat.completions.create({
            model: 'gpt-3.5-turbo',
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: messageTexts }
            ],
            max_tokens: 1000
          });
          
          logToFile(`OpenAI analysis completed for ${projectCode}`);
        } catch (aiError) {
          logToFile(`OpenAI error: ${aiError.message}`);
          await interaction.editReply(`❌ Error analyzing messages: ${aiError.message}`);
          return;
        }
        
        // Extract completion
        const completion = gptResponse.choices[0]?.message?.content;
        if (!completion) {
          await interaction.editReply('❌ Error: No completion received from OpenAI.');
          return;
        }
        
        // Try to parse the JSON response
        let extractedData;
        try {
          // Extract JSON from the response (it might be wrapped in markdown code blocks)
          const jsonMatch = completion.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/) || 
                            completion.match(/(\{[\s\S]*\})/);
                            
          const jsonString = jsonMatch ? jsonMatch[1] : completion;
          extractedData = JSON.parse(jsonString);
          
          logToFile(`Successfully parsed JSON for ${projectCode}`);
        } catch (parseError) {
          logToFile(`JSON parse error: ${parseError.message}, raw: ${completion}`);
          await interaction.editReply(`❌ Error parsing extracted data: ${parseError.message}`);
          return;
        }
        
        // Format the extracted data for display
        const embed = new EmbedBuilder()
          .setTitle(`Analysis Results: ${projectCode}`)
          .setDescription(`Analyzed ${messages.size} messages in <#${channel.id}>`)
          .setColor(dryRun ? 0xFFAA00 : 0x00AAFF)
          .setTimestamp();
        
        // Add fields for each piece of data
        Object.entries(extractedData).forEach(([key, value]) => {
          if (value && value !== '') {
            embed.addFields({ name: key, value: String(value).substring(0, 1024) });
          }
        });
        
        // Add footer based on dry run status
        if (dryRun) {
          embed.setFooter({ text: '⚠️ DRY RUN - No changes were made to Notion' });
        } else {
          // Convert extracted data to Notion properties
          const propertiesToUpdate = {};
          
          // Map extracted data to Notion properties
          if (extractedData.status) {
            propertiesToUpdate['Status'] = {
              select: { name: extractedData.status }
            };
          }
          
          if (extractedData.script_link) {
            propertiesToUpdate['Script'] = {
              url: extractedData.script_link
            };
          }
          
          if (extractedData.frame_io_link) {
            propertiesToUpdate['Frame.io'] = {
              url: extractedData.frame_io_link
            };
          }
          
          if (extractedData.editor) {
            propertiesToUpdate['Editor'] = {
              multi_select: extractedData.editor.split(',').map(name => ({ name: name.trim() }))
            };
          }
          
          if (extractedData.lead) {
            propertiesToUpdate['Lead'] = {
              people: extractedData.lead.split(',').map(name => ({ name: name.trim() }))
            };
          }
          
          if (extractedData.due_date) {
            propertiesToUpdate['Date'] = {
              date: { start: extractedData.due_date }
            };
          }
          
          // Update Notion if not a dry run
          try {
            await notion.pages.update({
              page_id: page.id,
              properties: propertiesToUpdate
            });
            
            embed.setFooter({ text: '✅ Notion updated successfully' });
            logToFile(`Notion updated for ${projectCode} with properties: ${Object.keys(propertiesToUpdate).join(', ')}`);
          } catch (notionError) {
            logToFile(`Notion update error: ${notionError.message}`);
            embed.setFooter({ text: `❌ Error updating Notion: ${notionError.message}` });
          }
        }
        
        // Send the response
        await interaction.editReply({ embeds: [embed] });
        
      } catch (error) {
        logToFile(`Error in /analyze command: ${error.message}`);
        if (hasResponded) {
          await interaction.editReply(`❌ Error analyzing messages: ${error.message}`);
        } else {
          await interaction.reply({ content: `❌ Error analyzing messages: ${error.message}`, ephemeral: true });
        }
      }
    }
    
    // Handle the /link command
    else if (commandName === 'link') {
      try {
        // Check if ephemeral flag is set
        const ephemeral = interaction.options.getBoolean('ephemeral') !== false; // Default to true
        
        await interaction.deferReply({ ephemeral });
        hasResponded = true;
        
        // Check if channel is linked to a project
        const channel = interaction.channel;
        if (!channel) {
          await interaction.editReply('❌ This command can only be used in a text channel.');
          return;
        }
        
        // Check if the channel name contains a project code (IB##, CL##, BC##)
        const channelName = channel.name.toLowerCase();
        const codeMatch = channelName.match(/(ib|cl|bc)\d{2}/i);
        
        if (!codeMatch) {
          await interaction.editReply('❌ This channel does not appear to be linked to a project. Channel name should contain a project code like IB23, CL45, etc.');
          return;
        }
        
        const projectCode = codeMatch[0].toUpperCase();
        
        // Find the project in Notion
        const project = await findProjectByQuery(projectCode);
        if (!project) {
          await interaction.editReply(`❌ Could not find project with code "${projectCode}" in Notion database.`);
          return;
        }
        
        // Get the Notion URL
        const notionUrl = getNotionPageUrl(project.page.id);
        if (!notionUrl) {
          await interaction.editReply(`❌ Could not generate Notion URL for project "${projectCode}".`);
          return;
        }
        
        // Create button
        const linkButton = new ButtonBuilder()
          .setLabel('Open in Notion')
          .setStyle(ButtonStyle.Link)
          .setURL(notionUrl);
          
        const row = new ActionRowBuilder().addComponents(linkButton);
        
        // Create embed
        const embed = new EmbedBuilder()
          .setTitle(`Project: ${projectCode}`)
          .setDescription(`Here's the Notion link for project **${projectCode}**:`)
          .setColor(0x0099FF)
          .addFields({ name: 'Notion Link', value: notionUrl })
          .setTimestamp();
        
        // Send response
        await interaction.editReply({
          embeds: [embed],
          components: [row]
        });
        
      } catch (error) {
        logToFile(`Error in /link command: ${error.message}`);
        if (hasResponded) {
          await interaction.editReply(`❌ Error finding Notion link: ${error.message}`);
        } else {
          await interaction.reply({ content: `❌ Error finding Notion link: ${error.message}`, ephemeral: true });
        }
      }
    }
    
    // Handle the /sync command
    else if (commandName === 'sync') {
      try {
        // Get command options
        const text = interaction.options.getString('text');
        const dryRun = interaction.options.getBoolean('dry_run') || false;
        
        await interaction.deferReply();
        hasResponded = true;
        
        // Check if channel is linked to a project
        const channel = interaction.channel;
        if (!channel) {
          await interaction.editReply('❌ This command can only be used in a text channel.');
          return;
        }
        
        // Check if the channel name contains a project code
        const channelName = channel.name.toLowerCase();
        const codeMatch = channelName.match(/(ib|cl|bc)\d{2}/i);
        
        if (!codeMatch) {
          await interaction.editReply('❌ This channel does not appear to be linked to a project. Channel name should contain a project code like IB23, CL45, etc.');
          return;
        }
        
        const projectCode = codeMatch[0].toUpperCase();
        
        // Find the project in Notion
        const project = await findProjectByQuery(projectCode);
        if (!project) {
          await interaction.editReply(`❌ Could not find project with code "${projectCode}" in Notion database.`);
          return;
        }
        
        // Parse the properties from text (simple key-value format)
        const properties = {};
        const propertyRegex = /(\w+)\s*[:=]\s*([^,]+)(?:,|$)/g;
        let match;
        
        while ((match = propertyRegex.exec(text)) !== null) {
          const key = match[1].trim();
          const value = match[2].trim();
          properties[key] = value;
        }
        
        if (Object.keys(properties).length === 0) {
          await interaction.editReply('❌ No valid properties found in the text. Use format "Property: Value, Another: Value"');
          return;
        }
        
        // Convert to Notion properties format
        const notionProperties = {};
        
        // Map to Notion properties
        Object.entries(properties).forEach(([key, value]) => {
          const propertyKey = key.charAt(0).toUpperCase() + key.slice(1);
          
          // Handle different property types
          if (propertyKey === 'Status') {
            notionProperties[propertyKey] = {
              select: { name: value }
            };
          } 
          else if (propertyKey === 'Script' || propertyKey === 'Frame.io') {
            // URL properties
            if (value.startsWith('http')) {
              notionProperties[propertyKey] = {
                url: value
              };
            }
          }
          else if (propertyKey === 'Date' || propertyKey === 'Due Date') {
            // Try to parse as date
            try {
              const date = new Date(value);
              if (!isNaN(date.getTime())) {
                notionProperties['Date'] = {
                  date: { start: date.toISOString().split('T')[0] }
                };
              }
            } catch (e) {
              // Not a valid date, ignore
            }
          }
          else if (propertyKey === 'Editor') {
            // Multi-select property
            notionProperties[propertyKey] = {
              multi_select: value.split(',').map(name => ({ name: name.trim() }))
            };
          }
          else if (propertyKey === 'Lead') {
            // People property
            notionProperties[propertyKey] = {
              people: value.split(',').map(name => ({ name: name.trim() }))
            };
          }
          // Add other property types as needed
        });
        
        // Create embed for display
        const embed = new EmbedBuilder()
          .setTitle(`Sync Results: ${projectCode}`)
          .setDescription(dryRun ? '⚠️ DRY RUN - Preview only, no changes made' : '✅ Notion updated successfully')
          .setColor(dryRun ? 0xFFAA00 : 0x00AAFF)
          .setTimestamp();
        
        // Add fields for each property
        Object.entries(properties).forEach(([key, value]) => {
          embed.addFields({ name: key, value: value.substring(0, 1024), inline: true });
        });
        
        // Update Notion if not a dry run
        if (!dryRun) {
          try {
            await notion.pages.update({
              page_id: project.page.id,
              properties: notionProperties
            });
            
            logToFile(`Notion updated for ${projectCode} with properties: ${Object.keys(notionProperties).join(', ')}`);
          } catch (notionError) {
            logToFile(`Notion update error: ${notionError.message}`);
            embed.setDescription(`❌ Error updating Notion: ${notionError.message}`);
          }
        }
        
        // Send response
        await interaction.editReply({ embeds: [embed] });
        
      } catch (error) {
        logToFile(`Error in /sync command: ${error.message}`);
        if (hasResponded) {
          await interaction.editReply(`❌ Error syncing with Notion: ${error.message}`);
        } else {
          await interaction.reply({ content: `❌ Error syncing with Notion: ${error.message}`, ephemeral: true });
        }
      }
    }
    
    // Handle the /help command
    else if (commandName === 'help') {
      try {
        // Create embed
        const embed = new EmbedBuilder()
          .setTitle('Insanity Discord Bot Help')
          .setDescription('Here are the available commands and how to use them:')
          .setColor(0x0099FF)
          .addFields(
            { name: '/where [query]', value: 'Find project info by code or name. Shows links, status, and people.' },
            { name: '/availability', value: 'See who is currently working and their remaining time.' },
            { name: '/link', value: 'Get the Notion link for the current channel\'s project.' },
            { name: '/analyze [messages]', value: 'Analyze recent messages to extract project info and update Notion.' },
            { name: '/sync [text]', value: 'Update Notion with properties from your text (format: "Status: Ready, Editor: Name").' },
            { name: '/schedule [task]', value: 'Schedule a task or reminder for the channel.' },
            { name: '/help', value: 'Show this help message.' }
          )
          .setFooter({ text: 'Use the ephemeral option on commands to make responses only visible to you' })
          .setTimestamp();
        
        await interaction.reply({ embeds: [embed], ephemeral: true });
        hasResponded = true;
        
      } catch (error) {
        logToFile(`Error in /help command: ${error.message}`);
        if (!hasResponded) {
          await interaction.reply({ content: `❌ Error displaying help: ${error.message}`, ephemeral: true });
        }
      }
    }
    
    // Handle the /schedule command
    else if (commandName === 'schedule') {
      try {
        await interaction.reply({ content: 'The scheduling feature is currently under development. Please check back soon!', ephemeral: true });
        hasResponded = true;
      } catch (error) {
        logToFile(`Error in /schedule command: ${error.message}`);
        if (!hasResponded) {
          await interaction.reply({ content: `❌ Error with schedule command: ${error.message}`, ephemeral: true });
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