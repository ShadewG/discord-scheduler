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
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ChannelType } = require('discord.js');
const fs = require('fs');
const { getTimeUntilNextExecution } = require('./utils');
const { OpenAI } = require('openai');

// Add this line to require the availability module
const { STAFF_AVAILABILITY, isStaffActive, getTimeLeftInShift, getCurrentBerlinTime, createTimeProgressBar } = require('./availability');

// ⬇⬇ Notion integration -----------------------------------------------------
// Normalize the database ID by removing any hyphens
const rawDB = process.env.NOTION_DB_ID || '';
// Both variables should point to the same database ID to avoid confusion
const DB = rawDB.replace(/-/g, '');  // For legacy code usage
const TARGET_PROP = 'Caption Status';
const TARGET_VALUE = 'Ready For Captions';
const RAY_ID = '348547268695162890';            // User ID to notify
const NOTION_CHANNEL_ID = '1364886978851508224';       // Channel for Notion notifications

// Use actual bot startup time instead of arbitrary past date
// Track when the bot started to only notify about changes after startup
const BOT_START_TIME = new Date();
let lastCheck = new Date();

// Add path for storing processed notifications
const processedNotificationsPath = path.join(__dirname, 'processed-notifications.json');

// Cache for Notion database title property to avoid repeated lookups
let CACHED_TITLE_PROPERTY = null;
// Cache for available status options
let CACHED_STATUS_OPTIONS = null;
let CACHED_SELECT_OPTIONS = {};

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

// Initialize API clients - make OpenAI optional
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

// Constants for Notion/OpenAI integration
const TRIGGER_PREFIX = '!sync';

// System prompt for analysis
const ANALYSIS_SYSTEM_PROMPT = `
You are an assistant that **reads the last N Discord messages for a single
video-project channel** and produces *only the final state* of each project
property so we can patch a Notion row.

IMPORTANT: Be EXTREMELY careful with property names and status options. 
The database has specific property names and status values - if you use the 
wrong names or values, the API will return errors!

─────────────────
## Output contract
Return **ONE** of the following:

1. **No function call**  
   when nothing in the messages changes project data.

2. A function call to \`update_properties\` where \`arguments\` is a JSON
   object that MAY contain any of the keys below **exactly as written**.
   Omit keys you cannot improve.  
   Do **NOT** invent keys or nested objects.

\`\`\`jsonc
{
  // ─────────── strings / urls ───────────
  "script_url":   "https://docs.google.com/document/d/…",
  "frameio_url":  "https://app.frame.io/…",
  "due_date":     "2025-04-15",          // ISO-8601 date
  "editor_discord":"348547268695162890", // snowflake as string
  "lead":          "Ray",
  "brand_deal":    "MySponsor2025",
  "current_stage_date":"2025-04-15",     // when next stage change is planned

  // ─────────── arrays of names ──────────
  "writer":       ["Anna","Michael"],
  "project_owner":"Sam",                // project owner is a SINGLE string (not array)
  "editor":       ["Ray","Jamie"],

  // ─────────── enums (use EXACT values) ─
  "priority":        "High",             // High | Medium | Low
  "caption_status":  "Ready For Captions",
  "status":          "Writing Review",
  "threed_status":   "Storyboarding",
  "category":        "CL",               // IB | CL | Bodycam

  // ─────────── rich notes block ─────────
  "page_content": "Bullet list of actionable decisions…"
}
\`\`\`

### How to decide what goes where
* **Latest wins:** if the same field is mentioned multiple times, keep the most
  recent value.
* **URLs**  
  * \`google docs\`, \`notion(.)site\`, or anything obviously a script ⇒
    \`script_url\`.  
  * \`frame.io\` or \`f.io\` ⇒ \`frameio_url\`.
* **Dates**  
  * Accept natural language ("this Friday", "12 Apr") and convert to YYYY-MM-DD
    **in the Berlin timezone** (${TZ}).
* **Names → arrays**  
  * If more than one writer/owner/editor is mentioned, accumulate them into the
    respective array (deduplicate, preserve order of first appearance).
* **Enum fuzziness**  
  * Map close variants to the valid enum:  
    "on hold" → \`"Pause"\`, "prio high" → \`"High"\`, etc.
* **page_content**  
  Include **only** actionable plans, creative decisions, concrete next steps,
  or deadlines **not already expressed by a property**.  
  Strip greetings, chatter, generic docs/guides links, and any link you already
  placed into \`script_url\` or \`frameio_url\`.

### Property extraction rules
* If the message names the current stage
  * "clip selection", "VA render", "writing review", etc.
  → set **status** to the closest allowed enum value.
  (Allowed: Uploaded · FOIA Received · Ready for production · Writing ·
   Writing Review · VA Render · VA Review · Writing Revisions · Ready for Editing ·
   Clip Selection · Clip Selection Review · MGX · MGX Review/Cleanup · Ready to upload ·
   Backlog · On Hold)

* If the message says someone "will handle", "is in charge of", "will edit",
  "will cut", etc.:
  * treat that name as **project_owner** when the task is managerial
    (Suki handles script changes → "project_owner": ["Suki"])
  * treat that name as **editor** when the task is editing
    (Hayes will cut clips → "editor": ["Hayes"])
  * treat that name as **writer** for writing tasks.

* Always convert stage names to the exact enum:
  - "va render"  → "VA Render"
  - "writing review" → "Writing Review" 
  - "on pause / hold" → "On Hold"

* If multiple owners/editors/writers are mentioned, return them as arrays,
  preserving first-mention order. Except for project_owner which should be a single name.

* **Stage date and deadlines**:
  - If messages mention a target date for stage completion like "aiming to finish writing by Friday" 
    or "VA render will be done by tomorrow", set **current_stage_date** to that date.
  - When updating the **status** field, also check if there's a target completion date
    and update **current_stage_date** accordingly.

* **URLs and latest references**:
  - For Frame.io links, always use the MOST RECENT link mentioned.
  - If messages say "new Frame.io link: https://f.io/abc" followed later by
    "updated Frame.io: https://f.io/xyz", use ONLY the latter.
  - This applies to all URLs - the latest mention always overrides earlier ones.

* Reminder: DO NOT invent keys; omit anything you are not certain about.

### Today's date
Today is \${new Date().toISOString().split('T')[0]}.
Remember this when interpreting relative dates like "next Monday".

Return nothing else.`;

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
      project_owner:  { type:'string' },
      editor:         { type:'array', items: { type:'string' } },
      lead:           { type:'string' },
      brand_deal:     { type:'string', description: 'The ID of the related item in the brand deals database' },
      status:         { type:'string', enum:['Uploaded','FOIA Received','Ready for production','Writing','Writing Review','VA Render','VA Review','Writing Revisions','Ready for Editing','Clip Selection','Clip Selection Review','MGX','MGX Review/Cleanup','Ready to upload','Backlog','On Hold'] },
      threed_status:  { type:'string', enum:['Storyboarding','In Progress','Rendered','Approved'] },
      current_stage_date: { type:'string', format:'date' },
      category:       { type:'string', enum:['IB','CL','Bodycam'], description: 'The category of the project (IB, CL, or Bodycam)' },
      discord_channel: { type:'string', description: 'Channel ID where project is discussed' },
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

// Function to find the closest matching option
function findClosestOption(value, options) {
  if (!value || !options || options.length === 0) return null;
  
  // Direct match
  const directMatch = options.find(opt => 
    opt.toLowerCase() === value.toLowerCase()
  );
  if (directMatch) return directMatch;
  
  // Contains match (e.g., "hold" matches "On Hold")
  const containsMatch = options.find(opt => 
    opt.toLowerCase().includes(value.toLowerCase()) || 
    value.toLowerCase().includes(opt.toLowerCase())
  );
  if (containsMatch) return containsMatch;
  
  // Word-based match
  const valueWords = value.toLowerCase().split(/\s+/);
  for (const opt of options) {
    const optWords = opt.toLowerCase().split(/\s+/);
    // Check if any word matches between the values
    for (const valueWord of valueWords) {
      if (optWords.some(word => word === valueWord || 
          word.includes(valueWord) || 
          valueWord.includes(word))) {
        return opt;
      }
    }
  }
  
  // Semantic match for common status pairs
  const statusPairs = [
    ['on hold', 'on hold'],
    ['pause', 'on hold'],
    ['paused', 'on hold'],
    ['on pause', 'on hold'],
    ['hold', 'on hold'],
    ['ready', 'ready for production'],
    ['done', 'completed'],
    ['finished', 'completed'],
    ['in progress', 'writing'],
    ['working', 'writing'],
    ['review', 'writing review']
  ];
  
  const valueLower = value.toLowerCase();
  for (const [from, to] of statusPairs) {
    if (valueLower.includes(from)) {
      const match = options.find(opt => opt.toLowerCase() === to.toLowerCase());
      if (match) return match;
    }
  }
  
  // No match found
  logToFile(`⚠️ No match found for "${value}" in available options: ${options.join(', ')}`);
  return null;
}

// Function to fetch available options for select and status properties
async function fetchNotionOptions() {
  try {
    if (!NOTION_TOKEN || !DB) {
      logToFile('❌ Cannot fetch Notion options: Missing NOTION_TOKEN or DB_ID');
      return;
    }
    
    logToFile('🔍 Fetching available options from Notion database...');
    
    // Get database schema
    const database = await notion.databases.retrieve({
      database_id: DB
    });
    
    // Log all available properties for debugging
    logToFile(`📊 Available properties in Notion database: ${Object.keys(database.properties).join(', ')}`);
    
    // Extract options from all select and status properties
    for (const [propName, prop] of Object.entries(database.properties)) {
      if (prop.type === 'status') {
        const options = prop.status.options.map(opt => opt.name);
        CACHED_STATUS_OPTIONS = options;
        logToFile(`✅ Cached ${options.length} status options: ${options.join(', ')}`);
        
        // Update the Status enum in the function schema
        if (FUNC_SCHEMA && 
            FUNC_SCHEMA.parameters && 
            FUNC_SCHEMA.parameters.properties && 
            FUNC_SCHEMA.parameters.properties.status) {
          FUNC_SCHEMA.parameters.properties.status.enum = options;
          logToFile(`✅ Updated Status enum in function schema with actual options from Notion`);
        }
      }
      else if (prop.type === 'select') {
        const options = prop.select.options.map(opt => opt.name);
        CACHED_SELECT_OPTIONS[propName] = options;
        logToFile(`✅ Cached ${options.length} select options for "${propName}": ${options.join(', ')}`);
      }
      else if (prop.type === 'multi_select') {
        const options = prop.multi_select.options.map(opt => opt.name);
        CACHED_SELECT_OPTIONS[propName] = options;
        logToFile(`✅ Cached ${options.length} multi-select options for "${propName}": ${options.join(', ')}`);
      }
    }
    
    // Map property types for better handling
    const propertyTypes = {};
    for (const [propName, prop] of Object.entries(database.properties)) {
      propertyTypes[propName] = prop.type;
      logToFile(`Property "${propName}" is of type: ${prop.type}`);
    }
    
    return true;
  } catch (error) {
    logToFile(`❌ Error fetching Notion options: ${error.message}`);
    return false;
  }
}

