import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import OpenAI from 'openai';
import { approveBrowserAction, browserTakeover, getBrowserState, pauseBrowser, startBrowserRun } from './browser-worker.mjs';

const app = express();
const port = Number(process.env.PORT ?? 8787);
const model = process.env.OPENAI_MODEL ?? 'gpt-5.5';
const realtimeModel = process.env.OPENAI_REALTIME_MODEL ?? 'gpt-realtime';

const specialists = [
  {
    name: 'Researcher',
    instructions: 'You are Tdotbot Researcher. Find current, relevant facts and source-backed context. Be concise. Use web search when freshness matters. Return findings for a coordinator, not a user-facing answer.',
    tools: [{ type: 'web_search' }],
  },
  {
    name: 'Planner',
    instructions: 'You are Tdotbot Planner. Turn the request into a practical, ordered approach. Identify dependencies, decisions, and the smallest useful next actions. Return a concise plan for a coordinator.',
    tools: [],
  },
  {
    name: 'Reviewer',
    instructions: 'You are Tdotbot Reviewer. Independently inspect the request for missing details, risks, incorrect assumptions, and quality gaps. Return concise corrections and checks for a coordinator.',
    tools: [],
  },
];

const actionTools = [
  {
    type: 'function', name: 'compose_email', description: 'Open an email draft on the phone. Requires explicit user approval.', strict: true,
    parameters: { type: 'object', properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } }, required: ['to', 'subject', 'body'], additionalProperties: false },
  },
  {
    type: 'function', name: 'compose_sms', description: 'Open an SMS draft on the phone. Requires explicit user approval.', strict: true,
    parameters: { type: 'object', properties: { phone: { type: 'string' }, message: { type: 'string' } }, required: ['phone', 'message'], additionalProperties: false },
  },
  {
    type: 'function', name: 'call_phone', description: 'Open the phone dialer with a number. It does not place the call automatically. Requires explicit user approval.', strict: true,
    parameters: { type: 'object', properties: { phone: { type: 'string' } }, required: ['phone'], additionalProperties: false },
  },
  {
    type: 'function', name: 'open_map', description: 'Open the phone map app for a place, address, or destination. Requires explicit user approval.', strict: true,
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
  },
  {
    type: 'function', name: 'open_url', description: 'Open a safe HTTP or HTTPS link on the phone. Requires explicit user approval.', strict: true,
    parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'], additionalProperties: false },
  },
  {
    type: 'function', name: 'share_text', description: 'Open the Android share sheet with prepared text. Requires explicit user approval.', strict: true,
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
  },
  {
    type: 'function', name: 'save_note', description: 'Save a private note locally inside Tdotbot. Requires explicit user approval.', strict: true,
    parameters: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' } }, required: ['title', 'body'], additionalProperties: false },
  },
  {
    type: 'function', name: 'create_contact', description: 'Create a contact on the phone. Requires explicit user approval.', strict: true,
    parameters: { type: 'object', properties: { name: { type: 'string' }, phone: { type: 'string' }, email: { type: 'string' } }, required: ['name', 'phone', 'email'], additionalProperties: false },
  },
];

const shouldDelegate = (messages) => {
  const last = [...messages].reverse().find((message) => message.role === 'user');
  const text = typeof last?.content === 'string'
    ? last.content
    : last?.content?.find?.((part) => part.type === 'input_text')?.text ?? '';
  return text.length >= 120 || /\b(agents?|delegate|research|compare|plan|analy[sz]e|investigate|review|options|best approach)\b/i.test(text);
};

const shouldUsePython = (messages) => {
  const last = [...messages].reverse().find((message) => message.role === 'user');
  const text = typeof last?.content === 'string'
    ? last.content
    : last?.content?.find?.((part) => part.type === 'input_text')?.text ?? '';
  return /\b(calculate|calculation|math|equation|analy[sz]e data|spreadsheet|csv|chart|graph|statistics|python)\b/i.test(text);
};

const writeActivity = (response, agent, label, status) => {
  response.write(`${JSON.stringify({ type: 'activity', agent, label, status })}\n`);
};

async function runSpecialist(client, specialist, messages, signal) {
  const result = await client.responses.create({
    model,
    instructions: specialist.instructions,
    input: messages,
    tools: specialist.tools,
    store: false,
  }, { signal });
  return result.output_text || 'No findings returned.';
}

app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.get('/health', (_request, response) => {
  response.json({ ok: true, model, coordinator: 'Tdotbot', specialists: specialists.map(({ name }) => name) });
});

