// test.js - Modified bot with test ping and commands
require('dotenv').config();
const cron = require('node-cron');
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const fs = require('fs');
const path = require('path');

const {
  DISCORD_TOKEN,
  CHANNEL_ID,
  ROLE_ID,
  TZ
} = process.env;

// Check for required environment variables
if (!DISCORD_TOKEN || !CHANNEL_ID || !ROLE_ID) {
  console.error('❌ Missing required environment variables in .env file:');
  if (!DISCORD_TOKEN) console.error('   - DISCORD_TOKEN');
  if (!CHANNEL_ID) console.error('   - CHANNEL_ID');
  if (!ROLE_ID) console.error('   - ROLE_ID');
  console.error('\nPlease check your .env file and try again.');
  process.exit(1);
}

// Need to add message content intent to handle commands
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages
  ]
});

// Store active cron jobs to be able to cancel them
const activeJobs = new Map();

/* ─ Helper : send a ping ───────────────────────── */
async function ping(text) {
  try {
    const channel = await client.channels.fetch(CHANNEL_ID);
    await channel.send(text.replace('@Editor', `<@&${ROLE_ID}>`));
    console.log(`📢 Sent message: ${text}`);
  } catch (error) {
    console.error(`❌ Error sending message: ${error.message}`);
    console.error(`Channel ID: ${CHANNEL_ID}, Role ID: ${ROLE_ID}`);
  }
}

/* ─ Helper : send a message without role ping ───── */
async function sendMessage(text) {
  try {
    const channel = await client.channels.fetch(CHANNEL_ID);
    await channel.send(text);
    console.log(`📢 Sent message: ${text}`);
  } catch (error) {
    console.error(`❌ Error sending message: ${error.message}`);
    console.error(`Channel ID: ${CHANNEL_ID}`);
  }
}

// Save jobs to a file
function saveJobs() {
  const jobsFilePath = path.join(__dirname, 'jobs.json');
  fs.writeFileSync(jobsFilePath, JSON.stringify(jobs, null, 2));
  console.log('Jobs saved to jobs.json');
}

// Load jobs from a file if it exists
function loadJobs() {
  const jobsFilePath = path.join(__dirname, 'jobs.json');
  if (fs.existsSync(jobsFilePath)) {
    try {
      const data = fs.readFileSync(jobsFilePath, 'utf8');
      const loadedJobs = JSON.parse(data);
      console.log('Jobs loaded from jobs.json');
      return loadedJobs;
    } catch (error) {
      console.error('Error loading jobs file:', error);
    }
  } else {
    console.log('No jobs file found. Using default jobs.');
  }
  return null;
}

/* ─ Schedule definition ──────────────────────────
   Cron syntax is MINUTE HOUR DOM MON DOW
   DOW: 1-5  →  Monday‑Friday (1=Monday, 5=Friday)
   We add "tz" specifically set to Europe/Berlin so cron respects Berlin timezone even on DST flips */
let jobs = [
  // Morning schedule (Monday-Friday only)
  { cron: '50 8 * * 1-5', text: '☕ Heads-up @Editor — Fika starts in 10 min (09:00). Grab a coffee!', tag: 'fika-heads-up' },
  { cron: '20 9 * * 1-5', text: '🔨 @Editor Deep Work (AM) starts now — focus mode ON.', tag: 'deep-work-am' },
  { cron: '0 11 * * 1-5', text: '🍪 Break time @Editor — 20-min Fika Break starts now.', tag: 'fika-break' },
  { cron: '20 11 * * 1-5', text: '🔨 @Editor Deep Work resumes now — back at it.', tag: 'deep-work-resume' },
  
  // Afternoon schedule (Monday-Friday only)
  { cron: '0 13 * * 1-5', text: '🍽️ Lunch break @Editor — enjoy! Back in 45 min.', tag: 'lunch-break' },
  { cron: '35 13 * * 1-5', text: '📋 Reminder @Editor — Planning Huddle in 10 min (13:45).', tag: 'planning-heads-up' },
  { cron: '0 14 * * 1-5', text: '🔨 @Editor Deep Work (PM) starts now — last push of the day.', tag: 'deep-work-pm' },
  { cron: '50 16 * * 1-5', text: '✅ Heads-up @Editor — Wrap-Up Meeting in 10 min (17:00).', tag: 'wrap-up-heads-up' }
];

// Load saved jobs if available
const loadedJobs = loadJobs();
if (loadedJobs) {
  jobs = loadedJobs;
}

