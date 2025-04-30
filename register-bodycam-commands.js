// register-bodycam-commands.js
// Script to register all commands except schedule-related ones to the INSANITY BODYCAM server

const { REST, Routes } = require('discord.js');
const { commands, commandsToJSON } = require('./commands');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// Get the token from environment variables
const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID; // Bot's client ID
const BODYCAM_SERVER_ID = '1290489132522672182';

// Function to log to file
function logToFile(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}\n`;
  
  // Append to log file
  fs.appendFileSync(path.join(__dirname, 'command-registration.log'), logMessage);
  
  // Also log to console
  console.log(message);
}

// Main function
async function registerCommandsToBodycamServer() {
  try {
    logToFile('🔄 Registering commands to INSANITY BODYCAM server...');
    
    if (!TOKEN) {
      logToFile('❌ Discord token not found in environment variables.');
      console.error('Error: Discord token not found in environment variables.');
      return;
    }
    
    // Extract client ID from environment or from token
    let clientId = CLIENT_ID;
    
    // If no client ID in environment, extract from token (tokens have the client ID encoded in them)
    if (!clientId && TOKEN) {
      try {
        // Discord tokens are in format: [client_id].[timestamp].[hmac]
        // The first part is base64 encoded
        const tokenParts = TOKEN.split('.');
        if (tokenParts.length >= 1) {
          const encodedId = tokenParts[0];
          clientId = Buffer.from(encodedId, 'base64').toString();
          logToFile(`Extracted client ID from token: ${clientId}`);
        }
      } catch (err) {
        logToFile(`❌ Error extracting client ID from token: ${err.message}`);
      }
    }
    
    if (!clientId) {
      logToFile('❌ Client ID not found and could not be extracted from token.');
      console.error('Error: Client ID not provided and could not be extracted from token.');
      
      // Try to find the client ID from the files in the directory
      const findClientId = () => {
        try {
          const files = fs.readdirSync(__dirname);
          for (const file of files) {
            if (file.endsWith('.js') && file !== 'register-bodycam-commands.js') {
              const content = fs.readFileSync(path.join(__dirname, file), 'utf8');
              const match = content.match(/const\s+CLIENT_ID\s*=\s*['"]([^'"]+)['"]/);
              if (match && match[1]) {
                return match[1];
              }
            }
          }
        } catch (err) {
          logToFile(`Error searching for client ID: ${err.message}`);
        }
        return null;
      };
      
      clientId = findClientId();
      if (clientId) {
        logToFile(`Found client ID in files: ${clientId}`);
      } else {
        return;
      }
    }
    
    // Initialize REST API client
    const rest = new REST({ version: '10' }).setToken(TOKEN);
    
    logToFile(`Using client ID: ${clientId}`);
    
    // Get all commands except schedule-related ones
    const commandsToRegister = [
      ...commands.basic,
      ...commands.notion,
      ...commands.utility
    ];
    
    // Convert to JSON format
    const commandsData = commandsToJSON(commandsToRegister);
    
    logToFile(`Registering ${commandsToRegister.length} commands to server ${BODYCAM_SERVER_ID}`);
    commandsToRegister.forEach(cmd => {
      logToFile(`- ${cmd.name}`);
    });
    
    // Register commands to the guild
    await rest.put(
      Routes.applicationGuildCommands(clientId, BODYCAM_SERVER_ID),
      { body: commandsData },
    );
    
    logToFile(`✅ Successfully registered commands to INSANITY BODYCAM server (${BODYCAM_SERVER_ID})`);
    
  } catch (error) {
    logToFile(`❌ Error registering commands: ${error.message}`);
    if (error.rawError) {
      logToFile(`API Error details: ${JSON.stringify(error.rawError, null, 2)}`);
    }
    console.error('Error registering commands:', error);
  }
}

// Run the function
registerCommandsToBodycamServer()
  .then(() => {
    logToFile('Command registration process completed.');
  })
  .catch(error => {
    logToFile(`Unhandled error in registration process: ${error.message}`);
    console.error('Unhandled error:', error);
  }); 