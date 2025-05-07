// Script to schedule automatic updates of the knowledge base
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const { spawn } = require('child_process');

// Setup logging
const LOGS_DIR = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

function log(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}\n`;
  fs.appendFileSync(path.join(LOGS_DIR, 'knowledge-updates.log'), logMessage);
  console.log(message);
}

// Function to run a script
function runScript(scriptName) {
  return new Promise((resolve, reject) => {
    log(`Running ${scriptName}...`);
    
    const process = spawn('node', [path.join(__dirname, scriptName)], {
      stdio: 'pipe'
    });
    
    let output = '';
    
    process.stdout.on('data', (data) => {
      const text = data.toString();
      output += text;
    });
    
    process.stderr.on('data', (data) => {
      const text = data.toString();
      output += text;
    });
    
    process.on('close', (code) => {
      if (code === 0) {
        log(`${scriptName} completed successfully`);
        resolve(output);
      } else {
        log(`${scriptName} failed with code ${code}`);
        reject(new Error(`Process exited with code ${code}: ${output}`));
      }
    });
    
    process.on('error', (err) => {
      log(`Error starting ${scriptName}: ${err.message}`);
      reject(err);
    });
  });
}

// Function to run all knowledge update tasks
async function updateKnowledgeBase() {
  try {
    log('Starting knowledge base update process');
    
    // Step 1: Backup Discord messages
    await runScript('backup-messages.js');
    
    // Step 2: Convert PDF guides to text
    await runScript('convert-guides.js');
    
    log('Knowledge base update completed successfully');
  } catch (error) {
    log(`Error updating knowledge base: ${error.message}`);
  }
}

// Schedule the knowledge update process
// Default: Run daily at 3:00 AM
const CRON_SCHEDULE = process.env.KNOWLEDGE_UPDATE_SCHEDULE || '0 3 * * *';

log(`Setting up scheduled knowledge base updates with schedule: ${CRON_SCHEDULE}`);

// Validate cron schedule
if (!cron.validate(CRON_SCHEDULE)) {
  log(`Invalid cron schedule: ${CRON_SCHEDULE}. Using default schedule: 0 3 * * *`);
}

// Schedule the job
const job = cron.schedule(CRON_SCHEDULE, () => {
  log(`Running scheduled knowledge base update (${new Date().toISOString()})`);
  updateKnowledgeBase();
}, {
  scheduled: true,
  timezone: process.env.TIMEZONE || 'UTC'
});

log('Knowledge base update scheduler started');

// Handle process termination
process.on('SIGINT', () => {
  job.stop();
  log('Knowledge base update scheduler stopped due to SIGINT');
  process.exit(0);
});

process.on('SIGTERM', () => {
  job.stop();
  log('Knowledge base update scheduler stopped due to SIGTERM');
  process.exit(0);
});

// Run immediately if requested
if (process.argv.includes('--run-now')) {
  log('Running immediate knowledge base update (--run-now flag detected)');
  updateKnowledgeBase();
} 