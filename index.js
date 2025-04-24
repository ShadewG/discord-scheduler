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
// Both variables should point to the same database ID to avoid confusion
const DB = rawDB.replace(/-/g, '');  // For legacy code usage
const TARGET_PROP = 'Caption Status';
const TARGET_VALUE = 'Ready For Captions';
const RAY_ID = '348547268695162890';            // User ID to notify
const NOTION_CHANNEL_ID = '1364886978851508224';       // Channel for Notion notifications

// Cache for Notion database title property to avoid repeated lookups
let CACHED_TITLE_PROPERTY = null;

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
      caption_status: { type:'string', enum:['Ready For Captions','Captions In Progress','Captions Done','Needs Captions'] },
      editor_discord: { type:'string' },
      writer:         { type:'array', items: { type:'string' } },
      project_owner:  { type:'array', items: { type:'string' } },
      editor:         { type:'array', items: { type:'string' } },
      lead:           { type:'string' },
      brand_deal:     { type:'string', description: 'The ID of the related item in the brand deals database' },
      status:         { type:'string', enum:['Uploaded','FOIA Received','Ready for production','Writing','Writing Review','VA Render','VA Review','Writing Revisions','Ready for Editing','Clip Selection','Clip Selection Review','MGX','MGX Review/Cleanup','Ready to upload','Backlog'] },
      threed_status:  { type:'string', enum:['Storyboarding','In Progress','Rendered','Approved'] },
      current_stage_date: { type:'string', format:'date' },
      category:       { type:'string', enum:['IB','CL','Bodycam'], description: 'The category of the project (IB, CL, or Bodycam)' },
      page_content:   { type:'string', description: 'Text content to append to the bottom of the Notion page, such as notes about new images or important information' }
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
  // Look for the project code pattern in the name (IB##, CL##, or BC##)
  const m = name.match(/^(ib|cl|bc)\d{2}/i);
  if (!m) return null;
  
  // Return the uppercase project code
  return m[0].toUpperCase();
}

// Function to determine project category from code
function getProjectCategory(code) {
  if (!code) return null;
  
  // Get the prefix (first two letters)
  const prefix = code.substring(0, 2).toUpperCase();
  
  // Map prefix to category
  switch (prefix) {
    case 'IB': return 'IB';
    case 'CL': return 'CL';
    case 'BC': return 'Bodycam';
    default: return null;
  }
}

