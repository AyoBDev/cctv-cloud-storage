import type { Sql } from 'postgres';

export interface ChatMessage {
  id: string;
  group_id: string;
  sender_id: string | null;
  type: 'text' | 'media' | 'system';
  content: string;
  media_url: string | null;
  media_type: string | null;
  edited_at: Date | null;
  deleted_at: Date | null;
  created_at: Date;
}

export interface SendMessageInput {
  groupId: string;
  senderId: string;
  type: 'text' | 'media' | 'system';
  content: string;
  mediaUrl?: string;
  mediaType?: string;
}

export interface PaginatedMessages {
  data: ChatMessage[];
  cursor: string | null;
}

export async function sendMessage(db: Sql, input: SendMessageInput): Promise<ChatMessage> {
  const rows = await db<ChatMessage[]>`
    INSERT INTO chat_messages (group_id, sender_id, type, content, media_url, media_type)
    VALUES (
      ${input.groupId},
      ${input.senderId},
      ${input.type},
      ${input.content},
      ${input.mediaUrl ?? null},
      ${input.mediaType ?? null}
    )
    RETURNING *
  `;

  const message = rows[0];
  if (!message) throw new Error('Insert returned no rows');
  return message;
}

export async function sendSystemMessage(
  db: Sql,
  groupId: string,
  content: string,
): Promise<ChatMessage> {
  const rows = await db<ChatMessage[]>`
    INSERT INTO chat_messages (group_id, sender_id, type, content)
    VALUES (${groupId}, NULL, 'system', ${content})
    RETURNING *
  `;

  const message = rows[0];
  if (!message) throw new Error('Insert returned no rows');
  return message;
}

export async function getMessages(
  db: Sql,
  groupId: string,
  limit: number,
  cursor?: string,
): Promise<PaginatedMessages> {
  let messages: ChatMessage[];

  if (cursor) {
    // Get the created_at of the cursor message
    const cursorRows = await db<[{ created_at: Date }?]>`
      SELECT created_at FROM chat_messages WHERE id = ${cursor}
    `;
    const cursorMessage = cursorRows[0];
    if (!cursorMessage) {
      messages = [];
    } else {
      messages = await db<ChatMessage[]>`
        SELECT * FROM chat_messages
        WHERE group_id = ${groupId}
          AND deleted_at IS NULL
          AND created_at < ${cursorMessage.created_at}
        ORDER BY created_at DESC
        LIMIT ${limit + 1}
      `;
    }
  } else {
    messages = await db<ChatMessage[]>`
      SELECT * FROM chat_messages
      WHERE group_id = ${groupId}
        AND deleted_at IS NULL
      ORDER BY created_at DESC
      LIMIT ${limit + 1}
    `;
  }

  const hasMore = messages.length > limit;
  if (hasMore) {
    messages = messages.slice(0, limit);
  }

  const nextCursor = hasMore && messages.length > 0 ? messages[messages.length - 1]!.id : null;

  return { data: messages, cursor: nextCursor };
}

export async function getMessageById(db: Sql, messageId: string): Promise<ChatMessage | null> {
  const rows = await db<ChatMessage[]>`
    SELECT * FROM chat_messages WHERE id = ${messageId} AND deleted_at IS NULL
  `;
  return rows[0] ?? null;
}

export async function editMessage(
  db: Sql,
  messageId: string,
  content: string,
): Promise<ChatMessage> {
  const rows = await db<ChatMessage[]>`
    UPDATE chat_messages
    SET content = ${content}, edited_at = now()
    WHERE id = ${messageId}
    RETURNING *
  `;

  const message = rows[0];
  if (!message) throw new Error('Update returned no rows');
  return message;
}

export async function deleteMessage(db: Sql, messageId: string): Promise<void> {
  await db`
    UPDATE chat_messages SET deleted_at = now() WHERE id = ${messageId}
  `;
}

export async function addReaction(
  db: Sql,
  messageId: string,
  userId: string,
  emoji: string,
): Promise<void> {
  await db`
    INSERT INTO chat_message_reactions (message_id, user_id, emoji)
    VALUES (${messageId}, ${userId}, ${emoji})
    ON CONFLICT (message_id, user_id, emoji) DO NOTHING
  `;
}

export async function removeReaction(
  db: Sql,
  messageId: string,
  userId: string,
  emoji: string,
): Promise<void> {
  await db`
    DELETE FROM chat_message_reactions
    WHERE message_id = ${messageId} AND user_id = ${userId} AND emoji = ${emoji}
  `;
}

export async function markRead(
  db: Sql,
  groupId: string,
  userId: string,
  lastReadMessageId: string,
): Promise<void> {
  await db`
    INSERT INTO chat_read_receipts (group_id, user_id, last_read_message_id, read_at)
    VALUES (${groupId}, ${userId}, ${lastReadMessageId}, now())
    ON CONFLICT (group_id, user_id)
    DO UPDATE SET last_read_message_id = ${lastReadMessageId}, read_at = now()
  `;
}
