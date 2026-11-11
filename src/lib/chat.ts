export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  attachments?: ChatAttachment[];
};

export type ChatAttachment = {
  id: string;
  name: string;
  mimeType: string;
  kind: 'image' | 'file';
  dataUrl: string;
  previewUri?: string;
};

type StreamEvent =
  | { type: 'delta'; delta: string }
  | { type: 'activity'; agent?: string; label: string; status: 'running' | 'complete' }
  | { type: 'approval'; id: string; responseId: string; name: string; arguments: Record<string, unknown> }
  | { type: 'done' }
  | { type: 'error'; message: string };

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8787';

export type BrowserWorkspaceState = {
  id: string;
  status: 'ready' | 'running' | 'paused' | 'needs_you' | 'needs_approval' | 'complete' | 'error';
  goal: string;
  result: string;
  url: string;
  title: string;
  screenshot: string;
  log: { at: number; message: string }[];
  pendingAction?: { type: string; text?: string } | null;
  viewport: { width: number; height: number };
  updatedAt: number;
};

async function browserRequest(path: string, options?: RequestInit): Promise<BrowserWorkspaceState> {
  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options?.headers ?? {}) },
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error ?? `Browser server returned ${response.status}.`);
  return payload as BrowserWorkspaceState;
}

export const startBrowserWorkspace = (id: string, url: string, goal: string) => browserRequest(`/api/browser/workspaces/${encodeURIComponent(id)}/run`, {
  method: 'POST', body: JSON.stringify({ url, goal }),
});
export const getBrowserWorkspace = (id: string) => browserRequest(`/api/browser/workspaces/${encodeURIComponent(id)}`);
export const pauseBrowserWorkspace = (id: string) => browserRequest(`/api/browser/workspaces/${encodeURIComponent(id)}/pause`, { method: 'POST', body: '{}' });
export const sendBrowserTakeover = (id: string, action: Record<string, unknown>) => browserRequest(`/api/browser/workspaces/${encodeURIComponent(id)}/takeover`, { method: 'POST', body: JSON.stringify(action) });
export const approveBrowserWorkspace = (id: string, approved: boolean) => browserRequest(`/api/browser/workspaces/${encodeURIComponent(id)}/approval`, { method: 'POST', body: JSON.stringify({ approved }) });

export function streamChat(
  messages: ChatMessage[],
  onDelta: (delta: string) => void,
  onEvent?: (event: Exclude<StreamEvent, { type: 'delta' | 'done' | 'error' }>) => void,
): { promise: Promise<void>; abort: () => void } {
  const xhr = new XMLHttpRequest();
  let consumed = 0;
  let pending = '';

  const promise = new Promise<void>((resolve, reject) => {
    const consume = () => {
      const next = xhr.responseText.slice(consumed);
      consumed = xhr.responseText.length;
      pending += next;

      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line) as StreamEvent;
        if (event.type === 'delta') onDelta(event.delta);
        if (event.type === 'activity' || event.type === 'approval') onEvent?.(event);
        if (event.type === 'error') reject(new Error(event.message));
      }
    };

    xhr.open('POST', `${API_URL}/api/chat`);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.onprogress = consume;
    xhr.onerror = () => reject(new Error('Could not reach the Tdotbot server.'));
    xhr.onabort = () => reject(new Error('Request cancelled.'));
    xhr.onload = () => {
      consume();
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`Server returned ${xhr.status}.`));
    };
    xhr.send(JSON.stringify({
      messages: messages.map(({ role, text, attachments }) => ({
        role,
        content: text,
        attachments: attachments?.filter((attachment) => attachment.dataUrl).map(({ name, mimeType, kind, dataUrl }) => ({ name, mimeType, kind, dataUrl })),
      })),
    }));
  });

  return { promise, abort: () => xhr.abort() };
}

export function continueTool(
  responseId: string,
  callId: string,
  output: Record<string, unknown>,
  onDelta: (delta: string) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let consumed = 0;
    let pending = '';
    const consume = () => {
      pending += xhr.responseText.slice(consumed);
      consumed = xhr.responseText.length;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line) as StreamEvent;
        if (event.type === 'delta') onDelta(event.delta);
        if (event.type === 'error') reject(new Error(event.message));
      }
    };
    xhr.open('POST', `${API_URL}/api/tool-result`);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.onprogress = consume;
    xhr.onerror = () => reject(new Error('Could not return the tool result to Tdotbot.'));
    xhr.onload = () => {
      consume();
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`Tool continuation returned ${xhr.status}.`));
    };
    xhr.send(JSON.stringify({ responseId, callId, output }));
  });
}
