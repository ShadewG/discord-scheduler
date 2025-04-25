# Discord Scheduler Bot

A Discord bot that sends scheduled reminder pings to the @Editor role at specific times throughout the workday, Monday through Friday.

## Features

- Scheduled reminders with beautiful formatting and emojis
- Monday to Friday schedule (weekends excluded)
- Berlin timezone support (configurable)
- Slash commands for managing and testing reminders
- Persistent storage of custom reminders

## Schedule

| Time (Berlin) | What fires | Message text |
| ------------- | ---------- | ------------ |
| 08:50 | 10-min heads-up for Fika | ☕ Heads-up @Editor — Fika starts in 10 min (09:00). Grab a coffee! |
| 09:20 | Deep Work (AM) start | 🔨 @Editor Deep Work (AM) starts now — focus mode ON. |
| 11:00 | Fika Break start | 🍪 Break time @Editor — 20-min Fika Break starts now. |
| 11:20 | Deep Work resumes | 🔨 @Editor Deep Work resumes now — back at it. |
| 13:00 | Lunch start | 🍽️ Lunch break @Editor — enjoy! Back in 45 min. |
| 13:35 | 10-min heads-up for Planning | 📋 Reminder @Editor — Planning Huddle in 10 min (13:45). |
| 14:00 | Deep Work (PM) start | 🔨 @Editor Deep Work (PM) starts now — last push of the day. |
| 16:50 | 10-min heads-up for Wrap-Up | ✅ Heads-up @Editor — Wrap-Up Meeting in 10 min (17:00). |

## Deployment on Railway

1. Fork or clone this repository
2. Log in to [Railway](https://railway.app/)
3. Create a new project from GitHub
4. Select your repository
5. Add the following environment variables:
   - `DISCORD_TOKEN`: Your Discord bot token
   - `CHANNEL_ID`: The Discord channel ID to send messages to
   - `ROLE_ID`: The Discord role ID to mention (Editor role)
   - `TZ`: Timezone (default: Europe/Berlin)
6. Deploy your project

Railway will automatically detect the Procfile and start your bot.

## Bot Commands

- `/test`: Send test messages for all scheduled reminders
- `/testjob`: Test a specific scheduled reminder
- `/list`: List all scheduled reminders
- `/status`: Check the bot status and configuration
- `/edit`: Edit a scheduled reminder
- `/add`: Add a new scheduled reminder
- `/help`: Show help information about the bot commands

## Inviting the Bot to Your Server

When creating your Discord bot, make sure to:

1. Enable the "applications.commands" OAuth2 scope
2. Give the bot permission to send messages and mention roles
3. Use the generated URL to invite the bot to your server 