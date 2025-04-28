// Script to fix try blocks without corresponding catch blocks
const fs = require('fs');
const path = require('path');

// Read the index.js file
const indexPath = path.join(__dirname, 'index.js');
let content = fs.readFileSync(indexPath, 'utf8');

// Function to find unmatched try blocks
function findUnmatchedTryBlocks(code) {
  const lines = code.split('\n');
  const tryLines = [];
  const catchLines = [];
  
  // Find all try and catch blocks
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.includes('try {') || line === 'try {' || line.startsWith('try {')) {
      tryLines.push(i);
    }
    if (line.includes('catch') || line.startsWith('catch')) {
      catchLines.push(i);
    }
  }
  
  console.log(`Found ${tryLines.length} try blocks and ${catchLines.length} catch blocks`);
  
  // Check if there are more try blocks than catch blocks
  if (tryLines.length > catchLines.length) {
    console.log('There are unmatched try blocks. Fixing...');
    
    // Find the unmatched try blocks
    const unmatchedTryLines = [];
    for (const tryLine of tryLines) {
      let hasMatchingCatch = false;
      for (const catchLine of catchLines) {
        if (catchLine > tryLine && catchLine - tryLine < 100) { // Assume catch is within 100 lines of try
          hasMatchingCatch = true;
          break;
        }
      }
      if (!hasMatchingCatch) {
        unmatchedTryLines.push(tryLine);
      }
    }
    
    return unmatchedTryLines;
  }
  
  return [];
}

// Find unmatched try blocks
const unmatchedTryLines = findUnmatchedTryBlocks(content);

if (unmatchedTryLines.length > 0) {
  console.log(`Found ${unmatchedTryLines.length} unmatched try blocks at lines: ${unmatchedTryLines.join(', ')}`);
  
  // Fix the unmatched try blocks by adding catch blocks
  const lines = content.split('\n');
  
  // Start from the end to avoid messing up line numbers
  for (let i = unmatchedTryLines.length - 1; i >= 0; i--) {
    const tryLine = unmatchedTryLines[i];
    
    // Find the closing brace of the try block
    let braceCount = 0;
    let closingBraceLine = -1;
    
    for (let j = tryLine; j < lines.length; j++) {
      const line = lines[j];
      
      for (let k = 0; k < line.length; k++) {
        if (line[k] === '{') braceCount++;
        if (line[k] === '}') {
          braceCount--;
          if (braceCount === 0) {
            closingBraceLine = j;
            break;
          }
        }
      }
      
      if (closingBraceLine !== -1) break;
    }
    
    if (closingBraceLine !== -1) {
      console.log(`Adding catch block after line ${closingBraceLine}`);
      
      // Add catch block after the closing brace
      lines.splice(closingBraceLine + 1, 0, '} catch (error) {', '  console.error(`Error: ${error.message}`);', '  return null;');
    }
  }
  
  // Join the lines back together
  const fixedContent = lines.join('\n');
  
  // Write the fixed content back to the file
  fs.writeFileSync(indexPath, fixedContent);
  console.log('Successfully fixed unmatched try blocks in index.js');
} else {
  console.log('No unmatched try blocks found in index.js');
  
  // As a fallback, let's check for the specific error at line 4586
  const lines = content.split('\n');
  if (lines.length >= 4586 && lines[4585].trim() === '}') {
    console.log('Found potential error at line 4586. Adding catch block as fallback fix.');
    
    // Add catch block after line 4586
    lines.splice(4586, 0, '} catch (error) {', '  console.error(`Error: ${error.message}`);', '  return null;');
    
    // Write the fixed content back to the file
    fs.writeFileSync(indexPath, lines.join('\n'));
    console.log('Applied fallback fix at line 4586');
  }
}
