// index.js - Discord Scheduler Bot with time logging
// Load environment variables first, before any other requires
const path = require('path');
const dotenv = require('dotenv');

// Try to load from .env file
const result = dotenv.config({ path: path.resolve(__dirname, '.env') });
if (result.error) {
  console.warn('Warning: .env file not found or could not be parsed.');
  console.log('Using environment variables from system if available.');
}

const cron = require('node-cron');
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const fs = require('fs');
const { getTimeUntilNextExecution } = require('./utils');
const { OpenAI } = require('openai');

// ⬇⬇ Notion integration -----------------------------------------------------
// Normalize the database ID by removing any hyphens
const rawDB = process.env.NOTION_DB_ID || '';
const DB = rawDB.replace(/-/g, '');
const TARGET_PROP = 'Caption Status';
const TARGET_VALUE = 'Ready For Captions';
const RAY_ID = '669012345678901245';                     // User ID to notify
const NOTION_CHANNEL_ID = '1364886978851508224';       // Channel for Notion notifications

// Initialize Notion client
const { Client: Notion } = require('@notionhq/client');
const notion = new Notion({ auth: process.env.NOTION_TOKEN });

// Load environment variables
const {
  DISCORD_TOKEN,
  CHANNEL_ID,
  ROLE_ID,
  TZ = 'Europe/Berlin', // Set default if not defined
  NOTION_TOKEN,
  NOTION_DB_ID,
  OPENAI_API_KEY
} = process.env;

// Check for required environment variables
if (!DISCORD_TOKEN || !CHANNEL_ID || !ROLE_ID) {
  console.error('❌ Missing required environment variables in .env file:');
  if (!DISCORD_TOKEN) console.error('   - DISCORD_TOKEN');
  if (!CHANNEL_ID) console.error('   - CHANNEL_ID');
  if (!ROLE_ID) console.error('   - ROLE_ID');
  console.error('\nPlease check your .env file and try again.');
  process.exit(1);
}

// Initialize API clients
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// Constants for Notion/OpenAI integration
const DB_ID = NOTION_DB_ID;
const TRIGGER_PREFIX = '!sync';

// Function calling schema for OpenAI
const FUNC_SCHEMA = {
  name: 'update_properties',
  description: 'Return only properties that must change.',
  parameters: {
    type: 'object',
    properties: {
      script_url:     { type:'string', format:'uri' },
      frameio_url:    { type:'string', format:'uri' },
      due_date:       { type:'string', format:'date' },
      priority:       { type:'string', enum:['High','Medium','Low'] },
      caption_status: { type:'string', enum:['Ready For Captions','Needs Captions'] },
      editor_discord: { type:'string' }
    },
    additionalProperties: false
  }
};

// Discord-snowflake -> Notion-People-ID mapping
const USER_TO_NOTION = {
  '669012345678901245': 'fb1d2b3c-4567-8901-2345-6789abcdef01' // Ray
};

// Utility helpers for Notion integration
function projectCode(name) {
  const m = name.match(/^(cl|ib)\d{2}/i);   // extend prefixes if needed
  return m ? m[0].toUpperCase() : null;
}

async function findPage(code) {
  const res = await notion.databases.query({
    database_id: DB_ID,
    filter: { property:'Name', rich_text:{ starts_with: code } },
    page_size: 1
  });
  return res.results[0]?.id ?? null;
}

function toNotion(p) {
  const out = {};
  if (p.script_url)     out.Script          = { url: p.script_url };
  if (p.frameio_url)    out['Frame.io']     = { url: p.frameio_url };
  if (p.due_date)       out.Date            = { date:{ start:p.due_date } };
  if (p.priority)       out.Priority        = { select:{ name:p.priority } };
  if (p.caption_status) out['Caption Status']= { select:{ name:p.caption_status } };
  if (p.editor_discord && USER_TO_NOTION[p.editor_discord])
                        out.Editor          = { people:[{ id: USER_TO_NOTION[p.editor_discord] }] };
  return out;
}

// Initialize Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// Store active cron jobs for management
const activeJobs = new Map();

// Log directory and file
const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}
const logFile = path.join(logsDir, 'bot-activity.log');

