import { loadConfigFromParameterStore } from './ssm-config.js';
import { parsePostCommandBody } from './post-command.js';

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

async function addReaction(botToken, channelId, ts, name = 'white_check_mark') {
  const res = await fetch('https://slack.com/api/reactions.add', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${botToken}`,
    },
    body: JSON.stringify({ channel: channelId, timestamp: ts, name }),
  });
  const data = await res.json();
  if (!data.ok && data.error !== 'already_reacted') {
    console.warn('control-channel-post: reactions.add failed', data.error);
  }
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

  await chatPostMessage(botToken, targetChannelId, body);

  if (ackMessageTs && controlChannelId) {
    await addReaction(botToken, controlChannelId, ackMessageTs);
  }

  console.log('control-channel-post: sent', {
    userId,
    targetChannelId,
    bodyChars: body.length,
  });
  return { ok: true, targetChannelId };
}
