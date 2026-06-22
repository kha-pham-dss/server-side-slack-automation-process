/**
 * Nhận invoke từ slack-events khi user gửi `POST: …` trong control channel.
 * Gửi nội dung (sau prefix) vào channel-id (SSM); react :white_check_mark: trên tin control.
 */

import { loadConfigFromParameterStore } from '@slack-dishes/shared/ssm-config.js';

const POST_PREFIX = /^POST:\s+/i;

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
    console.warn('reactions.add failed:', data.error);
  }
}

export async function handler(event) {
  const { userId, controlChannelId, ackMessageTs, text } = event;

  if (!POST_PREFIX.test((text || '').trim())) {
    return { ok: false, reason: 'not_post_command' };
  }

  const config = await loadConfigFromParameterStore();
  const botToken = (config['bot-token'] || '').trim();
  const targetChannelId = (config['channel-id'] || '').trim();

  if (!botToken) throw new Error('missing bot-token');
  if (!targetChannelId) throw new Error('missing channel-id');

  const body = (text || '').trim().replace(POST_PREFIX, '').trim();
  if (!body) return { ok: false, reason: 'empty_body' };

  await chatPostMessage(botToken, targetChannelId, body);

  if (ackMessageTs && controlChannelId) {
    await addReaction(botToken, controlChannelId, ackMessageTs);
  }

  console.log('control-channel-post: sent', { userId, targetChannelId });
  return { ok: true, targetChannelId };
}