function toNotion(p) {
  const out = {};
  if (p.script_url)     out.Script          = { url: p.script_url };
  if (p.frameio_url)    out['Frame.io']     = { url: p.frameio_url };
  if (p.due_date)       out.Date            = { date:{ start:p.due_date } };
  
  // Handle "Priority" with fuzzy matching
  if (p.priority && CACHED_SELECT_OPTIONS['Priority']) {
    const matchedPriority = findClosestOption(p.priority, CACHED_SELECT_OPTIONS['Priority']);
    if (matchedPriority) {
      out.Priority = { select: { name: matchedPriority } };
    } else {
      logToFile(`⚠️ Could not match priority "${p.priority}" to available options`);
      // Use original value as fallback
      out.Priority = { select: { name: p.priority } };
    }
  } else if (p.priority) {
    out.Priority = { select: { name: p.priority } };
  }
  
  // Handle "Caption Status" with fuzzy matching
  if (p.caption_status && CACHED_SELECT_OPTIONS['Caption Status']) {
    const matchedCaptionStatus = findClosestOption(p.caption_status, CACHED_SELECT_OPTIONS['Caption Status']);
    if (matchedCaptionStatus) {
      out['Caption Status'] = { select: { name: matchedCaptionStatus } };
    } else {
      logToFile(`⚠️ Could not match caption status "${p.caption_status}" to available options`);
      // Use original value as fallback
      out['Caption Status'] = { select: { name: p.caption_status } };
    }
  } else if (p.caption_status) {
    out['Caption Status'] = { select: { name: p.caption_status } };
  }
  
  if (p.editor_discord && USER_TO_NOTION[p.editor_discord])
                        out.Editor          = { people:[{ id: USER_TO_NOTION[p.editor_discord] }] };
  
  // New properties                      
  if (p.writer && Array.isArray(p.writer) && p.writer.length > 0) {
    // Ensure each writer name is a string
    const writerNames = p.writer.map(w => typeof w === 'string' ? w : String(w));
    out.Writer = { multi_select: writerNames.map(name => ({ name })) };
  }
  
  if (p.project_owner && Array.isArray(p.project_owner) && p.project_owner.length > 0) {
    // Project Owner is a select type, not multi_select
    const ownerName = typeof p.project_owner[0] === 'string' ? p.project_owner[0] : String(p.project_owner[0]);
    out['Project Owner'] = { select: { name: ownerName } };
  } else if (p.project_owner && !Array.isArray(p.project_owner)) {
    // Handle if it's directly a string
    out['Project Owner'] = { select: { name: p.project_owner } };
  }
  
  if (p.editor && Array.isArray(p.editor) && p.editor.length > 0) {
    // Ensure each editor name is a string
    const editorNames = p.editor.map(e => typeof e === 'string' ? e : String(e));
    out.Editor = { multi_select: editorNames.map(name => ({ name })) };
  }
  
  // Handle Lead property as a People type (not select)
  if (p.lead) {
    const leadName = Array.isArray(p.lead) ? p.lead[0] : p.lead;
    // For People type properties, we need a user's ID, not their name
    // Since we don't have a mapping of names to IDs, we'll log this issue
    logToFile(`Note: Lead property "${leadName}" is a People type in Notion but we don't have user IDs`);
    // We'll skip this property since we can't set it properly without user IDs
  }
  
  // Brand Deal is a relation type, not a select
  if (p.brand_deal)     out['Brand Deal']   = { relation: [{ id: p.brand_deal }] };
  
  // Status is a status type, not a select - try fuzzy matching
  if (p.status) {
    if (CACHED_STATUS_OPTIONS) {
      const matchedStatus = findClosestOption(p.status, CACHED_STATUS_OPTIONS);
      if (matchedStatus) {
        out.Status = { status: { name: matchedStatus } };
        if (matchedStatus.toLowerCase() !== p.status.toLowerCase()) {
          logToFile(`ℹ️ Mapped status "${p.status}" to closest option "${matchedStatus}"`);
        }
      } else {
        logToFile(`⚠️ Could not match status "${p.status}" to available options - using as is`);
        out.Status = { status: { name: p.status } };
      }
    } else {
      out.Status = { status: { name: p.status } };
    }
  }
  
  // Discord Channel - store the channel ID as rich text
  if (p.discord_channel) {
    out['Discord Channel'] = { 
      rich_text: [{ 
        type: 'text', 
        text: { content: p.discord_channel } 
      }]
    };
  }
  
  // 3D Status is a select type
  if (p.threed_status && CACHED_SELECT_OPTIONS['3D Status']) {
    const matched3dStatus = findClosestOption(p.threed_status, CACHED_SELECT_OPTIONS['3D Status']);
    if (matched3dStatus) {
      out['3D Status'] = { select: { name: matched3dStatus } };
    } else {
      out['3D Status'] = { select: { name: p.threed_status } };
    }
  } else if (p.threed_status) {
    out['3D Status'] = { select: { name: p.threed_status } };
  }
  
  // Current Stage Date - map to the actual property name "Date"
  if (p.current_stage_date) {
    // Use "Date" property instead of "Current Stage Date" which doesn't exist
    out.Date = { date: { start: p.current_stage_date } };
    logToFile(`Set Date property to ${p.current_stage_date} (from current_stage_date field)`);
  }
  
  // Handle "Category" with fuzzy matching
  if (p.category && CACHED_SELECT_OPTIONS['Category']) {
    const matchedCategory = findClosestOption(p.category, CACHED_SELECT_OPTIONS['Category']);
    if (matchedCategory) {
      out.Category = { select: { name: matchedCategory } };
    } else {
      logToFile(`⚠️ Could not match category "${p.category}" to available options`);
      // Use original value as fallback
      out.Category = { select: { name: p.category } };
    }
  } else if (p.category) {
    out.Category = { select: { name: p.category } };
  }
  
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

// Setup logging
const logsDir = path.join(__dirname, 'logs');
fs.mkdirSync(logsDir, { recursive: true });
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

// Duplicate declaration - already defined above
// const processedNotificationsPath = path.join(__dirname, 'processed-notifications.json');

// Add this function near the other save/load functions
function loadProcessedNotifications() {
  try {
    if (fs.existsSync(processedNotificationsPath)) {
      const data = fs.readFileSync(processedNotificationsPath, 'utf8');
      const loaded = JSON.parse(data);
      logToFile(`Loaded ${Object.keys(loaded).length} processed notifications from file`);
      return loaded;
    }
  } catch (error) {
    logToFile(`Error loading processed notifications: ${error.message}`);
  }
  return {};
}

// Add this function near the other save/load functions
function saveProcessedNotifications(notifications) {
  try {
    fs.writeFileSync(processedNotificationsPath, JSON.stringify(notifications, null, 2));
    logToFile(`Saved ${Object.keys(notifications).length} processed notifications to file`);
  } catch (error) {
    logToFile(`Error saving processed notifications: ${error.message}`);
  }
}

// Initialize the processed notifications tracking at global scope
let processedNotifications = loadProcessedNotifications();

// Replace the pollNotion function with this improved version
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
    const now = new Date();
    
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
        const edited = new Date(page.last_edited_time);
        
        // Skip pages that were edited before the bot started
        if (edited <= BOT_START_TIME) {
          logToFile(`👀 Page ${pageId.substring(0, 8)}... was last edited at ${edited.toISOString()}, which is before bot startup at ${BOT_START_TIME.toISOString()}. Ignoring.`);
          continue;
        }
        
        // Check if we've already processed this page recently
        const lastNotificationTime = processedNotifications[pageId];
        if (lastNotificationTime) {
          const lastNotified = new Date(lastNotificationTime);
          const hoursSinceLastNotification = (now.getTime() - lastNotified.getTime()) / (1000 * 60 * 60);
          
          // Skip if notification was sent in the last 24 hours
          if (hoursSinceLastNotification < 24) {
            logToFile(`🔄 Skipping page ${pageId.substring(0, 8)}... - already notified ${hoursSinceLastNotification.toFixed(1)} hours ago. Will notify again after 24 hours.`);
            continue;
          }
          
          logToFile(`⏱️ Page ${pageId.substring(0, 8)}... was last notified ${hoursSinceLastNotification.toFixed(1)} hours ago. It's time to notify again.`);
        }
        
        // Get the page title
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
        
        // If no title found in common properties, look for any title property
        if (!title) {
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
        
        logToFile(`🔔 Sending notification for page with caption ready: "${title}" (using property: ${titlePropertyName || 'none'})`);
        logToFile(`   - Last edited: ${edited.toISOString()}`);
        logToFile(`   - Current check time: ${now.toISOString()}`);
        
        // Send the notification
        await sendNotionMessage(
          `<@${RAY_ID}> Captions are ready for project **"${title}"**`
        );
        
        // Record that we've sent a notification for this page
        processedNotifications[pageId] = now.toISOString();
        saveProcessedNotifications(processedNotifications);
        
        logToFile(`✅ Notification sent and recorded for page ${pageId.substring(0, 8)}...`);
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
            const watcherKey = `${watcher.id}:${pageId}`;
            const edited = new Date(page.last_edited_time);
            
            // Skip pages that were edited before the bot started
            if (edited <= BOT_START_TIME) {
              logToFile(`👀 Page ${pageId.substring(0, 8)}... was last edited at ${edited.toISOString()}, which is before bot startup at ${BOT_START_TIME.toISOString()}. Ignoring.`);
              continue;
            }
            
            // Check if we've already processed this page for this watcher recently
            const lastNotificationTime = processedNotifications[watcherKey];
            if (lastNotificationTime) {
              const lastNotified = new Date(lastNotificationTime);
              const hoursSinceLastNotification = (now.getTime() - lastNotified.getTime()) / (1000 * 60 * 60);
              
              // Skip if notification was sent in the last 24 hours
              if (hoursSinceLastNotification < 24) {
                logToFile(`🔄 Skipping watcher notification for page ${pageId.substring(0, 8)}... - already notified ${hoursSinceLastNotification.toFixed(1)} hours ago.`);
                continue;
              }
              
              logToFile(`⏱️ Watcher "${watcher.name}" for page ${pageId.substring(0, 8)}... was last notified ${hoursSinceLastNotification.toFixed(1)} hours ago. It's time to notify again.`);
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
            
            // Send to the dedicated Notion channel
            await sendNotionMessage(
              `<@${watcher.userId}> Project **"${title}"** is now marked as **"${watcher.value}"** (${watcher.name})`
            );
            
            // Record that we've sent a notification for this watcher+page
            processedNotifications[watcherKey] = now.toISOString();
            saveProcessedNotifications(processedNotifications);
            
            logToFile(`✅ Watcher notification sent and recorded for page ${pageId.substring(0, 8)}...`);
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
    
    // Clean up old entries (older than 30 days) once a day to prevent the file from growing too large
    const cleanupTime = new Date();
    if (cleanupTime.getHours() === 0 && cleanupTime.getMinutes() === 0) {
      const thirtyDaysAgo = new Date(cleanupTime);
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      
      let cleanupCount = 0;
      for (const [key, timestamp] of Object.entries(processedNotifications)) {
        if (new Date(timestamp) < thirtyDaysAgo) {
          delete processedNotifications[key];
          cleanupCount++;
        }
      }
      
      if (cleanupCount > 0) {
        logToFile(`🧹 Cleaned up ${cleanupCount} old notification entries (older than 30 days)`);
        saveProcessedNotifications(processedNotifications);
      }
    }
    
    // Only update lastCheck if we actually checked the database successfully
    lastCheck = new Date();
  } catch (err) {
    logToFile(`❌ Notion poll general error: ${err.message}`);
    logToFile(err.stack);
  }
}

/* ─ Check for missing properties in Notion ─────────────────────────── */
async function checkForMissingProperties() {
  try {
    if (!process.env.NOTION_TOKEN || !DB) {
      logToFile('❌ Property check skipped: Missing NOTION_TOKEN or DB_ID');
      return;
    }
    
    logToFile('🔍 Checking Notion database for missing properties...');
    
    // Query the database to find pages missing the Discord Channel property
    const response = await notion.databases.query({
      database_id: DB,
      filter: {
        property: 'Discord Channel',
        rich_text: {
          is_empty: true
        }
      },
      page_size: 10 // Process a few pages at a time
    });
    
    if (response.results.length === 0) {
      logToFile('✅ No pages with missing Discord Channel properties found');
      return;
    }
    
    logToFile(`📊 Found ${response.results.length} pages with missing Discord Channel property`);
    
    // Process each page
    for (const page of response.results) {
      try {
        // Get the page title to extract project code
        const titleProp = Object.values(page.properties).find(prop => prop.type === 'title');
        if (!titleProp || !titleProp.title || titleProp.title.length === 0) {
          logToFile(`⚠️ Skipping page ${page.id}: Could not find title property`);
          continue;
        }
        
        const pageTitle = titleProp.title.map(t => t.plain_text).join('');
        const code = projectCode(pageTitle);
        
        if (!code) {
          logToFile(`⚠️ Skipping page "${pageTitle}": Could not extract project code`);
          continue;
        }
        
        // Look for matching Discord channels
        logToFile(`🔍 Looking for Discord channels matching code "${code}"...`);
        
        // Find channels with this code in the name
        const matchingChannels = client.channels.cache.filter(channel => 
          channel.type === ChannelType.GuildText && 
          channel.name.toLowerCase().includes(code.toLowerCase())
        );
        
        if (matchingChannels.size === 0) {
          logToFile(`⚠️ No matching Discord channels found for code "${code}"`);
          continue;
        }
        
        // Use the first matching channel
        const channel = matchingChannels.first();
        logToFile(`✅ Found matching channel for "${code}": #${channel.name} (${channel.id})`);
        
        // Update the Notion page with the Discord channel ID as a URL
        await notion.pages.update({
          page_id: page.id,
          properties: {
            'Discord Channel': {
              url: `https://discord.com/channels/${channel.guild.id}/${channel.id}`
            }
          }
        });
        
        logToFile(`✅ Updated Discord Channel for page "${pageTitle}" to ${channel.id}`);
        
        // Just log the auto-linking, don't send message to channel to avoid notification spam
        logToFile(`🔄 Auto-linked project ${code} to channel ${channel.id}`);
        // Uncomment if you want notifications again
        // if (NOTION_CHANNEL_ID) {
        //   sendNotionMessage(`🔄 Automatically linked project **${code}** to channel <#${channel.id}>`);
        // }
      } catch (pageError) {
        logToFile(`❌ Error processing page ${page.id}: ${pageError.message}`);
      }
    }
    
    logToFile('✅ Completed missing properties check');
  } catch (error) {
    logToFile(`❌ Error checking for missing properties: ${error.message}`);
  }
}

// Schedule the missing properties check to run hourly
setInterval(checkForMissingProperties, 3600 * 1000); // Every hour

// Run once on startup (with delay to allow bot to initialize)
setTimeout(checkForMissingProperties, 30 * 1000); // 30 seconds after startup

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

// Add this code:
// Add custom meetings support
const meetingsFilePath = path.join(__dirname, 'meetings.json');
const customMeetings = [];
// Define a Map to track active scheduled jobs
const activeJobs = new Map();

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
        .setDescription('Number of messages to analyze (default: 100, max: 300)')
        .setRequired(false)
    )
    .addBooleanOption(option =>
      option.setName('dry_run')
        .setDescription('Preview changes without updating Notion (dry-run mode)')
        .setRequired(false)
    )
    .addBooleanOption(option =>
      option.setName('ephemeral')
        .setDescription('Make response only visible to you')
        .setRequired(false)),
  
  new SlashCommandBuilder()
    .setName("availability"),
  
  new SlashCommandBuilder()
    .setName('sync')
    .setDescription('Update Notion with properties from your message (alias for !sync)')
    .addStringOption(option => 
      option.setName('text')
        .setDescription('The properties to update (same as !sync command)')
        .setRequired(true))
    .addBooleanOption(option =>
      option.setName('dry_run')
        .setDescription('Preview changes without updating Notion')
        .setRequired(false)),
  
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
    .setName('meeting')
    .setDescription('Schedule a meeting with other users')
    .addUserOption(option =>
      option.setName('participant')
        .setDescription('The primary user to meet with')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('time')
        .setDescription('Meeting time (e.g. "30m" for 30 min from now, or "1400" for 2:00 PM)')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('topic')
        .setDescription('Meeting topic (optional)')
        .setRequired(false))
    .addStringOption(option =>
      option.setName('additional_participants')
        .setDescription('Additional participants (mention them with @user1 @user2)')
        .setRequired(false)),
        
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
    .setName('link')
    .setDescription('Get the Notion link for the current project')
    .addBooleanOption(option =>
      option.setName('ephemeral')
        .setDescription('Make the response only visible to you')
        .setRequired(false)),
    
  new SlashCommandBuilder()
    .setName('where')
    .setDescription('Find all info about a project by code or link')
    .addStringOption(option => 
      option.setName('query')
        .setDescription('Project code (CL27) or any link (Frame.io, Script, YouTube)')
        .setRequired(true))
    .addBooleanOption(option =>
      option.setName('ephemeral')
        .setDescription('Make the response only visible to you')
        .setRequired(false)),
        
  new SlashCommandBuilder()
    .setName('availability')
    .setDescription('Show who is currently working and how much time they have left')
    .addBooleanOption(option =>
      option.setName('ephemeral')
        .setDescription('Make the response only visible to you')
        .setRequired(false)),
        
  new SlashCommandBuilder()
    .setName('register')
    .setDescription('Force re-register all slash commands (admin only)'),
    
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
        .setRequired(true)),
  
  new SlashCommandBuilder()
    .setName('set')
    .setDescription('Set a property directly on the Notion page for this channel')
    .addSubcommand(subcommand =>
      subcommand
        .setName('status')
        .setDescription('Set the Status property')
        .addStringOption(option =>
          option.setName('value')
            .setDescription('Status value')
            .setRequired(true)
            .addChoices(
              { name: 'Uploaded', value: 'Uploaded' },
              { name: 'FOIA Received', value: 'FOIA Received' },
              { name: 'Ready for production', value: 'Ready for production' },
              { name: 'Writing', value: 'Writing' },
              { name: 'Writing Review', value: 'Writing Review' },
              { name: 'VA Render', value: 'VA Render' },
              { name: 'VA Review', value: 'VA Review' },
              { name: 'Writing Revisions', value: 'Writing Revisions' },
              { name: 'Ready for Editing', value: 'Ready for Editing' },
              { name: 'Clip Selection', value: 'Clip Selection' },
              { name: 'Clip Selection Review', value: 'Clip Selection Review' },
              { name: 'MGX', value: 'MGX' },
              { name: 'MGX Review/Cleanup', value: 'MGX Review/Cleanup' },
              { name: 'Ready to upload', value: 'Ready to upload' },
              { name: 'Backlog', value: 'Backlog' },
              { name: 'On Hold', value: 'On Hold' }
            ))
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('due_date')
        .setDescription('Set the due date')
        .addStringOption(option =>
          option.setName('date')
            .setDescription('Due date (YYYY-MM-DD)')
            .setRequired(true))
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('priority')
        .setDescription('Set the priority')
        .addStringOption(option =>
          option.setName('level')
            .setDescription('Priority level')
            .setRequired(true)
            .addChoices(
              { name: 'High', value: 'High' },
              { name: 'Medium', value: 'Medium' },
              { name: 'Low', value: 'Low' }
            ))
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('editor')
        .setDescription('Set the editor(s)')
        .addStringOption(option =>
          option.setName('names')
            .setDescription('Editor names (comma-separated)')
            .setRequired(true))
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('writer')
        .setDescription('Set the writer(s)')
        .addStringOption(option =>
          option.setName('names')
            .setDescription('Writer names (comma-separated)')
            .setRequired(true))
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('lead')
        .setDescription('Set the lead person')
        .addStringOption(option =>
          option.setName('name')
            .setDescription('Lead name')
            .setRequired(true))
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('caption_status')
        .setDescription('Set the caption status')
        .addStringOption(option =>
          option.setName('status')
            .setDescription('Caption status')
            .setRequired(true)
            .addChoices(
              { name: 'Ready For Captions', value: 'Ready For Captions' },
              { name: 'Captions In Progress', value: 'Captions In Progress' },
              { name: 'Captions Done', value: 'Captions Done' },
              { name: 'Needs Captions', value: 'Needs Captions' }
            ))
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('script_url')
        .setDescription('Set the script URL')
        .addStringOption(option =>
          option.setName('url')
            .setDescription('URL to the script document')
            .setRequired(true))
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('frameio_url')
        .setDescription('Set the Frame.io URL')
        .addStringOption(option =>
          option.setName('url')
            .setDescription('URL to the Frame.io project')
            .setRequired(true))
    ),
  
  new SlashCommandBuilder()
    .setName('watch')
    .setDescription('Create a Notion watcher to notify when properties change')
    .addStringOption(option => 
      option.setName('property')
        .setDescription('The Notion property to watch')
        .setRequired(true))
    .addStringOption(option => 
      option.setName('value')
        .setDescription('The value to watch for')
        .setRequired(true))
    .addUserOption(option => 
      option.setName('notify')
        .setDescription('User to notify when this property value is found')
        .setRequired(true))
    .addStringOption(option => 
      option.setName('name')
        .setDescription('Optional name for this watcher')
        .setRequired(false)),
];

