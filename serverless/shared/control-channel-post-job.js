import { loadConfigFromParameterStore } from './ssm-config.js';
import { interpretAckReactionClaim, parsePostCommandBody } from './post-command.js';

async function chatPostMessage(botToken, channelId, text) {
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${botToken}`,
    },
    body: JSON.stringify({ channel: channelId, text }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`chat.postMessage: ${data.error ?? res.status}`);
  return data;
}

async function tryClaimAckReaction(botToken, channelId, ts, name = 'white_check_mark') {
  const res = await fetch('https://slack.com/api/reactions.add', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${botToken}`,
    },
    body: JSON.stringify({ channel: channelId, timestamp: ts, name }),
  });
  const data = await res.json();
  const claim = interpretAckReactionClaim(data);
  if (claim === 'unavailable') {
    console.warn('control-channel-post: reactions.add failed', data.error);
  }
  return claim;
}

/**
 * @param {{ userId?: string, controlChannelId?: string, ackMessageTs?: string, text?: string }} input
 */
export async function runControlChannelPost(input) {
  const { userId, controlChannelId, ackMessageTs, text } = input;

  const body = parsePostCommandBody(text);
  if (!body) {
    console.warn('control-channel-post: skip', {
      reason: 'not_post_command_or_empty',
      textPreview: String(text || '').slice(0, 80),
    });
    return { ok: false, reason: 'not_post_command' };
  }

  const config = await loadConfigFromParameterStore();
  const botToken = (config['bot-token'] || '').trim();
  const targetChannelId = (config['channel-id'] || '').trim();

  if (!botToken) throw new Error('missing bot-token');
  if (!targetChannelId) throw new Error('missing channel-id');

  // Claim before post so Slack Event retries cannot double-post.
  if (ackMessageTs && controlChannelId) {
    const claim = await tryClaimAckReaction(botToken, controlChannelId, ackMessageTs);
    if (claim === 'already_claimed') {
      console.log('control-channel-post: skip duplicate delivery', {
        userId,
        controlChannelId,
        ackMessageTs,
      });
      return { ok: true, skipped: true, reason: 'already_claimed' };
    }
  }

  await chatPostMessage(botToken, targetChannelId, body);

  console.log('control-channel-post: sent', {
    userId,
    targetChannelId,
    bodyChars: body.length,
  });
  return { ok: true, targetChannelId };
}
