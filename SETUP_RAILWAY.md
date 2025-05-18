# Setting Up Railway Environment Variables

To properly deploy your Discord bot to Railway and fix the Notion URL linking issue, you need to set up the following environment variables in your Railway project:

## Required Environment Variables

| Variable Name | Description | Example |
|--------------|-------------|---------|
| `DISCORD_TOKEN` | Your Discord bot token | `abcdefg123456789` |
| `CHANNEL_ID` | Default channel ID for announcements | `1234567890123456789` |
| `ROLE_ID` | ID of the role to ping for announcements | `1234567890123456789` |
| `NOTION_TOKEN` | Your Notion integration token | `secret_abcdefg123456789` |
| `NOTION_DB_ID` | Your Notion database ID | `abcdefg123456789` |
| `OPENAI_API_KEY` | Your OpenAI API key for AI functions | `sk-abcdefg123456789` |
| `TIMEZONE` | Your timezone for scheduling | `Europe/Berlin` |
| `NOTION_WORKSPACE` | Your Notion workspace name (for correct URL linking) | `your-workspace` |

## How to Find Your Notion Workspace Name

To fix the Notion URL linking issue, you need to set the `NOTION_WORKSPACE` variable:

1. Open any page in your Notion workspace
2. Look at the URL in your browser: `https://[workspace-name].notion.site/...`
3. The part before `.notion.site` is your workspace name

For example, if your Notion URL is `https://team-workspace.notion.site/abcdef123456`, then your workspace name is `team-workspace`.

## Setting Variables in Railway

1. Go to your Railway project dashboard
2. Click on the "Variables" tab
3. Add each variable and its value
4. Click "Add" for each variable
5. Deploy your project again after updating variables

With these environment variables set, your Notion links should now work correctly and the sync command will show detailed updates. 