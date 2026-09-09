export const BOT_CREATED_EVENT = "thechat:bot-created";

export function announceBotCreated() {
  window.dispatchEvent(new CustomEvent(BOT_CREATED_EVENT));
}
