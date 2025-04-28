# Setting Up Environment Variables on Railway

To fix the Notion API integration issues, you need to set up the required environment variables directly on Railway. Follow these steps:

## Required Environment Variables

Your Discord bot needs the following environment variables to function properly:

1. `DISCORD_TOKEN` - Your Discord bot token
2. `NOTION_KEY` - Your Notion API integration token
3. `NOTION_DATABASE_ID` - The ID of your Notion database
4. `OPENAI_API_KEY` - Your OpenAI API key (optional, only needed for AI features)
5. `GUILD_ID` - Your Discord server/guild ID (optional)

## Steps to Set Up Environment Variables on Railway

1. Go to your Railway dashboard: https://railway.app/dashboard
2. Select your Discord bot project
3. Click on the "Variables" tab
4. Add each of the required environment variables:

   - Click "New Variable"
   - Enter the variable name (e.g., `NOTION_KEY`)
   - Enter the variable value (your Notion API token)
   - Click "Add"
   
5. Repeat for all required variables
6. Railway will automatically redeploy your application with the new environment variables

## Getting Your Notion API Token

If you don't have a Notion API token:

1. Go to https://www.notion.so/my-integrations
2. Click "Create new integration"
3. Give it a name (e.g., "Discord Bot")
4. Select the workspace where your database is located
5. Click "Submit"
6. Copy the "Internal Integration Token" - this is your `NOTION_KEY`
7. Make sure to share your database with the integration:
   - Open your Notion database
   - Click "Share" in the top right
   - Click "Add people, emails, groups, or integrations"
   - Search for your integration name and select it
   - Click "Invite"

## Getting Your Notion Database ID

To get your Notion database ID:

1. Open your Notion database in a web browser
2. Look at the URL, which will be in this format:
   `https://www.notion.so/workspace/[database-id]?v=[view-id]`
3. Copy the [database-id] part - this is your `NOTION_DATABASE_ID`

## After Setting Up Environment Variables

After setting up the environment variables on Railway:

1. Railway will automatically redeploy your application
2. The bot should now be able to connect to Notion properly
3. The `/where` command should work with project codes like "IB23"

If you still encounter issues, check the Railway logs for any error messages.
