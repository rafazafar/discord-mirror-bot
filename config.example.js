// config.example.js
module.exports = {
    token: 'YOUR_DISCORD_TOKEN_HERE',
    roleId: 'YOUR_ROLE_ID_HERE',
    globalWebhookUrl: 'YOUR_GLOBAL_WEBHOOK_URL_HERE',
    enableHermesAssistant: false,
    hermesCommand: 'hermes',
    hermesSendTarget: 'telegram',
    enableLocalApi: true,
    localApiHost: '127.0.0.1',
    localApiPort: 3000,
    schedulerPollMs: 5000,
    sqlitePath: './data/scheduler.sqlite'
};
