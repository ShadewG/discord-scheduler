// Knowledge Assistant for Discord Bot
// Provides access to guides and Discord messages to answer questions
require('dotenv').config();
const { Client: NotionClient } = require('@notionhq/client');
const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder } = require('discord.js');
const { OpenAI } = require('openai');

// Try to load pdf-parse, but don't crash if it's not available
let pdfParse = null;
try {
  pdfParse = require('pdf-parse');
  console.log('pdf-parse module loaded successfully');
} catch (error) {
  console.error(`Error loading pdf-parse module: ${error.message}`);
  console.log('PDF processing will be disabled');
}

// Initialize OpenAI
let openai = null;
try {
  if (process.env.OPENAI_API_KEY) {
    openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });
    console.log('OpenAI client initialized successfully');
  } else {
    console.log('⚠️ OPENAI_API_KEY not found in environment. Knowledge assistant will not be available.');
  }
} catch (error) {
  console.error(`Error initializing OpenAI: ${error.message}`);
}

// Set the AI model to use
const AI_MODEL = 'gpt-4.1-2025-04-14';

// Log utility function
function logToFile(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}\n`;
  
  // Ensure logs directory exists
  const logsDir = path.join(__dirname, 'logs');
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }
  
  fs.appendFileSync(path.join(logsDir, 'knowledge-assistant.log'), logMessage);
}

// Function to extract text from PDF files
async function extractTextFromPDF(filePath) {
  try {
    // Check if pdfParse is available
    if (!pdfParse) {
      logToFile(`Cannot extract text from PDF ${filePath}: pdf-parse module is not available`);
      return `[PDF text extraction not available - please install pdf-parse]`;
    }
    
    const dataBuffer = fs.readFileSync(filePath);
    const data = await pdfParse(dataBuffer);
    
    // Limit text to 50,000 characters to prevent excessive memory usage
    const maxLength = 50000;
    const text = data.text.substring(0, maxLength);
    
    if (data.text.length > maxLength) {
      logToFile(`PDF ${filePath} text was truncated from ${data.text.length} to ${maxLength} characters`);
    }
    
    return text;
  } catch (error) {
    logToFile(`Error extracting text from PDF ${filePath}: ${error.message}`);
    return '';
  }
}

// Function to load all guides from the guides folder
async function loadGuides() {
  const guidesDir = path.join(__dirname, 'guides');
  const textGuidesDir = path.join(guidesDir, 'text');
  const guides = {};

  try {
    // Check if guides directory exists
    if (!fs.existsSync(guidesDir)) {
      logToFile(`Guides directory ${guidesDir} does not exist`);
      return guides;
    }
    
    // First check if we have text/JSON versions of the guides
    if (fs.existsSync(textGuidesDir)) {
      const textFiles = fs.readdirSync(textGuidesDir);
      
      // Look for JSON files (they contain more metadata)
      for (const file of textFiles) {
        if (file.toLowerCase().endsWith('.json')) {
          const filePath = path.join(textGuidesDir, file);
          logToFile(`Loading guide from JSON: ${file}`);
          
          try {
            const guideData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            guides[guideData.sourceFile] = {
              name: guideData.title,
              content: guideData.content,
              path: filePath,
              source: 'json'
            };
            
            logToFile(`Loaded ${guideData.contentLength} characters from ${file}`);
          } catch (parseError) {
            logToFile(`Error parsing JSON guide ${file}: ${parseError.message}`);
          }
        }
      }
      
      // If we found JSON guides, return them
      if (Object.keys(guides).length > 0) {
        logToFile(`Loaded ${Object.keys(guides).length} guides from JSON files`);
        return guides;
      }
      
      // Otherwise, check for text files
      for (const file of textFiles) {
        if (file.toLowerCase().endsWith('.txt')) {
          const filePath = path.join(textGuidesDir, file);
          const baseName = path.basename(file, '.txt') + '.pdf';
          logToFile(`Loading guide from text file: ${file}`);
          
          try {
            const content = fs.readFileSync(filePath, 'utf8');
            guides[baseName] = {
              name: path.basename(file, '.txt'),
              content: content,
              path: filePath,
              source: 'text'
            };
            
            logToFile(`Loaded ${content.length} characters from ${file}`);
          } catch (readError) {
            logToFile(`Error reading text guide ${file}: ${readError.message}`);
          }
        }
      }
      
      // If we found text guides, return them
      if (Object.keys(guides).length > 0) {
        logToFile(`Loaded ${Object.keys(guides).length} guides from text files`);
        return guides;
      }
    }
    
    // If we don't have text/JSON versions, fall back to PDF parsing
    // Check if pdf-parse is available
    if (!pdfParse) {
      logToFile('PDF processing is disabled - cannot load guides from PDFs');
      return guides;
    }
    
    const files = fs.readdirSync(guidesDir);

    for (const file of files) {
      if (file.toLowerCase().endsWith('.pdf')) {
        const filePath = path.join(guidesDir, file);
        logToFile(`Loading guide from PDF: ${file}`);
        
        const content = await extractTextFromPDF(filePath);
        guides[file] = {
          name: file.replace('.pdf', ''),
          content: content,
          path: filePath,
          source: 'pdf'
        };
        
        logToFile(`Loaded ${content.length} characters from ${file}`);
      }
    }

    return guides;
  } catch (error) {
    logToFile(`Error loading guides: ${error.message}`);
    return {};
  }
}

// Function to load Discord message backups
function loadDiscordMessages() {
  const backupsDir = path.join(__dirname, 'backups');
  let messages = [];

  try {
    // First, check for real-time messages in memory
    const recentMessagesFromBot = global.recentMessages || [];
    if (recentMessagesFromBot.length > 0) {
      logToFile(`Loaded ${recentMessagesFromBot.length} real-time messages from memory`);
      messages = [...recentMessagesFromBot];
    }
    
    // Then check for message backups
    if (!fs.existsSync(backupsDir)) {
      logToFile('Backups directory not found');
      return messages;
    }
    
    const files = fs.readdirSync(backupsDir);
    
    for (const file of files) {
      if (file.endsWith('.json')) {
        const filePath = path.join(backupsDir, file);
        logToFile(`Loading Discord backup: ${file}`);
        
        try {
          const backup = JSON.parse(fs.readFileSync(filePath, 'utf8'));
          if (backup.messages && Array.isArray(backup.messages)) {
            messages.push(...backup.messages);
            logToFile(`Loaded ${backup.messages.length} messages from ${file}`);
          }
        } catch (parseError) {
          logToFile(`Error parsing backup file ${file}: ${parseError.message}`);
        }
      }
    }
    
    return messages;
  } catch (error) {
    logToFile(`Error loading Discord messages: ${error.message}`);
    return messages;
  }
}

// Function to answer a question using guides and Discord messages
async function answerQuestion(question, discordMessages, guides) {
  try {
    logToFile(`Processing question: ${question}`);
    
    // Check if OpenAI is initialized
    if (!openai) {
      return "The Knowledge Assistant is not available because the OpenAI API key is not configured. Please ask an administrator to add an OpenAI API key to the .env file.";
    }
    
    // Format context from guides
    let guidesContext = '';
    Object.keys(guides).slice(0, 3).forEach(key => {
      const guide = guides[key];
      // Get the first 2000 characters of each guide for context
      guidesContext += `=== From Guide: ${guide.name} ===\n${guide.content.substring(0, 2000)}\n\n`;
    });
    
    // Format context from Discord messages
    let discordContext = '';
    
    // Get the 20 most recent messages that might be relevant
    const relevantMessages = discordMessages
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, 20);
    
    if (relevantMessages.length > 0) {
      discordContext = "=== Recent Discord Messages ===\n";
      relevantMessages.forEach(msg => {
        discordContext += `${msg.author.tag}: ${msg.content}\n`;
      });
    }
    
    // Create the system prompt
    const systemPrompt = `
