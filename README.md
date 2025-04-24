# Discord Scheduler Bot

A Discord bot for scheduling and sending reminders for meetings and work sessions.

## Features

- 📅 Schedule reminders for work sessions, meetings, and breaks
- ⏰ Send automated notifications at scheduled times
- 📊 View upcoming reminders with countdown timers
- ✏️ Edit existing reminders through Discord UI
- ➕ Add new reminders easily with slash commands
- 🌐 Support for timezone-specific scheduling
- 🔇 Silent operation (no startup announcements)
- 📝 Send manual messages to the channel with optional role mentions
- 📓 Notion integration to track changes in databases
- 🔔 Custom Notion watchers for specific status changes

## Commands

- `/schedule` - Show the complete schedule with countdown timers
- `/next` - Show the next upcoming reminders
- `/list` - List all scheduled reminders
- `/send` - Send a custom message to the channel (with optional role mention)
- `/status` - View bot configuration and status
- `/test` - Test all scheduled reminders
- `/testjob` - Test a specific reminder
- `/edit` - Edit an existing reminder
- `/add` - Add a new reminder
- `/meeting` - Schedule a meeting with another user (e.g. `/meeting @user 30m` or `/meeting @user 1400`)
- `!sync` - Update Notion project properties using AI in project-specific channels (name starts with project code):
  - `!sync add script URL https://docs.google.com/...`
  - `!sync set Frame.io link to https://app.frame.io/...`
  - `!sync this project is high priority and due on April 30th`
  - `!sync Ray will be my editor and needs captions by end of week`
- `/notion` - Manage Notion status watchers:
  - `/notion add` - Add a new status watcher
  - `/notion list` - List all watchers
  - `/notion enable` - Enable a watcher
  - `/notion disable` - Disable a watcher
  - `/notion delete` - Delete a watcher
  - `/notion properties` - List available properties in database
- `/help` - Show available commands

## Installation

1. Clone this repository
2. Install dependencies with `npm install`
3. Create a `.env` file with your Discord bot token and configuration
4. Start the bot with `npm start`

## Environment Variables

Create a `.env` file with the following:

```
# Discord Bot Configuration
DISCORD_TOKEN=your_discord_bot_token_here
CHANNEL_ID=your_channel_id_here
ROLE_ID=your_role_id_here
TZ=Europe/Berlin

# Notion Integration (optional)
NOTION_TOKEN=secret_xxx
NOTION_DB_ID=83c7...a1a3

# OpenAI Integration (for !sync command)
OPENAI_API_KEY=sk-xxxx
```

## Deployment

This bot can be deployed to services like Railway or Heroku.

### Railway Deployment

1. Push your code to GitHub
2. Connect your repository to Railway
3. Add environment variables in Railway dashboard
4. Deploy the bot

## Notion Integration

The bot includes an integration with Notion that:

1. Polls a specified Notion database every minute
2. Checks for pages where "Caption Status" equals "Ready For Captions"
3. Notifies a specified user when new matching pages are found

For more information, see the [notion-integration.js](./notion-integration.js) file.

## License

ISC

## Author

Created with ❤️ for managing your daily work schedule. 