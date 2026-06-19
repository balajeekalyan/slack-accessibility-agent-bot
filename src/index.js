require('dotenv').config();

['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'SLACK_SIGNING_SECRET', 'SLACK_USER_TOKEN'].forEach(key => {
  if (!process.env[key]) { console.error(`Missing required env var: ${key}`); process.exit(1); }
});

const { App } = require('@slack/bolt');
const { fetchAllChannels, postReport, uploadReport, findAuditResultsChannel, RESULTS_CHANNEL_NAME } = require('./slack/client');
const { auditChannelWithClaude, checkChannelMetadata } = require('./audit/auditor');
const { calculateSeverity } = require('./report/severity-calculator');
const { formatReport, buildDetailedHtml } = require('./report/formatter');

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
});

app.command('/accessibility-audit', async ({ command, ack, respond, client }) => {
  await ack();

  const params = (command.text || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  const auditAll = params.includes('all');

  // Verify the results channel exists and the bot is a member before doing anything
  const resultsChannel = await findAuditResultsChannel(client);
  if (!resultsChannel) {
    await respond({
      response_type: 'ephemeral',
      text: `:x: Channel *#${RESULTS_CHANNEL_NAME}* doesn't exist. Please create it and invite the bot, then re-run the audit.`,
    });
    return;
  }
  if (!resultsChannel.is_member) {
    await respond({
      response_type: 'ephemeral',
      text: `:x: The bot isn't a member of *#${RESULTS_CHANNEL_NAME}*. Run \`/invite @<bot-name>\` in that channel, then re-run the audit.`,
    });
    return;
  }
  const resultsChannelId = resultsChannel.id;

  await respond({
    response_type: 'ephemeral',
    text: auditAll
      ? `:mag: Accessibility audit starting for *all channels and group messages*… Results will be posted to *#${RESULTS_CHANNEL_NAME}*.`
      : `:mag: Accessibility audit starting… Results will be posted to *#${RESULTS_CHANNEL_NAME}*.`,
  });

  try {
    let allResults = [];
    let singleChannelName = null;

    if (auditAll) {
      const { member: channels, notMember } = await fetchAllChannels(client);
      const noAccess = notMember.map(c => c.name);
      if (channels.length === 0) {
        await respond({
          response_type: 'ephemeral',
          text: ':x: No accessible channels found. Invite the bot to channels first with `/invite @<your-bot-name>`.',
        });
        return;
      }
      const skipped = [{ name: RESULTS_CHANNEL_NAME, reason: 'results_channel' }];
      const audited = [];
      for (const channel of channels) {
        console.log(`[audit] Starting audit for #${channel.name}`);
        try {
          if (!channel.is_mpim) allResults.push(...checkChannelMetadata(channel.id, channel.name, channel));
          const results = await auditChannelWithClaude(channel.id, channel.name);
          allResults.push(...results);
          audited.push(channel.name);
        } catch (err) {
          const notInvited = err.data?.error === 'not_in_channel' || err.message?.includes('not_in_channel');
          if (notInvited) {
            console.warn(`[audit] Skipping #${channel.name} — bot not invited`);
            skipped.push({ name: channel.name, reason: 'not_invited' });
          } else {
            console.error(`[audit] Error auditing #${channel.name}:`, err.message);
            skipped.push({ name: channel.name, reason: err.message });
          }
        }
      }

      const counts = calculateSeverity(allResults);
      const blocks = formatReport(allResults, counts, skipped, audited, noAccess);
      const html = buildDetailedHtml(allResults, counts, skipped, audited, noAccess);
      const filename = `accessibility-audit-all-${new Date().toISOString().slice(0, 10)}.html`;
      await postReport(client, resultsChannelId, blocks);
      await uploadReport(client, resultsChannelId, html, filename, 'text/html');
      return;
    } else {
      const { channel } = await client.conversations.info({ channel: command.channel_id });
      if (channel.name === RESULTS_CHANNEL_NAME) {
        await respond({
          response_type: 'ephemeral',
          text: `:x: Cannot audit *#${RESULTS_CHANNEL_NAME}* — that's where results are posted.`,
        });
        return;
      }
      console.log(`[audit] Starting audit for #${channel.name}`);
      allResults = [
        ...checkChannelMetadata(channel.id, channel.name, channel),
        ...await auditChannelWithClaude(channel.id, channel.name),
      ];
      singleChannelName = channel.name;
    }

    const counts = calculateSeverity(allResults);
    const blocks = formatReport(allResults, counts, [], singleChannelName ? [singleChannelName] : [], []);
    const html = buildDetailedHtml(allResults, counts, [], singleChannelName ? [singleChannelName] : [], []);
    const filename = `accessibility-audit-channel-${new Date().toISOString().slice(0, 10)}.html`;
    await postReport(client, resultsChannelId, blocks);
    await uploadReport(client, resultsChannelId, html, filename, 'text/html');
  } catch (err) {
    console.error('Audit failed:', err);
    await respond({
      response_type: 'ephemeral',
      text: `:x: Audit failed: ${err.message}`,
    });
  }
});

(async () => {
  await app.start();
  console.log('Accessibility Audit Agent running (socket mode)');
})();