// Helper function to write to log file
function logToFile(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}\n`;
  
  // Log to console
  console.log(message);
  
  // Append to log file
  fs.appendFileSync(logFile, logMessage);
}

/* ─ Helper : Send a ping with role mention ───────── */
async function ping(text) {
  try {
    const channel = await client.channels.fetch(CHANNEL_ID);
    
    // Check if the message already contains a role mention
    if (text.includes('@Editor') || text.includes(`<@&${ROLE_ID}>`)) {
      // Replace @Editor with the role mention if present
      await channel.send(text.replace('@Editor', `<@&${ROLE_ID}>`));
    } else {
      // Add role mention at the beginning if not present
      await channel.send(`<@&${ROLE_ID}> ${text}`);
    }
    
    logToFile(`📢 Sent message: ${text}`);
  } catch (error) {
    logToFile(`❌ Error sending message: ${error.message}`);
    logToFile(`Channel ID: ${CHANNEL_ID}, Role ID: ${ROLE_ID}`);
  }
}

/* ─ Helper : Send a message without role ping ───── */
async function sendMessage(text) {
  try {
    const channel = await client.channels.fetch(CHANNEL_ID);
    await channel.send(text);
    logToFile(`📢 Sent message: ${text}`);
  } catch (error) {
    logToFile(`❌ Error sending message: ${error.message}`);
    logToFile(`Channel ID: ${CHANNEL_ID}`);
  }
}

/* ─ Helper : Send a message to Notion channel ──── */
async function sendNotionMessage(text) {
  try {
    const channel = await client.channels.fetch(NOTION_CHANNEL_ID);
    await channel.send(text);
    logToFile(`📢 Sent Notion notification to channel ${NOTION_CHANNEL_ID}: ${text}`);
  } catch (error) {
    logToFile(`❌ Error sending Notion notification: ${error.message}`);
    logToFile(`Notion Channel ID: ${NOTION_CHANNEL_ID}`);
  }
}

/* ─ Poll Notion every minute ─────────────────────────────────────── */
// Use actual bot startup time instead of arbitrary past date
let lastCheck = new Date();  // Use current time when the bot starts
const processedPageIds = new Set();     // track pages we've already processed

async function pollNotion() {
  try {
    if (!process.env.NOTION_TOKEN) {
      logToFile('❌ Notion poll skipped: Missing NOTION_TOKEN');
      return;
    }
    
    if (!DB) {
      logToFile('❌ Notion poll skipped: Missing NOTION_DB_ID');
      return;
    }
    
    logToFile(`🔍 Polling Notion database (ID: ${DB.substring(0, 6)}...${DB.substring(DB.length - 4)}) for updates...`);
    
    let notificationCount = 0;
    
    // Track newly processed pages to avoid duplicate notifications
    const processedThisRun = new Set();
    
    // First, check the default Caption Status watcher
    try {
      const res = await notion.databases.query({
        database_id: DB,
        filter: {
          property: TARGET_PROP,
          select: { equals: TARGET_VALUE }
        },
        sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }]
      });

      logToFile(`✅ Checked default watcher (found ${res.results.length} matching results)`);

      for (const page of res.results) {
        const pageId = page.id;
        
        // Skip if we've already processed this page
        if (processedPageIds.has(pageId)) {
          logToFile(`👀 Page ${pageId.substring(0, 8)}... was already processed previously. Skipping.`);
          continue;
        }
        
        const edited = new Date(page.last_edited_time);
        
        // Skip pages that were edited before the bot started
        if (edited <= lastCheck) {
          logToFile(`👀 Page ${pageId.substring(0, 8)}... was last edited at ${edited.toISOString()}, which is before or at bot startup time (${lastCheck.toISOString()}). Ignoring pre-existing pages.`);
          
          // Still add to processed pages so we don't check it again
          processedPageIds.add(pageId);
          continue;
        }
        
        // Try different title property names
        let title = null;
        let titlePropertyName = null;
        
        // Check for various common title property names
        const possibleTitleProps = ["Project Name", "Name", "Title", "Page", "Project"];
        
        for (const propName of possibleTitleProps) {
          if (page.properties[propName]?.title?.length > 0) {
            title = page.properties[propName].title[0].plain_text;
            titlePropertyName = propName;
            break;
          }
        }
        
        // If no title found, list available properties and use default
        if (!title) {
          const availableProps = Object.keys(page.properties).join(', ');
          logToFile(`⚠️ Could not find title property. Available properties: ${availableProps}`);
          
          // Find any title property
          for (const [propName, prop] of Object.entries(page.properties)) {
            if (prop.type === 'title' && prop.title?.length > 0) {
              title = prop.title[0].plain_text;
              titlePropertyName = propName;
              logToFile(`✅ Found title in property "${propName}": "${title}"`);
              break;
            }
          }
          
          // If still no title, use default
          if (!title) {
            title = '(untitled project)';
          }
        }
        
        logToFile(`🔔 Found new Notion page with caption ready: "${title}" (using property: ${titlePropertyName || 'none'})`);
        logToFile(`   - Last edited: ${edited.toISOString()}`);
        logToFile(`   - Bot startup: ${lastCheck.toISOString()}`);
        
        // Add to processed pages so we don't notify again
        processedPageIds.add(pageId);
        processedThisRun.add(pageId);
        
        // Send to the dedicated Notion channel instead of regular channel
        await sendNotionMessage(
          `<@${RAY_ID}> Captions are ready for project **"${title}"**`
        );
        
        notificationCount++;
      }
    } catch (err) {
      logToFile(`❌ Default watcher error: ${err.message}`);
      
      // More detailed error logging
      if (err.code === 'object_not_found') {
        logToFile(`🔧 TROUBLESHOOTING: Make sure the database ID is correct and the integration has access to it.`);
        logToFile(`🔧 Raw database ID from env: "${rawDB}"`);
        logToFile(`🔧 Processed database ID: "${DB}"`);
        logToFile(`🔧 Steps to fix:`);
        logToFile(`   1. Verify the database ID in your .env file`);
        logToFile(`   2. Go to the database in Notion and share it with your integration`);
        logToFile(`   3. Make sure the "${TARGET_PROP}" property exists and is a Select type`);
      } else if (err.message.includes('undefined')) {
        // Log specific debug info for property errors
        logToFile(`🔧 PROPERTY ERROR: Check the title property name in your Notion database.`);
        logToFile(`🔧 The code will try these properties for title: ${["Project Name", "Name", "Title", "Page", "Project"].join(', ')}`);
      }
    }
    
    // Now check all custom watchers
    if (customWatchers && customWatchers.length > 0) {
      logToFile(`⏳ Processing ${customWatchers.length} custom Notion watchers...`);
      
      for (const watcher of customWatchers) {
        try {
          // Skip disabled watchers
          if (watcher.disabled) {
            logToFile(`⏭️ Skipping disabled watcher: "${watcher.name}"`);
            continue;
          }
          
          logToFile(`🔍 Checking watcher "${watcher.name}" (${watcher.property} = ${watcher.value})`);
          
          const res = await notion.databases.query({
            database_id: DB,
            filter: {
              property: watcher.property,
              select: { equals: watcher.value }
            },
            sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }]
          });
          
          logToFile(`✅ Watcher "${watcher.name}" found ${res.results.length} matching results`);
          
          for (const page of res.results) {
            const pageId = page.id;
            
            // Skip if we've already processed this page for this watcher
            const watcherPageKey = `${watcher.id}:${pageId}`;
            if (processedPageIds.has(watcherPageKey)) {
              logToFile(`👀 Page ${pageId.substring(0, 8)}... was already processed for watcher "${watcher.name}". Skipping.`);
              continue;
            }
            
            const edited = new Date(page.last_edited_time);
            
            // Skip pages that were edited before the bot started
            if (edited <= lastCheck) {
              logToFile(`👀 Page ${pageId.substring(0, 8)}... was last edited at ${edited.toISOString()}, which is before bot startup. Ignoring for watcher "${watcher.name}".`);
              
              // Still add to processed pages so we don't check it again
              processedPageIds.add(watcherPageKey);
              continue;
            }
            
            // Skip if we already processed this page in this run
            if (processedThisRun.has(pageId)) {
              logToFile(`👀 Page ${pageId.substring(0, 8)}... was already processed by another watcher in this run. Skipping duplicate notification.`);
              processedPageIds.add(watcherPageKey);
              continue;
            }
            
            // Get the title
            let title = null;
            for (const propName of ["Project Name", "Name", "Title", "Page", "Project"]) {
              if (page.properties[propName]?.title?.length > 0) {
                title = page.properties[propName].title[0].plain_text;
                break;
              }
            }
            
            // If no title found yet, check for any title property
            if (!title) {
              for (const [propName, prop] of Object.entries(page.properties)) {
                if (prop.type === 'title' && prop.title?.length > 0) {
                  title = prop.title[0].plain_text;
                  break;
                }
              }
              
              // If still no title, use default
              if (!title) {
                title = '(untitled project)';
              }
            }
            
            logToFile(`🔔 Custom watcher "${watcher.name}" found updated page: "${title}"`);
            logToFile(`   - Property: ${watcher.property} = ${watcher.value}`);
            logToFile(`   - User to notify: <@${watcher.userId}>`);
            
            // Add to processed pages so we don't notify again
            processedPageIds.add(watcherPageKey);
            processedThisRun.add(pageId);
            
            // Send to the dedicated Notion channel
            await sendNotionMessage(
              `<@${watcher.userId}> Project **"${title}"** is now marked as **"${watcher.value}"** (${watcher.name})`
            );
            
            notificationCount++;
          }
        } catch (err) {
          logToFile(`❌ Error in custom watcher "${watcher.name}": ${err.message}`);
          
          if (err.code === 'validation_error') {
            logToFile(`🔧 WATCHER ERROR: Property "${watcher.property}" may not exist or is not a Select type.`);
            logToFile(`🔧 Consider disabling or deleting this watcher if the property no longer exists.`);
          }
        }
      }
    }
    
    if (notificationCount > 0) {
      logToFile(`📊 Sent ${notificationCount} Notion notifications`);
    }
    
    // Only update lastCheck if we actually checked the database successfully
    lastCheck = new Date();
  } catch (err) {
    logToFile(`❌ Notion poll general error: ${err.message}`);
    logToFile(err.stack);
  }
}

// Save jobs to a file
function saveJobs() {
  const jobsFilePath = path.join(__dirname, 'jobs.json');
  fs.writeFileSync(jobsFilePath, JSON.stringify(jobs, null, 2));
  logToFile('Jobs saved to jobs.json');
}

// Load jobs from a file if it exists
function loadJobs() {
  const jobsFilePath = path.join(__dirname, 'jobs.json');
  if (fs.existsSync(jobsFilePath)) {
    try {
      const data = fs.readFileSync(jobsFilePath, 'utf8');
      const loadedJobs = JSON.parse(data);
      logToFile('Jobs loaded from jobs.json');
      return loadedJobs;
    } catch (error) {
      logToFile(`Error loading jobs file: ${error.message}`);
    }
  } else {
    logToFile('No jobs file found. Using default jobs.');
  }
  return null;
}

/* ─ Schedule definition ──────────────────────────
   Cron syntax is MINUTE HOUR DOM MON DOW
   DOW: 1-5  →  Monday‑Friday (1=Monday, 5=Friday)
   We add "tz" specifically set to Europe/Berlin so cron respects Berlin timezone even on DST flips */
let jobs = [
  // Morning schedule (Monday-Friday only)
  { cron: '50 8 * * 1-5', text: '☕ Heads-up @Editor — Fika starts in 10 min (09:00). Grab a coffee!', tag: 'fika-heads-up' },
  { cron: '20 9 * * 1-5', text: '🔨 @Editor Deep Work (AM) starts now — focus mode ON.', tag: 'deep-work-am' },
  { cron: '0 11 * * 1-5', text: '🍪 Break time @Editor — 20-min Fika Break starts now.', tag: 'fika-break' },
  { cron: '20 11 * * 1-5', text: '🔨 @Editor Deep Work resumes now — back at it.', tag: 'deep-work-resume' },
  
  // Afternoon schedule (Monday-Friday only)
  { cron: '0 13 * * 1-5', text: '🍽️ Lunch break @Editor — enjoy! Back in 45 min.', tag: 'lunch-break' },
  { cron: '35 13 * * 1-5', text: '📋 Reminder @Editor — Planning Huddle in 10 min (13:45).', tag: 'planning-heads-up' },
  { cron: '0 14 * * 1-5', text: '🔨 @Editor Deep Work (PM) starts now — last push of the day.', tag: 'deep-work-pm' },
  { cron: '50 16 * * 1-5', text: '✅ Heads-up @Editor — Wrap-Up Meeting in 10 min (17:00).', tag: 'wrap-up-heads-up' }
];

// Load saved jobs if available
const loadedJobs = loadJobs();
if (loadedJobs) {
  jobs = loadedJobs;
}

// Helper function to calculate time until next job execution
function getNextExecution(cronExpression) {
  return getTimeUntilNextExecution(cronExpression, TZ);
}

// Function to log next execution times for all jobs
function logNextExecutions() {
  logToFile('\n⏰ Next scheduled executions:');
  
  jobs.forEach(job => {
    const nextExecution = getNextExecution(job.cron);
    if (nextExecution) {
      logToFile(`   → ${job.tag}: Next run in ${nextExecution.formattedTimeLeft} (${nextExecution.formatted} ${TZ})`);
    } else {
      logToFile(`   → ${job.tag}: Could not calculate next execution time`);
    }
  });
}

// Function to schedule a job and add to activeJobs map
function scheduleJob(job) {
  // Cancel existing job if it exists
  if (activeJobs.has(job.tag)) {
    activeJobs.get(job.tag).stop();
    activeJobs.delete(job.tag);
  }
  
  // Ensure timezone is properly set
  const options = {
    timezone: TZ,
    scheduled: true
  };
  
  // Schedule the new job
  const scheduledJob = cron.schedule(job.cron, () => {
    // Log the execution with timestamp in Berlin time
    const berlinTime = new Date().toLocaleString('en-US', { timeZone: TZ });
    logToFile(`⏰ Executing job: ${job.tag} at ${berlinTime} (${TZ} time)`);
    
    // Send the message
    ping(job.text);
    
    // Log next executions after this job runs
    setTimeout(() => {
      logNextExecutions();
    }, 1000);
  }, options);
  
  activeJobs.set(job.tag, scheduledJob);
  logToFile(`Scheduled job: ${job.tag} (${job.cron} in ${TZ} timezone)`);
  
  // Get and log the next execution time
  const nextExecution = getNextExecution(job.cron);
  if (nextExecution) {
    logToFile(`   → Next execution: ${nextExecution.formatted} (in ${nextExecution.formattedTimeLeft})`);
  }
  
  return scheduledJob;
}

// Define slash commands
const commands = [
  new SlashCommandBuilder()
    .setName('watchers')
    .setDescription('List all Notion watchers in detail'),
  
  new SlashCommandBuilder()
    .setName('test')
    .setDescription('Send test messages for all scheduled reminders'),
  
  new SlashCommandBuilder()
    .setName('testjob')
    .setDescription('Test a specific reminder')
    .addStringOption(option => 
      option.setName('tag')
        .setDescription('The tag of the reminder to test')
        .setRequired(true)
        .addChoices(
          { name: 'Fika Heads-up (08:50)', value: 'fika-heads-up' },
          { name: 'Deep Work AM (09:20)', value: 'deep-work-am' },
          { name: 'Fika Break (11:00)', value: 'fika-break' },
          { name: 'Deep Work Resume (11:20)', value: 'deep-work-resume' },
          { name: 'Lunch Break (13:00)', value: 'lunch-break' },
          { name: 'Planning Heads-up (13:35)', value: 'planning-heads-up' },
          { name: 'Deep Work PM (14:00)', value: 'deep-work-pm' },
          { name: 'Wrap-up Heads-up (16:50)', value: 'wrap-up-heads-up' }
        )),
  
  new SlashCommandBuilder()
    .setName('send')
    .setDescription('Send a custom message to the channel')
    .addStringOption(option => 
      option.setName('message')
        .setDescription('The message you want to send')
        .setRequired(true))
    .addBooleanOption(option =>
      option.setName('mention')
        .setDescription('Whether to mention the role')
        .setRequired(false)),
        
  new SlashCommandBuilder()
    .setName('notion')
    .setDescription('Manage Notion status watchers')
    .addSubcommand(subcommand =>
      subcommand
        .setName('add')
        .setDescription('Add a new Notion status watcher')
        .addStringOption(option => 
          option.setName('name')
            .setDescription('A name for this watcher')
            .setRequired(true))
        .addStringOption(option => 
          option.setName('property')
            .setDescription('The Notion property to watch (e.g. "Status")')
            .setRequired(true))
        .addStringOption(option => 
          option.setName('value')
            .setDescription('The value to watch for (e.g. "In Progress")')
            .setRequired(true))
        .addUserOption(option => 
          option.setName('user')
            .setDescription('The user to notify when this status is found')
            .setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand
        .setName('list')
        .setDescription('List all Notion watchers'))
    .addSubcommand(subcommand =>
      subcommand
        .setName('enable')
        .setDescription('Enable a Notion watcher')
        .addStringOption(option => 
          option.setName('id')
            .setDescription('The ID of the watcher to enable')
            .setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand
        .setName('disable')
        .setDescription('Disable a Notion watcher')
        .addStringOption(option => 
          option.setName('id')
            .setDescription('The ID of the watcher to disable')
            .setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand
        .setName('delete')
        .setDescription('Delete a Notion watcher')
        .addStringOption(option => 
          option.setName('id')
            .setDescription('The ID of the watcher to delete')
            .setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand
        .setName('properties')
        .setDescription('List available properties in the Notion database')),
        
  new SlashCommandBuilder()
    .setName('list')
    .setDescription('List all scheduled reminders'),

  new SlashCommandBuilder()
    .setName('schedule')
    .setDescription('Show the complete schedule with countdown timers'),
  
  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Check the bot status and configuration'),

  new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show help information about the bot commands'),
    
  new SlashCommandBuilder()
    .setName('next')
    .setDescription('Show when the next reminders will run'),

  new SlashCommandBuilder()
    .setName('edit')
    .setDescription('Edit a scheduled reminder'),

  new SlashCommandBuilder()
    .setName('add')
    .setDescription('Add a new scheduled reminder')
    .addStringOption(option =>
      option.setName('tag')
        .setDescription('A unique ID for the reminder')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('cron')
        .setDescription('Cron schedule (e.g., "30 9 * * 1-5")')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('text')
        .setDescription('Message to send')
        .setRequired(true))
];

// Register slash commands when the bot is ready
async function registerCommands(clientId, guildId) {
  try {
    const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
    logToFile('Started refreshing application (/) commands.');

    const commandsData = commands.map(command => command.toJSON());
    
    // Find all guilds the bot is in if no specific guild is provided
    if (!guildId) {
      // Get the guilds the bot is in
      const guilds = client.guilds.cache;
      if (guilds.size > 0) {
        // Register commands for each guild (server)
        for (const guild of guilds.values()) {
          logToFile(`Registering commands for guild: ${guild.name} (${guild.id})`);
          await rest.put(
            Routes.applicationGuildCommands(clientId, guild.id),
            { body: commandsData }
          );
        }
      } else {
        // If not in any guild, register globally (takes up to an hour to propagate)
        await rest.put(Routes.applicationCommands(clientId), { body: commandsData });
      }
    } else {
      // Register for specific guild if provided
      await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commandsData });
    }

    logToFile('Successfully reloaded application (/) commands.');
  } catch (error) {
    logToFile(`Error registering commands: ${error.message}`);
  }
}

// Create an embed to display job information
function createJobsEmbed() {
  const embed = new EmbedBuilder()
    .setColor(0x0099FF)
    .setTitle('Discord Scheduler - Reminder List')
    .setDescription('Here are all the scheduled reminders:')
    .setTimestamp()
    .setFooter({ text: 'Timezone: ' + TZ });

  jobs.forEach(job => {
    const nextExecution = getNextExecution(job.cron);
    const nextExecutionText = nextExecution 
      ? `Next: ${nextExecution.formatted} (in ${nextExecution.formattedTimeLeft})`
      : 'Could not calculate next execution';
      
    embed.addFields({ 
      name: `${job.tag}`, 
      value: `⏰ Schedule: \`${job.cron}\`\n📝 Message: ${job.text}\n⏱️ ${nextExecutionText}`
    });
  });

  return embed;
}

