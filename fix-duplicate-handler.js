const fs = require('fs');
const path = require('path');

// Read the original file
const filePath = path.join(__dirname, 'index.js');
let content = fs.readFileSync(filePath, 'utf8');

// Define the start and end of the section to remove
const startMarker = '// Find where the registerCommandsOnStartup function is being called';
const endMarker = '// Other command handlers continue here...';
const closingBrace = '});';

// Find the position of these markers
const startPos = content.indexOf(startMarker);
const endMarkerPos = content.indexOf(endMarker, startPos);

if (startPos !== -1 && endMarkerPos !== -1) {
  // Find the end of the code block (the closing brace and parenthesis after endMarker)
  const blockEndPos = content.indexOf(closingBrace, endMarkerPos) + closingBrace.length;
  
  // Replace the duplicate handler with a comment
  const beforeBlock = content.substring(0, startPos);
  const afterBlock = content.substring(blockEndPos);
  
  const replacementComment = 
    '// NOTE: The duplicate command handler for /extract-tasks was removed from here\n' +
    '// This was causing the issue with tasks not being properly created\n' +
    '// The main handler is already defined at line ~985\n\n';
  
  // Create the new content
  const newContent = beforeBlock + replacementComment + afterBlock;
  
  // Write the fixed file
  const backupPath = path.join(__dirname, 'index.js.bak-before-fix');
  fs.writeFileSync(backupPath, content, 'utf8');
  fs.writeFileSync(filePath, newContent, 'utf8');
  
  console.log(`✅ Successfully removed duplicate handler! Original backed up to ${backupPath}`);
} else {
  console.error('❌ Could not find the duplicate handler section.');
} 