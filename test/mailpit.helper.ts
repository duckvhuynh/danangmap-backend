export async function captureMailpitCode(recipient: string, timeoutMs = 15_000): Promise<string> {
  return (await waitForMailpitMessage(recipient, 1, timeoutMs)).code;
}

export interface CapturedMailpitMessage {
  code: string;
  subject: string;
  text: string;
  messageId: string;
  count: number;
}

export async function waitForMailpitMessage(
  recipient: string,
  expectedCount = 1,
  timeoutMs = 15_000,
): Promise<CapturedMailpitMessage> {
  const baseUrl = process.env.MAILPIT_API_URL;
  if (!baseUrl) throw new Error('MAILPIT_API_URL is not configured');
  const deadline = Date.now() + timeoutMs;
  const query = encodeURIComponent(`to:"${recipient}"`);
  while (Date.now() < deadline) {
    const [searchResponse, textResponse] = await Promise.all([
      fetch(`${baseUrl}/api/v1/search?query=${query}`),
      fetch(`${baseUrl}/view/latest.txt?query=${query}`),
    ]);
    if (searchResponse.ok && textResponse.ok) {
      const search = (await searchResponse.json()) as {
        total?: number;
        count?: number;
        messages_count?: number;
        messages?: Array<{ Subject?: string; MessageID?: string }>;
      };
      const text = (await textResponse.text()).replaceAll('\r\n', '\n');
      const match = /\n\n([A-Za-z0-9_-]{20,256})\n\n/.exec(text);
      const message = search.messages?.[0];
      const count = search.messages_count ?? search.count ?? search.messages?.length ?? 0;
      if (count === expectedCount && match?.[1] && message) {
        return {
          code: match[1],
          subject: message.Subject ?? '',
          text,
          messageId: message.MessageID ?? '',
          count,
        };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Mailpit did not receive the expected credential mail count');
}

export async function mailpitMessageCount(recipient: string): Promise<number> {
  const baseUrl = process.env.MAILPIT_API_URL;
  if (!baseUrl) return 0;
  const response = await fetch(
    `${baseUrl}/api/v1/search?query=${encodeURIComponent(`to:"${recipient}"`)}`,
  );
  if (!response.ok) throw new Error('Mailpit search failed');
  const body = (await response.json()) as {
    total?: number;
    Total?: number;
    messages_count?: number;
  };
  return body.messages_count ?? body.total ?? body.Total ?? 0;
}
