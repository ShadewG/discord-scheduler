# Discord Scheduler Bot

A Discord bot for scheduling and sending reminders for meetings and work sessions.

## Features

- 📅 Schedule reminders for work sessions, meetings, and breaks
- ⏰ Send automated notifications at scheduled times
- 📊 View upcoming reminders with countdown timers
- ✏️ Edit existing reminders through Discord UI
- ➕ Add new reminders easily with slash commands
- 🌐 Support for timezone-specific scheduling
- 🔇 No startup announcement when the bot goes online (silent operation)
- 📝 Send manual messages to the channel with optional role mentions

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
```

## Deployment

This bot can be deployed to services like Railway or Heroku.

### Railway Deployment

1. Push your code to GitHub
2. Connect your repository to Railway
3. Add environment variables in Railway dashboard
4. Deploy the bot

## License

ISC

## Author

Created with ❤️ for managing your daily work schedule. 