// Register slash commands when the bot is ready
async function registerCommands(clientId, guildId) {
  try {
    // Ensure critical commands are at the beginning of the array
    // First, get the indices of critical commands in the array
    const linkIndex = commands.findIndex(cmd => cmd.name === 'link');
    const whereIndex = commands.findIndex(cmd => cmd.name === 'where');
    const availabilityIndex = commands.findIndex(cmd => cmd.name === 'availability');
    
    // Get references to the critical commands
    const linkCommand = linkIndex >= 0 ? commands[linkIndex] : null;
    const whereCommand = whereIndex >= 0 ? commands[whereIndex] : null;
    const availabilityCommand = availabilityIndex >= 0 ? commands[availabilityIndex] : null;
    
    // If any of the critical commands exist, remove them from their current position
    const criticalCommands = [];
    if (linkCommand) {
      criticalCommands.push(linkCommand);
      commands.splice(linkIndex, 1);
    }
    if (whereCommand) {
      criticalCommands.push(whereCommand);
      commands.splice(whereIndex > linkIndex ? whereIndex - 1 : whereIndex, 1);
    }
    if (availabilityCommand) {
      criticalCommands.push(availabilityCommand);
      commands.splice(availabilityIndex > Math.max(linkIndex, whereIndex) ? availabilityIndex - 2 : 
                     (availabilityIndex > Math.min(linkIndex, whereIndex) ? availabilityIndex - 1 : 
                      availabilityIndex), 1);
    }
    
    // Reinsert critical commands at the beginning of the array
    commands.unshift(...criticalCommands);
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
      value: `⏱️ In: **${item.next.formattedTimeLeft}**\n🕒 At: ${item.next.formatted}\n📝 Message: ${item.job.text}`
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
      // Notion integration commands
      { name: '📋 Notion Integration', value: '__________________________' },
      { name: '/sync', value: 'Update Notion with details from your message' },
      { name: '/analyze', value: 'Analyze channel messages and update Notion automatically' },
      { name: '/where', value: 'Find all project links and info by code or any link (works in DMs too)' },
      { name: '/link', value: 'Get the Notion link for the current project' },
      { name: '/set', value: 'Set a specific property on the Notion page for this channel' },
      { name: '/notion', value: 'Manage Notion status watchers (add/list/enable/disable/delete/properties)' },
      { name: '/watchers', value: 'List all Notion watchers in detail' },
      
      // Schedule commands
      { name: '⏰ Schedule Management', value: '__________________________' },
      { name: '/test', value: 'Send test messages for all scheduled reminders' },
      { name: '/testjob', value: 'Test a specific scheduled reminder (select from dropdown)' },
      { name: '/send', value: 'Send a custom message to the channel (with optional role mention)' },
      { name: '/next', value: 'Show when the next reminders will run' },
      { name: '/schedule', value: 'Show the complete schedule with countdown timers' },
      { name: '/list', value: 'List all scheduled reminders' },
      { name: '/status', value: 'Check the bot status and configuration' },
      { name: '/edit', value: 'Edit a scheduled reminder' },
      { name: '/add', value: 'Add a new scheduled reminder' },
      { name: '/help', value: 'Show this help information' }
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
    
    else if (commandName === 'set') {
      try {
        await interaction.deferReply({ ephemeral: true });
        hasResponded = true;
        clearTimeout(timeoutWarning);
        
        // Extract the project code from the channel name
        const code = projectCode(interaction.channel.name);
        if (!code) {
          await interaction.editReply('No project code detected in channel name. This command must be used in a project channel (e.g., cl23-project).');
          return;
        }
        
        // Find the Notion page for this project
        let pageId = await findPage(code);
        if (!pageId) {
          await interaction.editReply(`No Notion page found for project code "${code}". Use !sync first to create a page.`);
          return;
        }
        
        // Get subcommand and value
        const subcommand = interaction.options.getSubcommand();
        let propValue = null;
        let notionProps = {};
        
        // Process based on subcommand
        logToFile(`Processing /set ${subcommand} for project ${code}`);
        
        switch (subcommand) {
          case 'status':
            propValue = interaction.options.getString('value');
            logToFile(`Setting Status to "${propValue}"`);
            
            // Try to determine if Status is a status or select type
            try {
              // First try as status type
              notionProps.Status = { status: { name: propValue } };
            } catch (statusError) {
              logToFile(`Error setting status as status type: ${statusError.message}`);
              // Fallback to select type
              notionProps.Status = { select: { name: propValue } };
            }
            break;
          
          case 'due_date':
            propValue = interaction.options.getString('date');
            // Validate date format (YYYY-MM-DD)
            if (!propValue.match(/^\d{4}-\d{2}-\d{2}$/)) {
              await interaction.editReply('Invalid date format. Use YYYY-MM-DD (e.g., 2025-04-15).');
              return;
            }
            notionProps.Date = { date: { start: propValue } };
            break;
          
          case 'priority':
            propValue = interaction.options.getString('level');
            notionProps.Priority = { select: { name: propValue } };
            break;
          
          case 'editor':
            propValue = interaction.options.getString('names');
            const editorNames = propValue.split(',').map(n => n.trim()).filter(n => n);
            if (editorNames.length === 0) {
              await interaction.editReply('Please provide at least one editor name.');
              return;
            }
            notionProps.Editor = { multi_select: editorNames.map(name => ({ name })) };
            break;
          
          case 'writer':
            propValue = interaction.options.getString('names');
            const writerNames = propValue.split(',').map(n => n.trim()).filter(n => n);
            if (writerNames.length === 0) {
              await interaction.editReply('Please provide at least one writer name.');
              return;
            }
            notionProps.Writer = { multi_select: writerNames.map(name => ({ name })) };
            break;
          
          case 'lead':
            propValue = interaction.options.getString('name');
            // Lead is a People type - we can't set it with a string name
            logToFile(`Note: Lead property "${propValue}" is a People type in Notion but we don't have user IDs`);
            // Skip setting this property
            break;
          
          case 'caption_status':
            propValue = interaction.options.getString('status');
            notionProps['Caption Status'] = { select: { name: propValue } };
            break;
          
          case 'script_url':
            propValue = interaction.options.getString('url');
            notionProps.Script = { url: propValue };
            break;
          
          case 'frameio_url':
            propValue = interaction.options.getString('url');
            notionProps['Frame.io'] = { url: propValue };
            break;
        }
        
        try {
          logToFile(`Updating Notion page ${pageId} with properties: ${JSON.stringify(notionProps)}`);
          
          // Update the Notion property
          await notion.pages.update({ 
            page_id: pageId, 
            properties: notionProps 
          });
          
          // Get the Notion URL for the page
          const notionUrl = getNotionPageUrl(pageId);
          
          // Success message
          await interaction.editReply({
            content: `✅ Updated ${subcommand.replace('_', ' ')} to "${propValue}" for project ${code}`,
            components: notionUrl ? [
              new ActionRowBuilder()
                .addComponents(
                  new ButtonBuilder()
                    .setLabel('View in Notion')
                    .setStyle(ButtonStyle.Link)
                    .setURL(notionUrl)
                )
            ] : []
          });
          
          // Also send a non-ephemeral message to channel
          await interaction.channel.send(
            `✅ <@${interaction.user.id}> set ${subcommand.replace('_', ' ')} to "${propValue}" for project ${code}`
          );
        } catch (updateError) {
          logToFile(`Error updating property in /set command: ${updateError.message}`);
          await interaction.editReply(`❌ Error updating property: ${updateError.message}`);
        }
      } catch (cmdError) {
        logToFile(`Error in /set command: ${cmdError.message}`);
        logToFile(cmdError.stack);
        if (!hasResponded) {
          try {
            await interaction.reply({ content: `❌ Error: ${cmdError.message}`, ephemeral: true });
            hasResponded = true;
          } catch (replyError) {
            logToFile(`Failed to send error reply: ${replyError.message}`);
          }
        } else {
          await interaction.editReply(`❌ Error: ${cmdError.message}`);
        }
      }
    }
    
    else if (commandName === 'meeting') {
      try {
        await interaction.deferReply({ ephemeral: false });
        hasResponded = true;
        clearTimeout(timeoutWarning);
        
        logToFile(`Processing /meeting command from ${interaction.user.tag}`);
        
        // Get the parameters
        const participant = interaction.options.getUser('participant');
        const timeStr = interaction.options.getString('time');
        const topic = interaction.options.getString('topic') || 'Discussion';
        const additionalParticipants = interaction.options.getString('additional_participants');
        
        // Modify to handle multiple participants
        let participants = [participant];
        if (additionalParticipants) {
          // Get the additional participant mentions and extract the IDs
          const additionalParticipantIds = additionalParticipants.match(/<@!?(\d+)>/g) || [];
          if (additionalParticipantIds.length > 0) {
            for (const mention of additionalParticipantIds) {
              const id = mention.replace(/<@!?(\d+)>/g, '$1');
              // Try to fetch the user to ensure they exist
              try {
                const user = await client.users.fetch(id);
                if (user && !participants.some(p => p.id === user.id)) {
                  participants.push(user);
                }
              } catch (userError) {
                logToFile(`Warning: Could not fetch user with ID ${id}: ${userError.message}`);
              }
            }
          }
        }
        
        logToFile(`Meeting details: with ${participants.map(p => p.tag).join(', ')}, time: ${timeStr}, topic: ${topic}`);
        
        // Parse the meeting time
        const meetingTime = parseTimeString(timeStr);
        if (!meetingTime) {
          await interaction.editReply(`❌ Invalid time format: "${timeStr}". Use "30m" for 30 minutes from now, or "1400" for 2:00 PM today.`);
          return;
        }
        
        // Calculate the reminder time (5 minutes before)
        const reminderTime = new Date(meetingTime.getTime() - 5 * 60 * 1000);
        
        // Format time for display
        const timeDisplay = meetingTime.toLocaleString('en-US', {
          hour: 'numeric',
          minute: '2-digit',
          hour12: true
        });
        
        // Generate a unique ID
        const id = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
        
        // Create the new meeting
        const newMeeting = {
          id,
          participants: participants.map(p => p.id),
          time: timeStr,
          scheduledTime: meetingTime.toISOString(),
          reminderTime: reminderTime.toISOString(),
          topic,
          notified: false,
          createdAt: new Date().toISOString(),
          createdBy: interaction.user.id
        };
        
        // Add to custom meetings
        customMeetings.push(newMeeting);
        
        logToFile(`Created meeting with ID: ${id}, scheduled for ${meetingTime.toISOString()}`);
        
        // Save to file
        saveMeetings();
        
        // Participant mentions for message
        const participantMentions = participants.map(p => `<@${p.id}>`).join(', ');
        
        // Reply to confirm meeting creation (only one message)
        await interaction.editReply({
          content: `✅ Meeting scheduled with ${participantMentions} for **${timeDisplay}**\n📋 Topic: ${topic}\n⏰ A reminder will be sent 5 minutes before the meeting.`,
          allowedMentions: { users: participants.map(p => p.id) }
        });
        
        // No DM sent at creation time per request
        
      } catch (cmdError) {
        logToFile(`Error in /meeting command: ${cmdError.message}`);
        logToFile(cmdError.stack);
        if (!hasResponded) {
          try {
            await interaction.reply(`❌ Error scheduling meeting: ${cmdError.message}`);
            hasResponded = true;
          } catch (replyError) {
            logToFile(`Failed to send error reply: ${replyError.message}`);
          }
        }
      }
    }
    
    else if (commandName === 'analyze') {
      try {
        // Check if response should be ephemeral
        const ephemeral = interaction.options.getBoolean('ephemeral') || false;
        
        // Immediately defer reply to prevent timeout
        await interaction.deferReply({
          ephemeral: ephemeral
        });
        hasResponded = true;
        clearTimeout(timeoutWarning);
        
        // Check if OpenAI is available
        if (!openai) {
          await interaction.editReply('❌ OpenAI API key not configured. Cannot process analyze command.');
          return;
        }
        
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
          
          // Get number of messages to analyze (default: 100, max: 300)
          const limit = Math.min(interaction.options.getInteger('messages') || 100, 300);
          
          // Check if this is a dry run
          const isDryRun = interaction.options.getBoolean('dry_run') || false;
          const dryRunPrefix = isDryRun ? '[DRY RUN] ' : '';
          
          await interaction.editReply(`${dryRunPrefix}🔍 Analyzing the last ${limit} messages in this channel to update Notion...`);
          
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
          const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format

          const gpt = await openai.chat.completions.create({
            model: 'gpt-4o',
            temperature: 0,
            messages: [
              { role: 'system', content: ANALYSIS_SYSTEM_PROMPT },
              // Few-shot examples
              { role: 'user', content: 'The project is in VA render stage now. Ray will do the final cut.' },
              { role: 'assistant', function_call: { 
                name: 'update_properties',
                arguments: JSON.stringify({ status: 'VA Render', editor: ['Ray'] })
              }},
              { role: 'user', content: 'Suki is managing the project now. Due by April 12th. Medium priority.' },
              { role: 'assistant', function_call: { 
                name: 'update_properties',
                arguments: JSON.stringify({ project_owner: ['Suki'], due_date: '2025-04-12', priority: 'Medium' })
              }},
              // New example showing latest link wins
              { role: 'user', content: 'First edit on Frame.io: https://f.io/abc123. [Later message] We moved to a new Frame.io: https://f.io/xyz789.' },
              { role: 'assistant', function_call: { 
                name: 'update_properties',
                arguments: JSON.stringify({ frameio_url: 'https://f.io/xyz789' })
              }},
              // Add example for stage date
              { role: 'user', content: 'Aiming to have the script revised and new VA render by tomorrow.' },
              { role: 'assistant', function_call: { 
                name: 'update_properties',
                arguments: JSON.stringify({ 
                  status: 'VA Render', 
                  current_stage_date: new Date(new Date().setDate(new Date().getDate() + 1)).toISOString().split('T')[0]
                })
              }},
              // Actual message
              { role: 'user', content: `Here's the chat history for project ${code}. Extract the latest information about project properties like due dates, priorities, etc.:\n\n${chatHistory}` }
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
          
          // Try to extract Frame.io link if needed
          if (hasPageContent && !props.frameio_url && !notionProps['Frame.io']) {
            try {
              const frameioLink = extractFrameioLink(props.page_content);
              if (frameioLink) {
                logToFile(`📝 Found potential Frame.io link in content: ${frameioLink}`);
                // Add the Frame.io URL to properties
                try {
                  notionProps['Frame.io'] = { url: frameioLink };
                  hasPropertiesToUpdate = true;
                } catch (frameioError) {
                  logToFile(`Error adding Frame.io URL to properties: ${frameioError.message}`);
                  errorProperties.push("Frame.io URL");
                }
              }
            } catch (extractError) {
              logToFile(`Error extracting Frame.io link: ${extractError.message}`);
              errorProperties.push("Frame.io extraction");
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
              if (!isDryRun) {
                await notion.pages.update({ 
                  page_id: pageId, 
                  properties: notionProps 
                });
                updatedProperties = true;
              } else {
                logToFile(`💧 DRY RUN: Would update these properties: ${JSON.stringify(notionProps)}`);
                updatedProperties = true; // Mark as "updated" for the summary even though we didn't actually update
              }
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
              if (!isDryRun) {
                await notion.blocks.children.append({
                  block_id: pageId,
                  children: contentBlocks
                });
                updatedContent = true;
              } else {
                logToFile(`💧 DRY RUN: Would add content: ${props.page_content.trim().substring(0, 100)}...`);
                updatedContent = true; // Mark as "updated" for the summary
              }
            } catch (contentError) {
              logToFile(`Error adding page content: ${contentError.message}`);
              errorProperties.push("Page content");
            }
          }
          
          // Format analysis for display
          const analysisEmbed = new EmbedBuilder()
            .setColor(isDryRun ? 0x00FFFF : 0x00FF00) // Cyan for dry-run, green for regular
            .setTitle(`${dryRunPrefix}📊 Analysis Results for ${code}`)
            .setDescription(`I've analyzed ${sortedMessages.length} messages and ${isNewPage ? 'created a new page with' : 'updated the following:'}`)
            .setFooter({ text: `Analyzed ${limit} messages${isDryRun ? ' (DRY RUN - No changes made)' : ''}` })
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
          
          // If ephemeral, set up auto-delete after 5 minutes
          if (ephemeral) {
            setTimeout(async () => {
              try {
                // For ephemeral messages, we don't need to delete them as they're already
                // only visible to the user and Discord handles cleanup
                logToFile(`👻 Ephemeral analyze results for ${code} should auto-expire now`);
              } catch (deleteError) {
                logToFile(`Error with ephemeral message: ${deleteError.message}`);
              }
            }, 5 * 60 * 1000); // 5 minutes
          }
          
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
    
    else if (commandName === 'sync') {
      try {
        // Make response ephemeral (only visible to the command sender)
        await interaction.deferReply({ ephemeral: true });
        hasResponded = true;
        clearTimeout(timeoutWarning);
        
        // Extract the project code from the channel name
        const code = projectCode(interaction.channel.name);
        if (!code) {
          await interaction.editReply('No project code detected in channel name. This command must be used in a project channel (e.g., cl23-project).');
          return;
        }
        
        // Get the text input and dry run option
        const text = interaction.options.getString('text');
        const isDryRun = interaction.options.getBoolean('dry_run') || false;
        const dryRunPrefix = isDryRun ? '[DRY RUN] ' : '';
        
        await interaction.editReply(`${dryRunPrefix}🔄 Processing sync request: "${text}"`);
        
        // Process as if it were a !sync command
        logToFile(`/sync command used by ${interaction.user.tag}: "${text}"`);
        
        // Use a fake msg object to reuse !sync logic
        const fakeMsg = {
          content: `${TRIGGER_PREFIX} ${text}${isDryRun ? ' --dry' : ''}`,
          channel: interaction.channel,
          author: interaction.user,
          interaction: interaction, // Add reference to the original interaction
          reply: async (content) => {
            if (typeof content === 'string') {
              await interaction.editReply(content);
            } else {
              await interaction.editReply(content);
            }
          }
        };
        
        // Call the existing message handler directly
        // This avoids duplicating logic between !sync and /sync
        await handleSyncMessage(fakeMsg);
      } catch (cmdError) {
        logToFile(`Error in /sync command: ${cmdError.message}`);
        if (!hasResponded) {
          try {
            await interaction.reply({ content: `❌ Error processing sync command: ${cmdError.message}`, ephemeral: true });
            hasResponded = true;
          } catch (replyError) {
            logToFile(`Failed to send error reply: ${replyError.message}`);
          }
        } else {
          await interaction.editReply(`❌ Error processing sync command: ${cmdError.message}`);
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
    
    // Link command to get Notion URL
    else if (commandName === 'link') {
      try {
        // Check if should be ephemeral (default to true)
        const ephemeral = interaction.options.getBoolean('ephemeral') !== false;
        
        await interaction.deferReply({ ephemeral });
        hasResponded = true;
        clearTimeout(timeoutWarning);
        
        // Extract the project code from the channel name
        const code = projectCode(interaction.channel.name);
        if (!code) {
          await interaction.editReply('❌ No project code detected in this channel name. Use this command in a project channel (e.g., cl23-project).');
          return;
        }
        
        // Find the Notion page for this project
        const pageId = await findPage(code);
        if (!pageId) {
          await interaction.editReply(`❌ No Notion page found for project code "${code}". Use \`/sync\` first to create a page.`);
          return;
        }
        
        // Get the Notion URL
        const notionUrl = getNotionPageUrl(pageId);
        if (!notionUrl) {
          await interaction.editReply(`❌ Could not generate Notion URL for project "${code}".`);
          return;
        }
        
        // Create button for the Notion link
        const linkButton = new ActionRowBuilder()
          .addComponents(
            new ButtonBuilder()
              .setLabel('Open in Notion')
              .setStyle(ButtonStyle.Link)
              .setURL(notionUrl)
          );
        
        // Send the reply with a link button
        await interaction.editReply({
          content: `🔗 **Notion Page for project ${code}**: ${notionUrl}`,
          components: [linkButton]
        });
        
        // If not ephemeral and shown in the channel, delete after 5 minutes
        if (!ephemeral) {
          setTimeout(async () => {
            try {
              // Check if the reply still exists and delete it
              const fetchedReply = await interaction.fetchReply().catch(() => null);
              if (fetchedReply) {
                await interaction.deleteReply();
                logToFile(`🗑️ Auto-deleted Notion link for ${code} after 5 minutes`);
              }
            } catch (deleteError) {
              logToFile(`Error deleting Notion link reply: ${deleteError.message}`);
            }
          }, 5 * 60 * 1000); // 5 minutes
        }
      } catch (cmdError) {
        logToFile(`Error in /link command: ${cmdError.message}`);
        if (!hasResponded) {
          try {
            await interaction.reply({ content: `❌ Error getting Notion link: ${cmdError.message}`, ephemeral: true });
            hasResponded = true;
          } catch (replyError) {
            logToFile(`Failed to send error reply: ${replyError.message}`);
          }
        } else {
          await interaction.editReply(`❌ Error getting Notion link: ${cmdError.message}`);
        }
      }
    }
    
    // Test-link command handler
    else if (commandName === 'test-link') {
      try {
        // Check if should be ephemeral (default to true)
        const ephemeral = interaction.options.getBoolean('ephemeral') !== false;
        
        await interaction.deferReply({ ephemeral });
        hasResponded = true;
        clearTimeout(timeoutWarning);
        
        // Create a simple embed for the test
        const testEmbed = new EmbedBuilder()
          .setColor('#00FF00')
          .setTitle('Command Registration Test')
          .setDescription('✅ This test command is working correctly!')
          .addFields(
            { name: 'Command Name', value: 'test-link' },
            { name: 'Registration Status', value: 'Successfully registered and working' },
            { name: 'Server', value: interaction.guild ? interaction.guild.name : 'Direct Message' },
            { name: 'Channel', value: interaction.channel ? interaction.channel.name : 'Unknown' },
            { name: 'User', value: interaction.user.tag }
          )
          .setTimestamp()
          .setFooter({ text: 'Command Registration Test' });
        
        // Send the reply with the embed
        await interaction.editReply({
          content: '✅ **Test command is working!** If you can see this, command registration is successful.',
          embeds: [testEmbed]
        });
        
        // Log the successful test
        logToFile(`🧪 Test-link command executed by ${interaction.user.tag} in ${interaction.guild ? interaction.guild.name : 'DM'}`);
        
        // If not ephemeral, delete after 1 minute
        if (!ephemeral) {
          setTimeout(async () => {
            try {
              const fetchedReply = await interaction.fetchReply().catch(() => null);
              if (fetchedReply) {
                await interaction.deleteReply();
                logToFile(`🗑️ Auto-deleted test-link response after 1 minute`);
              }
            } catch (deleteError) {
              logToFile(`Error deleting test-link reply: ${deleteError.message}`);
            }
          }, 1 * 60 * 1000); // 1 minute
        }
      } catch (cmdError) {
        logToFile(`Error in /test-link command: ${cmdError.message}`);
        if (!hasResponded) {
          try {
            await interaction.reply({ content: `❌ Error in test command: ${cmdError.message}`, ephemeral: true });
            hasResponded = true;
          } catch (replyError) {
            logToFile(`Failed to send error reply: ${replyError.message}`);
          }
        }
      }
    }
    
    // Where command to find all project info
    else if (commandName === 'where') {
      try {
        // Get query and ephemeral setting
        const query = interaction.options.getString('query');
        const ephemeral = interaction.options.getBoolean('ephemeral') !== false; // Default to true
        
        await interaction.deferReply({ ephemeral });
        hasResponded = true;
        clearTimeout(timeoutWarning);
        
        // Log the query
        logToFile(`/where command used with query: "${query}" by ${interaction.user.tag}`);
        
        // Search for the project
        const result = await findProjectByQuery(query);
        
        if (!result) {
          await interaction.editReply({
            content: `❌ No project found matching "${query}". Try a different search.`,
            ephemeral: true
          });
          return;
        }
        
        // Extract project information
        const projectInfo = await extractProjectInfo(result.page, result.code);
        
        if (!projectInfo) {
          await interaction.editReply({
            content: `❌ Error extracting project info for "${query}".`,
            ephemeral: true
          });
          return;
        }
        
        // Find Discord channels if not already found
        let discordChannels = [];
        if (!projectInfo.discordChannelId) {
          discordChannels = await findDiscordChannels(projectInfo.code);
        }
        
        // Create an embed to display project info
        const embed = new EmbedBuilder()
          .setColor(0x0099FF)
          .setTitle(`Project: ${projectInfo.title || projectInfo.code}`)
          .setDescription(`Here's everything you need for project **${projectInfo.code}**:`)
          .setTimestamp();
        
        // Add fields for each piece of information
        // Notion Link
        if (projectInfo.notionUrl) {
          embed.addFields({
            name: '📋 Notion Card',
            value: projectInfo.notionUrl
          });
        }
        
        // Discord Channel
        let discordValue = 'No Discord channel found';
        if (projectInfo.discordChannelId) {
          discordValue = `<#${projectInfo.discordChannelId}>`;
        } else if (discordChannels.length > 0) {
          discordValue = discordChannels.map(channel => `<#${channel.id}>`).join('\n');
        }
        embed.addFields({
          name: '💬 Discord Channel',
          value: discordValue
        });
        
        // Frame.io
        if (projectInfo.frameioUrl) {
          embed.addFields({
            name: '🎬 Frame.io',
            value: projectInfo.frameioUrl
          });
        }
        
        // Script
        if (projectInfo.scriptUrl) {
          embed.addFields({
            name: '📝 Script',
            value: projectInfo.scriptUrl
          });
        }
        
        // Editors
        if (projectInfo.editors && projectInfo.editors.length > 0) {
          embed.addFields({
            name: '✂️ Editors',
            value: projectInfo.editors.join(', ')
          });
        }
        
        // Status & Due Date
        let statusText = projectInfo.status || 'N/A';
        if (projectInfo.dueDate) {
          statusText += ` (Due: ${projectInfo.dueDate})`;
        }
        embed.addFields({
          name: '📊 Status',
          value: statusText
        });
        
        // Create buttons for easy access
        const buttons = [];
        
        // Notion button
        if (projectInfo.notionUrl) {
          buttons.push(
            new ButtonBuilder()
              .setLabel('Open in Notion')
              .setStyle(ButtonStyle.Link)
              .setURL(projectInfo.notionUrl)
          );
        }
        
        // Frame.io button
        if (projectInfo.frameioUrl) {
          buttons.push(
            new ButtonBuilder()
              .setLabel('Open Frame.io')
              .setStyle(ButtonStyle.Link)
              .setURL(projectInfo.frameioUrl)
          );
        }
        
        // Script button
        if (projectInfo.scriptUrl) {
          buttons.push(
            new ButtonBuilder()
              .setLabel('Open Script')
              .setStyle(ButtonStyle.Link)
              .setURL(projectInfo.scriptUrl)
          );
        }
        
        // Add buttons if we have any
        const components = [];
        if (buttons.length > 0) {
          const row = new ActionRowBuilder().addComponents(...buttons);
          components.push(row);
        }
        
        // Send the response
        await interaction.editReply({
          embeds: [embed],
          components
        });
        
        // If not ephemeral, auto-delete after 5 minutes
        if (!ephemeral) {
          setTimeout(async () => {
            try {
              // Check if the reply still exists and delete it
              const fetchedReply = await interaction.fetchReply().catch(() => null);
              if (fetchedReply) {
                await interaction.deleteReply();
                logToFile(`🗑️ Auto-deleted where command results for ${projectInfo.code} after 5 minutes`);
              }
            } catch (deleteError) {
              logToFile(`Error deleting where command reply: ${deleteError.message}`);
            }
          }, 5 * 60 * 1000); // 5 minutes
        }
      } catch (cmdError) {
        logToFile(`Error in /where command: ${cmdError.message}`);
        if (!hasResponded) {
          try {
            await interaction.reply({ 
              content: `❌ Error finding project: ${cmdError.message}`, 
              ephemeral: true 
            });
            hasResponded = true;
          } catch (replyError) {
            logToFile(`Failed to send error reply: ${replyError.message}`);
          }
        } else {
          await interaction.editReply(`❌ Error finding project: ${cmdError.message}`);
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
  
  // Fetch available Notion options for better matching
  await fetchNotionOptions();

  // Add this line to load watchers
  customWatchers = loadWatchers();
  logToFile(`Loaded ${customWatchers.length} custom watchers from file`);

  logToFile('\n🔄  Bot is running! Press Ctrl+C to stop.');
  
  // Log the next execution times for all jobs
  logNextExecutions();

  // Auto-register commands if running on Railway
  if (process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_SERVICE_ID) {
    try {
      logToFile('🔄 Detected Railway environment, automatically registering slash commands...');
      await registerCommands(client.user.id);
      logToFile('✅ Successfully registered slash commands globally - they should appear in Discord within an hour');
      
      // Try to register commands for the first few guilds for faster updates
      let registerCount = 0;
      for (const guild of client.guilds.cache.values()) {
        if (registerCount < 5) { // Limit to 5 guilds to avoid rate limits
          try {
            await registerCommands(client.user.id, guild.id);
            logToFile(`✅ Registered commands for guild: ${guild.name} (${guild.id})`);
            registerCount++;
          } catch (guildError) {
            logToFile(`⚠️ Could not register commands for guild ${guild.name}: ${guildError.message}`);
          }
        }
      }
    } catch (error) {
      logToFile(`❌ Error registering commands on startup: ${error.message}`);
    }
  }
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
let customWatchers = [];

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
  
  fs.writeFileSync(watchersFilePath, JSON.stringify(customWatchers, null, 2));
  logToFile('Custom Notion watchers saved to notion-watchers.json');
}

// Add all the missing meeting functions
// Load meetings from file
function loadMeetings() {
  if (fs.existsSync(meetingsFilePath)) {
    try {
      const data = fs.readFileSync(meetingsFilePath, 'utf8');
      const loadedMeetings = JSON.parse(data);
      logToFile(`Loaded ${loadedMeetings.length} existing meetings from file`);
      return loadedMeetings;
    } catch (error) {
      logToFile(`Error loading meetings file: ${error.message}`);
    }
  } else {
    logToFile('No meetings.json file found. Starting with empty meetings list.');
  }
  return [];
}

// Save meetings to file
function saveMeetings() {
  if (customMeetings.length === 0) {
    logToFile('No meetings to save');
    return;
  }
  
  fs.writeFileSync(meetingsFilePath, JSON.stringify(customMeetings, null, 2));
  logToFile(`Saved ${customMeetings.length} meetings to meetings.json`);
}

// Parse a time string into a Date
function parseTimeString(timeStr) {
  const now = new Date();
  
  // Handle relative time format (e.g., "30m" for 30 minutes from now)
  const relativeMatch = timeStr.match(/^(\d+)([mh])$/i);
  if (relativeMatch) {
    const [_, amount, unit] = relativeMatch;
    const milliseconds = unit.toLowerCase() === 'm' 
      ? parseInt(amount) * 60 * 1000 // minutes
      : parseInt(amount) * 60 * 60 * 1000; // hours
    
    const futureTime = new Date(now.getTime() + milliseconds);
    return futureTime;
  }
  
  // Handle absolute time format (e.g., "1400" for 2:00 PM today)
  const absoluteMatch = timeStr.match(/^(\d{1,2})(\d{2})$/);
  if (absoluteMatch) {
    const [_, hours, minutes] = absoluteMatch;
    const futureTime = new Date(now);
    futureTime.setHours(parseInt(hours));
    futureTime.setMinutes(parseInt(minutes));
    futureTime.setSeconds(0);
    
    // If the time is in the past, assume it's for tomorrow
    if (futureTime < now) {
      futureTime.setDate(futureTime.getDate() + 1);
    }
    
    return futureTime;
  }
  
  // Return null if format is not recognized
  return null;
}

// Send a DM to a user
async function sendDirectMessage(userId, message) {
  try {
    const user = await client.users.fetch(userId);
    await user.send(message);
    logToFile(`Sent DM to ${user.tag}: ${message}`);
    return true;
  } catch (error) {
    logToFile(`Error sending DM to user ${userId}: ${error.message}`);
    return false;
  }
}

// Function to find the first image URL in a set of messages
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

// Check for upcoming meetings and send reminders
async function checkMeetings() {
  if (customMeetings.length === 0) return;
  
  const now = new Date();
  
  // Check each meeting
  for (let i = customMeetings.length - 1; i >= 0; i--) {
    const meeting = customMeetings[i];
    
    // Skip if already notified
    if (meeting.notified) continue;
    
    // Parse the meeting time
    const meetingTime = meeting.scheduledTime 
      ? new Date(meeting.scheduledTime) 
      : parseTimeString(meeting.time);
    
    // Store the parsed time back to the meeting
    if (!meeting.scheduledTime && meetingTime) {
      meeting.scheduledTime = meetingTime.toISOString();
      saveMeetings();
    }
    
    // If time couldn't be parsed, skip
    if (!meetingTime) continue;
    
    // Calculate the reminder time (5 minutes before)
    const reminderTime = new Date(meetingTime.getTime() - 5 * 60 * 1000);
    
    // Check if it's time for the reminder
    if (now >= reminderTime && now < meetingTime) {
      // Send reminders
      const topicText = meeting.topic ? ` about "${meeting.topic}"` : '';
      const timeText = meetingTime.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true
      });
      
      // Handle multiple participants
      const participants = Array.isArray(meeting.participants) ? meeting.participants : 
                           (meeting.participant ? [meeting.participant] : []);
      
      // Handle legacy meeting format
      if (!Array.isArray(meeting.participants) && meeting.participant) {
        meeting.participants = [meeting.participant];
        delete meeting.participant;
        saveMeetings();
      }
      
      // Get participants as mentions
      const participantMentions = participants
        .filter(pid => pid !== meeting.createdBy) // Filter out creator if they're in the list
        .map(pid => `<@${pid}>`)
        .join(', ');
      
      // Add creator to the list for notification
      const allParticipants = [...new Set([meeting.createdBy, ...participants])];
      
      // Send DM to all participants
      for (const userId of allParticipants) {
        try {
          // Customize message based on whether user is creator or participant
          let message;
          if (userId === meeting.createdBy) {
            message = `🔔 Reminder: Your meeting${topicText} starts in 5 minutes (${timeText})!`;
            if (participantMentions) {
              message += ` Participants: ${participantMentions}`;
            }
          } else {
            message = `🔔 Reminder: <@${meeting.createdBy}> has scheduled a meeting${topicText} in 5 minutes (${timeText})!`;
          }
          
          await sendDirectMessage(userId, message);
          logToFile(`Sent reminder to user ${userId} for meeting ${meeting.id}`);
        } catch (dmError) {
          logToFile(`Failed to send reminder to user ${userId}: ${dmError.message}`);
        }
      }
      
      // Mark as notified
      meeting.notified = true;
      saveMeetings();
      
      logToFile(`Sent reminders for meeting ${meeting.id}`);
    }
    
    // Remove meetings that are more than an hour old
    if (meetingTime && (now.getTime() - meetingTime.getTime() > 60 * 60 * 1000)) {
      customMeetings.splice(i, 1);
      saveMeetings();
      logToFile(`Removed old meeting ${meeting.id}`);
    }
  }
}

// Schedule meeting checks
setInterval(checkMeetings, 60 * 1000); // Check every minute

// Load existing meetings
const loadedMeetings = loadMeetings();
if (loadedMeetings && loadedMeetings.length > 0) {
  customMeetings.push(...loadedMeetings);
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
    } 
    // Check if it's a bullet point or an actionable item (starting with - or •)
    else if (line.trim().match(/^[-•]\s+/)) {
      const text = line.trim().replace(/^[-•]\s+/, '');
      
      // Detect if this is an actionable item (contains action verbs or is a task)
      const isActionable = 
        text.match(/\b(do|add|create|update|change|fix|implement|review|check|test|verify|complete|finish|make|build|set up|configure|write|design|develop)\b/i) ||
        text.includes('task') || 
        text.includes('TODO') || 
        text.includes('to-do') ||
        text.includes('action item');
      
      if (isActionable) {
        // Create a to-do item (unchecked)
        blocks.push({
          object: 'block',
          type: 'to_do',
          to_do: {
            rich_text: [
              {
                type: 'text',
                text: {
                  content: text
                }
              }
            ],
            checked: false
          }
        });
      } else {
        // Regular bullet point
        blocks.push({
          object: 'block',
          type: 'bulleted_list_item',
          bulleted_list_item: {
            rich_text: [
              {
                type: 'text',
                text: {
                  content: text
                }
              }
            ]
          }
        });
      }
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
  
  // Check for formatted "Script document link: URL" format
  const formattedScriptMatch = content.match(/script\s*(?:document|doc)?\s*(?:link|url)?:?\s*(https?:\/\/[^\s]+)/i);
  if (formattedScriptMatch) {
    return formattedScriptMatch[1];
  }
  
  // Look for any Google Docs link with "script" nearby
  const nearbyScriptMatch = content.match(/script.*?(https:\/\/docs\.google\.com\/document\/[^\s]+)|(?:https:\/\/docs\.google\.com\/document\/[^\s]+).*?script/i);
  if (nearbyScriptMatch) {
    return nearbyScriptMatch[1] || nearbyScriptMatch[2];
  }
  
  // If no explicit script, look for any Google Docs link
  const docsMatch = content.match(/(https:\/\/docs\.google\.com\/document\/[^\s]+)/i);
  if (docsMatch) {
    return docsMatch[1];
  }
  
  // Check for Notion document links that might be scripts
  const notionMatch = content.match(/(https:\/\/[^\/]+\.notion\.site\/[^\s]+)/i);
  if (notionMatch && content.toLowerCase().includes('script')) {
    return notionMatch[1];
  }
  
  return null;
}

// Function to extract Frame.io links
function extractFrameioLink(content) {
  // Check for explicit Frame.io URL with different formats
  const explicitMatch = content.match(/(?:frame\.io|f\.io)\s*(?:link|url)?:?\s*(https?:\/\/(?:app\.)?(?:frame\.io|f\.io)\/[^\s]+)/i);
  if (explicitMatch) {
    return explicitMatch[1];
  }
  
  // Check for formatted "Frame.io link: URL" format
  const formattedMatch = content.match(/frame\.io\s*(?:link|url)?:?\s*(https?:\/\/[^\s]+)/i);
  if (formattedMatch) {
    return formattedMatch[1];
  }
  
  // Look for any Frame.io link
  const frameioMatch = content.match(/(https?:\/\/(?:app\.)?(?:frame\.io|f\.io)\/[^\s]+)/i);
  if (frameioMatch) {
    return frameioMatch[1];
  }
  
  return null;
}

function getNotionPageUrl(pageId) {
  if (!pageId) return null;
  // Format is: https://www.notion.so/{workspace}/{page-id}
  return `https://www.notion.so/${pageId.replace(/-/g, '')}`;
}

// Add handleSyncMessage function here
async function handleSyncMessage(msg) {
  // Check if OpenAI is available
  if (!openai) {
    await msg.reply('❌ OpenAI API key not configured. Cannot process sync command.');
    return;
  }
  
  // Create a reply function that suppresses notifications
  const quietReply = async (content) => {
    try {
      let replyOptions = typeof content === 'string' 
        ? { content, flags: [1 << 2] } // 1 << 2 is SUPPRESS_EMBEDS flag
        : { ...content, flags: [1 << 2] };
      
      return await msg.reply(replyOptions);
    } catch (err) {
      // Fallback to regular reply if something goes wrong
      logToFile(`Error sending quiet reply: ${err.message}`);
      return await msg.reply(content);
    }
  };
  
  const code = projectCode(msg.channel.name);
  if (!code) {
    await quietReply('No project code detected in channel name.');
    return;
  }

  // Get the first 50 messages to look for images
  const messages = await msg.channel.messages.fetch({ limit: 50 });
  const firstImageUrl = findFirstImageUrl(Array.from(messages.values()));

  // Check for dry run flag
  const isDryRun = msg.content.includes('--dry');
  const dryRunPrefix = isDryRun ? '[DRY RUN] ' : '';
  
  // Remove dry run flag from the text
  const userText = msg.content.slice(TRIGGER_PREFIX.length).trim().replace('--dry', '').trim();
  
  let isNewPage = false;
  
  // Check for URLs directly in the user message
  let directFrameioLink = null;
  let directScriptLink = null;

  try {
    directFrameioLink = extractFrameioLink(userText);
    if (directFrameioLink) {
      logToFile(`🔗 Found Frame.io link directly in user message: ${directFrameioLink}`);
    }
    
    directScriptLink = extractScriptLink(userText);
    if (directScriptLink) {
      logToFile(`🔗 Found script link directly in user message: ${directScriptLink}`);
    }
  } catch (error) {
    logToFile(`⚠️ Error checking for direct links: ${error.message}`);
  }

  // Find the Notion page for this project
  let pageId = await findPage(code);
  isNewPage = false;
  
  // If no page exists, create one
  if (!pageId) {
    await quietReply(`${dryRunPrefix}Creating new Notion page for project code "${code}"...`);
    
    // Create a new page with the channel name as the title
    if (!isDryRun) {
      pageId = await createNotionPage(code, msg.channel.name, {}, firstImageUrl);
      
      if (!pageId) {
        await quietReply('❌ Failed to create Notion page. Check logs for details.');
        return;
      }
    } else {
      logToFile(`💧 DRY RUN: Would create new Notion page for project "${code}"`);
    }
    
    isNewPage = true;
  }

  try {
    // Get current date in ISO format
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format

    const gpt = await openai.chat.completions.create({
      model: 'gpt-4o',
      temperature: 0,
      messages: [
        { role: 'system', content: ANALYSIS_SYSTEM_PROMPT },
        // Few-shot examples
        { role: 'user', content: '!sync Project is in VA render. Ray will do final cut.' },
        { role: 'assistant', function_call: { 
          name: 'update_properties',
          arguments: JSON.stringify({ status: 'VA Render', editor: ['Ray'] })
        }},
        { role: 'user', content: '!sync Suki owns it now. Due 12 Apr.' },
        { role: 'assistant', function_call: { 
          name: 'update_properties',
          arguments: JSON.stringify({ project_owner: ['Suki'], due_date: '2025-04-12' })
        }},
        // New example showing latest link wins
        { role: 'user', content: '!sync Here is our Frame.io: https://f.io/abc123. [Later] Actually use this updated Frame.io link: https://f.io/xyz789.' },
        { role: 'assistant', function_call: { 
          name: 'update_properties',
          arguments: JSON.stringify({ frameio_url: 'https://f.io/xyz789' })
        }},
        // Add example for stage date
        { role: 'user', content: 'Aiming to have the script revised and new VA render by tomorrow.' },
        { role: 'assistant', function_call: { 
          name: 'update_properties',
          arguments: JSON.stringify({ 
            status: 'VA Render', 
            current_stage_date: new Date(new Date().setDate(new Date().getDate() + 1)).toISOString().split('T')[0]
          })
        }},
        // Actual message
        { role: 'user', content: userText || `This is a new project with code ${code} in channel ${msg.channel.name}. Add appropriate initial properties.` }
      ],
      functions: [FUNC_SCHEMA],
      function_call: 'auto'
    });

    const call = gpt.choices[0].message.function_call;
    if (!call) {
      await quietReply('No relevant properties found.');
      return;
    }

    let props;
    try {
      props = JSON.parse(call.arguments);
    } catch (e) {
      console.error('JSON parse error', e, call.arguments);
      await quietReply('❌ Error parsing GPT response.');
      return;
    }

    // Add direct links found in user message if GPT didn't capture them
    if (directFrameioLink && !props.frameio_url) {
      props.frameio_url = directFrameioLink;
      logToFile(`📎 Adding Frame.io link from direct extraction: ${directFrameioLink}`);
    }

    if (directScriptLink && !props.script_url) {
      props.script_url = directScriptLink;
      logToFile(`📎 Adding script link from direct extraction: ${directScriptLink}`);
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
    
    // Try to extract Frame.io link if needed
    if (hasPageContent && !props.frameio_url && !notionProps['Frame.io']) {
      try {
        const frameioLink = extractFrameioLink(props.page_content);
        if (frameioLink) {
          logToFile(`📝 Found potential Frame.io link in content: ${frameioLink}`);
          // Add the Frame.io URL to properties
          try {
            notionProps['Frame.io'] = { url: frameioLink };
            hasPropertiesToUpdate = true;
          } catch (frameioError) {
            logToFile(`Error adding Frame.io URL to properties in !sync: ${frameioError.message}`);
            errorProperties.push("Frame.io URL");
          }
        }
      } catch (extractError) {
        logToFile(`Error extracting Frame.io link in !sync: ${extractError.message}`);
        errorProperties.push("Frame.io extraction");
      }
    }
    
    if (!hasPropertiesToUpdate && !hasPageContent && !isNewPage) {
      await quietReply('Nothing to update.');
      return;
    }

    // Track what was updated successfully
    let updatedProperties = false;
    let updatedContent = false;
    
    // Update page properties if needed
    if (hasPropertiesToUpdate && Object.keys(notionProps).length > 0) {
      try {
        if (!isDryRun) {
          await notion.pages.update({ 
            page_id: pageId, 
            properties: notionProps 
          });
          updatedProperties = true;
        } else {
          logToFile(`💧 DRY RUN: Would update these properties: ${JSON.stringify(notionProps)}`);
          updatedProperties = true; // Mark as "updated" for the summary even though we didn't actually update
        }
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
        if (!isDryRun) {
          await notion.blocks.children.append({
            block_id: pageId,
            children: contentBlocks
          });
          updatedContent = true;
        } else {
          logToFile(`💧 DRY RUN: Would add content: ${props.page_content.trim().substring(0, 100)}...`);
          updatedContent = true; // Mark as "updated" for the summary
        }
      } catch (contentError) {
        logToFile(`Error adding page content in !sync: ${contentError.message}`);
        errorProperties.push("Page content");
      }
    }

    // Create response message
    let responseDescription = '';
    if (isNewPage) {
      responseDescription += `✨ ${isDryRun ? 'Would create' : 'Created'} new Notion page for project **${code}**\n\n`;
      if (firstImageUrl) {
        responseDescription += `${isDryRun ? 'Would add' : 'Added'} first image from channel as thumbnail\n\n`;
      }
    }
    
    if (updatedProperties) {
      responseDescription += `${isDryRun ? 'Would update' : 'Updated'} properties:\n` + Object.keys(notionProps).map(k => `• **${k}**`).join('\n');
    }
    
    if (updatedContent) {
      if (responseDescription) responseDescription += '\n\n';
      responseDescription += `${isDryRun ? 'Would add' : 'Added'} notes to page content`;
    }
    
    // Add error information if any
    if (errorProperties.length > 0) {
      if (responseDescription) responseDescription += '\n\n';
      responseDescription += `⚠️ **Errors:** There were issues with: ${errorProperties.join(', ')}.\nOther updates were still applied.`;
    }

    // Make reply only visible to the command sender if possible
    // For slash commands this would be ephemeral, for normal messages this still replies
    try {
      // If this is from the /sync command via a fake msg (it has interaction property)
      if (msg.interaction) {
        // For interactions/slash commands, use editReply to maintain ephemeral status
        await msg.interaction.editReply({
          embeds: [{
            title: `${dryRunPrefix}✅ ${code} ${isNewPage ? 'created' : 'updated'}${errorProperties.length > 0 ? ' (with some errors)' : ''}`,
            description: responseDescription,
            color: isDryRun ? 0x00FFFF : (errorProperties.length > 0 ? 0xFFA500 : 0x57F287)
          }]
        });
      } else {
        // For regular messages, still try to make it somewhat discreet
        await quietReply({
          embeds: [{
            title: `${dryRunPrefix}✅ ${code} ${isNewPage ? 'created' : 'updated'}${errorProperties.length > 0 ? ' (with some errors)' : ''}`,
            description: responseDescription,
            color: isDryRun ? 0x00FFFF : (errorProperties.length > 0 ? 0xFFA500 : 0x57F287)
          }]
        });
      }
    } catch (replyError) {
      logToFile(`Error sending reply: ${replyError.message}`);
      // Fallback to regular reply
      const replyMsg = await quietReply({
        embeds: [{
          title: `${dryRunPrefix}✅ ${code} ${isNewPage ? 'created' : 'updated'}${errorProperties.length > 0 ? ' (with some errors)' : ''}`,
          description: responseDescription,
          color: isDryRun ? 0x00FFFF : (errorProperties.length > 0 ? 0xFFA500 : 0x57F287)
        }]
      });
      
      // Auto-delete the message after 5 minutes if it's a regular message (not ephemeral)
      if (replyMsg && replyMsg.deletable) {
        setTimeout(async () => {
          try {
            await replyMsg.delete();
            logToFile(`🗑️ Auto-deleted status update message for ${code} after 5 minutes`);
          } catch (deleteError) {
            logToFile(`Error deleting status message: ${deleteError.message}`);
          }
        }, 5 * 60 * 1000); // 5 minutes
      }
    }

    // After the main response embed:
    if (updatedProperties || updatedContent || isNewPage) {
      // Get the Notion URL for the page
      const notionUrl = getNotionPageUrl(pageId);
      
      // If we have a URL, send it back to the sender
      if (notionUrl) {
        try {
          // For interaction commands, add it to the existing ephemeral reply 
          if (msg.interaction) {
            await msg.interaction.followUp({
              content: `🔗 **Notion Page**: ${notionUrl}`,
              ephemeral: true  // Only visible to command sender
            });
          } else {
            // For regular messages, send via DM if possible, or channel as fallback
            try {
              await msg.author.send(`🔗 **Notion Page for ${code}**: ${notionUrl}`);
              logToFile(`Sent Notion URL via DM to ${msg.author.tag}`);
            } catch (dmError) {
              // Fallback to channel if DM fails
              logToFile(`Failed to send DM, falling back to channel: ${dmError.message}`);
              const linkMsg = await msg.channel.send({
                content: `🔗 **Notion Page**: ${notionUrl}`,
                flags: [1 << 2] // SUPPRESS_EMBEDS 
              });
              
              // Auto-delete the message after 5 minutes
              setTimeout(async () => {
                try {
                  await linkMsg.delete();
                  logToFile(`🗑️ Auto-deleted Notion link message for ${code} after 5 minutes`);
                } catch (deleteError) {
                  logToFile(`Error deleting Notion link message: ${deleteError.message}`);
                }
              }, 5 * 60 * 1000); // 5 minutes
            }
          }
        } catch (urlError) {
          logToFile(`Error sending Notion URL: ${urlError.message}`);
        }
      }
    }
  } catch (err) {
    console.error(err);
    quietReply('❌ Error updating Notion; check logs.');
  }
}