// Create next reminders embed
function createNextRemindersEmbed() {
  const embed = new EmbedBuilder()
    .setColor(0xFF9900)
    .setTitle('Discord Scheduler - Next Reminders')
    .setDescription('Here are the upcoming reminders:')
    .setTimestamp()
    .setFooter({ text: 'Timezone: ' + TZ });

  // Calculate next execution for all jobs and sort by time
  const nextExecutions = jobs.map(job => {
    const nextExecution = getNextExecution(job.cron);
    return {
      job,
      next: nextExecution
    };
  })
  .filter(item => item.next) // Filter out any failed calculations
  .sort((a, b) => a.next.date.getTime() - b.next.date.getTime());
  
  // Add the next 5 jobs to the embed
  nextExecutions.slice(0, 5).forEach((item, index) => {
    embed.addFields({ 
      name: `${index + 1}. ${item.job.tag}`, 
      value: `⏰ Runs in: **${item.next.formattedTimeLeft}**\n🕒 At: ${item.next.formatted}\n📝 Message: ${item.job.text}`
    });
  });

  return embed;
}

// Create status embed with bot configuration
function createStatusEmbed() {
  const embed = new EmbedBuilder()
    .setColor(0x00FF99)
    .setTitle('Discord Scheduler - Status')
    .setDescription('Current bot configuration and status:')
    .addFields(
      { name: 'Bot Username', value: client.user.tag, inline: true },
      { name: 'Timezone', value: TZ || 'System default', inline: true },
      { name: 'Channel ID', value: CHANNEL_ID, inline: true },
      { name: 'Role ID', value: ROLE_ID, inline: true },
      { name: 'Active Jobs', value: activeJobs.size.toString(), inline: true },
      { name: 'Status', value: '✅ Online', inline: true }
    )
    .setTimestamp();

  return embed;
}

