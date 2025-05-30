# Insanity Discord Bot

A powerful Discord bot that integrates with Notion to manage projects, schedule meetings, and provide reminders for your team.

## Features

- **Notion integration**: Sync Discord channels with Notion pages for project tracking
- **Project Management**: Track project status, owner, due dates, and more
- **Scheduled Reminders**: Automatically send reminders at scheduled times
- **Meeting Coordination**: Schedule and coordinate meetings with team members
- **Customizable Watchers**: Get notified when Notion properties change
- **Creds 2.0 Economy**: Earn and spend Creds through `/kudos`, check balances with `/creds`, and redeem rewards from `/shop`.
- **Email Forwarding**: Send emails arriving at `dropbox@matcher.com` straight to your Discord channel.
- **Gmail Poller**: Automatically poll Gmail and post new emails to your Discord channel.

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
ELEVENLABS_API_KEY=your_elevenlabs_api_key
ELEVENLABS_VOICE_ID=your_elevenlabs_voice_id
RUNWAY_API_KEY=your_runway_api_key
RUNWAY_MODEL=gen4_turbo
FRAMEIO_TOKEN=your_frameio_api_token (optional)
FRAMEIO_ACCOUNT_ID=your_frameio_account_id (optional, auto-detected if omitted)

TIMEZONE=your_timezone (e.g., Europe/Berlin)
EMAIL_CHANNEL_ID=channel_id_for_forwarding
ENABLE_GMAIL_POLLER=false
GMAIL_CREDENTIALS_PATH=credentials.json
GMAIL_TOKEN_PATH=token.json
GMAIL_CREDENTIALS_JSON=
GMAIL_TOKEN_JSON=
GMAIL_POLL_INTERVAL=5
```

For Frame.io integration, provide:

- `FRAMEIO_TOKEN` – your Frame.io API token
- `FRAMEIO_ACCOUNT_ID` – your Frame.io account ID (auto-detected if omitted)
- `FRAMEIO_ROOT_ASSET_ID` – root asset ID of the project for comment scraping

If you encounter a 404 error when using the Frame.io commands, double-check that
`FRAMEIO_ACCOUNT_ID` and `FRAMEIO_ROOT_ASSET_ID` contain valid IDs from your
Frame.io workspace.

### Getting Frame.io IDs

1. Log in to [developer.frame.io](https://developer.frame.io/) and create a
   developer token. Save this value as `FRAMEIO_TOKEN`.
2. Retrieve your **Account ID** by running:

   ```bash
   curl -H "Authorization: Bearer $FRAMEIO_TOKEN" https://api.frame.io/v2/me
   ```

   Copy the `account_id` field from the response and store it in
   `FRAMEIO_ACCOUNT_ID`.
3. Open the project you want the bot to read comments from in your browser. The
   URL contains the project ID (the string after `/projects/`). Request that
   project via the API to find its root asset:

   ```bash
   curl -H "Authorization: Bearer $FRAMEIO_TOKEN" \
     https://api.frame.io/v2/projects/<project_id>
   ```

   The returned JSON includes a `root_asset_id`. Use this value as
   `FRAMEIO_ROOT_ASSET_ID`.


The bot primarily uses the `TIMEZONE` variable for scheduling. If your
deployment platform relies on the standard `TZ` variable, you can set both to
the same value.

## Deployment

### Local Development

1. Clone the repository
2. Install dependencies: `npm install`
3. Create a `.env` file with the required environment variables
4. Run the bot: `node index.js`

## Email Forwarding

1. Configure your email provider (e.g., SendGrid or Mailgun) to POST incoming
   messages to `/incoming-email` on your deployed bot.
2. Set `EMAIL_CHANNEL_ID` in your `.env` with the Discord channel that should receive the messages.

## Gmail Poller
Set `ENABLE_GMAIL_POLLER` to `true` to poll Gmail automatically. The bot will use `GMAIL_CREDENTIALS_PATH` and `GMAIL_TOKEN_PATH` for file-based authentication and check every `GMAIL_POLL_INTERVAL` minutes. New emails are posted to `EMAIL_CHANNEL_ID`.

If you prefer not to store the credential files on disk, provide the contents via `GMAIL_CREDENTIALS_JSON` and `GMAIL_TOKEN_JSON` environment variables instead.


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
- `/issue-report <timeframe>` - Compile recent Discord messages, Frame.io comments, Notion changelog entries and project assignments into text files
- `/frameio [timeframe]` - Fetch recent Frame.io comments to test connectivity
- `/vo <text>` - Generate an ElevenLabs voiceover and send it
- `/video <prompt> <image> [duration]` - Generate a video from an image using Runway
  (requires API version header `X-Runway-Version: 2024-11-06`)


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