// Function to schedule a job and add to activeJobs map
function scheduleJob(job) {
  // Cancel existing job if it exists
  if (activeJobs.has(job.tag)) {
    activeJobs.get(job.tag).stop();
  }
  
  // Ensure timezone is properly set
  const options = {
    timezone: TZ,
    scheduled: true,
    recoverMissedExecutions: true
  };
  
  // Schedule the new job
  const scheduledJob = cron.schedule(job.cron, () => {
    // Log the execution with timestamp in Berlin time
    const berlinTime = new Date().toLocaleString('en-US', { timeZone: TZ });
    console.log(`⏰ Executing job: ${job.tag} at ${berlinTime} (Berlin time)`);
    
    // Send the message
    ping(job.text);
  }, options);
  
  activeJobs.set(job.tag, scheduledJob);
  console.log(`Scheduled job: ${job.tag} (${job.cron} in ${TZ} timezone)`);
  return scheduledJob;
}

// Define slash commands
const commands = [
  new SlashCommandBuilder()
    .setName('test')
    .setDescription('Send test messages for all scheduled reminders'),
  
  new SlashCommandBuilder()
    .setName('testjob')
    .setDescription('Test a specific reminder')
    .addStringOption(option => 
      option.setName('tag')
        .setDescription('The tag of the reminder to test')
        .setRequired(true)
        .addChoices(
          { name: 'Fika Heads-up (08:50)', value: 'fika-heads-up' },
          { name: 'Deep Work AM (09:20)', value: 'deep-work-am' },
          { name: 'Fika Break (11:00)', value: 'fika-break' },
          { name: 'Deep Work Resume (11:20)', value: 'deep-work-resume' },
          { name: 'Lunch Break (13:00)', value: 'lunch-break' },
          { name: 'Planning Heads-up (13:35)', value: 'planning-heads-up' },
          { name: 'Deep Work PM (14:00)', value: 'deep-work-pm' },
          { name: 'Wrap-up Heads-up (16:50)', value: 'wrap-up-heads-up' }
        )),
  
  new SlashCommandBuilder()
    .setName('list')
    .setDescription('List all scheduled reminders'),
  
  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Check the bot status and configuration'),

  new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show help information about the bot commands'),

  new SlashCommandBuilder()
    .setName('edit')
    .setDescription('Edit a scheduled reminder'),

  new SlashCommandBuilder()
    .setName('add')
    .setDescription('Add a new scheduled reminder')
    .addStringOption(option =>
      option.setName('tag')
        .setDescription('A unique ID for the reminder')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('cron')
        .setDescription('Cron schedule (e.g., "30 9 * * 1-5")')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('text')
        .setDescription('Message to send')
        .setRequired(true))
];

// Register slash commands when the bot is ready
async function registerCommands(clientId, guildId) {
  try {
    const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
    console.log('Started refreshing application (/) commands.');

    const commandsData = commands.map(command => command.toJSON());
    
    // Find all guilds the bot is in if no specific guild is provided
    if (!guildId) {
      // Get the first guild the bot is in
      const guilds = client.guilds.cache;
      if (guilds.size > 0) {
        // Register commands for each guild (server)
        for (const guild of guilds.values()) {
          console.log(`Registering commands for guild: ${guild.name} (${guild.id})`);
          await rest.put(
            Routes.applicationGuildCommands(clientId, guild.id),
            { body: commandsData }
          );
        }
      } else {
        // If not in any guild, register globally (takes up to an hour to propagate)
        await rest.put(Routes.applicationCommands(clientId), { body: commandsData });
      }
    } else {
      // Register for specific guild if provided
      await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commandsData });
    }

    console.log('Successfully reloaded application (/) commands.');
  } catch (error) {
    console.error('Error registering commands:', error);
  }
}

// Create an embed to display job information
function createJobsEmbed() {
  const embed = new EmbedBuilder()
    .setColor(0x0099FF)
    .setTitle('Discord Scheduler - Reminder List')
    .setDescription('Here are all the scheduled reminders:')
    .setTimestamp()
    .setFooter({ text: 'Timezone: ' + TZ });

  jobs.forEach(job => {
    embed.addFields({ 
      name: `${job.tag}`, 
      value: `⏰ Schedule: \`${job.cron}\`\n📝 Message: ${job.text}`
    });
  });

  return embed;
}