// Create help embed with command information
function createHelpEmbed() {
  const embed = new EmbedBuilder()
    .setColor(0xFFCC00)
    .setTitle('Discord Scheduler - Help')
    .setDescription('Here are the available commands:')
    .addFields(
      { name: '/test', value: 'Send test messages for all scheduled reminders' },
      { name: '/testjob', value: 'Test a specific scheduled reminder (select from dropdown)' },
      { name: '/send', value: 'Send a custom message to the channel (with optional role mention)' },
      { name: '/next', value: 'Show when the next reminders will run' },
      { name: '/schedule', value: 'Show the complete schedule with countdown timers in categories' },
      { name: '/list', value: 'List all scheduled reminders' },
      { name: '/status', value: 'Check the bot status and configuration' },
      { name: '/edit', value: 'Edit a scheduled reminder' },
      { name: '/add', value: 'Add a new scheduled reminder' },
      { name: '/notion', value: 'Manage Notion status watchers (add/list/enable/disable/delete/properties)' },
      { name: '/help', value: 'Show this help information' },
      { name: '/watchers', value: 'List all Notion watchers in detail' }
    )
    .setTimestamp();

  return embed;
}

// Create schedule embed with time-ordered reminders
function createScheduleEmbed() {
  const embed = new EmbedBuilder()
    .setColor(0x00AAFF)
    .setTitle('Discord Scheduler - Complete Schedule')
    .setDescription('Here\'s the full schedule with countdown timers:')
    .setTimestamp()
    .setFooter({ text: `Timezone: ${TZ} • Current time: ${new Date().toLocaleString('en-US', { timeZone: TZ })}` });

  // Get current weekday in Berlin time (0=Sunday, 6=Saturday)
  const tzNow = new Date(new Date().toLocaleString('en-US', { timeZone: TZ }));
  const berlinWeekday = tzNow.getDay();

  // Process jobs for special formatting
  const upcomingJobs = [];
  const weekdayJobs = [];
  const weekendJobs = [];
  
  jobs.forEach(job => {
    const nextExecution = getNextExecution(job.cron);
    if (!nextExecution) return;
    
    // Check if this is a weekday-only job (1-5)
    const isWeekdayOnly = job.cron.includes('1-5') || job.cron.includes('1,2,3,4,5');
    
    // Check if this is a weekend-only job (0,6)
    const isWeekendOnly = job.cron.includes('0,6') || job.cron.includes('6,0');
    
    // Add formatted job info to the appropriate list
    const jobInfo = {
      tag: job.tag,
      cronExpr: job.cron,
      text: job.text,
      next: nextExecution,
      timeUntil: nextExecution.formattedTimeLeft,
      formatted: nextExecution.formatted
    };
    
    // Add to upcoming if it's within the next 24 hours
    if (nextExecution.timeLeft.hours < 24) {
      upcomingJobs.push(jobInfo);
    }
    // Sort other jobs by weekday/weekend status
    else if (isWeekdayOnly) {
      weekdayJobs.push(jobInfo);
    } 
    else if (isWeekendOnly) {
      weekendJobs.push(jobInfo);
    }
    else {
      // Daily jobs that are not upcoming go to weekday or weekend based on current day
      if (berlinWeekday === 0 || berlinWeekday === 6) {
        weekendJobs.push(jobInfo);
      } else {
        weekdayJobs.push(jobInfo);
      }
    }
  });
  
  // Sort upcoming jobs by execution time
  upcomingJobs.sort((a, b) => a.next.date.getTime() - b.next.date.getTime());
  
  // Sort weekday and weekend jobs by time of day
  const sortByTimeOfDay = (a, b) => {
    const getMinutes = (cronExpr) => {
      const parts = cronExpr.split(' ');
      return parseInt(parts[0]) + parseInt(parts[1]) * 60;
    };
    return getMinutes(a.cronExpr) - getMinutes(b.cronExpr);
  };
  
  weekdayJobs.sort(sortByTimeOfDay);
  weekendJobs.sort(sortByTimeOfDay);
  
  // Add upcoming reminders section if there are any
  if (upcomingJobs.length > 0) {
    embed.addFields({ 
      name: '⏰ UPCOMING REMINDERS', 
      value: '━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
    });
    
    upcomingJobs.forEach((job, index) => {
      embed.addFields({ 
        name: `${index + 1}. ${job.tag}`, 
        value: `⏱️ In: **${job.timeUntil}**\n🕒 At: ${job.formatted}\n📝 Message: ${job.text}`
      });
    });
  }
  
  // Add weekday reminders section
  if (weekdayJobs.length > 0) {
    embed.addFields({ 
      name: '📅 WEEKDAY SCHEDULE (Mon-Fri)', 
      value: '━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
    });
    
    weekdayJobs.forEach((job) => {
      // Extract hour and minute from cron for readability
      const cronParts = job.cronExpr.split(' ');
      const hour = cronParts[1].padStart(2, '0');
      const minute = cronParts[0].padStart(2, '0');
      
      embed.addFields({ 
        name: `${hour}:${minute} — ${job.tag}`, 
        value: `⏱️ Runs: \`${job.cronExpr}\`\n📝 Message: ${job.text}`
      });
    });
  }
  
  // Add weekend reminders section
  if (weekendJobs.length > 0) {
    embed.addFields({ 
      name: '🏖️ WEEKEND SCHEDULE (Sat-Sun)', 
      value: '━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
    });
    
    weekendJobs.forEach((job) => {
      // Extract hour and minute from cron for readability
      const cronParts = job.cronExpr.split(' ');
      const hour = cronParts[1].padStart(2, '0');
      const minute = cronParts[0].padStart(2, '0');
      
      embed.addFields({ 
        name: `${hour}:${minute} — ${job.tag}`, 
        value: `⏱️ Runs: \`${job.cronExpr}\`\n📝 Message: ${job.text}`
      });
    });
  }
  
  return embed;
}

