const fs = require('fs');
const path = require('path');

// Read the original file
const filePath = path.join(__dirname, 'index.js');
let content = fs.readFileSync(filePath, 'utf8');

// Define the text to replace
const textToReplace = `// Initialize OpenAI client if API key is provided
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

const replacementText = `// Note: OpenAI client is already initialized at the top of the file
// let openai = null; (removed duplicate initialization)`;

// Replace the text
content = content.replace(textToReplace, replacementText);

// Write the modified content back to the file
fs.writeFileSync(filePath, content);

console.log('Successfully fixed OpenAI initialization in index.js'); 