// Create status embed with bot configuration
function createStatusEmbed() {
  const embed = new EmbedBuilder()
    .setColor(0x00FF99)
    .setTitle('Discord Scheduler - Status')
    .setDescription('Current bot configuration and status:')
    .addFields(
      { name: 'Bot Username', value: client.user.tag, inline: true },
      { name: 'Timezone', value: TZ || 'System default', inline: true },
      { name: 'Channel ID', value: CHANNEL_ID, inline: true },
      { name: 'Role ID', value: ROLE_ID, inline: true },
      { name: 'Active Jobs', value: jobs.length.toString(), inline: true },
      { name: 'Status', value: '✅ Online', inline: true }
    )
    .setTimestamp();

  return embed;
}

// Create help embed with command information
function createHelpEmbed() {
  const embed = new EmbedBuilder()
    .setColor(0xFFCC00)
    .setTitle('Discord Scheduler - Help')
    .setDescription('Here are the available commands:')
    .addFields(
      { name: '/test', value: 'Send test messages for all scheduled reminders' },
      { name: '/testjob', value: 'Test a specific scheduled reminder (select from dropdown)' },
      { name: '/list', value: 'List all scheduled reminders' },
      { name: '/status', value: 'Check the bot status and configuration' },
      { name: '/edit', value: 'Edit a scheduled reminder' },
      { name: '/add', value: 'Add a new scheduled reminder' },
      { name: '/help', value: 'Show this help information' }
    )
    .setTimestamp();

  return embed;
}

// Handle slash command interactions
client.on('interactionCreate', async interaction => {
  if (!interaction.isCommand()) return;

  const { commandName } = interaction;

  if (commandName === 'test') {
    await interaction.deferReply();
    
    // Send a test message for each job
    let testMsg = '📢 Sending test messages for all reminders:\n\n';
    
    for (const job of jobs) {
      testMsg += `▸ Testing: ${job.tag}\n`;
    }
    
    await interaction.editReply(testMsg);
    
    // Send each message with a delay to avoid rate limits
    for (const job of jobs) {
      await new Promise(resolve => setTimeout(resolve, 1500));
      await ping(`[TEST] ${job.text}`);
    }
    
    await interaction.followUp('✅ All test messages sent!');
  }
  
  else if (commandName === 'testjob') {
    const tag = interaction.options.getString('tag');
    const job = jobs.find(j => j.tag === tag);
    
    if (!job) {
      await interaction.reply({ content: `❌ Could not find job with tag: ${tag}`, ephemeral: true });
      return;
    }
    
    await interaction.reply(`📢 Sending test message for: **${job.tag}**`);
    await ping(`[TEST] ${job.text}`);
  }
  
  else if (commandName === 'list') {
    const jobsEmbed = createJobsEmbed();
    
    const row = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('refresh_list')
          .setLabel('Refresh')
          .setStyle(ButtonStyle.Primary),
      );
    
    await interaction.reply({ embeds: [jobsEmbed], components: [row] });
  }
  
  else if (commandName === 'status') {
    const statusEmbed = createStatusEmbed();
    await interaction.reply({ embeds: [statusEmbed] });
  }
  
  else if (commandName === 'help') {
    const helpEmbed = createHelpEmbed();
    await interaction.reply({ embeds: [helpEmbed] });
  }
  
  else if (commandName === 'edit') {
    // Create a select menu with all job tags as options
    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId('select_job_to_edit')
      .setPlaceholder('Select a reminder to edit')
      .addOptions(jobs.map(job => ({
        label: job.tag,
        description: `Cron: ${job.cron}`,
        value: job.tag
      })));
    
    const row = new ActionRowBuilder().addComponents(selectMenu);
    
    await interaction.reply({ 
      content: 'Select a reminder to edit:',
      components: [row]
    });
  }
  
  else if (commandName === 'add') {
    const tag = interaction.options.getString('tag');
    const cron = interaction.options.getString('cron');
    const text = interaction.options.getString('text');
    
    // Check if job with same tag already exists
    if (jobs.some(job => job.tag === tag)) {
      await interaction.reply({ content: '❌ A reminder with this tag already exists. Please use a unique tag or edit the existing one.', ephemeral: true });
      return;
    }
    
    // Validate cron expression
    try {
      cron.validate(cron);
    } catch (error) {
      await interaction.reply({ content: `❌ Invalid cron expression: ${error.message}`, ephemeral: true });
      return;
    }
    
    // Add the new job
    const newJob = { tag, cron, text };
    jobs.push(newJob);
    
    // Schedule the job
    scheduleJob(newJob);
    
    // Save the updated jobs
    saveJobs();
    
    await interaction.reply(`✅ Added new reminder "${tag}" scheduled for \`${cron}\``);
  }
});