// Create a Notion watchers embed
function createWatchersEmbed() {
  const embed = new EmbedBuilder()
    .setColor(0x8A2BE2) // BlueViolet color
    .setTitle('Notion Status Watchers')
    .setDescription('These watchers will check for specific status changes in Notion and notify the designated user:')
    .setTimestamp()
    .setFooter({ text: 'Notion integration' });

  // Add default watcher
  embed.addFields({
    name: '🔍 Default Watcher',
    value: `Property: **${TARGET_PROP}**\nValue: **${TARGET_VALUE}**\nNotifies: <@${RAY_ID}>\nStatus: ✅ Always enabled`,
  });

  // Add custom watchers
  if (customWatchers.length === 0) {
    embed.addFields({
      name: '📝 Custom Watchers',
      value: 'No custom watchers configured yet. Use `/notion add` to create one.',
    });
  } else {
    embed.addFields({
      name: '📝 Custom Watchers',
      value: 'The following custom watchers are configured:',
    });

    customWatchers.forEach(watcher => {
      const status = watcher.disabled ? '❌ Disabled' : '✅ Enabled';
      embed.addFields({
        name: `${watcher.name} (ID: ${watcher.id})`,
        value: `Property: **${watcher.property}**\nValue: **${watcher.value}**\nNotifies: <@${watcher.userId}>\nStatus: ${status}`,
      });
    });
  }

  return embed;
}

