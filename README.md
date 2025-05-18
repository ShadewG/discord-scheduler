# Insanity Discord Bot

A powerful Discord bot that integrates with Notion to manage projects, schedule meetings, and provide reminders for your team.

## Features

- **Notion integration**: Sync Discord channels with Notion pages for project tracking
- **Project Management**: Track project status, owner, due dates, and more
- **Scheduled Reminders**: Automatically send reminders at scheduled times
- **Meeting Coordination**: Schedule and coordinate meetings with team members
- **Customizable Watchers**: Get notified when Notion properties change
- **Creds 2.0 Economy**: Earn and spend Creds through `/kudos`, check balances with `/creds`, and redeem rewards from `/shop`.

## Environment Variables

You'll need to set up the following environment variables:

```
DISCORD_TOKEN=your_discord_bot_token
CHANNEL_ID=your_default_channel_id
ROLE_ID=your_editor_role_id
NOTION_TOKEN=your_notion_integration_token
NOTION_DB_ID=your_notion_database_id
NOTION_WORKSPACE=your_notion_workspace_name (optional, for correct URL linking)
OPENAI_API_KEY=your_openai_api_key
TIMEZONE=your_timezone (e.g., Europe/Berlin)
```

The bot primarily uses the `TIMEZONE` variable for scheduling. If your
deployment platform relies on the standard `TZ` variable, you can set both to
the same value.

## Deployment

### Local Development

1. Clone the repository
2. Install dependencies: `npm install`
3. Create a `.env` file with the required environment variables
4. Run the bot: `node index.js`

### Using GitHub Actions + Railway

This project is set up to automatically deploy to Railway using GitHub Actions when changes are pushed to the main branch.

To set up continuous deployment:

1. Create a Railway project for your bot
2. Get your Railway API token by running `railway login` locally
3. Add the token as a GitHub secret:
   - Go to your GitHub repository
   - Navigate to Settings > Secrets and Variables > Actions
   - Add a new repository secret named `RAILWAY_TOKEN` with your Railway token
4. Push changes to the `main` branch to trigger a deployment

## Commands

The bot supports various slash commands:

- `/sync <message>` - Update Notion with information from your message
- `/analyze` - Analyze channel messages and update Notion
- `/meeting <user> <time> [topic]` - Schedule a meeting
- `/schedule` - View the reminder schedule
- `/notion` - Manage Notion status watchers
- `/set` - Update properties on a Notion page
- `/issue-report <timeframe>` - Compile recent Discord messages and Frame.io comments into text files

## Creds 2.0

Use the economy system to motivate your team:

```
/creds                // check your balance and XP
/kudos @user 5 Great job!  // reward a teammate
/shop                 // list available rewards
/redeem "Vacation hour"   // spend your Creds
```

## Custom Watchers

Set up custom watchers to get notified when specific property values change in Notion:

```
/notion add <name> <property> <value> <user>
```

## Troubleshooting

- If you get errors about missing functions, ensure your index.js file includes all required utility functions
- For Notion integration issues, check that your integration has access to the database
- For deployment issues, verify your environment variables are correctly set in Railway

## License

MIT License 