app.post('/api/browser/workspaces/:id/run', async (request, response) => {
  if (!process.env.OPENAI_API_KEY) {
    response.status(503).json({ error: 'OPENAI_API_KEY is not configured.' });
    return;
  }
  try {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const state = await startBrowserRun({ id: request.params.id, url: request.body?.url, goal: request.body?.goal, client, model });
    response.json(state);
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : 'Could not start browser workspace.' });
  }
});

app.get('/api/browser/workspaces/:id', async (request, response) => {
  const state = await getBrowserState(request.params.id);
  if (!state) response.status(404).json({ error: 'Browser workspace is not active on this server.' });
  else response.json(state);
});

app.post('/api/browser/workspaces/:id/takeover', async (request, response) => {
  try { response.json(await browserTakeover(request.params.id, request.body ?? {})); }
  catch (error) { response.status(400).json({ error: error instanceof Error ? error.message : 'Takeover action failed.' }); }
});

app.post('/api/browser/workspaces/:id/approval', async (request, response) => {
  try { response.json(await approveBrowserAction(request.params.id, request.body?.approved === true)); }
  catch (error) { response.status(400).json({ error: error instanceof Error ? error.message : 'Approval failed.' }); }
});

app.post('/api/browser/workspaces/:id/pause', async (request, response) => {
  try { response.json(await pauseBrowser(request.params.id)); }
  catch (error) { response.status(400).json({ error: error instanceof Error ? error.message : 'Pause failed.' }); }
});

app.post('/api/realtime/client-secret', async (_request, response) => {
  if (!process.env.OPENAI_API_KEY) {
    response.status(503).json({ error: 'OPENAI_API_KEY is not configured.' });
    return;
  }
  const upstream = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
      'OpenAI-Safety-Identifier': 'tdotbot-personal-user',
    },
    body: JSON.stringify({
      session: {
        type: 'realtime',
        model: realtimeModel,
        instructions: 'You are Tdotbot, a warm and practical personal voice assistant.',
        audio: { output: { voice: 'marin' } },
      },
    }),
  });
  const payload = await upstream.json();
  response.status(upstream.status).json(payload);
});

app.post('/api/tool-result', async (request, response) => {
  if (!process.env.OPENAI_API_KEY) {
    response.status(503).json({ error: 'OPENAI_API_KEY is not configured.' });
    return;
  }
  const { responseId, callId, output } = request.body ?? {};
  if (!responseId || !callId) {
    response.status(400).json({ error: 'responseId and callId are required.' });
    return;
  }
  response.status(200);
  response.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  response.setHeader('Cache-Control', 'no-cache, no-transform');
  response.flushHeaders();
  try {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const stream = await client.responses.create({
      model,
      previous_response_id: responseId,
      input: [{ type: 'function_call_output', call_id: callId, output: JSON.stringify(output ?? {}) }],
      instructions: 'Continue as Tdotbot. Explain the tool result plainly. Never claim more than the returned output confirms.',
      stream: true,
      store: true,
    });
    for await (const event of stream) {
      if (event.type === 'response.output_text.delta') {
        response.write(`${JSON.stringify({ type: 'delta', delta: event.delta })}\n`);
      }
    }
    response.write(`${JSON.stringify({ type: 'done' })}\n`);
    response.end();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Tool continuation failed.';
    response.write(`${JSON.stringify({ type: 'error', message })}\n`);
    response.end();
  }
});

