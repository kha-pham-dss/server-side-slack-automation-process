import { runControlChannelPost } from '@slack-dishes/shared/control-channel-post-job.js';

export async function handler(event) {
  try {
    return await runControlChannelPost(event);
  } catch (err) {
    console.error('control-channel-post: error', err?.message || err, {
      userId: event?.userId,
      controlChannelId: event?.controlChannelId,
    });
    throw err;
  }
}
