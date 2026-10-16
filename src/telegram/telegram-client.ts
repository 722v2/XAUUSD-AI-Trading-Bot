export interface TelegramChat {
  readonly chatId: string;
  readonly title: string;
  readonly type: "private" | "group" | "supergroup" | "channel" | "unknown";
  readonly username?: string;
  readonly lastSeenAt: string;
}
export type TelegramErrorCode = "NOT_CONFIGURED" | "HTTP_ERROR" | "API_ERROR" | "RATE_LIMITED" | "INVALID_RESPONSE" | "WEBHOOK_CONFLICT" | "TIMEOUT";
export class TelegramClientError extends Error {
  readonly code: TelegramErrorCode;
  readonly retryAfterSeconds?: number;
  constructor(code: TelegramErrorCode, message: string, retryAfterSeconds?: number) {
    super(message); this.name = "TelegramClientError"; this.code = code;
    if (retryAfterSeconds !== undefined) this.retryAfterSeconds = retryAfterSeconds;
  }
}
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
interface ApiResponse { ok?: boolean; result?: unknown; description?: string; error_code?: number; parameters?: { retry_after?: number }; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function normalizeChat(raw: unknown, seenAt: string): TelegramChat | null {
  if (!isRecord(raw) || (typeof raw.id !== "number" && typeof raw.id !== "string")) return null;
  const id = String(raw.id);
  const type = raw.type === "private" || raw.type === "group" || raw.type === "supergroup" || raw.type === "channel" ? raw.type : "unknown";
  const name = [raw.title, raw.first_name, raw.username].find(x => typeof x === "string" && x.trim()) as string | undefined;
  const username = typeof raw.username === "string" ? raw.username : undefined;
  return { chatId: id, title: name ?? id, type, ...(username ? { username } : {}), lastSeenAt: seenAt };
}

/** Server-side Telegram API adapter. The credential is never returned to callers. */
export class TelegramBotClient {
  readonly #token: string;
  readonly #fetch: FetchLike;
  readonly #chats = new Map<string, TelegramChat>();
  #lastUpdateId: number | null = null;
  constructor(token: string | undefined, fetchImpl: FetchLike = fetch) { this.#token = token?.trim() ?? ""; this.#fetch = fetchImpl; }
  get configured(): boolean { return this.#token.length > 0; }
  listDiscoveredChats(): readonly TelegramChat[] { return [...this.#chats.values()].sort((a,b) => a.title.localeCompare(b.title)); }

  async #call(method: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.configured) throw new TelegramClientError("NOT_CONFIGURED", "Telegram bot token is not configured");
    let response: Response;
    try {
      response = await this.#fetch("https://api.telegram.org/bot" + this.#token + "/" + method, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(8000)
      });
    } catch (error) { throw new TelegramClientError(error instanceof Error && error.name === "TimeoutError" ? "TIMEOUT" : "HTTP_ERROR", error instanceof Error && error.name === "TimeoutError" ? "Telegram API request timed out" : "Telegram API request failed"); }
    let body: ApiResponse;
    try { body = await response.json() as ApiResponse; }
    catch { throw new TelegramClientError("INVALID_RESPONSE", "Telegram returned invalid JSON"); }
    if (response.status === 429 || body.error_code === 429) throw new TelegramClientError("RATE_LIMITED", "Telegram rate limit reached", body.parameters?.retry_after);
    if (response.status === 409) throw new TelegramClientError("WEBHOOK_CONFLICT", "getUpdates conflicts with an active webhook");
    if (!response.ok) throw new TelegramClientError("HTTP_ERROR", "Telegram returned HTTP " + response.status);
    if (body.ok !== true) throw new TelegramClientError("API_ERROR", typeof body.description === "string" ? body.description.slice(0, 200) : "Telegram rejected the request");
    return body.result;
  }

  async discoverChats(now = new Date().toISOString()): Promise<readonly TelegramChat[]> {
    const payload: Record<string, unknown> = { timeout: 0, allowed_updates: ["message", "channel_post", "callback_query", "my_chat_member"] };
    if (this.#lastUpdateId !== null) payload.offset = this.#lastUpdateId + 1;
    const result = await this.#call("getUpdates", payload);
    if (!Array.isArray(result)) throw new TelegramClientError("INVALID_RESPONSE", "Updates response is not an array");
    for (const item of result) {
      if (!isRecord(item)) continue;
      if (typeof item.update_id === "number") this.#lastUpdateId = Math.max(this.#lastUpdateId ?? item.update_id, item.update_id);
      const candidates: unknown[] = [];
      for (const key of ["message", "channel_post", "edited_message", "my_chat_member"]) {
        const update = item[key];
        if (isRecord(update)) candidates.push(update.chat);
      }
      const callback = item.callback_query;
      if (isRecord(callback) && isRecord(callback.message)) candidates.push(callback.message.chat);
      for (const rawChat of candidates) {
        const chat = normalizeChat(rawChat, now);
        if (chat) this.#chats.set(chat.chatId, chat);
      }
    }
    return this.listDiscoveredChats();
  }

  async sendMessage(chatId: string, text: string): Promise<{ readonly messageId: number | null }> {
    if (!chatId.trim() || !text.trim()) throw new TelegramClientError("API_ERROR", "Chat ID and message are required");
    const result = await this.#call("sendMessage", { chat_id: chatId, text: text.slice(0, 4096), disable_web_page_preview: true });
    if (!isRecord(result)) throw new TelegramClientError("INVALID_RESPONSE", "sendMessage response is invalid");
    return { messageId: typeof result.message_id === "number" ? result.message_id : null };
  }

  async sendToDiscoveredChats(text: string, enabledChatIds: readonly string[]): Promise<readonly { readonly chatId: string; readonly ok: boolean; readonly errorCode?: TelegramErrorCode }[]> {
    const results: { chatId: string; ok: boolean; errorCode?: TelegramErrorCode }[] = [];
    for (const chatId of [...new Set(enabledChatIds)]) {
      try { await this.sendMessage(chatId, text); results.push({ chatId, ok: true }); }
      catch (error) {
        results.push({ chatId, ok: false, errorCode: error instanceof TelegramClientError ? error.code : "HTTP_ERROR" });
        if (error instanceof TelegramClientError && error.code === "RATE_LIMITED") break;
      }
    }
    return results;
  }
}
