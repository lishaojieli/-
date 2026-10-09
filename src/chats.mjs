import { randomUUID } from 'node:crypto';

export function newChat() {
  const now = new Date().toISOString();
  return { id: randomUUID(), title: '新聊天', createdAt: now, updatedAt: now, currentTaskId: null, isolatedWorkspace: true };
}

export function migrateChats(state) {
  if (state.version >= 2 && Array.isArray(state.chats)) return state;
  const now = new Date().toISOString(); const chats = [];
  const taskChats = new Map();
  for (const task of state.tasks) {
    const chat = { id: randomUUID(), title: task.title || '较早任务', createdAt: task.createdAt || now, updatedAt: task.createdAt || now, currentTaskId: task.id, isolatedWorkspace: false };
    task.chatId = chat.id; taskChats.set(task.id, chat); chats.push(chat);
  }
  let earlier;
  for (const message of state.messages) {
    let chat = taskChats.get(message.taskId);
    if (!chat) { if (!earlier) { earlier = { ...newChat(), title: '较早交流', isolatedWorkspace: false }; chats.push(earlier); } chat = earlier; }
    message.chatId = chat.id;
    if (message.time && message.time > chat.updatedAt) chat.updatedAt = message.time;
  }
  if (!chats.length) chats.push(newChat());
  return { ...state, version: 2, chats, currentChatId: taskChats.get(state.currentTaskId)?.id || chats.at(-1).id };
}
