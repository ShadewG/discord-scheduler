/**
 * This script applies essential fixes to the Discord bot code:
 * 1. Makes OpenAI initialization optional (bot works without OPENAI_API_KEY)
 * 2. Prioritizes critical commands (/link, /where, /availability) in registration
 */

const fs = require('fs');
const path = require('path');

// Path to main bot file
const indexPath = path.join(__dirname, 'index.js');

console.log('🔧 Discord Bot Auto-Fix Script');
console.log('────────────────────────────');

// Read the current content
console.log('📄 Reading index.js...');
let content;
try {
  content = fs.readFileSync(indexPath, 'utf8');
  console.log('✅ File read successfully');
} catch (err) {
  console.error(`❌ Error reading file: ${err.message}`);
  process.exit(1);
}

// Apply Fix 1: Make OpenAI initialization optional
console.log('🔄 Making OpenAI initialization optional...');
const openaiRegex = /\/\/ Initialize API clients\s+const openai = new OpenAI\(\{ apiKey: OPENAI_API_KEY \}\);/;
const openaiReplacement = `// Initialize API clients - make OpenAI optional
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
}`;

content = content.replace(openaiRegex, openaiReplacement);

// Apply Fix 2: Add checks for OpenAI in handleSyncMessage
console.log('🔄 Adding OpenAI checks to handleSyncMessage...');
const syncMessageRegex = /\/\/ Add handleSyncMessage function here\s+async function handleSyncMessage\(msg\) \{\s+\/\/ Create a reply function/;
const syncMessageReplacement = `// Add handleSyncMessage function here
async function handleSyncMessage(msg) {
  // Check if OpenAI is available
  if (!openai) {
    await msg.reply('❌ OpenAI API key not configured. Cannot process sync command.');
    return;
  }
  
  // Create a reply function`;

content = content.replace(syncMessageRegex, syncMessageReplacement);

// Apply Fix 3: Prioritize critical commands in registerCommands
console.log('🔄 Updating command registration to prioritize critical commands...');
const registerCommandsRegex = /async function registerCommands\(clientId, guildId\) \{\s+try \{/;
const registerCommandsReplacement = `async function registerCommands(clientId, guildId) {
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
    commands.unshift(...criticalCommands);`;

content = content.replace(registerCommandsRegex, registerCommandsReplacement);

// Save the modified content
console.log('💾 Saving changes...');
try {
  fs.writeFileSync(indexPath, content);
  console.log('✅ File updated successfully');
} catch (err) {
  console.error(`❌ Error saving file: ${err.message}`);
  process.exit(1);
}

console.log('');
console.log('🎉 All fixes applied successfully!');
console.log('⏭️ Next steps:');
console.log('  1. Commit the changes: git add index.js apply-fixes.js');
console.log('  2. Push to Railway: git commit -m "Fix OpenAI error and command registration" && git push origin refactor-modular');
console.log('');
console.log('The bot should now:');
console.log('  - Start even without an OpenAI API key');
console.log('  - Prioritize critical commands (/link, /where, /availability) during registration');
console.log('  - Skip AI features gracefully when OpenAI isn\'t available');

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