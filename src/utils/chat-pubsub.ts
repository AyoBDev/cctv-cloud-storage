import { Redis } from 'ioredis';
import { env } from '@config/env';

type MessageHandler = (channel: string, message: string) => void;

let subscriber: Redis | null = null;
let publisher: Redis | null = null;
const handlers = new Map<string, Set<MessageHandler>>();

function getSubscriber(): Redis {
  if (!subscriber) {
    subscriber = new Redis(env.REDIS_URL, { connectTimeout: 5000, maxRetriesPerRequest: 1 });
    subscriber.on('message', (channel: string, message: string) => {
      const channelHandlers = handlers.get(channel);
      if (channelHandlers) {
        for (const handler of channelHandlers) {
          handler(channel, message);
        }
      }
    });
  }
  return subscriber;
}

function getPublisher(): Redis {
  if (!publisher) {
    publisher = new Redis(env.REDIS_URL, { connectTimeout: 5000, maxRetriesPerRequest: 1 });
  }
  return publisher;
}

export async function publish(channel: string, payload: unknown): Promise<void> {
  await getPublisher().publish(channel, JSON.stringify(payload));
}

export async function subscribe(channel: string, handler: MessageHandler): Promise<void> {
  const sub = getSubscriber();
  if (!handlers.has(channel)) {
    handlers.set(channel, new Set());
    await sub.subscribe(channel);
  }
  handlers.get(channel)!.add(handler);
}

export async function unsubscribe(channel: string, handler: MessageHandler): Promise<void> {
  const channelHandlers = handlers.get(channel);
  if (!channelHandlers) return;
  channelHandlers.delete(handler);
  if (channelHandlers.size === 0) {
    handlers.delete(channel);
    await getSubscriber().unsubscribe(channel);
  }
}

export async function shutdown(): Promise<void> {
  if (subscriber) {
    await subscriber.quit();
    subscriber = null;
  }
  if (publisher) {
    await publisher.quit();
    publisher = null;
  }
  handlers.clear();
}

export function channelForGroup(groupId: string): string {
  return `chat:group:${groupId}`;
}
