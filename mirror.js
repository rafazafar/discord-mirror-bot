const axios = require('axios');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { createSchedulerDb } = require('./src/scheduler-db');
const { startLocalApi } = require('./src/local-api');
const { startScheduler } = require('./src/scheduler');


const execFileAsync = promisify(execFile);
const writeFileAsync = promisify(fs.writeFile);
const unlinkAsync = promisify(fs.unlink);

function closeServer(server) {
    return new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
    });
}

function startSchedulerServices({
    client,
    config: schedulerConfig = {},
    createSchedulerDb: createDb = createSchedulerDb,
    startScheduler: startSchedulerService = startScheduler,
    startLocalApi: startApi = startLocalApi
}) {
    const {
        enableLocalApi = true,
        localApiHost = '127.0.0.1',
        localApiPort = 3000,
        schedulerPollMs = 5000,
        sqlitePath = './data/scheduler.sqlite'
    } = schedulerConfig;

    const db = createDb(sqlitePath);
    const scheduler = startSchedulerService({ db, client, pollMs: schedulerPollMs });
    const localApiServer = enableLocalApi ? startApi({ db, client, host: localApiHost, port: localApiPort }) : null;

    return {
        db,
        scheduler,
        localApiServer,
        async cleanup() {
            let cleanupError;
            try {
                await scheduler.stop();
                if (localApiServer) await closeServer(localApiServer);
            } catch (error) {
                cleanupError = error;
            } finally {
                db.close();
            }

            if (cleanupError) throw cleanupError;
        }
    };
}

function createShutdownHandler({ getSchedulerServices, process: processObject = process, console: consoleObject = console }) {
    let isShuttingDown = false;

    return async function shutdown(signal) {
        if (isShuttingDown) return;
        isShuttingDown = true;

        try {
            const schedulerServices = getSchedulerServices();
            if (schedulerServices) await schedulerServices.cleanup();
        } catch (error) {
            consoleObject.error('Error during shutdown cleanup:', error);
        } finally {
            processObject.exit(signal === 'SIGINT' ? 130 : 143);
        }
    };
}

async function isReplyToSelf(message, client, consoleObject = console) {
    if (!message.reference?.messageId) return false;

    try {
        const repliedMessage = await message.channel.messages.fetch(message.reference.messageId);
        return repliedMessage.author.id === client.user.id;
    } catch (error) {
        consoleObject.error('Error checking replied message:', error);
        return false;
    }
}

function getMessageUrl(message) {
    if (!message.guild?.id) return null;
    return `https://discord.com/channels/${message.guild.id}/${message.channel.id}/${message.id}`;
}

function getAttachments(message) {
    if (message.attachments.size === 0) return 'None';
    return message.attachments.map(attachment => {
        const details = [attachment.name, attachment.contentType, attachment.size ? `${attachment.size} bytes` : null].filter(Boolean).join(', ');
        return details ? `${attachment.url} (${details})` : attachment.url;
    }).join('\n');
}

function getImageAttachments(message) {
    return Array.from(message.attachments.values()).filter(attachment => {
        if (attachment.contentType?.startsWith('image/')) return true;
        return /\.(png|jpe?g|gif|webp)$/i.test(attachment.name || attachment.url || '');
    });
}

function getLinks(message) {
    return message.content.match(/https?:\/\/\S+/g) || [];
}

function getHermesAck(message, trigger) {
    const source = message.guild?.id ? `#${message.channel?.name || message.channel.id}` : 'DM';
    return `Picked up ${trigger} from ${message.author.username} in ${source}. Looking into it...`;
}

