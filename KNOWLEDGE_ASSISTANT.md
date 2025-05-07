# Knowledge Assistant Guide

The Knowledge Assistant allows users to ask questions about guides, workflows, and best practices, and get answers based on:
1. PDF Guides stored in the guides directory
2. Discord message history

## Setup and Configuration

### Requirements
- Node.js 20.0.0+
- Discord bot with appropriate permissions
- OpenAI API key (for answering questions)

### Configuration
1. Add your OpenAI API key to the `.env` file:
```
OPENAI_API_KEY=your_key_here
```

2. Optionally configure when the knowledge base updates via environment variables:
```
# Run updates at 4 AM in America/New_York timezone (default is 3 AM UTC)
KNOWLEDGE_UPDATE_SCHEDULE=0 4 * * *
TIMEZONE=America/New_York
```

## Adding Guides

### PDF Guides
1. Place PDF guides in the `guides/` directory
2. Run `npm run convert-guides` to extract text from PDFs
   - This creates text and JSON versions in `guides/text/` folder
   - Text versions are tracked in git, PDFs are not

### Discord Messages
Discord messages are collected in two ways:
1. **Real-time collection**: Messages are automatically collected as users chat
2. **Scheduled backups**: Run `npm run backup-messages` or use the scheduler

## Automated Updates

The Knowledge Assistant includes automation to keep content up-to-date:

1. **Manual update**: `npm run update-knowledge`
2. **Schedule updates**: `npm run start-knowledge-scheduler`
3. **Immediate update with scheduler**: `npm run update-knowledge-now`

The scheduler runs daily by default (see configuration options above).

## Using the Assistant

Users can ask questions using the `/ask` command:

```
/ask question: What's the workflow for editing videos?
```

Optional parameters:
- `ephemeral`: Set to true to make the answer only visible to you

## How It Works

1. The assistant extracts text from PDF guides
2. It collects Discord messages from chats
3. When a user asks a question, it:
   - Searches through guide content
   - Reviews recent Discord conversations
   - Uses OpenAI to generate a helpful answer

## Troubleshooting

### PDF Extraction Not Working
1. Make sure `pdf-parse` is installed: `npm install pdf-parse --save`
2. Check for errors in logs/knowledge-assistant.log

### Missing Messages
1. Verify the bot has proper permissions to read messages in channels
2. Ensure `discord.js` intents are properly configured
3. Run `npm run backup-messages` to manually trigger a backup

### OpenAI API Issues
1. Check your API key is valid in the .env file
2. Look for API errors in logs/knowledge-assistant.log 