// Handle slash command interactions
client.on('interactionCreate', async interaction => {
  if (!interaction.isCommand()) return;

  const { commandName } = interaction;

  if (commandName === 'test') {
    await interaction.deferReply();
    
    // Send a test message for each job
    let testMsg = '📢 Sending test messages for all reminders:\n\n';
    
    for (const job of jobs) {
      testMsg += `▸ Testing: ${job.tag}\n`;
    }
    
    await interaction.editReply(testMsg);
    
    // Send each message with a delay to avoid rate limits
    for (const job of jobs) {
      await new Promise(resolve => setTimeout(resolve, 1500));
      await ping(`[TEST] ${job.text}`);
    }
    
    await interaction.followUp('✅ All test messages sent!');
    
    // Log next executions after tests
    logNextExecutions();
  }
  
  else if (commandName === 'testjob') {
    const tag = interaction.options.getString('tag');
    const job = jobs.find(j => j.tag === tag);
    
    if (!job) {
      await interaction.reply({ content: `❌ Could not find job with tag: ${tag}`, ephemeral: true });
      return;
    }
    
    await interaction.reply(`📢 Sending test message for: **${job.tag}**`);
    await ping(`[TEST] ${job.text}`);
    
    // Log next execution for this job
    const nextExecution = getNextExecution(job.cron);
    if (nextExecution) {
      await interaction.followUp(`Next scheduled run: ${nextExecution.formatted} (in ${nextExecution.formattedTimeLeft})`);
    }
  }
  
  else if (commandName === 'send') {
    const messageText = interaction.options.getString('message');
    const mentionRole = interaction.options.getBoolean('mention') || false;
    
    await interaction.deferReply();
    
    try {
      // Send the message with or without role mention
      if (mentionRole) {
        await ping(messageText);
        await interaction.editReply(`✅ Message sent with @Editor role mention: "${messageText}"`);
      } else {
        await sendMessage(messageText);
        await interaction.editReply(`✅ Message sent: "${messageText}"`);
      }
      
      logToFile(`📢 Manual message sent by ${interaction.user.tag}: "${messageText}"`);
    } catch (error) {
      await interaction.editReply(`❌ Error sending message: ${error.message}`);
      logToFile(`Error sending manual message: ${error.message}`);
    }
  }
  
  else if (commandName === 'schedule') {
    await interaction.deferReply();
    
    const scheduleEmbed = createScheduleEmbed();
    
    const row = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('refresh_schedule')
          .setLabel('Refresh Timers')
          .setStyle(ButtonStyle.Primary),
      );
    
    await interaction.editReply({
      content: '📅 Here is the complete schedule with countdown timers:',
      embeds: [scheduleEmbed],
      components: [row]
    });
  }
  
  else if (commandName === 'next') {
    const nextRemindersEmbed = createNextRemindersEmbed();
    
    await interaction.reply({ 
      content: '⏱️ Here are the upcoming scheduled reminders:',
      embeds: [nextRemindersEmbed] 
    });
  }
  
  else if (commandName === 'list') {
    const jobsEmbed = createJobsEmbed();
    
    const row = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('refresh_list')
          .setLabel('Refresh')
          .setStyle(ButtonStyle.Primary),
      );
    
    await interaction.reply({ embeds: [jobsEmbed], components: [row] });
  }
  
  else if (commandName === 'status') {
    const statusEmbed = createStatusEmbed();
    await interaction.reply({ embeds: [statusEmbed] });
  }
  
  else if (commandName === 'help') {
    const helpEmbed = createHelpEmbed();
    await interaction.reply({ embeds: [helpEmbed] });
  }
  
  else if (commandName === 'edit') {
    // Create a select menu with all job tags as options
    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId('select_job_to_edit')
      .setPlaceholder('Select a reminder to edit')
      .addOptions(jobs.map(job => ({
        label: job.tag,
        description: `Cron: ${job.cron}`,
        value: job.tag
      })));
    
    const row = new ActionRowBuilder().addComponents(selectMenu);
    
    await interaction.reply({ 
      content: 'Select a reminder to edit:',
      components: [row]
    });
  }
  
  else if (commandName === 'add') {
    const tag = interaction.options.getString('tag');
    const cronExp = interaction.options.getString('cron');
    const text = interaction.options.getString('text');
    
    // Check if job with same tag already exists
    if (jobs.some(job => job.tag === tag)) {
      await interaction.reply({ content: '❌ A reminder with this tag already exists. Please use a unique tag or edit the existing one.', ephemeral: true });
      return;
    }
    
    // Validate cron expression
    try {
      cron.validate(cronExp);
    } catch (error) {
      await interaction.reply({ content: `❌ Invalid cron expression: ${error.message}`, ephemeral: true });
      return;
    }
    
    // Add the new job
    const newJob = { tag, cron: cronExp, text };
    jobs.push(newJob);
    
    // Schedule the job
    scheduleJob(newJob);
    
    // Save the updated jobs
    saveJobs();
    
    // Get next execution time
    const nextExecution = getNextExecution(cronExp);
    let executionInfo = '';
    if (nextExecution) {
      executionInfo = `\nNext run: ${nextExecution.formatted} (in ${nextExecution.formattedTimeLeft})`;
    }
    
    await interaction.reply(`✅ Added new reminder "${tag}" scheduled for \`${cronExp}\`${executionInfo}`);
  }
  
  else if (commandName === 'notion') {
    const subcommand = interaction.options.getSubcommand();
    
    if (subcommand === 'add') {
      const name = interaction.options.getString('name');
      const property = interaction.options.getString('property');
      const value = interaction.options.getString('value');
      const user = interaction.options.getUser('user');
      
      // Generate a unique ID
      const id = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
      
      // Create the new watcher
      const newWatcher = {
        id,
        name,
        property,
        value,
        userId: user.id,
        createdAt: new Date().toISOString(),
        createdBy: interaction.user.id,
        disabled: false
      };
      
      // Add to custom watchers
      customWatchers.push(newWatcher);
      
      // Save to file
      saveWatchers();
      
      await interaction.reply({
        content: `✅ Created new Notion watcher "${name}" (ID: ${id}):\n- Property: ${property}\n- Value: ${value}\n- Notifies: ${user}\n\nThis watcher is now active and will notify ${user} when a Notion page's "${property}" property is set to "${value}".`,
        ephemeral: true
      });
    }
    
    else if (subcommand === 'list') {
      const embed = createWatchersEmbed();
      await interaction.reply({ embeds: [embed] });
    }
    
    else if (subcommand === 'enable') {
      const id = interaction.options.getString('id');
      
      // Find the watcher
      const watcher = customWatchers.find(w => w.id === id);
      
      if (!watcher) {
        await interaction.reply({
          content: `❌ Watcher with ID ${id} not found. Use \`/notion list\` to see available watchers.`,
          ephemeral: true
        });
        return;
      }
      
      // Enable the watcher
      watcher.disabled = false;
      
      // Save to file
      saveWatchers();
      
      await interaction.reply({
        content: `✅ Enabled Notion watcher "${watcher.name}" (ID: ${id}).`,
        ephemeral: true
      });
    }
    
    else if (subcommand === 'disable') {
      const id = interaction.options.getString('id');
      
      // Find the watcher
      const watcher = customWatchers.find(w => w.id === id);
      
      if (!watcher) {
        await interaction.reply({
          content: `❌ Watcher with ID ${id} not found. Use \`/notion list\` to see available watchers.`,
          ephemeral: true
        });
        return;
      }
      
      // Disable the watcher
      watcher.disabled = true;
      
      // Save to file
      saveWatchers();
      
      await interaction.reply({
        content: `✅ Disabled Notion watcher "${watcher.name}" (ID: ${id}). It will no longer check for status changes.`,
        ephemeral: true
      });
    }
    
    else if (subcommand === 'delete') {
      const id = interaction.options.getString('id');
      
      // Find the watcher index
      const watcherIndex = customWatchers.findIndex(w => w.id === id);
      
      if (watcherIndex === -1) {
        await interaction.reply({
          content: `❌ Watcher with ID ${id} not found. Use \`/notion list\` to see available watchers.`,
          ephemeral: true
        });
        return;
      }
      
      // Get the watcher name before removing
      const watcherName = customWatchers[watcherIndex].name;
      
      // Remove the watcher
      customWatchers.splice(watcherIndex, 1);
      
      // Save to file
      saveWatchers();
      
      await interaction.reply({
        content: `✅ Deleted Notion watcher "${watcherName}" (ID: ${id}).`,
        ephemeral: true
      });
    }
    
    else if (subcommand === 'properties') {
      await interaction.deferReply();
      
      try {
        // Fetch database metadata to get properties
        const database = await notion.databases.retrieve({
          database_id: DB
        });
        
        const properties = database.properties;
        const propertyList = Object.entries(properties)
          .map(([name, prop]) => `- **${name}** (${prop.type})`)
          .join('\n');
        
        const embed = new EmbedBuilder()
          .setColor(0x8A2BE2)
          .setTitle('Notion Database Properties')
          .setDescription(`The following properties are available in the Notion database:\n\n${propertyList}\n\nYou can use any property of type **select** with the \`/notion add\` command.`)
          .setTimestamp();
        
        await interaction.editReply({ embeds: [embed] });
      } catch (error) {
        await interaction.editReply({
          content: `❌ Error fetching database properties: ${error.message}\n\nMake sure your Notion integration is set up correctly.`
        });
      }
    }
  }
  
  else if (commandName === 'watchers') {
    await interaction.deferReply();
    
    try {
      // Create a rich embed to display all watchers
      const embed = new EmbedBuilder()
        .setColor(0x0099FF)
        .setTitle('📋 All Notion Watchers')
        .setDescription('Here are all configured Notion watchers that notify users when properties change.')
        .setTimestamp();
      
      // Add field for default watcher
      embed.addFields({
        name: '🔍 Default Watcher',
        value: `**Property:** ${TARGET_PROP}\n**Value:** ${TARGET_VALUE}\n**Notifies:** <@${RAY_ID}>`
      });
      
      // Add fields for custom watchers
      if (customWatchers && customWatchers.length > 0) {
        customWatchers.forEach(watcher => {
          const status = watcher.disabled ? '🔴 Disabled' : '🟢 Active';
          embed.addFields({
            name: `${status} | ${watcher.name} (ID: ${watcher.id})`,
            value: `**Property:** ${watcher.property}\n**Value:** ${watcher.value}\n**Notifies:** <@${watcher.userId}>\n**Created:** ${new Date(watcher.createdAt).toLocaleDateString()}`
          });
        });
      } else {
        embed.addFields({
          name: 'Custom Watchers',
          value: '*No custom watchers configured*\nUse `/notion add` to create watchers.'
        });
      }
      
      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      logToFile(`Error in /watchers command: ${error.message}`);
      await interaction.editReply('❌ Error retrieving watchers. Check logs for details.');
    }
  }
});

