// check-env.js
// Script to validate essential environment variables on startup

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('discord.js');

// Function to log to file
function log(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}\n`;
  
  try {
    // Append to log file
    fs.appendFileSync(path.join(__dirname, 'env-check.log'), logMessage);
    
    // Also log to console
    console.log(message);
  } catch (err) {
    console.error(`Error writing to log: ${err.message}`);
  }
}

// Function to check required environment variables
function checkEnvVars() {
  log('Checking environment variables...');
  
  const requiredVars = [
    'DISCORD_TOKEN',
    'NOTION_TOKEN',
    'NOTION_DATABASE_ID',
    'NOTION_CHANGELOG_DB_ID',
    'CLIENT_ID'
  ];
  
  const missingVars = [];
  
  requiredVars.forEach(varName => {
    if (!process.env[varName]) {
      missingVars.push(varName);
      log(`❌ Missing required environment variable: ${varName}`);
    } else {
      // Don't log the actual values for security
      log(`✅ Found ${varName}`);
    }
  });
  
  if (missingVars.length > 0) {
    log(`⚠️ WARNING: ${missingVars.length} required environment variables are missing!`);
    return false;
  }
  
  log('✅ All required environment variables are present');
  return true;
}

// Function to validate Discord token
async function validateDiscordToken() {
  log('Validating Discord token...');
  
  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    log('❌ Cannot validate Discord token: Token not found in environment variables');
    return false;
  }
  
  // Try to create a temporary client to validate the token
  const client = new Client({ intents: [] });
  
  try {
    log('Attempting to log in to Discord with the token...');
    
    // Set a timeout to avoid hanging indefinitely
    const loginPromise = client.login(token);
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Login timed out after 10 seconds')), 10000);
    });
    
    // Race the login against a timeout
    await Promise.race([loginPromise, timeoutPromise]);
    
    log('✅ Discord token is valid - successfully authenticated');
    
    // Clean up by destroying the client
    client.destroy();
    return true;
  } catch (error) {
    log(`❌ Discord token validation failed: ${error.message}`);
    
    // Attempt to clean up
    try {
      client.destroy();
    } catch (err) {
      // Ignore any errors during cleanup
    }
    
    return false;
  }
}

// Function to check if we can connect to the BODYCAM server
async function checkBodycamServer() {
  log('Checking access to BODYCAM server...');
  
  const token = process.env.DISCORD_TOKEN;
  const BODYCAM_SERVER_ID = '1290489132522672182';
  
  if (!token) {
    log('❌ Cannot check BODYCAM server: Token not found in environment variables');
    return false;
  }
  
  // Create a client with minimal intents
  const client = new Client({ intents: ['Guilds'] });
  
  try {
    // Log in to Discord
    await client.login(token);
    
    // Check if the bot is in the BODYCAM server
    const bodycamGuild = client.guilds.cache.get(BODYCAM_SERVER_ID);
    
    if (bodycamGuild) {
      log(`✅ Bot has access to BODYCAM server: ${bodycamGuild.name} (${bodycamGuild.id})`);
      
      // Get server info
      log(`Server details: ${bodycamGuild.memberCount} members, ${bodycamGuild.channels.cache.size} channels`);
      
      // Check permissions
      const botMember = bodycamGuild.members.cache.get(client.user.id);
      if (botMember) {
        const permissions = botMember.permissions.toArray();
        log(`Bot permissions in BODYCAM server: ${permissions.join(', ')}`);
      }
      
      client.destroy();
      return true;
    } else {
      log(`❌ Bot is not in the BODYCAM server with ID ${BODYCAM_SERVER_ID}`);
      client.destroy();
      return false;
    }
  } catch (error) {
    log(`❌ Error checking BODYCAM server: ${error.message}`);
    
    try {
      client.destroy();
    } catch (err) {
      // Ignore any errors during cleanup
    }
    
    return false;
  }
}

// Main function
async function runChecks() {
  log('=== Starting Environment Validation ===');
  
  // Check environment variables
  const envVarsOk = checkEnvVars();
  
  // Validate Discord token
  const tokenOk = await validateDiscordToken();
  
  // Check BODYCAM server access
  const bodycamOk = await checkBodycamServer();
  
  // Overall status
  log('=== Environment Validation Summary ===');
  log(`Environment Variables: ${envVarsOk ? '✅ OK' : '❌ ISSUES FOUND'}`);
  log(`Discord Token: ${tokenOk ? '✅ VALID' : '❌ INVALID'}`);
  log(`BODYCAM Server Access: ${bodycamOk ? '✅ ACCESSIBLE' : '❌ NOT ACCESSIBLE'}`);
  
  if (envVarsOk && tokenOk && bodycamOk) {
    log('✅ All checks passed - environment is properly configured');
    return true;
  } else {
    log('⚠️ Some checks failed - review the log for details');
    return false;
  }
}

// Run the checks
runChecks()
  .then(result => {
    log(`Environment validation ${result ? 'successful' : 'failed'}`);
    process.exit(result ? 0 : 1);
  })
  .catch(error => {
    log(`Error during environment validation: ${error.message}`);
    process.exit(1);
  }); 