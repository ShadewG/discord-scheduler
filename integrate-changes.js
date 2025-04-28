// integrate-changes.js
// Script to integrate the changes from changelog-enhancement.js and status-watcher.js into index.js

const fs = require('fs');
const path = require('path');

// Log function
function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
  fs.appendFileSync('implement-changes.log', `${message}\n`);
}

// Paths to files
const indexPath = path.join(__dirname, 'index.js');
const statusWatcherPath = path.join(__dirname, 'status-watcher.js');
const changelogPath = path.join(__dirname, 'changelog-enhancement.js');
const backupPath = path.join(__dirname, 'index.js.backup-implementation');

// Read files
log('Reading files...');
const indexContent = fs.readFileSync(indexPath, 'utf8');
const statusWatcherContent = fs.readFileSync(statusWatcherPath, 'utf8');
const changelogContent = fs.readFileSync(changelogPath, 'utf8');

// Create backup
log('Creating backup of index.js...');
fs.writeFileSync(backupPath, indexContent);

// 1. Add Status Watchers configuration
log('1. Adding Status Watchers configuration...');

// Find the right spot after environment variables are loaded
const envVarsLoadedPattern = /const GUILD_ID = process\.env\.GUILD_ID;/;
const statusWatchersConfig = `
// Status watchers configuration
const STATUS_WATCHERS = [
  {
    status: "MGX Review/Cleanup",
    userId: "348547268695162890",
    message: "This project might be ready for dubbing, check with the leads"
  }
  // Additional watchers can be added in the future
];`;

let updatedContent = indexContent.replace(
  envVarsLoadedPattern, 
  `$&\n${statusWatchersConfig}`
);

// 2. Add checkStatusAndNotify function
log('2. Adding checkStatusAndNotify function...');

// Find a good spot after utility functions, before command handlers
const beforeCommandHandlersPattern = /\/\/ Handle slash command interactions/;
const checkStatusFunction = `
// Function to check status and trigger notifications
async function checkStatusAndNotify(projectCode, newStatus, channelId) {
  try {
    logToFile(\`Checking status watchers for project \${projectCode} with status "\${newStatus}"\`);
    
    // Find watchers that match this status
    const matchingWatchers = STATUS_WATCHERS.filter(watcher => 
      watcher.status.toLowerCase() === newStatus.toLowerCase());
    
    if (matchingWatchers.length === 0) {
      logToFile(\`No status watchers found for status "\${newStatus}"\`);
      return;
    }
    
    logToFile(\`Found \${matchingWatchers.length} matching watchers for status "\${newStatus}"\`);
    
    // If we don't have a channel ID, we can't send a notification
    if (!channelId) {
      logToFile(\`No channel ID provided, can't send notification for project \${projectCode}\`);
      return;
    }
    
    // Find the channel
    const channel = client.channels.cache.get(channelId);
    if (!channel) {
      logToFile(\`Could not find channel with ID \${channelId} for project \${projectCode}\`);
      return;
    }
    
    // Send a notification for each matching watcher
    for (const watcher of matchingWatchers) {
      try {
        const message = \`<@\${watcher.userId}> \${watcher.message}\`;
        logToFile(\`Sending status notification to user \${watcher.userId} in channel #\${channel.name}\`);
        
        await channel.send(message);
        logToFile(\`Successfully sent status notification for \${projectCode} to user \${watcher.userId}\`);
      } catch (error) {
        logToFile(\`Error sending status notification: \${error.message}\`);
      }
    }
  } catch (error) {
    logToFile(\`Error in checkStatusAndNotify: \${error.message}\`);
  }
}`;

updatedContent = updatedContent.replace(
  beforeCommandHandlersPattern, 
  `${checkStatusFunction}\n\n$&`
);

// 3. Add status watcher check to the /set command
log('3. Adding status watcher check to /set command...');

// Find the status subcommand in the /set command
const setStatusSubcommandPattern = /if \(subcommand === 'status'\) {([^}]*)/;
const statusWatcherCheck = `
      // Check status watchers and send notifications if needed
      checkStatusAndNotify(projectCode, value, channel.id);
      `;

updatedContent = updatedContent.replace(
  setStatusSubcommandPattern, 
  `if (subcommand === 'status') {${statusWatcherCheck}$1`
);

// 4. Replace the changelog command with the enhanced version
log('4. Replacing /changelog command with enhanced version...');

// Extract the enhanced changelog command logic
const changelogCommandPattern = /else if \(commandName === 'changelog'\) {[\s\S]*?(?=\s*\/\/ Handle the \/\w+ command|$)/;
// Extract enhanced changelog command from changelogContent
const enhancedChangelogMatch = changelogContent.match(/else if \(commandName === 'changelog'\) {[\s\S]*?(?=\s*})/);

if (enhancedChangelogMatch) {
  const enhancedChangelogCommand = enhancedChangelogMatch[0] + '}';
  
  // Check if the changelog command exists in the original file
  const originalChangelogMatch = updatedContent.match(changelogCommandPattern);
  
  if (originalChangelogMatch) {
    // Replace existing changelog command
    updatedContent = updatedContent.replace(
      changelogCommandPattern,
      enhancedChangelogCommand + '\n\n'
    );
  } else {
    // Add at the end of command handlers, before the next section
    const lastCommandPattern = /\/\/ Handle other commands here/;
    updatedContent = updatedContent.replace(
      lastCommandPattern,
      enhancedChangelogCommand + '\n\n$&'
    );
  }
}

// 5. Write the updated content back to index.js
log('5. Writing updated content to index.js...');
fs.writeFileSync(indexPath, updatedContent);

log('Changes implemented successfully!');
log('Please run the following commands to commit and push the changes:');
log('git add index.js');
log('git commit -m "Implement enhanced changelog and status watcher"');
log('git push'); 