// Handle select menu interactions
client.on('interactionCreate', async interaction => {
  if (!interaction.isStringSelectMenu()) return;
  
  if (interaction.customId === 'select_job_to_edit') {
    const selectedTag = interaction.values[0];
    const selectedJob = jobs.find(job => job.tag === selectedTag);
    
    if (!selectedJob) {
      await interaction.update({ content: '❌ Job not found. Please try again.', components: [] });
      return;
    }
    
    // Create a modal for editing the job
    const modal = new ModalBuilder()
      .setCustomId(`edit_job_${selectedTag}`)
      .setTitle(`Edit Reminder: ${selectedTag}`);
    
    // Add input components
    const cronInput = new TextInputBuilder()
      .setCustomId('cronInput')
      .setLabel('Cron Schedule')
      .setStyle(TextInputStyle.Short)
      .setValue(selectedJob.cron)
      .setPlaceholder('e.g., 30 9 * * 1-5')
      .setRequired(true);
    
    const textInput = new TextInputBuilder()
      .setCustomId('textInput')
      .setLabel('Message Text')
      .setStyle(TextInputStyle.Paragraph)
      .setValue(selectedJob.text)
      .setPlaceholder('The message to send at the scheduled time')
      .setRequired(true);
    
    // Add action rows
    const firstRow = new ActionRowBuilder().addComponents(cronInput);
    const secondRow = new ActionRowBuilder().addComponents(textInput);
    
    // Add inputs to the modal
    modal.addComponents(firstRow, secondRow);
    
    // Show the modal
    await interaction.showModal(modal);
  }
});

// Handle modal submissions
client.on('interactionCreate', async interaction => {
  if (!interaction.isModalSubmit()) return;
  
  if (interaction.customId.startsWith('edit_job_')) {
    const jobTag = interaction.customId.replace('edit_job_', '');
    const cronValue = interaction.fields.getTextInputValue('cronInput');
    const textValue = interaction.fields.getTextInputValue('textInput');
    
    // Validate cron expression
    try {
      cron.validate(cronValue);
    } catch (error) {
      await interaction.reply({ content: `❌ Invalid cron expression: ${error.message}`, ephemeral: true });
      return;
    }
    
    // Find and update the job
    const jobIndex = jobs.findIndex(job => job.tag === jobTag);
    if (jobIndex === -1) {
      await interaction.reply({ content: '❌ Job not found. Please try again.', ephemeral: true });
      return;
    }
    
    // Update the job
    jobs[jobIndex].cron = cronValue;
    jobs[jobIndex].text = textValue;
    
    // Reschedule the job
    scheduleJob(jobs[jobIndex]);
    
    // Save the updated jobs
    saveJobs();
    
    // Get next execution time
    const nextExecution = getNextExecution(cronValue);
    let executionInfo = '';
    if (nextExecution) {
      executionInfo = `\nNext run: ${nextExecution.formatted} (in ${nextExecution.formattedTimeLeft})`;
    }
    
    await interaction.reply(`✅ Updated reminder "${jobTag}" with new schedule: \`${cronValue}\`${executionInfo}`);
  }
});

