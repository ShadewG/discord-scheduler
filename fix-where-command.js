// Script to fix the /where command implementation
const fs = require('fs');
const path = require('path');

// Read the index.js file
const indexPath = path.join(__dirname, 'index.js');
let content = fs.readFileSync(indexPath, 'utf8');

// Find the start of the where command implementation
const whereCommandStart = content.indexOf('else if (commandName === \'where\')');
if (whereCommandStart === -1) {
  console.error('Could not find where command implementation');
  process.exit(1);
}

// Find the end of the try block for the where command
let braceCount = 0;
let whereCommandEnd = whereCommandStart;
let foundTry = false;

for (let i = whereCommandStart; i < content.length; i++) {
  if (content[i] === '{') {
    braceCount++;
    if (!foundTry && content.substring(i-4, i).includes('try')) {
      foundTry = true;
    }
  } else if (content[i] === '}') {
    braceCount--;
    if (foundTry && braceCount === 0) {
      whereCommandEnd = i + 1;
      break;
    }
  }
}

// New implementation for the where command
const newWhereCommand = `else if (commandName === 'where') {
      try {
        // Get query and ephemeral setting
        const query = interaction.options.getString('query');
        const ephemeral = interaction.options.getBoolean('ephemeral') !== false; // Default to true
        
        await interaction.deferReply({ ephemeral });
        hasResponded = true;
        clearTimeout(timeoutWarning);
        
        // Log the query
        logToFile(\`/where command used with query: "\${query}" by \${interaction.user.tag}\`);
        
        // Search for the project
        const result = await findProjectByQuery(query);
        
        if (!result) {
          await interaction.editReply({
            content: \`❌ No project found matching "\${query}". Try a different search.\`,
            ephemeral: true
          });
          return;
        }
        
        // Get the page details directly
        const page = result.page;
        const code = result.code;
        
        // Extract information directly from the page
        const properties = page.properties;
        
        // Get basic info
        const title = properties.Name?.title?.[0]?.plain_text || code;
        const status = properties.Status?.select?.name || 'Not Set';
        const dueDate = properties['Due Date']?.date?.start || '';
        const formattedDueDate = dueDate ? new Date(dueDate).toLocaleDateString('en-US', { 
          month: 'short', day: 'numeric' 
        }) : '';
        
        // Get URLs
        const notionUrl = getNotionPageUrl(page.id);
        const frameioUrl = properties['Frame.io']?.url || '';
        const scriptUrl = properties.Script?.url || '';
        
        // Get people
        const editors = properties.Editor?.people?.map(p => p.name) || [];
        const leads = properties.Lead?.people?.map(p => p.name) || [];
        
        // Create embed
        const embed = new EmbedBuilder()
          .setColor(0x0099FF)
          .setTitle(\`Project: \${title}\`)
          .setDescription(\`Information for project **\${code}**\`)
          .setTimestamp();
        
        // Add Notion link
        if (notionUrl) {
          embed.addFields({ name: '📋 Notion Card', value: notionUrl });
        }
        
        // Add status with due date
        let statusText = status;
        if (formattedDueDate) {
          statusText += \` (Due: \${formattedDueDate})\`;
        }
        embed.addFields({ name: '📊 Status', value: statusText });
        
        // Add people fields
        if (leads.length > 0) {
          embed.addFields({ name: '🎬 Lead', value: leads.join(', '), inline: true });
        }
        
        if (editors.length > 0) {
          embed.addFields({ name: '✂️ Editor', value: editors.join(', '), inline: true });
        }
        
        // Add Discord channels
        const discordChannels = await findDiscordChannels(code);
        if (discordChannels.length > 0) {
          const channelLinks = discordChannels.map(ch => \`<#\${ch.id}>\`).join('\\n');
          embed.addFields({ name: '💬 Discord Channel', value: channelLinks });
        }
        
        // Add links
        if (scriptUrl) {
          embed.addFields({ name: '📝 Script', value: scriptUrl });
        }
        
        if (frameioUrl) {
          embed.addFields({ name: '🎬 Frame.io', value: frameioUrl });
        }
        
        // Create buttons
        const buttons = [];
        
        if (notionUrl) {
          buttons.push(
            new ButtonBuilder()
              .setLabel('Open in Notion')
              .setStyle(ButtonStyle.Link)
              .setURL(notionUrl)
          );
        }
        
        if (scriptUrl) {
          buttons.push(
            new ButtonBuilder()
              .setLabel('Open Script')
              .setStyle(ButtonStyle.Link)
              .setURL(scriptUrl)
          );
        }
        
        if (frameioUrl) {
          buttons.push(
            new ButtonBuilder()
              .setLabel('Open Frame.io')
              .setStyle(ButtonStyle.Link)
              .setURL(frameioUrl)
          );
        }
        
        // Add buttons if we have any
        const components = [];
        if (buttons.length > 0) {
          const row = new ActionRowBuilder().addComponents(...buttons);
          components.push(row);
        }
        
        // Send the response
        await interaction.editReply({
          embeds: [embed],
          components
        });
        
        // If not ephemeral, auto-delete after 5 minutes
        if (!ephemeral) {
          setTimeout(async () => {
            try {
              // Check if the reply still exists and delete it
              const fetchedReply = await interaction.fetchReply().catch(() => null);
              if (fetchedReply) {
                await interaction.deleteReply();
                logToFile(\`🗑️ Auto-deleted where command results for \${code} after 5 minutes\`);
              }
            } catch (deleteError) {
              logToFile(\`Error deleting where command reply: \${deleteError.message}\`);
            }
          }, 5 * 60 * 1000); // 5 minutes
        }
      } catch (cmdError) {
        logToFile(\`Error in /where command: \${cmdError.message}\`);
        if (!hasResponded) {
          try {
            await interaction.reply({ 
              content: \`❌ Error finding project: \${cmdError.message}\`, 
              ephemeral: true 
            });
            hasResponded = true;
          } catch (replyError) {
            logToFile(\`Failed to send error reply: \${replyError.message}\`);
          }
        } else {
          await interaction.editReply(\`❌ Error finding project: \${cmdError.message}\`);
        }
      }`;

// Replace the old implementation with the new one
content = content.substring(0, whereCommandStart) + newWhereCommand + content.substring(whereCommandEnd);

// Write the updated content back to the file
fs.writeFileSync(indexPath, content);
console.log('Successfully updated the /where command implementation');
