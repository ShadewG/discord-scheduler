# Local Testing Guide for Discord Bot

This guide explains how to run a local instance of your Discord bot for testing while keeping your Railway deployment active.

## Prerequisites

1. Make sure you have Node.js installed locally
2. Ensure all dependencies are installed (`npm install`)
3. Have a proper `.env` file with all required credentials

## Option 1: Create a Test Bot for Local Development

The best practice is to create a separate Discord application/bot for testing:

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a new application (e.g., "Insanity Bot - Test")
3. Add a bot to this application
4. Copy the bot token
5. Create a `.env.local` file with this test bot token:

```
DISCORD_TOKEN=your_test_bot_token
CLIENT_ID=your_test_client_id
# Keep other environment variables the same
```

6. Invite this test bot to your server with appropriate permissions

## Option 2: Run Local Instance with Different Command Prefix

If you want to use the same bot but avoid command conflicts:

1. Create a copy of your `.env` file as `.env.local`
2. Run the bot with this environment file:

```bash
NODE_ENV=development node -r dotenv/config index.js dotenv_config_path=.env.local
```

## Running the Bot Locally

To run the bot locally:

```bash
# Standard way
node index.js

# With specific environment file
NODE_ENV=development node -r dotenv/config index.js dotenv_config_path=.env.local
```

## Testing Command Registration Locally

To test command registration without affecting your production bot:

```bash
# Register commands for your test bot
NODE_ENV=development node -r dotenv/config fix-commands.js dotenv_config_path=.env.local
```

## Pausing Railway Deployment

If you need to temporarily pause your Railway deployment:

1. Log in to [Railway](https://railway.app/)
2. Go to your project
3. Click on the "Settings" tab
4. Scroll down to find "Pause Service"
5. Click to pause the service
6. When ready to resume, click "Resume Service"

## Best Practices for Local Testing

1. **Use a separate bot for development** to avoid conflicts with your production bot
2. **Keep command names the same** but register them to different guilds
3. **Commit and push changes** only after thorough local testing
4. **Use environment variables** to distinguish between development and production

## Troubleshooting Local Development

If you encounter issues running the bot locally:

1. Check for errors in the console
2. Verify your `.env` file has all required variables
3. Ensure you're not running into port conflicts
4. Check Discord Developer Portal for rate limits

Remember that Discord has rate limits for API calls, including command registration. Be mindful of how often you register commands during testing.