function buildHermesPrompt(message, trigger) {
    const links = getLinks(message);

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

Links:
${links.length > 0 ? links.join('\n') : 'None'}

Task:
Help me understand what is happening. If the message is not in English, translate or summarize it in English.

Do background work or research if it would help me understand the situation.

If links are present, inspect and summarize relevant linked information before final update.

If attachments are present, inspect or summarize them when accessible and relevant. Image attachments may be provided directly as image input.

Prepare a concise Telegram update for me with:
1. Situation
2. Urgency
3. Whether I need to act
4. Suggested reply, if useful
5. Follow-up, if useful
6. Confidence or missing context`;
}

async function sendToHermes(message, trigger, config, consoleObject = console) {
    const {
        enableHermesAssistant,
        hermesCommand = 'hermes',
        hermesSendTarget = 'telegram'
    } = config;

    if (!enableHermesAssistant) return;

    let imagePath = null;

    try {
        await execFileAsync(hermesCommand, ['send', '--to', hermesSendTarget, '--subject', '[Discord]', getHermesAck(message, trigger)], { timeout: 60000, maxBuffer: 1024 * 1024 });

        const prompt = buildHermesPrompt(message, trigger);
        const imageAttachments = getImageAttachments(message);
        const hermesArgs = imageAttachments.length > 0
            ? ['chat', '-q', prompt, '--image', await downloadAttachment(imageAttachments[0]), '-Q', '--source', 'tool']
            : ['-z', prompt];

        imagePath = hermesArgs.includes('--image') ? hermesArgs[hermesArgs.indexOf('--image') + 1] : null;

        const { stdout } = await execFileAsync(hermesCommand, hermesArgs, { timeout: 300000, maxBuffer: 1024 * 1024 });
        const response = stdout.trim();

        if (!response) return;

        await execFileAsync(hermesCommand, ['send', '--to', hermesSendTarget, '--subject', '[Discord]', response], { timeout: 60000, maxBuffer: 1024 * 1024 });
        consoleObject.log(`Hermes assistant processed message ${message.id}.`);
    } catch (error) {
        consoleObject.error('Error sending message to Hermes:', error);
    } finally {
        if (imagePath) {
            unlinkAsync(imagePath).catch(cleanupError => consoleObject.error('Error cleaning up Hermes image:', cleanupError));
        }
    }
}

async function downloadAttachment(attachment) {
    const response = await axios.get(attachment.url, { responseType: 'arraybuffer' });
    const extension = path.extname(attachment.name || '') || '.img';
    const filePath = path.join(os.tmpdir(), `discord-hermes-${attachment.id}-${Date.now()}${extension}`);

    await writeFileAsync(filePath, response.data);
    return filePath;
}

function attachClientHandlers({ client, config, channelWebhookMap, console: consoleObject = console }) {
    let schedulerServices;
    const {
        roleId,
        globalWebhookUrl,
    } = config;

    client.on('ready', () => {
        consoleObject.log(`Logged in as ${client.user.tag}!`);
        if (!schedulerServices) {
            schedulerServices = startSchedulerServices({ client, config });
        }
    });

    client.on('messageCreate', async (message) => {
    const webhookUrl = channelWebhookMap[message.channel.id];
    const isDm = !message.guild;
    const isFromSelf = message.author.id === client.user.id;
    const mentionedSelf = message.mentions.users.has(client.user.id);
    const repliedToSelf = await isReplyToSelf(message, client, consoleObject);
    const trigger = isDm && !isFromSelf ? 'dm' : mentionedSelf && repliedToSelf ? 'mention_and_reply' : mentionedSelf ? 'mention' : repliedToSelf ? 'reply' : null;
    const shouldForwardToGlobal = !webhookUrl
        && globalWebhookUrl
        && trigger;

    if (trigger) {
        sendToHermes(message, trigger, config, consoleObject);
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
            consoleObject.log(`Message from ${message.author.username} in channel ${message.channel.id} forwarded.`);
        } catch (error) {
            consoleObject.error('Error sending message through webhook:', error);
        }
    }
});

    return {
        getSchedulerServices() {
            return schedulerServices;
        }
    };
}

async function loginClient({ client, token, console: consoleObject = console, process: processObject = process }) {
    try {
        await client.login(token);
    } catch (error) {
        consoleObject.error('Discord login failed:', error);
        processObject.exit(1);
    }
}

function main({
    Discord = require('discord.js-selfbot-v13'),
    config = require('./config.js'),
    channelWebhookMap = require('./webhookMap.json'),
    process: processObject = process,
    console: consoleObject = console,
} = {}) {
    const { token } = config;
    const client = new Discord.Client();
    const runtime = attachClientHandlers({ client, config, channelWebhookMap, console: consoleObject });
    const shutdown = createShutdownHandler({
        getSchedulerServices: runtime.getSchedulerServices,
        process: processObject,
        console: consoleObject,
    });

    processObject.on('SIGINT', () => shutdown('SIGINT'));
    processObject.on('SIGTERM', () => shutdown('SIGTERM'));
    loginClient({ client, token, console: consoleObject, process: processObject });

    return { client, runtime, shutdown };
}

if (require.main === module) {
    main();
}

module.exports = {
    attachClientHandlers,
    createShutdownHandler,
    loginClient,
    main,
    startSchedulerServices,
};
