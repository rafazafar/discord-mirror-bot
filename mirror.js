const Discord = require('discord.js-selfbot-v13');
const axios = require('axios');
const fs = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');


const {
    token,
    roleId,
    globalWebhookUrl,
    enableHermesAssistant,
    hermesCommand = 'hermes',
    hermesSendTarget = 'telegram'
} = require('./config.js');
const channelWebhookMap = require('./webhookMap.json');
const execFileAsync = promisify(execFile);

const client = new Discord.Client();

client.on('ready', () => {
    console.log(`Logged in as ${client.user.tag}!`);
});

async function isReplyToSelf(message) {
    if (!message.reference?.messageId) return false;

    try {
        const repliedMessage = await message.channel.messages.fetch(message.reference.messageId);
        return repliedMessage.author.id === client.user.id;
    } catch (error) {
        console.error('Error checking replied message:', error);
        return false;
    }
}

function getMessageUrl(message) {
    if (!message.guild?.id) return null;
    return `https://discord.com/channels/${message.guild.id}/${message.channel.id}/${message.id}`;
}

function getAttachments(message) {
    if (message.attachments.size === 0) return 'None';
    return message.attachments.map(attachment => attachment.url).join('\n');
}

function buildHermesPrompt(message, trigger) {
    return `You are my proactive personal assistant.

I received this Discord message because it mentioned me or replied to one of my messages.

Context:
- Server/Guild: ${message.guild?.name || 'DM'} (${message.guild?.id || 'DM'})
- Channel: #${message.channel?.name || 'DM'} (${message.channel.id})
- Author: ${message.author.username} (${message.author.id})
- Message URL: ${getMessageUrl(message) || 'Unavailable'}
- Trigger: ${trigger}
- Timestamp: ${message.createdAt.toISOString()}

Message:
${message.content || '[no text content]'}

Attachments:
${getAttachments(message)}

Task:
Help me understand what is happening. If the message is not in English, translate or summarize it in English.

Do background work or research if it would help me understand the situation.

Prepare a concise Telegram update for me with:
1. Situation
2. Urgency
3. Whether I need to act
4. Suggested reply, if useful
5. Follow-up, if useful
6. Confidence or missing context`;
}

async function sendToHermes(message, trigger) {
    if (!enableHermesAssistant) return;

    try {
        const prompt = buildHermesPrompt(message, trigger);
        const { stdout } = await execFileAsync(hermesCommand, ['-z', prompt], { timeout: 300000, maxBuffer: 1024 * 1024 });
        const response = stdout.trim();

        if (!response) return;

        await execFileAsync(hermesCommand, ['send', '--to', hermesSendTarget, '--subject', '[Discord]', response], { timeout: 60000, maxBuffer: 1024 * 1024 });
        console.log(`Hermes assistant processed message ${message.id}.`);
    } catch (error) {
        console.error('Error sending message to Hermes:', error);
    }
}

client.on('messageCreate', async (message) => {
    const webhookUrl = channelWebhookMap[message.channel.id];
    const mentionedSelf = message.mentions.users.has(client.user.id);
    const repliedToSelf = await isReplyToSelf(message);
    const trigger = mentionedSelf && repliedToSelf ? 'mention_and_reply' : mentionedSelf ? 'mention' : repliedToSelf ? 'reply' : null;
    const shouldForwardToGlobal = !webhookUrl
        && globalWebhookUrl
        && trigger;

    if (trigger) {
        sendToHermes(message, trigger);
    }

    if (webhookUrl || shouldForwardToGlobal) {
        try {
            const avatarURL = message.author.displayAvatarURL({ format: 'png', dynamic: true });
            let content = message.content;
            let embeds = [];

            content = content.replace(/@everyone/g, `<@&${roleId}>`).replace(/@here/g, `<@&${roleId}>`); // Replace @everyone and @here with role ID
            content = content.replace(/<@&\d+>/g, ''); // Remove role mentions
            content = content.replace(/<#\d+>/g, '');  // Remove channel mentions
            content = content.replace(/https:\/\/discord\.com\/channels\/\d+\/\d+\/\d+/g, '');  // Remove Discord message links

            if (message.attachments.size > 0) {
                message.attachments.forEach(attachment => {
                    content += `\n${attachment.url}`;
                });
            }

            if (message.stickers.size > 0) {
                message.stickers.forEach(sticker => {
                    content += `\nhttps://cdn.discordapp.com/stickers/${sticker.id}.png`;
                });
            }

            if (message.embeds.length > 0) {
                embeds = message.embeds.map(embed => {
                    const embedData = {};
                    if (embed.title) embedData.title = embed.title;
                    if (embed.description) embedData.description = embed.description;
                    if (embed.url) embedData.url = embed.url;
                    if (embed.color) embedData.color = embed.color;
                    if (embed.timestamp) embedData.timestamp = new Date(embed.timestamp).toISOString();
                    if (embed.author) embedData.author = { name: embed.author.name, url: embed.author.url, icon_url: embed.author.iconURL };
                    if (embed.footer) embedData.footer = { text: embed.footer.text, icon_url: embed.footer.iconURL };
                    if (embed.image) embedData.image = { url: embed.image.url };
                    if (embed.thumbnail) embedData.thumbnail = { url: embed.thumbnail.url };
                    if (embed.fields) embedData.fields = embed.fields.map(field => ({
                        name: field.name,
                        value: field.value,
                        inline: field.inline
                    }));
                    return embedData;
                });
            }

            const payload = {
                //username: message.author.username,
                //avatar_url: avatarURL,
                content: content.trim() || null,
                embeds: embeds.length > 0 ? embeds : undefined
            };

            await axios.post(webhookUrl || globalWebhookUrl, payload);
            console.log(`Message from ${message.author.username} in channel ${message.channel.id} forwarded.`);
        } catch (error) {
            console.error('Error sending message through webhook:', error);
        }
    }
});

client.login(token);