You are a knowledgeable assistant for a content creation team that specializes in video production.
You have access to official guides and Discord messages to provide accurate, helpful information.
When answering questions, prioritize information from the guides but also consider Discord messages for recent context.
Always cite your sources when providing information, and indicate whether it's from guides or Discord conversations.
If you don't have enough information to answer a question, acknowledge that limitation and suggest what information would be needed.

Here are relevant excerpts from the guides and Discord messages to help you answer the question:

${guidesContext}

${discordContext}`;

    // Call the OpenAI API
    const response = await openai.chat.completions.create({
      model: AI_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: question }
      ],
      temperature: 0.3,
      max_tokens: 1500
    });
    
    return response.choices[0]?.message?.content || "I couldn't generate an answer.";
  } catch (error) {
    logToFile(`Error answering question: ${error.message}`);
    return `Error processing your question: ${error.message}`;
  }
}

// Function to handle the /ask command
async function handleAskCommand(interaction) {
  try {
    // Check if ephemeral flag is set
    const ephemeral = interaction.options.getBoolean('ephemeral') || false;
    
    await interaction.deferReply({ ephemeral });
    
    const question = interaction.options.getString('question');
    if (!question) {
      return await interaction.editReply('Please provide a question to ask.');
    }
    
    logToFile(`Loading knowledge base for question: ${question}`);
    
    // Load guides and Discord messages for context
    const guides = await loadGuides();
    const discordMessages = loadDiscordMessages();
    
    logToFile(`Loaded ${Object.keys(guides).length} guides and ${discordMessages.length} Discord messages`);
    
    // If no guides were loaded, inform the user about potential issues
    if (Object.keys(guides).length === 0) {
      const errorEmbed = new EmbedBuilder()
        .setTitle('Knowledge Assistant - Limited Functionality')
        .setDescription(`**Question:** ${question}\n\n**Answer:**\nI'm currently operating with limited functionality because no guides were found. Make sure guides are available in the 'guides' folder.`)
        .setColor(0xFF5555)
        .setFooter({ text: 'Powered by Discord Knowledge Only (Guides unavailable)' })
        .setTimestamp();
      
      return await interaction.editReply({ embeds: [errorEmbed] });
    }
    
    // Generate answer
    const answer = await answerQuestion(question, discordMessages, guides);
    
    // Create embed response
    const embed = new EmbedBuilder()
      .setTitle('Knowledge Assistant')
      .setDescription(`**Question:** ${question}\n\n**Answer:**\n${answer}`)
      .setColor(0x00AAFF)
      .setFooter({ text: 'Powered by Insanity Guides & Discord Knowledge' })
      .setTimestamp();
    
    // Send the response
    await interaction.editReply({ embeds: [embed] });
    
  } catch (error) {
    logToFile(`Error in handleAskCommand: ${error.message}`);
    try {
      if (interaction.deferred) {
        await interaction.editReply(`❌ Error processing your question: ${error.message}`);
      } else {
        await interaction.reply({ content: `❌ Error processing your question: ${error.message}`, ephemeral: true });
      }
    } catch (replyError) {
      logToFile(`Failed to send error reply: ${replyError.message}`);
    }
  }
}

// Export the functionality for use in the main bot
module.exports = {
  handleAskCommand,
  loadGuides,
  loadDiscordMessages,
  answerQuestion
};

// If this file is run directly, test the functionality
if (require.main === module) {
  // Test the knowledge assistant
  (async () => {
    try {
      console.log('Loading guides...');
      const guides = await loadGuides();
      console.log(`Loaded ${Object.keys(guides).length} guides`);
      
      console.log('Loading Discord messages...');
      const discordMessages = loadDiscordMessages();
      console.log(`Loaded ${discordMessages.length} Discord messages`);
      
      // Test question
      const testQuestion = "What's the workflow for editing videos?";
      console.log(`Testing with question: "${testQuestion}"`);
      
      const answer = await answerQuestion(testQuestion, discordMessages, guides);
      console.log('Answer:');
      console.log(answer);
      
    } catch (error) {
      console.error('Test failed:', error);
    }
  })();
} 