// Handle select menu interactions
client.on('interactionCreate', async interaction => {
  if (!interaction.isStringSelectMenu()) return;
  
  if (interaction.customId === 'select_job_to_edit') {
    const selectedTag = interaction.values[0];
    const selectedJob = jobs.find(job => job.tag === selectedTag);
    
    if (!selectedJob) {
      await interaction.update({ content: '❌ Job not found. Please try again.', components: [] });
      return;
    }
    
    // Create a modal for editing the job
    const modal = new ModalBuilder()
      .setCustomId(`edit_job_${selectedTag}`)
      .setTitle(`Edit Reminder: ${selectedTag}`);
    
    // Add input components
    const cronInput = new TextInputBuilder()
      .setCustomId('cronInput')
      .setLabel('Cron Schedule')
      .setStyle(TextInputStyle.Short)
      .setValue(selectedJob.cron)
      .setPlaceholder('e.g., 30 9 * * 1-5')
      .setRequired(true);
    
    const textInput = new TextInputBuilder()
      .setCustomId('textInput')
      .setLabel('Message Text')
      .setStyle(TextInputStyle.Paragraph)
      .setValue(selectedJob.text)
      .setPlaceholder('The message to send at the scheduled time')
      .setRequired(true);
    
    // Add action rows
    const firstRow = new ActionRowBuilder().addComponents(cronInput);
    const secondRow = new ActionRowBuilder().addComponents(textInput);
    
    // Add inputs to the modal
    modal.addComponents(firstRow, secondRow);
    
    // Show the modal
    await interaction.showModal(modal);
  }
});

// Handle modal submissions
client.on('interactionCreate', async interaction => {
  if (!interaction.isModalSubmit()) return;
  
  if (interaction.customId.startsWith('edit_job_')) {
    const jobTag = interaction.customId.replace('edit_job_', '');
    const cronValue = interaction.fields.getTextInputValue('cronInput');
    const textValue = interaction.fields.getTextInputValue('textInput');
    
    // Validate cron expression
    try {
      cron.validate(cronValue);
    } catch (error) {
      await interaction.reply({ content: `❌ Invalid cron expression: ${error.message}`, ephemeral: true });
      return;
    }
    
    // Find and update the job
    const jobIndex = jobs.findIndex(job => job.tag === jobTag);
    if (jobIndex === -1) {
      await interaction.reply({ content: '❌ Job not found. Please try again.', ephemeral: true });
      return;
    }
    
    // Update the job
    jobs[jobIndex].cron = cronValue;
    jobs[jobIndex].text = textValue;
    
    // Reschedule the job
    scheduleJob(jobs[jobIndex]);
    
    // Save the updated jobs
    saveJobs();
    
    await interaction.reply(`✅ Updated reminder "${jobTag}" with new schedule: \`${cronValue}\``);
  }
});

// Handle button interactions
client.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;
  
  if (interaction.customId === 'refresh_list') {
    const jobsEmbed = createJobsEmbed();
    
    const row = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('refresh_list')
          .setLabel('Refresh')
          .setStyle(ButtonStyle.Primary),
      );
    
    await interaction.update({ embeds: [jobsEmbed], components: [row] });
  }
});

/* ─ Activate jobs on ready ─────────────────────── */
client.once('ready', async () => {
  console.log(`\n✅  Discord Scheduler Bot is now online as ${client.user.tag}`);
  console.log(`📆  Timezone set to: ${TZ || 'Not set (using system default)'}`);
  console.log(`📌  Pinging role ID: ${ROLE_ID}`);
  console.log(`💬  Sending to channel ID: ${CHANNEL_ID}`);
  console.log('\n⏰  Scheduled jobs:');

  // Schedule all jobs
  jobs.forEach(job => {
    scheduleJob(job);
    console.log(`   → ${job.tag}: "${job.text}" (${job.cron} ${TZ})`);
  });
  
  // Register slash commands
  await registerCommands(client.user.id);
  
  console.log('\n🔄  Bot is running! Press Ctrl+C to stop.');
  
  // Send an immediate test message when the bot starts
  setTimeout(() => {
    // Get current time in Berlin timezone
    const berlinTime = new Date().toLocaleString('en-GB', { timeZone: TZ });
    
    sendMessage(`Bot is now online and ready to send reminders! Current time in Berlin: ${berlinTime}. All jobs will run Monday-Friday only, on Berlin time.`);
    console.log('Sent startup message');
  }, 2000); // Wait 2 seconds after startup
});

client.login(DISCORD_TOKEN); 