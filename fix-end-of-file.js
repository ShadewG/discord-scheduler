// Script to completely fix the end of the index.js file
const fs = require('fs');
const path = require('path');

// Read the index.js file
const indexPath = path.join(__dirname, 'index.js');
let content = fs.readFileSync(indexPath, 'utf8');

// Find the last complete function in the file
const lastFunctionMatch = content.match(/function\s+(\w+)\s*\([^)]*\)\s*\{(?:[^{}]|{[^{}]*})*\}/g);
let lastCompleteFunction = '';

if (lastFunctionMatch && lastFunctionMatch.length > 0) {
  lastCompleteFunction = lastFunctionMatch[lastFunctionMatch.length - 1];
  console.log(`Found last complete function: ${lastCompleteFunction.substring(0, 50)}...`);
}

// Find the position of the last complete function
const lastFunctionPos = content.lastIndexOf(lastCompleteFunction);

if (lastFunctionPos !== -1) {
  // Keep everything up to and including the last complete function
  const cleanContent = content.substring(0, lastFunctionPos + lastCompleteFunction.length);
  
  // Add a proper closing to the file
  const fixedContent = cleanContent + '\n\n// End of file\n';
  
  // Write the fixed content back to the file
  fs.writeFileSync(indexPath, fixedContent);
  console.log('Successfully fixed the end of index.js');
} else {
  console.error('Could not find the last complete function');
  
  // As a fallback, let's truncate the file at a safe point
  const lines = content.split('\n');
  // Keep only the first 4500 lines to avoid the problematic area
  const safeContent = lines.slice(0, 4500).join('\n');
  
  // Add a proper closing to the file
  const fixedContent = safeContent + '\n\n// End of file\n';
  
  // Write the fixed content back to the file
  fs.writeFileSync(indexPath, fixedContent);
  console.log('Applied fallback fix by truncating the file to 4500 lines');
}
