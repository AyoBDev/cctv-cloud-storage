import type { Sql } from 'postgres';
import type { SNSClient } from '@aws-sdk/client-sns';
import type { SESClient } from '@aws-sdk/client-ses';
import { PublishCommand } from '@aws-sdk/client-sns';
import { SendEmailCommand } from '@aws-sdk/client-ses';
import { env } from '@config/env';

interface PushToken {
  id: string;
  user_id: string;
  platform: 'ios' | 'android' | 'web';
  token: string;
}

const pendingDigests = new Map<string, NodeJS.Timeout>();

export async function registerPushToken(
  db: Sql,
  userId: string,
  platform: 'ios' | 'android' | 'web',
  token: string,
): Promise<void> {
  await db`
    INSERT INTO user_push_tokens (user_id, platform, token)
    VALUES (${userId}, ${platform}, ${token})
    ON CONFLICT (user_id, token) DO NOTHING
  `;
}

export async function removePushToken(db: Sql, userId: string, token: string): Promise<void> {
  await db`
    DELETE FROM user_push_tokens WHERE user_id = ${userId} AND token = ${token}
  `;
}

export async function sendPushNotification(
  db: Sql,
  sns: SNSClient,
  userId: string,
  title: string,
  body: string,
): Promise<void> {
  if (env.NODE_ENV === 'test') return;

  const tokens = await db<PushToken[]>`
    SELECT * FROM user_push_tokens WHERE user_id = ${userId}
  `;

  for (const token of tokens) {
    if (token.platform === 'ios' || token.platform === 'android') {
      const message = JSON.stringify({
        default: body,
        GCM: JSON.stringify({ notification: { title, body } }),
        APNS: JSON.stringify({ aps: { alert: { title, body } } }),
      });

      await sns.send(
        new PublishCommand({
          TargetArn: token.token,
          Message: message,
          MessageStructure: 'json',
        }),
      );
    }
  }
}

export async function scheduleEmailDigest(
  db: Sql,
  ses: SESClient,
  userId: string,
  groupName: string,
  messagePreview: string,
): Promise<void> {
  if (env.NODE_ENV === 'test') return;

  const digestKey = userId;

  if (pendingDigests.has(digestKey)) {
    clearTimeout(pendingDigests.get(digestKey)!);
  }

  const timer = setTimeout(
    async () => {
      pendingDigests.delete(digestKey);

      const [user] = await db<Array<{ email: string }>>`
      SELECT email FROM users WHERE id = ${userId}
    `;
      if (!user) return;

      await ses.send(
        new SendEmailCommand({
          Source: env.SES_FROM_EMAIL,
          Destination: { ToAddresses: [user.email] },
          Message: {
            Subject: { Data: `New messages in ${groupName}` },
            Body: {
              Text: {
                Data: `You have unread messages in "${groupName}":\n\n${messagePreview}\n\nOpen the app to view all messages.`,
              },
            },
          },
        }),
      );
    },
    5 * 60 * 1000,
  ); // 5 minutes

  pendingDigests.set(digestKey, timer);
}

export function clearAllDigestTimers(): void {
  for (const timer of pendingDigests.values()) {
    clearTimeout(timer);
  }
  pendingDigests.clear();
}