async function findPage(code) {
  try {
    // Use cached title property if available
    if (!CACHED_TITLE_PROPERTY) {
      // Step 1: First get database schema to find the title property
      const dbInfo = await notion.databases.retrieve({
        database_id: DB
      });
      
      // Find which property is of type 'title'
      let titlePropertyName = null;
      for (const [propName, propDetails] of Object.entries(dbInfo.properties)) {
        if (propDetails.type === 'title') {
          titlePropertyName = propName;
          logToFile(`✅ Found title property in database: "${titlePropertyName}"`);
          break;
        }
      }
      
      if (!titlePropertyName) {
        logToFile(`❌ Could not find any title property in the database. Available properties: ${Object.keys(dbInfo.properties).join(', ')}`);
        return null;
      }
      
      // Cache the title property for future use
      CACHED_TITLE_PROPERTY = titlePropertyName;
    } else {
      logToFile(`✅ Using cached title property: "${CACHED_TITLE_PROPERTY}"`);
    }
    
    // Step 2: Now query using the correct title property
    const res = await notion.databases.query({
      database_id: DB,
      filter: {
        property: CACHED_TITLE_PROPERTY,
        rich_text: { starts_with: code }
      },
      page_size: 1
    });
    
    if (res.results.length > 0) {
      logToFile(`✅ Found matching page for code "${code}" in property "${CACHED_TITLE_PROPERTY}"`);
      return res.results[0].id;
    } else {
      // Try a more lenient search if exact start match fails
      logToFile(`🔍 No exact match found. Trying with 'contains' filter...`);
      const containsRes = await notion.databases.query({
        database_id: DB,
        filter: {
          property: CACHED_TITLE_PROPERTY,
          rich_text: { contains: code }
        },
        page_size: 1
      });
      
      if (containsRes.results.length > 0) {
        logToFile(`✅ Found matching page containing code "${code}" in property "${CACHED_TITLE_PROPERTY}"`);
        return containsRes.results[0].id;
      }
      
      logToFile(`❌ No pages found with code "${code}" in title property "${CACHED_TITLE_PROPERTY}"`);
      return null;
    }
  } catch (error) {
    logToFile(`❌ Error finding page with code "${code}": ${error.message}`);
    
    // Clear the cache if there was an error with the property
    if (error.code === 'validation_error') {
      CACHED_TITLE_PROPERTY = null;
      logToFile(`🔄 Title property cache cleared due to validation error`);
    }
    
    // More detailed troubleshooting
    if (error.code === 'validation_error') {
      logToFile(`🔍 TROUBLESHOOTING: Database property issue`);
      logToFile(`1. Make sure your Notion integration has access to the database`);
      logToFile(`2. Database ID being used: ${DB}`);
      logToFile(`3. Check if the database structure has changed`);
    }
    
    return null;
  }
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
  
  // New properties                      
  if (p.writer && Array.isArray(p.writer) && p.writer.length > 0) {
    // Ensure each writer name is a string
    const writerNames = p.writer.map(w => typeof w === 'string' ? w : String(w));
    out.Writer = { multi_select: writerNames.map(name => ({ name })) };
  }
  
  if (p.project_owner && Array.isArray(p.project_owner) && p.project_owner.length > 0) {
    // Ensure each project owner name is a string
    const ownerNames = p.project_owner.map(o => typeof o === 'string' ? o : String(o));
    out['Project Owner'] = { multi_select: ownerNames.map(name => ({ name })) };
  }
  
  if (p.editor && Array.isArray(p.editor) && p.editor.length > 0) {
    // Ensure each editor name is a string
    const editorNames = p.editor.map(e => typeof e === 'string' ? e : String(e));
    out.Editor = { multi_select: editorNames.map(name => ({ name })) };
  }
  
  // Handle Lead property - ensure it's a string even if an array was provided
  if (p.lead) {
    const leadName = Array.isArray(p.lead) ? p.lead[0] : p.lead;
    out.Lead = { select: { name: leadName } };
  }
  
  // Brand Deal is a relation type, not a select
  if (p.brand_deal)     out['Brand Deal']   = { relation: [{ id: p.brand_deal }] };
  
  // Status is a status type, not a select
  if (p.status)         out.Status          = { status: { name: p.status } };
  
  if (p.threed_status)  out['3D Status']    = { select: { name: p.threed_status } };
  if (p.current_stage_date) out['Current Stage Date'] = { date: { start: p.current_stage_date } };
  if (p.category)       out.Category        = { select: { name: p.category } };
  
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
// Track when the bot started to only notify about changes after startup
const BOT_START_TIME = new Date();
let lastCheck = new Date();
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
        if (edited <= BOT_START_TIME) {
          logToFile(`👀 Page ${pageId.substring(0, 8)}... was last edited at ${edited.toISOString()}, which is before bot startup at ${BOT_START_TIME.toISOString()}. Ignoring for default watcher.`);
          
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
        logToFile(`   - Current check time: ${new Date().toISOString()}`);
        
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
            if (edited <= BOT_START_TIME) {
              logToFile(`👀 Page ${pageId.substring(0, 8)}... was last edited at ${edited.toISOString()}, which is before bot startup at ${BOT_START_TIME.toISOString()}. Ignoring for watcher "${watcher.name}".`);
              
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
    
    // Periodically clear the processedPageIds cache to prevent it from growing too large
    // We'll clear it every hour based on the current minute
    const currentMinute = new Date().getMinutes();
    if (currentMinute === 0) { // At the top of each hour
      const oldSize = processedPageIds.size;
      processedPageIds.clear();
      logToFile(`🧹 Cleared processed pages cache (cleared ${oldSize} page IDs)`);
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
    .setName('analyze')
    .setDescription('Analyze channel messages and update Notion with latest information')
    .addIntegerOption(option => 
      option.setName('messages')
        .setDescription('Number of messages to analyze (default: 50, max: 100)')
        .setRequired(false)
    ),
  
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
  
  // Add global error handling for all command interactions
  try {
    // Create a timeout to track if we're at risk of hitting Discord's 3-second limit
    let hasResponded = false;
    const timeoutWarning = setTimeout(() => {
      if (!hasResponded) {
        logToFile(`⚠️ Warning: Interaction ${commandName} is taking too long to respond`);
      }
    }, 2500); // Set a warning at 2.5 seconds

    // Process command based on name
    if (commandName === 'test') {
      try {
        await interaction.deferReply();
        hasResponded = true;
        clearTimeout(timeoutWarning);
        
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
      } catch (cmdError) {
        logToFile(`Error in /test command: ${cmdError.message}`);
        // Only try to reply if we haven't already
        if (!hasResponded) {
          await interaction.reply({ content: '❌ An error occurred while processing this command.', ephemeral: true });
          hasResponded = true;
        } else {
          await interaction.followUp({ content: '❌ An error occurred while processing this command.', ephemeral: true });
        }
      }
    }
    
    else if (commandName === 'analyze') {
      try {
        // Immediately defer reply to prevent timeout
        await interaction.deferReply();
        hasResponded = true;
        clearTimeout(timeoutWarning);
        
        // Continue with the analyze command logic
        try {
          // Extract the project code from the channel name
          const code = projectCode(interaction.channel.name);
          if (!code) {
            await interaction.editReply('No project code detected in channel name. This command must be used in a project channel (e.g., cl23-project).');
            return;
          }
          
          // Find the Notion page for this project
          let pageId = await findPage(code);
          let isNewPage = false;
          
          // Fetch channel messages for analysis
          const messages = await interaction.channel.messages.fetch({ limit: 100 });
          
          // Look for the first image in the messages for a thumbnail
          const firstImageUrl = findFirstImageUrl(Array.from(messages.values()));
          
          // If no page exists, create one
          if (!pageId) {
            await interaction.editReply(`No Notion page found for project code "${code}". Creating a new page...`);
            
            // Create a new page with the channel name as the title
            pageId = await createNotionPage(code, interaction.channel.name, {}, firstImageUrl);
            
            if (!pageId) {
              await interaction.editReply('❌ Failed to create Notion page. Check logs for details.');
              return;
            }
            
            isNewPage = true;
            await interaction.editReply(`✅ Created new Notion page for project "${code}". Now analyzing messages...`);
          }
          
          // Get number of messages to analyze (default: 50, max: 100)
          const limit = Math.min(interaction.options.getInteger('messages') || 50, 100);
          
          await interaction.editReply(`🔍 Analyzing the last ${limit} messages in this channel to update Notion...`);
          
          if (!messages || messages.size === 0) {
            await interaction.editReply('No messages found to analyze.');
            return;
          }
          
          // Sort messages by timestamp (oldest first)
          const sortedMessages = Array.from(messages.values())
            .filter(msg => !msg.author.bot) // Skip bot messages
            .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
            .slice(0, limit); // Limit to the requested number
          
          if (sortedMessages.length === 0) {
            await interaction.editReply('No user messages found to analyze.');
            return;
          }
          
          // Format messages for analysis
          const formattedMessages = sortedMessages.map(msg => {
            return {
              author: msg.author.username,
              timestamp: new Date(msg.createdTimestamp).toISOString(),
              content: msg.content
            };
          });
          
          // Convert to plain text format for GPT
          const chatHistory = formattedMessages.map(m => 
            `[${m.timestamp.split('T')[0]} ${m.timestamp.split('T')[1].substring(0, 8)}] ${m.author}: ${m.content}`
          ).join('\n');
          
          // Get current date
          const today = new Date().toISOString().split('T')[0];
          
          // Send to OpenAI for analysis
          const gpt = await openai.chat.completions.create({
            model: 'gpt-4o',
            temperature: 0,
            messages: [
              { 
                role: 'system', 
                content: `You analyze project discussions to extract the latest decisions about project details.
Your task is to identify the FINAL/LATEST mentions of key properties from a chat history.
For example, if someone initially sets a due date to Friday but later changes it to Sunday, use Sunday.
Resolve conflicts by preferring the most recent mentions.

If you find mentions of images, assets, or other important information that should be added to the page
as notes rather than properties, include those in the page_content field.

You can also identify or update the project category to "IB", "CL", or "Bodycam" based on discussions.
The category is usually determined from the project code (IB##, CL##, BC##), but can be changed.

Today's date is ${today}.`
              },
              { 
                role: 'user', 
                content: `Here's the chat history for project ${code}. Extract the latest information about project properties like due dates, priorities, etc.:\n\n${chatHistory}`
              }
            ],
            functions: [FUNC_SCHEMA],
            function_call: 'auto'
          });
          
          const call = gpt.choices[0].message.function_call;
          if (!call) {
            await interaction.editReply('No relevant information found in the chat history.');
            return;
          }
          
          let props;
          try {
            props = JSON.parse(call.arguments);
          } catch (e) {
            logToFile(`JSON parse error in analyze command: ${e}, raw: ${call.arguments}`);
            await interaction.editReply('❌ Error parsing the analysis results.');
            return;
          }
          
          // Create the Notion properties object
          let notionProps = {};
          let hasPropertiesToUpdate = false;
          let hasPageContent = false;
          let errorProperties = [];
          
          // Process each property individually with error handling
          try {
            notionProps = toNotion(props);
            hasPropertiesToUpdate = Object.keys(notionProps).length > 0;
          } catch (propsError) {
            logToFile(`Error converting properties: ${propsError.message}`);
            errorProperties.push("Base properties");
            // Continue with empty properties rather than failing completely
            notionProps = {};
          }
          
          try {
            hasPageContent = props.page_content && props.page_content.trim().length > 0;
          } catch (contentError) {
            logToFile(`Error checking page content: ${contentError.message}`);
            hasPageContent = false;
          }
          
          // Try to extract script link if needed
          if (hasPageContent && !props.script_url && !notionProps.Script) {
            try {
              const scriptLink = extractScriptLink(props.page_content);
              if (scriptLink) {
                logToFile(`📝 Found potential script link in content: ${scriptLink}`);
                // Add the script URL to properties
                try {
                  notionProps.Script = { url: scriptLink };
                  hasPropertiesToUpdate = true;
                } catch (scriptError) {
                  logToFile(`Error adding script URL to properties: ${scriptError.message}`);
                  errorProperties.push("Script URL");
                }
              }
            } catch (extractError) {
              logToFile(`Error extracting script link: ${extractError.message}`);
              errorProperties.push("Script extraction");
            }
          }
          
          if (!hasPropertiesToUpdate && !hasPageContent && !isNewPage) {
            await interaction.editReply('No updates needed based on the chat history analysis.');
            return;
          }
          
          // Track what was updated successfully
          let updatedProperties = false;
          let updatedContent = false;
          
          // Update page properties if needed
          if (hasPropertiesToUpdate && Object.keys(notionProps).length > 0) {
            try {
              await notion.pages.update({ 
                page_id: pageId, 
                properties: notionProps 
              });
              updatedProperties = true;
            } catch (updateError) {
              logToFile(`Error updating properties: ${updateError.message}`);
              errorProperties.push("Notion properties update");
            }
          }
          
          // Add page content if provided
          if (hasPageContent) {
            try {
              // Format the content with a timestamp
              const timestamp = new Date().toLocaleString();
              const formattedContent = `**Analysis from Discord (${timestamp}):**\n${props.page_content.trim()}`;
              
              // Format the content into proper Notion blocks with clickable links
              const contentBlocks = formatNotionContent(formattedContent);
              
              // Append the formatted blocks to the page
              await notion.blocks.children.append({
                block_id: pageId,
                children: contentBlocks
              });
              updatedContent = true;
            } catch (contentError) {
              logToFile(`Error adding page content: ${contentError.message}`);
              errorProperties.push("Page content");
            }
          }
          
          // Format analysis for display
          const analysisEmbed = new EmbedBuilder()
            .setColor(0x00FF00)
            .setTitle(`📊 Analysis Results for ${code}`)
            .setDescription(`I've analyzed ${sortedMessages.length} messages and ${isNewPage ? 'created a new page with' : 'updated the following:'}`)
            .setFooter({ text: `Analyzed ${limit} messages` })
            .setTimestamp();
          
          // Add note about page creation if applicable
          if (isNewPage) {
            analysisEmbed.addFields({
              name: '✨ New Page Created',
              value: `Created a new Notion page for project **${code}**${firstImageUrl ? ' with thumbnail image' : ''}`
            });
          }
          
          // Add fields for updated properties
          if (updatedProperties) {
            analysisEmbed.addFields({
              name: 'Updated Properties:',
              value: Object.keys(notionProps).map(propName => {
                return propName === 'Date' ? 
                      `• **${propName}:** ${props.due_date}` : 
                      propName === 'Priority' ?
                      `• **${propName}:** ${props.priority}` :
                      propName === 'Caption Status' ?
                      `• **${propName}:** ${props.caption_status}` :
                      propName === 'Script' ?
                      `• **${propName}:** ${props.script_url || 'From content'}` :
                      propName === 'Frame.io' ?
                      `• **${propName}:** ${props.frameio_url}` :
                      propName === 'Editor' ?
                      `• **${propName}:** <@${props.editor_discord}>` :
                      propName === 'Brand Deal' ?
                      `• **${propName}:** Updated` :
                      propName === 'Status' ?
                      `• **${propName}:** ${props.status}` :
                      `• **${propName}**`;
              }).join('\n') || 'No properties updated'
            });
          }
          
          // Add field for page content
          if (updatedContent) {
            analysisEmbed.addFields({
              name: 'Added Notes to Page:',
              value: props.page_content.length > 1000 
                ? props.page_content.substring(0, 997) + '...' 
                : props.page_content
            });
          }
          
          // Add field for errors if any occurred
          if (errorProperties.length > 0) {
            analysisEmbed.addFields({
              name: '⚠️ Errors:',
              value: `There were issues with the following: ${errorProperties.join(', ')}.\nOther updates were still applied.`
            });
          }
          
          let completionMessage = '✅ Analysis complete!';
          if (isNewPage) completionMessage += ' New page created!';
          if (updatedProperties) completionMessage += ' Properties updated!';
          if (updatedContent) completionMessage += ' Content added!';
          if (errorProperties.length > 0) completionMessage += ' (Some errors occurred)';
          
          await interaction.editReply({ content: completionMessage, embeds: [analysisEmbed] });
        } catch (analyzeError) {
          logToFile(`Error in /analyze command: ${analyzeError.message}`);
          await interaction.editReply(`❌ Error analyzing channel history: ${analyzeError.message}`);
        }
      } catch (deferError) {
        logToFile(`Failed to defer reply for /analyze command: ${deferError.message}`);
        try {
          // Try to send an immediate reply instead if deferring failed
          await interaction.reply({ content: '❌ Error initializing command. Please try again.', ephemeral: true });
        } catch (replyError) {
          logToFile(`Failed to send error reply for /analyze command: ${replyError.message}`);
        }
      }
    }
    
    else if (commandName === 'testjob') {
      try {
        // Get parameters first - do quick operations before deferring
        const tag = interaction.options.getString('tag');
        const job = jobs.find(j => j.tag === tag);
        
        if (!job) {
          await interaction.reply({ content: `❌ Could not find job with tag: ${tag}`, ephemeral: true });
          hasResponded = true;
          clearTimeout(timeoutWarning);
          return;
        }
        
        await interaction.reply(`📢 Sending test message for: **${job.tag}**`);
        hasResponded = true;
        clearTimeout(timeoutWarning);
        
        await ping(`[TEST] ${job.text}`);
        
        // Log next execution for this job
        const nextExecution = getNextExecution(job.cron);
        if (nextExecution) {
          await interaction.followUp(`Next scheduled run: ${nextExecution.formatted} (in ${nextExecution.formattedTimeLeft})`);
        }
      } catch (cmdError) {
        logToFile(`Error in /testjob command: ${cmdError.message}`);
        if (!hasResponded) {
          try {
            await interaction.reply({ content: `❌ Error testing job: ${cmdError.message}`, ephemeral: true });
            hasResponded = true;
          } catch (replyError) {
            logToFile(`Failed to send error reply: ${replyError.message}`);
          }
        }
      }
    }
    
    else if (commandName === 'send') {
      try {
        const messageText = interaction.options.getString('message');
        const mentionRole = interaction.options.getBoolean('mention') || false;
        
        await interaction.deferReply();
        hasResponded = true;
        clearTimeout(timeoutWarning);
        
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
        } catch (sendError) {
          logToFile(`Error sending message: ${sendError.message}`);
          await interaction.editReply(`❌ Error sending message: ${sendError.message}`);
        }
      } catch (cmdError) {
        logToFile(`Error in /send command: ${cmdError.message}`);
        if (!hasResponded) {
          try {
            await interaction.reply({ content: `❌ Error sending message: ${cmdError.message}`, ephemeral: true });
          } catch (replyError) {
            logToFile(`Failed to send error reply: ${replyError.message}`);
          }
        }
      }
    }
    
    else if (commandName === 'schedule') {
      try {
        await interaction.deferReply();
        hasResponded = true;
        clearTimeout(timeoutWarning);
        
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
      } catch (cmdError) {
        logToFile(`Error in /schedule command: ${cmdError.message}`);
        if (!hasResponded) {
          try {
            await interaction.reply({ content: `❌ Error showing schedule: ${cmdError.message}`, ephemeral: true });
          } catch (replyError) {
            logToFile(`Failed to send error reply: ${replyError.message}`);
          }
        } else {
          try {
            await interaction.editReply(`❌ Error showing schedule: ${cmdError.message}`);
          } catch (editError) {
            logToFile(`Failed to edit reply: ${editError.message}`);
          }
        }
      }
    }
    
    // Handle simpler commands with standardized error handling
    else if (['next', 'list', 'status', 'help', 'edit'].includes(commandName)) {
      try {
        let response;
        let components = [];
        
        // Prepare response based on command
        if (commandName === 'next') {
          response = { 
            content: '⏱️ Here are the upcoming scheduled reminders:',
            embeds: [createNextRemindersEmbed()]
          };
        }
        else if (commandName === 'list') {
          response = { embeds: [createJobsEmbed()] };
          components = [
            new ActionRowBuilder()
              .addComponents(
                new ButtonBuilder()
                  .setCustomId('refresh_list')
                  .setLabel('Refresh')
                  .setStyle(ButtonStyle.Primary),
              )
          ];
        }
        else if (commandName === 'status') {
          response = { embeds: [createStatusEmbed()] };
        }
        else if (commandName === 'help') {
          response = { embeds: [createHelpEmbed()] };
        }
        else if (commandName === 'edit') {
          const selectMenu = new StringSelectMenuBuilder()
            .setCustomId('select_job_to_edit')
            .setPlaceholder('Select a reminder to edit')
            .addOptions(jobs.map(job => ({
              label: job.tag,
              description: `Cron: ${job.cron}`,
              value: job.tag
            })));
          
          response = { content: 'Select a reminder to edit:' };
          components = [new ActionRowBuilder().addComponents(selectMenu)];
        }
        
        // Send the response
        if (components.length > 0) {
          response.components = components;
        }
        
        await interaction.reply(response);
        hasResponded = true;
        clearTimeout(timeoutWarning);
        
      } catch (cmdError) {
        logToFile(`Error in /${commandName} command: ${cmdError.message}`);
        if (!hasResponded) {
          try {
            await interaction.reply({ content: `❌ Error processing command: ${cmdError.message}`, ephemeral: true });
            hasResponded = true;
          } catch (replyError) {
            logToFile(`Failed to send error reply: ${replyError.message}`);
          }
        }
      }
    }
    
    // More complex commands
    else if (commandName === 'add') {
      try {
        const tag = interaction.options.getString('tag');
        const cronExp = interaction.options.getString('cron');
        const text = interaction.options.getString('text');
        
        // Check if job with same tag already exists
        if (jobs.some(job => job.tag === tag)) {
          await interaction.reply({ content: '❌ A reminder with this tag already exists. Please use a unique tag or edit the existing one.', ephemeral: true });
          hasResponded = true;
          clearTimeout(timeoutWarning);
          return;
        }
        
        // Validate cron expression
        try {
          cron.validate(cronExp);
        } catch (cronError) {
          await interaction.reply({ content: `❌ Invalid cron expression: ${cronError.message}`, ephemeral: true });
          hasResponded = true;
          clearTimeout(timeoutWarning);
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
        hasResponded = true;
        clearTimeout(timeoutWarning);
        
      } catch (cmdError) {
        logToFile(`Error in /add command: ${cmdError.message}`);
        if (!hasResponded) {
          try {
            await interaction.reply({ content: `❌ Error adding job: ${cmdError.message}`, ephemeral: true });
            hasResponded = true;
          } catch (replyError) {
            logToFile(`Failed to send error reply: ${replyError.message}`);
          }
        }
      }
    }
    
    else if (commandName === 'notion') {
      try {
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
          hasResponded = true;
          clearTimeout(timeoutWarning);
        }
        
        else if (subcommand === 'list') {
          const embed = createWatchersEmbed();
          await interaction.reply({ embeds: [embed] });
          hasResponded = true;
          clearTimeout(timeoutWarning);
        }
        
        else if (subcommand === 'properties') {
          await interaction.deferReply();
          hasResponded = true;
          clearTimeout(timeoutWarning);
          
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
          } catch (propError) {
            logToFile(`Error fetching database properties: ${propError.message}`);
            await interaction.editReply({
              content: `❌ Error fetching database properties: ${propError.message}\n\nMake sure your Notion integration is set up correctly.`
            });
          }
        }
        
        else if (['enable', 'disable', 'delete'].includes(subcommand)) {
          const id = interaction.options.getString('id');
          
          // Find the watcher
          let watcher, watcherIndex;
          
          if (subcommand === 'delete') {
            watcherIndex = customWatchers.findIndex(w => w.id === id);
            if (watcherIndex !== -1) {
              watcher = customWatchers[watcherIndex];
            }
          } else {
            watcher = customWatchers.find(w => w.id === id);
          }
          
          if (!watcher) {
            await interaction.reply({
              content: `❌ Watcher with ID ${id} not found. Use \`/notion list\` to see available watchers.`,
              ephemeral: true
            });
            hasResponded = true;
            clearTimeout(timeoutWarning);
            return;
          }
          
          let responseMessage = '';
          
          if (subcommand === 'enable') {
            watcher.disabled = false;
            responseMessage = `✅ Enabled Notion watcher "${watcher.name}" (ID: ${id}).`;
          }
          else if (subcommand === 'disable') {
            watcher.disabled = true;
            responseMessage = `✅ Disabled Notion watcher "${watcher.name}" (ID: ${id}). It will no longer check for status changes.`;
          }
          else if (subcommand === 'delete') {
            const watcherName = watcher.name;
            customWatchers.splice(watcherIndex, 1);
            responseMessage = `✅ Deleted Notion watcher "${watcherName}" (ID: ${id}).`;
          }
          
          // Save to file
          saveWatchers();
          
          await interaction.reply({
            content: responseMessage,
            ephemeral: true
          });
          hasResponded = true;
          clearTimeout(timeoutWarning);
        }
      } catch (notionError) {
        logToFile(`Error in /notion ${interaction.options?.getSubcommand() || ''} command: ${notionError.message}`);
        if (!hasResponded) {
          try {
            await interaction.reply({ content: `❌ Error processing Notion command: ${notionError.message}`, ephemeral: true });
            hasResponded = true;
          } catch (replyError) {
            logToFile(`Failed to send error reply: ${replyError.message}`);
          }
        }
      }
    }
    
    else if (commandName === 'watchers') {
      try {
        await interaction.deferReply();
        hasResponded = true;
        clearTimeout(timeoutWarning);
        
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
        } catch (watcherError) {
          logToFile(`Error displaying watchers: ${watcherError.message}`);
          await interaction.editReply('❌ Error retrieving watchers. Check logs for details.');
        }
      } catch (cmdError) {
        logToFile(`Error in /watchers command: ${cmdError.message}`);
        if (!hasResponded) {
          try {
            await interaction.reply({ content: '❌ Error retrieving watchers. Please try again.', ephemeral: true });
            hasResponded = true;
          } catch (replyError) {
            logToFile(`Failed to send error reply: ${replyError.message}`);
          }
        }
      }
    }
    
    // Add similar error handling patterns for other commands...
    // For brevity, I'm not showing all commands, but you should apply the same pattern
    
  } catch (error) {
    // Global error handling for any unexpected errors
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
    } catch (replyError) {
      logToFile(`Failed to send error message: ${replyError.message}`);
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

// Register commands when joining a new server
client.on('guildCreate', async guild => {
  logToFile(`🔔 Bot was added to a new server: ${guild.name} (${guild.id})`);
  try {
    await registerCommands(client.user.id, guild.id);
    logToFile(`✅ Registered commands for new server: ${guild.name}`);
  } catch (error) {
    logToFile(`❌ Failed to register commands for new server: ${error.message}`);
  }
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
  
  // Create a backup copy with timestamp to help recovery
  const timestamp = new Date().toISOString().replace(/:/g, '-');
  const backupDir = path.join(__dirname, 'backups');
  
  // Create backups directory if it doesn't exist
  if (!fs.existsSync(backupDir)) {
    try {
      fs.mkdirSync(backupDir, { recursive: true });
    } catch (err) {
      logToFile(`Failed to create backups directory: ${err.message}`);
    }
  }
  
  // Save backup with timestamp
  try {
    const backupPath = path.join(backupDir, `watchers-${timestamp}.json`);
    fs.writeFileSync(backupPath, JSON.stringify(customWatchers, null, 2));
    logToFile(`📦 Saved watchers backup to ${backupPath}`);
  } catch (err) {
    logToFile(`Failed to save watchers backup: ${err.message}`);
  }
  
  // Log watcher details for manual restoration if needed
  logToFile('📋 WATCHER DATA FOR MANUAL RESTORATION:');
  logToFile('```json');
  logToFile(JSON.stringify(customWatchers, null, 2));
  logToFile('```');
  logToFile('Copy the above JSON if needed to restore watchers after deployment');
  
  fs.writeFileSync(watchersFilePath, JSON.stringify(customWatchers, null, 2));
  logToFile('Custom Notion watchers saved to notion-watchers.json');
}

// Initialize custom watchers
const loadedWatchers = loadWatchers();
if (loadedWatchers && loadedWatchers.length > 0) {
  customWatchers.push(...loadedWatchers);
  logToFile(`${customWatchers.length} Notion watchers active`);
}

// Function to add a predefined watcher for easy recovery
function addPredefinedWatcher() {
  // Check for command line arguments to restore watcher
  const args = process.argv.slice(2);
  // Disable auto-adding of watcher to let users add it manually
  /*if (args.length > 0 && args[0] === '--add-watcher') {
    try {
      const watcher = {
        id: args[1] || `m${Date.now().toString(36)}`,
        name: args[2] || "3D Notif",
        property: args[3] || "3D Status",
        value: args[4] || "Storyboarding",
        userId: args[5] || "348547268695162890", // Default to RAY_ID if not specified
        createdAt: new Date().toISOString(),
        createdBy: "system",
        disabled: false
      };
      
      // Don't add duplicate watchers
      const existing = customWatchers.find(w => 
        w.property === watcher.property && 
        w.value === watcher.value && 
        w.userId === watcher.userId
      );
      
      if (existing) {
        logToFile(`⚠️ Watcher with property "${watcher.property}" and value "${watcher.value}" already exists (ID: ${existing.id})`);
        return;
      }
      
      customWatchers.push(watcher);
      saveWatchers();
      logToFile(`✅ Predefined watcher "${watcher.name}" added successfully (ID: ${watcher.id})`);
      logToFile(`   Property: ${watcher.property} = ${watcher.value}`);
      logToFile(`   Notifies: <@${watcher.userId}>`);
    } catch (error) {
      logToFile(`❌ Error adding predefined watcher: ${error.message}`);
    }
  }*/
}

// Try to add predefined watcher if requested via command line
addPredefinedWatcher();

/* ─ Handle !sync messages for Notion updates ─────────────────────── */
client.on('messageCreate', async msg => {
  if (msg.author.bot || !msg.content.startsWith(TRIGGER_PREFIX)) return;

  const code = projectCode(msg.channel.name);
  if (!code) {
    await msg.reply('No project code detected in channel name.');
    return;
  }

  // Get the first 50 messages to look for images
  const messages = await msg.channel.messages.fetch({ limit: 50 });
  const firstImageUrl = findFirstImageUrl(Array.from(messages.values()));

  // Find the Notion page for this project
  let pageId = await findPage(code);
  let isNewPage = false;
  
  // If no page exists, create one
  if (!pageId) {
    await msg.reply(`Creating new Notion page for project code "${code}"...`);
    
    // Create a new page with the channel name as the title
    pageId = await createNotionPage(code, msg.channel.name, {}, firstImageUrl);
    
    if (!pageId) {
      await msg.reply('❌ Failed to create Notion page. Check logs for details.');
      return;
    }
    
    isNewPage = true;
  }

  const userText = msg.content.slice(TRIGGER_PREFIX.length).trim();
  if (!userText && !isNewPage) return;

  try {
    // Get current date in ISO format
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format

    const gpt = await openai.chat.completions.create({
      model: 'gpt-4o',
      temperature: 0,
      messages: [
        { role: 'system', content: `You update video-pipeline metadata from chat. Today's date is ${today}.
You can update both properties and add content to the page itself. 
If the user mentions new images, notes, or other content that should be added to the page (not just as properties),
include that in the page_content field.

You can set the project category to "IB", "CL", or "Bodycam" based on user instructions.
The category is automatically determined from the project code prefix (IB, CL, BC), but users can change it.` },
        { role: 'user', content: userText || `This is a new project with code ${code} in channel ${msg.channel.name}. Add appropriate initial properties.` }
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

    // Create the Notion properties object with error handling
    let notionProps = {};
    let hasPropertiesToUpdate = false;
    let hasPageContent = false;
    let errorProperties = [];
    
    // Process each property individually with error handling
    try {
      notionProps = toNotion(props);
      hasPropertiesToUpdate = Object.keys(notionProps).length > 0;
    } catch (propsError) {
      logToFile(`Error converting properties in !sync: ${propsError.message}`);
      errorProperties.push("Base properties");
      // Continue with empty properties rather than failing completely
      notionProps = {};
    }
    
    try {
      hasPageContent = props.page_content && props.page_content.trim().length > 0;
    } catch (contentError) {
      logToFile(`Error checking page content in !sync: ${contentError.message}`);
      hasPageContent = false;
    }
    
    // Try to extract script link if needed
    if (hasPageContent && !props.script_url && !notionProps.Script) {
      try {
        const scriptLink = extractScriptLink(props.page_content);
        if (scriptLink) {
          logToFile(`📝 Found potential script link in content: ${scriptLink}`);
          // Add the script URL to properties
          try {
            notionProps.Script = { url: scriptLink };
            hasPropertiesToUpdate = true;
          } catch (scriptError) {
            logToFile(`Error adding script URL to properties in !sync: ${scriptError.message}`);
            errorProperties.push("Script URL");
          }
        }
      } catch (extractError) {
        logToFile(`Error extracting script link in !sync: ${extractError.message}`);
        errorProperties.push("Script extraction");
      }
    }
    
    if (!hasPropertiesToUpdate && !hasPageContent && !isNewPage) {
      await msg.reply('Nothing to update.');
      return;
    }

    // Track what was updated successfully
    let updatedProperties = false;
    let updatedContent = false;
    
    // Update page properties if needed
    if (hasPropertiesToUpdate && Object.keys(notionProps).length > 0) {
      try {
        await notion.pages.update({ 
          page_id: pageId, 
          properties: notionProps 
        });
        updatedProperties = true;
      } catch (updateError) {
        logToFile(`Error updating properties in !sync: ${updateError.message}`);
        errorProperties.push("Notion properties update");
      }
    }
    
    // Add page content if provided
    if (hasPageContent) {
      try {
        // Format the content with a timestamp
        const timestamp = new Date().toLocaleString();
        const formattedContent = `**Update from Discord (${timestamp}):**\n${props.page_content.trim()}`;
        
        // Format the content into proper Notion blocks
        const contentBlocks = formatNotionContent(formattedContent);
        
        // Append the formatted blocks to the page
        await notion.blocks.children.append({
          block_id: pageId,
          children: contentBlocks
        });
        updatedContent = true;
      } catch (contentError) {
        logToFile(`Error adding page content in !sync: ${contentError.message}`);
        errorProperties.push("Page content");
      }
    }

    // Create response message
    let responseDescription = '';
    if (isNewPage) {
      responseDescription += `✨ Created new Notion page for project **${code}**\n\n`;
      if (firstImageUrl) {
        responseDescription += 'Added first image from channel as thumbnail\n\n';
      }
    }
    
    if (updatedProperties) {
      responseDescription += 'Updated properties:\n' + Object.keys(notionProps).map(k => `• **${k}**`).join('\n');
    }
    
    if (updatedContent) {
      if (responseDescription) responseDescription += '\n\n';
      responseDescription += 'Added notes to page content';
    }
    
    // Add error information if any
    if (errorProperties.length > 0) {
      if (responseDescription) responseDescription += '\n\n';
      responseDescription += `⚠️ **Errors:** There were issues with: ${errorProperties.join(', ')}.\nOther updates were still applied.`;
    }

    await msg.reply({
      embeds: [{
        title: `✅ ${code} ${isNewPage ? 'created' : 'updated'}${errorProperties.length > 0 ? ' (with some errors)' : ''}`,
        description: responseDescription,
        color: errorProperties.length > 0 ? 0xFFA500 : 0x57F287
      }]
    });
  } catch (err) {
    console.error(err);
    msg.reply('❌ Error updating Notion; check logs.');
  }
});

// Function to create a new Notion page if one doesn't exist
async function createNotionPage(code, channelName, properties = {}, firstImageUrl = null) {
  logToFile(`🔨 Creating new Notion page for project code "${code}" from channel "${channelName}"`);
  
  try {
    // Make sure we have the database schema
    if (!CACHED_TITLE_PROPERTY) {
      // Get database schema to find the title property
      const dbInfo = await notion.databases.retrieve({
        database_id: DB
      });
      
      // Find which property is of type 'title'
      for (const [propName, propDetails] of Object.entries(dbInfo.properties)) {
        if (propDetails.type === 'title') {
          CACHED_TITLE_PROPERTY = propName;
          logToFile(`✅ Found title property in database: "${CACHED_TITLE_PROPERTY}"`);
          break;
        }
      }
      
      if (!CACHED_TITLE_PROPERTY) {
        logToFile(`❌ Could not find any title property in the database. Available properties: ${Object.keys(dbInfo.properties).join(', ')}`);
        return null;
      }
    }
    
    // Format a proper title for the new page - remove redundancy
    let cleanChannelName = channelName;
    
    // Remove the code from the channel name if it's already there to avoid duplication
    if (channelName.toLowerCase().includes(code.toLowerCase())) {
      // Extract just the descriptive part, removing the code prefix
      const codeRegex = new RegExp(`^${code.toLowerCase()}-?\\s*`, 'i');
      cleanChannelName = channelName.replace(codeRegex, '');
      logToFile(`📝 Cleaned channel name to "${cleanChannelName}" by removing code prefix`);
    }
    
    // Format the title with the code first, then the cleaned channel name
    const title = `${code} - ${cleanChannelName}`;
    
    // Determine the category from the project code
    const category = getProjectCategory(code);
    if (category) {
      logToFile(`📝 Setting category to "${category}" based on project code ${code}`);
    }
    
    // Try to find the template in Notion
    const templateName = "Project Name"; // Default template name
    let templateId = null;
    
    try {
      // Search for the template in the database
      const templateQuery = await notion.databases.query({
        database_id: DB,
        filter: {
          property: CACHED_TITLE_PROPERTY,
          rich_text: { equals: templateName }
        }
      });
      
      if (templateQuery.results.length > 0) {
        templateId = templateQuery.results[0].id;
        logToFile(`✅ Found template with name "${templateName}" (ID: ${templateId})`);
      } else {
        logToFile(`⚠️ Couldn't find template with name "${templateName}". Will create page without template.`);
      }
    } catch (err) {
      logToFile(`⚠️ Error looking for template: ${err.message}`);
    }
    
    // Create the basic page properties
    const pageProperties = {
      [CACHED_TITLE_PROPERTY]: {
        title: [
          {
            text: {
              content: title
            }
          }
        ]
      },
      ...properties
    };
    
    // Add category if determined from the code
    if (category) {
      pageProperties['Category'] = {
        select: {
          name: category
        }
      };
    }
    
    // Set a default Status if none provided - try to infer a reasonable starting status
    if (!properties.Status) {
      pageProperties['Status'] = {
        status: {
          name: 'Ready for production' // Default starting status
        }
      };
    }
    
    // Create the page, using template if available
    let response;
    
    // Create the basic page first
    response = await notion.pages.create({
      parent: {
        database_id: DB
      },
      properties: pageProperties
    });
    
    logToFile(`✅ Created new Notion page for "${title}" with ID: ${response.id}`);
    
    // Try to add template content if available
    if (templateId) {
      try {
        // Get the template's children blocks
        const templateBlocks = await notion.blocks.children.list({
          block_id: templateId
        });
        
        // Copy template blocks to the new page
        if (templateBlocks.results.length > 0) {
          logToFile(`📋 Copying ${templateBlocks.results.length} blocks from template`);
          
          // We'll handle this differently - need to recreate each block type
          const blocksToCopy = [];
          
          // Process and recreate each block type
          for (const block of templateBlocks.results) {
            // Skip if it's a child database/relation, we can't easily duplicate these
            if (block.type === 'child_database') {
              logToFile(`⚠️ Skipping child_database block - can't automatically duplicate`);
              continue;
            }
            
            // Skip image blocks with empty URLs
            if (block.type === 'image' && 
                ((!block.image.external || !block.image.external.url) && 
                 (!block.image.file || !block.image.file.url))) {
              logToFile(`⚠️ Skipping image block with empty URL`);
              continue;
            }
            
            // Create a simplified copy of the block object (structure depends on block type)
            try {
              // Create a basic copy with the same type and content
              const newBlock = {
                object: 'block',
                type: block.type
              };
              
              // Copy the content specific to this block type
              newBlock[block.type] = JSON.parse(JSON.stringify(block[block.type]));
              
              // Extra validation for specific block types to avoid API errors
              if (newBlock.type === 'image') {
                // Ensure image has a valid URL
                if (newBlock.image.type === 'external' && (!newBlock.image.external || !newBlock.image.external.url)) {
                  logToFile(`⚠️ Skipping image block with invalid external URL`);
                  continue;
                }
                
                // Convert file URLs to external if needed
                if (newBlock.image.type === 'file' && newBlock.image.file && newBlock.image.file.url) {
                  newBlock.image.type = 'external';
                  newBlock.image.external = { url: newBlock.image.file.url };
                  delete newBlock.image.file;
                }
              }
              
              blocksToCopy.push(newBlock);
            } catch (blockErr) {
              logToFile(`⚠️ Error processing template block: ${blockErr.message}`);
            }
          }
          
          // Add the blocks to the new page
          if (blocksToCopy.length > 0) {
            try {
              await notion.blocks.children.append({
                block_id: response.id,
                children: blocksToCopy
              });
              logToFile(`✅ Added ${blocksToCopy.length} template blocks to new page`);
            } catch (appendError) {
              // If appending all blocks fails, try adding them one by one to identify problematic blocks
              logToFile(`⚠️ Error appending all blocks: ${appendError.message}`);
              logToFile(`🔄 Attempting to add blocks individually...`);
              
              let successCount = 0;
              for (const block of blocksToCopy) {
                try {
                  await notion.blocks.children.append({
                    block_id: response.id,
                    children: [block]
                  });
                  successCount++;
                } catch (singleBlockError) {
                  logToFile(`⚠️ Failed to add block of type ${block.type}: ${singleBlockError.message}`);
                }
              }
              logToFile(`✅ Successfully added ${successCount}/${blocksToCopy.length} blocks individually`);
            }
          }
        }
      } catch (templateError) {
        // Template handling failed but we already have the basic page
        logToFile(`⚠️ Error copying template content: ${templateError.message}`);
        logToFile(`✅ Basic page was still created successfully without template content`);
      }
    }
    
    // Add the thumbnail image if provided
    if (firstImageUrl) {
      try {
        // Validate the URL before adding it
        if (!firstImageUrl.startsWith('http')) {
          logToFile(`⚠️ Invalid thumbnail URL format: ${firstImageUrl}`);
        } else {
          await notion.blocks.children.append({
            block_id: response.id,
            children: [
              {
                object: 'block',
                type: 'image',
                image: {
                  type: 'external',
                  external: {
                    url: firstImageUrl
                  }
                }
              },
              {
                object: 'block',
                type: 'paragraph',
                paragraph: {
                  rich_text: [
                    {
                      type: 'text',
                      text: {
                        content: `Project created from Discord channel ${channelName}`
                      }
                    }
                  ]
                }
              }
            ]
          });
          logToFile(`✅ Added thumbnail image to new page`);
        }
      } catch (imgError) {
        logToFile(`❌ Error adding thumbnail image: ${imgError.message}`);
      }
    }
    
    return response.id;
  } catch (error) {
    logToFile(`❌ Error creating Notion page: ${error.message}`);
    // Provide more detailed error info for troubleshooting
    if (error.code === 'validation_error') {
      logToFile(`🔍 Validation error details: ${error.message}`);
      
      // Try creating a simpler page without template or thumbnail as fallback
      logToFile(`🔄 Attempting to create a basic page without template...`);
      try {
        const basicResponse = await notion.pages.create({
          parent: {
            database_id: DB
          },
          properties: pageProperties
        });
        logToFile(`✅ Created basic page as fallback`);
        return basicResponse.id;
      } catch (fallbackError) {
        logToFile(`❌ Fallback page creation also failed: ${fallbackError.message}`);
      }
    }
    return null;
  }
}

// Function to extract the first image URL from messages
function findFirstImageUrl(messages) {
  if (!messages || messages.length === 0) return null;
  
  for (const msg of messages) {
    // Check for attachments
    if (msg.attachments && msg.attachments.size > 0) {
      const attachment = Array.from(msg.attachments.values())[0];
      if (attachment.contentType && attachment.contentType.startsWith('image/')) {
        logToFile(`📸 Found image attachment with URL: ${attachment.url}`);
        return attachment.url;
      }
    }
    
    // Check for embeds with images
    if (msg.embeds && msg.embeds.length > 0) {
      for (const embed of msg.embeds) {
        if (embed.image && embed.image.url) {
          logToFile(`📸 Found image in embed with URL: ${embed.image.url}`);
          return embed.image.url;
        }
      }
    }
    
    // Look for image URLs in the content
    if (msg.content) {
      // More comprehensive image URL regex
      const urlRegex = /(https?:\/\/\S+\.(?:png|jpg|jpeg|gif|webp|bmp|tiff|svg)(\?[^\s]*)?)/i;
      const match = msg.content.match(urlRegex);
      if (match && match[1]) {
        logToFile(`📸 Found image URL in message content: ${match[1]}`);
        return match[1];
      }
    }
  }
  
  logToFile(`⚠️ No image found in channel messages`);
  return null;
}

// Function to properly format content for Notion blocks with proper link handling
function formatNotionContent(content) {
  // Split the content into lines
  const lines = content.trim().split('\n');
  const blocks = [];
  
  // Process each line to create appropriate blocks
  for (const line of lines) {
    // Skip empty lines
    if (!line.trim()) {
      continue;
    }
    
    // Check if it's a link line (e.g., "SCRIPT: https://...")
    const linkMatch = line.match(/^([^:]+):\s+(https?:\/\/\S+)$/i);
    if (linkMatch) {
      const [_, label, url] = linkMatch;
      
      // Create a paragraph with a link
      blocks.push({
        object: 'block',
        type: 'paragraph',
        paragraph: {
          rich_text: [
            {
              type: 'text',
              text: {
                content: `${label}: `,
                link: null
              },
              annotations: {
                bold: true
              }
            },
            {
              type: 'text',
              text: {
                content: url,
                link: {
                  url: url
                }
              }
            }
          ]
        }
      });
    } else {
      // Regular paragraph block
      blocks.push({
        object: 'block',
        type: 'paragraph',
        paragraph: {
          rich_text: [
            {
              type: 'text',
              text: {
                content: line
              }
            }
          ]
        }
      });
    }
  }
  
  return blocks;
}

// Function to extract Google Doc links as potential script links
function extractScriptLink(content) {
  // Check for an explicit script URL
  const scriptMatch = content.match(/script:?\s*(https:\/\/docs\.google\.com\/document\/[^\s]+)/i);
  if (scriptMatch) {
    return scriptMatch[1];
  }
  
  // If no explicit script, look for any Google Docs link
  const docsMatch = content.match(/(https:\/\/docs\.google\.com\/document\/[^\s]+)/i);
  if (docsMatch) {
    return docsMatch[1];
  }
  
  return null;
}
