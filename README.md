# Discord Message Forwarder Bot

This project uses `discord.js-selfbot-v13` to forward messages from specific Discord channels to predefined webhooks. The bot processes messages, removes certain mentions, and forwards them along with embeds, attachments, and stickers.

## 📋 Original Project

This is a fork of the original Discord Mirror Bot created by [gitarynnn](https://github.com/gitarynnn/discord-mirror). The original project can be found at: <https://github.com/gitarynnn/discord-mirror>

### 🆕 What's New in This Fork

- **Fixed message duplication issue** - Resolved the deprecated `message` event causing duplicate message forwarding
- **Enhanced security** - Added proper `.gitignore` and example configuration files
- **Improved documentation** - Updated README with comprehensive setup instructions
- **Better process management** - Enhanced PM2 configuration and management scripts
- **Code cleanup** - Removed unused files and improved code organization

## Features

- **Message Forwarding**: Captures messages from specified channels and forwards them to associated webhooks.
- **Global Mention/Reply Forwarding**: For channels not in `webhookMap.json`, forwards messages that mention you or reply to your messages to a global webhook.
- **Hermes Assistant Support**: Optionally sends all mention/reply events to local Hermes and forwards the assistant summary to Telegram.
- **Mention Replacement**: Replaces `@everyone` and `@here` mentions with a specific role mention so that you wont get spammed.
- **Content Cleanup**: Removes role mentions, channel mentions, and message links.
- **Embed Support**: Extracts and forwards embed data (titles, descriptions, images, etc.) customizable
- **Attachment and Sticker Handling**: Includes attachments and stickers in the forwarded content.

## Prerequisites

- [Node.js](https://nodejs.org/) installed on your system.
- A Discord account and a valid token its a selfbot (Discord doesn't allow the use of selfbots, use the script at your own risk)
- The `discord.js-selfbot-v13`, `axios`, and `fs` modules installed.

## Installation

1. Clone the repository or download the code.
2. Install dependencies: `npm install`
3. Configure the bot:
   - **Edit `config.js`**: Replace `YOUR_DISCORD_TOKEN_HERE` with your Discord account token, `YOUR_ROLE_ID_HERE` with the role ID to mention during `@everyone` and `@here` pings, and `YOUR_GLOBAL_WEBHOOK_URL_HERE` with your catch-all webhook URL
   - **Edit `webhookMap.json`**: Replace the placeholder values with your actual channel IDs and webhook URLs
4. Start the bot using PM2 or directly with Node.js

### Configuration Files

**`config.example.js`** - Bot configuration template:

```javascript
module.exports = {
    token: 'YOUR_DISCORD_TOKEN_HERE',        // Your Discord account token
    roleId: 'YOUR_ROLE_ID_HERE',             // Role ID to mention instead of @everyone/@here
    globalWebhookUrl: 'YOUR_GLOBAL_WEBHOOK_URL_HERE', // Webhook for mentions/replies outside mapped channels
    enableHermesAssistant: false,                     // Set true to summarize mentions/replies with Hermes
    hermesCommand: 'hermes',                          // Hermes CLI command
    hermesSendTarget: 'telegram'                      // Target for `hermes send --to`
};
```

**`webhookMap.example.json`** - Channel to webhook mapping template:

```json
{
    "YOUR_CHANNEL_ID_1": "YOUR_WEBHOOK_URL_1",
    "YOUR_CHANNEL_ID_2": "YOUR_WEBHOOK_URL_2"
}
```

### Setup Instructions

1. **Copy the example files:**

   ```bash
   cp config.example.js config.js
   cp webhookMap.example.json webhookMap.json
   ```

2. **Edit the configuration files:**
   - Replace `YOUR_DISCORD_TOKEN_HERE` with your Discord account token
   - Replace `YOUR_ROLE_ID_HERE` with the role ID to mention instead of @everyone/@here
   - Replace `YOUR_GLOBAL_WEBHOOK_URL_HERE` with your catch-all webhook URL
   - Set `enableHermesAssistant` to `true` if Hermes is installed locally and Telegram is configured
   - Replace the placeholder channel IDs and webhook URLs with your actual values

### ⚠️ Important Security Notes

- **Never commit your actual Discord token or webhook URLs to version control**
- The `.gitignore` file is configured to exclude sensitive files
- Log files are automatically excluded from the repository
- Always use placeholder values in the repository and replace them locally

## PM2 Process Management

This project includes PM2 support for production deployment and process management. PM2 ensures your Discord mirror bot runs continuously and automatically restarts if it crashes.

### Quick Start with PM2

1. **Start the application:**

   ```bash
   npm run pm2:start
   # or
   ./start.sh start
   ```

2. **Check status:**

   ```bash
   npm run pm2:status
   # or
   ./start.sh status
   ```

3. **View logs:**

   ```bash
   npm run pm2:logs
   # or
   ./start.sh logs
   ```

### Available PM2 Commands

#### Using npm scripts

- `npm run pm2:start` - Start the application
- `npm run pm2:stop` - Stop the application
- `npm run pm2:restart` - Restart the application
- `npm run pm2:reload` - Reload the application (zero-downtime)
- `npm run pm2:delete` - Remove from PM2
- `npm run pm2:logs` - View application logs
- `npm run pm2:monit` - Open PM2 monitoring interface
- `npm run pm2:status` - Show PM2 status
- `npm run pm2:save` - Save current PM2 configuration
- `npm run pm2:startup` - Configure PM2 to start on system boot

#### Using the startup script

- `./start.sh start` - Start the application
- `./start.sh stop` - Stop the application
- `./start.sh restart` - Restart the application
- `./start.sh reload` - Reload the application
- `./start.sh status` - Show status
- `./start.sh logs` - View logs
- `./start.sh monit` - Open monitoring
- `./start.sh delete` - Remove from PM2
- `./start.sh setup` - Configure startup on boot

### PM2 Configuration

The `ecosystem.config.js` file contains the PM2 configuration with the following features:

- **Auto-restart**: Automatically restarts the application if it crashes
- **Memory management**: Restarts if memory usage exceeds 1GB
- **Logging**: Comprehensive logging to `./logs/` directory
- **Environment variables**: Support for development and production environments
- **Process management**: Configurable restart policies and delays

### Logs

PM2 logs are stored in the `./logs/` directory:

- `err.log` - Error logs
- `out.log` - Standard output logs
- `combined.log` - Combined logs with timestamps

### Setting up Auto-start on Boot

To make your Discord mirror bot start automatically when your system boots:

```bash
npm run pm2:startup
npm run pm2:save
# or
./start.sh setup
```

This will generate a startup script that you can run to enable PM2 startup on boot.

### Monitoring

PM2 provides a built-in monitoring interface:

```bash
npm run pm2:monit
# or
./start.sh monit
```

This opens a terminal-based monitoring dashboard showing CPU usage, memory usage, and process status.

### Production Deployment

For production deployment, use the production environment:

```bash
pm2 start ecosystem.config.js --env production
```

This will use production-specific environment variables and settings.

## 🙏 Credits

### Original Developer

- **Original Project**: [gitarynnn/discord-mirror](https://github.com/gitarynnn/discord-mirror)
- **Original Developer**: [gitarynnn](https://github.com/gitarynnn)

### This Fork

- **Fork Maintainer**: [brokechubb](https://github.com/brokechubb)
- **Repository**: [brokechubb/discord-mirror-bot](https://github.com/brokechubb/discord-mirror-bot)

## 📄 License

This project is a fork of the original Discord Mirror Bot. Please refer to the original repository for licensing information.
