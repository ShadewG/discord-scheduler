# New Discord Bot Commands

This document describes the new utility commands added to the Discord bot.

## Dashboard Command

The `/dashboard` command provides a visual overview of your project's current status and key metrics.

**Usage:**
```
/dashboard [ephemeral]
```

**Options:**
- `ephemeral`: (Optional) Make the response only visible to you

**Features:**
- Shows current project status
- Displays key metrics and deadlines
- Provides quick access to important links
- Updates in real-time with Notion data

## Timeline Command

The `/timeline` command generates a visual timeline of project milestones and deadlines.

**Usage:**
```
/timeline [timeframe] [ephemeral]
```

**Options:**
- `timeframe`: (Optional) Timeframe to display - "week", "month", or "quarter"
- `ephemeral`: (Optional) Make the response only visible to you

**Features:**
- Visual representation of project timeline
- Color-coded by status and priority
- Shows upcoming deadlines and milestones
- Adjustable timeframe for different planning horizons

## Export Command

The `/export` command allows you to export project data to different file formats.

**Usage:**
```
/export format [include_history]
```

**Options:**
- `format`: (Required) Export format - "csv", "json", or "txt"
- `include_history`: (Optional) Include historical data in the export

**Features:**
- Export project data for offline use or analysis
- Multiple format options for compatibility
- Option to include historical data
- Files are delivered via direct message

## Summary Command

The `/summary` command uses AI to generate a concise summary of recent project activity.

**Usage:**
```
/summary [days] [ephemeral]
```

**Options:**
- `days`: (Optional) Number of days to summarize (default: 7)
- `ephemeral`: (Optional) Make the response only visible to you

**Features:**
- AI-generated summary of recent activity
- Highlights key changes and developments
- Identifies trends and potential issues
- Customizable time period

## Implementation

These commands are defined in the `commands.js` file but require handler implementation in `index.js`. To implement these commands, you'll need to:

1. Add handler functions for each command in `index.js`
2. Create the necessary helper functions for generating dashboards, timelines, etc.
3. Test each command thoroughly

The command definitions are already registered with Discord, but they won't function until the handlers are implemented.