app.post('/api/chat', async (request, response) => {
  if (!process.env.OPENAI_API_KEY) {
    response.status(503).json({ error: 'OPENAI_API_KEY is not configured.' });
    return;
  }

  const rawMessages = Array.isArray(request.body?.messages) ? request.body.messages : [];
  const messages = rawMessages.map((message) => {
    const attachments = Array.isArray(message.attachments) ? message.attachments.filter((attachment) => attachment.dataUrl) : [];
    if (!attachments.length || message.role !== 'user') return { role: message.role, content: message.content };
    const content = [{ type: 'input_text', text: message.content || 'Please analyze the attached content.' }];
    for (const attachment of attachments) {
      if (attachment.kind === 'image') {
        content.push({ type: 'input_image', image_url: attachment.dataUrl, detail: 'auto' });
      } else {
        content.push({ type: 'input_file', filename: attachment.name, file_data: attachment.dataUrl });
      }
    }
    return { role: 'user', content };
  });
  if (!messages.length || messages.length > 100) {
    response.status(400).json({ error: 'A non-empty messages array is required.' });
    return;
  }

  response.status(200);
  response.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  response.setHeader('Cache-Control', 'no-cache, no-transform');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.flushHeaders();
  const controller = new AbortController();
  request.on('aborted', () => controller.abort());
  response.on('close', () => {
    if (!response.writableEnded) controller.abort();
  });

  try {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    writeActivity(response, 'Tdotbot', 'Coordinator is routing the request', 'running');
    let specialistContext = '';
    if (shouldDelegate(messages)) {
      for (const specialist of specialists) writeActivity(response, specialist.name, 'Working independently', 'running');
      const results = await Promise.allSettled(
        specialists.map((specialist) => runSpecialist(client, specialist, messages, controller.signal)),
      );
      specialistContext = results.map((result, index) => {
        const specialist = specialists[index];
        if (result.status === 'fulfilled') {
          writeActivity(response, specialist.name, 'Findings delivered to coordinator', 'complete');
          return `${specialist.name}:\n${result.value}`;
        }
        writeActivity(response, specialist.name, 'Could not complete; coordinator will continue', 'complete');
        return `${specialist.name}: unavailable`;
      }).join('\n\n');
    } else {
      writeActivity(response, 'Tdotbot', 'Quick request kept with coordinator', 'complete');
    }
    let responseId = '';
    const stream = await client.responses.create({
      model,
      instructions: [
        'You are Tdotbot, the coordinator of a concise, warm, practical personal agent team.',
        'You own the final answer. Synthesize specialist findings without mentioning hidden implementation details or copying their output blindly.',
        'Use web search when current or sourced information would improve the answer.',
        'Use the available function tools for device actions instead of merely explaining how the user could do them.',
        'When the user asks to create a reminder, call create_reminder rather than claiming it was created.',
        'Be honest about uncertainty and never claim an action ran unless a tool result confirms it.',
        specialistContext ? `<specialist_findings>\n${specialistContext}\n</specialist_findings>` : '',
      ].join(' '),
      input: messages,
      tools: [
        { type: 'web_search' },
        ...(shouldUsePython(messages) ? [{ type: 'code_interpreter', container: { type: 'auto' } }] : []),
        {
          type: 'function',
          name: 'create_reminder',
          description: 'Propose a reminder. The user must approve it in the app before execution.',
          strict: true,
          parameters: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              when_iso: { type: 'string', description: 'An explicit future ISO 8601 timestamp including timezone offset.' },
            },
            required: ['title', 'when_iso'],
            additionalProperties: false,
          },
        },
        {
          type: 'function',
          name: 'get_current_location',
          description: 'Request the user’s current device location. Requires explicit approval.',
          strict: true,
          parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
        },
        {
          type: 'function',
          name: 'find_contact',
          description: 'Search the device contacts by name after explicit approval.',
          strict: true,
          parameters: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
            additionalProperties: false,
          },
        },
        {
          type: 'function',
          name: 'create_calendar_event',
          description: 'Open the system calendar confirmation UI for a proposed event.',
          strict: true,
          parameters: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              start_iso: { type: 'string' },
              end_iso: { type: 'string' },
            },
            required: ['title', 'start_iso', 'end_iso'],
            additionalProperties: false,
          },
        },
        ...actionTools,
      ],
      stream: true,
      store: true,
    }, { signal: controller.signal });

    let pythonActivityStatus = '';
    for await (const event of stream) {
      if (event.type === 'response.created') responseId = event.response.id;
      if (event.type === 'response.output_text.delta') {
        response.write(`${JSON.stringify({ type: 'delta', delta: event.delta })}\n`);
      }
      if (event.type.includes('web_search_call')) {
        const status = event.type.endsWith('.completed') ? 'complete' : 'running';
        writeActivity(response, 'Tdotbot', 'Searching the web', status);
      }
      if (event.type.includes('code_interpreter_call')) {
        const status = event.type.endsWith('.completed') ? 'complete' : 'running';
        if (status !== pythonActivityStatus) {
          pythonActivityStatus = status;
          writeActivity(response, 'Tdotbot', 'Running Python analysis', status);
        }
      }
      if (event.type === 'response.output_item.done' && event.item?.type === 'function_call') {
        let parsed = {};
        try { parsed = JSON.parse(event.item.arguments || '{}'); } catch { parsed = {}; }
        response.write(`${JSON.stringify({
          type: 'approval',
          id: event.item.call_id,
          responseId,
          name: event.item.name,
          arguments: parsed,
        })}\n`);
      }
    }
    writeActivity(response, 'Tdotbot', 'Coordinator finished the response', 'complete');
    response.write(`${JSON.stringify({ type: 'done' })}\n`);
    response.end();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'OpenAI request failed.';
    response.write(`${JSON.stringify({ type: 'error', message })}\n`);
    response.end();
  }
});

const server = app.listen(port, '0.0.0.0', () => {
  console.log(`Tdotbot server listening on http://localhost:${port}`);
});

// Keep a strong reference to the listener for runtimes that may otherwise
// collect the returned server handle after this module finishes evaluating.
server.ref();
