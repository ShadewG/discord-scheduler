// run-local.js - A script to run the bot locally for testing
// This script helps run a local instance of the bot while the Railway instance remains active

// Load environment variables
const path = require('path');
const dotenv = require('dotenv');
const fs = require('fs');
const { spawn } = require('child_process');

// Define paths
const envPath = path.resolve(__dirname, '.env');
const localEnvPath = path.resolve(__dirname, '.env.local');

// Check if .env.local exists, if not create it from .env
if (!fs.existsSync(localEnvPath) && fs.existsSync(envPath)) {
  console.log('Creating .env.local from .env...');
  
  // Read the .env file
  const envContent = fs.readFileSync(envPath, 'utf8');
  
  // Create .env.local with a comment indicating it's for local testing
  const localEnvContent = 
`# Local testing environment - created by run-local.js
# This file is used for local testing and won't affect your Railway deployment
# You can modify this file to use different tokens or settings for local testing

${envContent}

# Add any local-specific settings below
NODE_ENV=development
`;

  // Write to .env.local
  fs.writeFileSync(localEnvPath, localEnvContent);
  console.log('.env.local created successfully!');
}

// Function to run a command with .env.local
function runWithLocalEnv(command, args = []) {
  console.log(`Running: ${command} ${args.join(' ')}`);
  
  const childProcess = spawn(command, args, {
    env: { ...process.env, DOTENV_CONFIG_PATH: localEnvPath },
    stdio: 'inherit'
  });
  
  childProcess.on('error', (error) => {
    console.error(`Error running ${command}: ${error.message}`);
  });
  
  return childProcess;
}

// Parse command line arguments
const args = process.argv.slice(2);
const command = args[0] || 'start';

switch (command) {
  case 'start':
    console.log('Starting bot locally using .env.local...');
    runWithLocalEnv('node', ['-r', 'dotenv/config', 'index.js', 'dotenv_config_path=.env.local']);
    break;
    
  case 'register':
    console.log('Registering commands locally using .env.local...');
    runWithLocalEnv('node', ['-r', 'dotenv/config', 'fix-commands.js', 'dotenv_config_path=.env.local']);
    break;
    
  case 'test':
    console.log('Running tests locally using .env.local...');
    runWithLocalEnv('node', ['-r', 'dotenv/config', 'test.js', 'dotenv_config_path=.env.local']);
    break;
    
  case 'edit-env':
    // Open the .env.local file in the default editor
    console.log('Opening .env.local for editing...');
    if (process.platform === 'win32') {
      runWithLocalEnv('notepad', [localEnvPath]);
    } else if (process.platform === 'darwin') {
      runWithLocalEnv('open', [localEnvPath]);
    } else {
      runWithLocalEnv('nano', [localEnvPath]);
    }
    break;
    
  default:
    console.log(`
Local Testing Helper for Discord Bot
===================================

Usage:
  node run-local.js [command]

Commands:
  start       Start the bot locally (default)
  register    Register Discord commands locally
  test        Run test.js locally
  edit-env    Open .env.local for editing

Examples:
  node run-local.js start
  node run-local.js register
`);
}
