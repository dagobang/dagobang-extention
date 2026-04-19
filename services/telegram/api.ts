export type TelegramApiConfig = {
  botToken: string;
  chatId: string;
};

export type TelegramCommand = {
  updateId: number;
  chatId: string;
  userId: string;
  text: string;
  callbackQueryId?: string;
};

type TelegramUpdate = {
  update_id: number;
  message?: {
    text?: string;
    chat?: { id?: number | string };
    from?: { id?: number | string };
  };
  callback_query?: {
    id?: string;
    data?: string;
    from?: { id?: number | string };
    message?: {
      chat?: { id?: number | string };
    };
  };
};

type TelegramApiResponse<T> = {
  ok: boolean;
  result?: T;
  description?: string;
};

function trimSafe(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function buildBaseUrl(botToken: string): string {
  return `https://api.telegram.org/bot${botToken}`;
}

async function requestTelegram<T>(botToken: string, method: string, payload: Record<string, unknown>): Promise<T> {
  const url = `${buildBaseUrl(botToken)}/${method}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = (await resp.json().catch(() => ({}))) as TelegramApiResponse<T>;
  if (!resp.ok || data.ok !== true || !('result' in data)) {
    throw new Error(data?.description || `Telegram ${method} failed (${resp.status})`);
  }
  return data.result as T;
}

export function isTelegramConfigured(cfg: TelegramApiConfig | null | undefined): cfg is TelegramApiConfig {
  if (!cfg) return false;
  return trimSafe(cfg.botToken).length > 0 && trimSafe(cfg.chatId).length > 0;
}

export async function telegramSendMessage(cfg: TelegramApiConfig, text: string): Promise<void> {
  await telegramSendMessageWithOptions(cfg, text);
}

export async function telegramSendMessageWithOptions(
  cfg: TelegramApiConfig,
  text: string,
  options?: {
    inlineKeyboard?: Array<Array<{ text: string; callbackData: string }>>;
  }
): Promise<void> {
  const inlineKeyboard = options?.inlineKeyboard;
  const replyMarkup = inlineKeyboard && inlineKeyboard.length
    ? {
      inline_keyboard: inlineKeyboard.map((row) =>
        row.map((btn) => ({
          text: btn.text,
          callback_data: btn.callbackData,
        }))
      ),
    }
    : undefined;
  await requestTelegram(cfg.botToken, 'sendMessage', {
    chat_id: cfg.chatId,
    text,
    disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

export async function telegramGetCommands(cfg: TelegramApiConfig, offset: number): Promise<TelegramCommand[]> {
  const updates = await requestTelegram<TelegramUpdate[]>(cfg.botToken, 'getUpdates', {
    offset,
    timeout: 0,
    allowed_updates: ['message', 'callback_query'],
    limit: 30,
  });
  const list: TelegramCommand[] = [];
  for (const item of updates) {
    const cb = item?.callback_query;
    if (cb?.id) {
      const text = trimSafe(cb.data);
      const chatId = String(cb?.message?.chat?.id ?? '').trim();
      const userId = String(cb?.from?.id ?? '').trim();
      if (chatId && text) {
        list.push({
          updateId: Number(item.update_id),
          chatId,
          userId,
          text,
          callbackQueryId: String(cb.id),
        });
        continue;
      }
    }
    const text = trimSafe(item?.message?.text);
    const chatId = String(item?.message?.chat?.id ?? '').trim();
    const userId = String(item?.message?.from?.id ?? '').trim();
    if (!chatId || !text) continue;
    list.push({
      updateId: Number(item.update_id),
      chatId,
      userId,
      text,
    });
  }
  return list;
}

export async function telegramAnswerCallbackQuery(
  cfg: TelegramApiConfig,
  callbackQueryId: string,
  text?: string
): Promise<void> {
  await requestTelegram(cfg.botToken, 'answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text: text || undefined,
    show_alert: false,
  });
}