// Handle button interactions
client.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;
  
  if (interaction.customId === 'refresh_list') {
    const jobsEmbed = createJobsEmbed();
    
    const row = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('refresh_list')
          .setLabel('Refresh')
          .setStyle(ButtonStyle.Primary),
      );
    
    await interaction.update({ embeds: [jobsEmbed], components: [row] });
  }
  
  else if (interaction.customId === 'refresh_schedule') {
    const scheduleEmbed = createScheduleEmbed();
    
    const row = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('refresh_schedule')
          .setLabel('Refresh Timers')
          .setStyle(ButtonStyle.Primary),
      );
    
    await interaction.update({ embeds: [scheduleEmbed], components: [row] });
  }
});

// Schedule regular execution time checks (every 15 minutes)
setInterval(() => {
  logNextExecutions();
}, 15 * 60 * 1000);

// Handle errors and keep bot running
process.on('uncaughtException', (error) => {
  logToFile(`Uncaught Exception: ${error.message}`);
  logToFile(error.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  logToFile(`Unhandled Rejection at: ${promise}`);
  logToFile(`Reason: ${reason}`);
});

/* ─ Activate jobs on ready ─────────────────────── */
client.once('ready', async () => {
  logToFile(`\n✅  Discord Scheduler Bot is now online as ${client.user.tag}`);
  logToFile(`📆  Timezone set to: ${TZ || 'Not set (using system default)'}`);
  logToFile(`📌  Pinging role ID: ${ROLE_ID}`);
  logToFile(`💬  Sending to channel ID: ${CHANNEL_ID}`);
  logToFile(`💬  Notion notifications channel: ${NOTION_CHANNEL_ID}`);
  logToFile('\n⏰  Scheduled jobs:');

  // Schedule all jobs
  jobs.forEach(job => {
    scheduleJob(job);
  });
  
  // Schedule Notion poller
  cron.schedule('* * * * *', pollNotion, { timezone: TZ });
  logToFile('🔍 Notion poller scheduled every 1 min');
  
  // Register slash commands
  await registerCommands(client.user.id);
  
  logToFile('\n🔄  Bot is running! Press Ctrl+C to stop.');
  
  // Log the next execution times for all jobs
  logNextExecutions();
});

// Connect to Discord
client.login(DISCORD_TOKEN);

// Custom Notion watchers - will be loaded from file
const customWatchers = [];

// Load custom watchers from a file if it exists
function loadWatchers() {
  const watchersFilePath = path.join(__dirname, 'notion-watchers.json');
  if (fs.existsSync(watchersFilePath)) {
    try {
      const data = fs.readFileSync(watchersFilePath, 'utf8');
      const loadedWatchers = JSON.parse(data);
      logToFile(`Loaded ${loadedWatchers.length} existing Notion watchers from file`);
      return loadedWatchers;
    } catch (error) {
      logToFile(`Error loading watchers file: ${error.message}`);
    }
  } else {
    logToFile('No notion-watchers.json file found. Using default watcher only.');
  }
  return [];
}

// Save custom watchers to a file
function saveWatchers() {
  const watchersFilePath = path.join(__dirname, 'notion-watchers.json');
  // Only save if there are watchers to save
  if (customWatchers.length === 0) {
    logToFile('No custom watchers to save');
    return;
  }
  
  // Check if the file already exists and has the same content to avoid unnecessary writes
  if (fs.existsSync(watchersFilePath)) {
    try {
      const existingData = fs.readFileSync(watchersFilePath, 'utf8');
      const existingWatchers = JSON.parse(existingData);
      
      // Compare if watchers are identical (simple length check first)
      if (existingWatchers.length === customWatchers.length &&
          JSON.stringify(existingWatchers.sort((a, b) => a.id.localeCompare(b.id))) === 
          JSON.stringify(customWatchers.sort((a, b) => a.id.localeCompare(b.id)))) {
        logToFile('Watchers unchanged - skipping write to notion-watchers.json');
        return;
      }
    } catch (error) {
      // If reading existing file fails, proceed with saving
      logToFile(`Error reading existing watchers file: ${error.message}`);
    }
  }
  
  fs.writeFileSync(watchersFilePath, JSON.stringify(customWatchers, null, 2));
  logToFile('Custom Notion watchers saved to notion-watchers.json');
}

// Initialize custom watchers
const loadedWatchers = loadWatchers();
if (loadedWatchers && loadedWatchers.length > 0) {
  customWatchers.push(...loadedWatchers);
  logToFile(`${customWatchers.length} Notion watchers active`);
}

/* ─ Handle !sync messages for Notion updates ─────────────────────── */
client.on('messageCreate', async msg => {
  if (msg.author.bot || !msg.content.startsWith(TRIGGER_PREFIX)) return;

  const code = projectCode(msg.channel.name);
  if (!code) {
    await msg.reply('No project code detected in channel name.');
    return;
  }

  const pageId = await findPage(code);
  if (!pageId) {
    await msg.reply(`No Notion page starting with "${code}".`);
    return;
  }

  const userText = msg.content.slice(TRIGGER_PREFIX.length).trim();
  if (!userText) return;

  try {
    const gpt = await openai.chat.completions.create({
      model: 'gpt-4o',
      temperature: 0,
      messages: [
        { role: 'system', content: 'You update video-pipeline metadata from chat.' },
        { role: 'user', content: userText }
      ],
      functions: [FUNC_SCHEMA],
      function_call: 'auto'
    });

    const call = gpt.choices[0].message.function_call;
    if (!call) {
      await msg.reply('No relevant properties found.');
      return;
    }

    let props;
    try {
      props = JSON.parse(call.arguments);
    } catch (e) {
      console.error('JSON parse error', e, call.arguments);
      await msg.reply('❌ Error parsing GPT response.');
      return;
    }

    const notionProps = toNotion(props);
    if (Object.keys(notionProps).length === 0) {
      await msg.reply('Nothing to update.');
      return;
    }

    await notion.pages.update({ page_id: pageId, properties: notionProps });

    await msg.reply({
      embeds: [{
        title: `✅ ${code} updated`,
        description: Object.keys(notionProps).map(k => `• **${k}**`).join('\n'),
        color: 0x57F287
      }]
    });
  } catch (err) {
    console.error(err);
    msg.reply('❌ Error updating Notion; check logs.');
  }
});
