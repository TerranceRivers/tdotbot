# Orbit — OpenAI companion

Orbit is an original Expo/React Native assistant inspired by the interaction pattern of the inspected Grok Bot APK. It does not reuse proprietary source code, artwork, branding, hidden prompts, or xAI/Cursor services.

## What works

- Android, iOS, and web client through Expo Router
- Responsive companion-style chat UI
- Streaming text responses through the OpenAI Responses API
- Conversation context during the current app session
- Persistent on-device chat and agent activity history
- OpenAI hosted web search when the model decides current information is needed
- Confirmation cards for proposed reminder actions
- Real local notifications after reminder approval
- Camera, photo-library, and document attachments
- Multiple saved conversations (tap to open, long-press to delete)
- Approval-gated location, contact search, and calendar-event tools
- Approval-gated email, SMS, phone dialer, maps, links, sharing, local notes, and contact creation
- Hosted Python tool for calculations, data analysis, charts, and supported file processing
- Tool results are returned to OpenAI so Orbit can continue the conversation naturally
- Secure Realtime client-secret endpoint for the upcoming native voice client
- Visible agent activity and proper upstream cancellation
- Persistent browser workspaces with goals, status, activity history, pause/resume, and phone-browser takeover
- Teach-by-demonstration step capture saved as reusable personal skills
- Routine editor with active state, dry runs, run history, schedules, Slack, Teams, Git, Linear, Sentry, PagerDuty, and webhook trigger definitions
- Agent Hub actions hand workspace, skill, and routine runs to the existing OpenAI coordinator
- Private persistent Chromium worker powered by Playwright
- Live 1280×720 browser screenshots in the mobile Agent Hub
- Phone-controlled remote taps and typing into the focused browser field
- Bounded autonomous browser runs with persistent cookies, pause controls, and verified completion reports
- Automatic CAPTCHA/security-challenge handoff and explicit approval before consequential clicks

## Where the agent runs

The current build deploys a Tdotbot coordinator plus three bounded specialist workers in `server/index.mjs`: Researcher, Planner, and Reviewer. On complex requests they work independently in parallel, return findings to Tdotbot, and Tdotbot owns the final user-facing answer. Short requests stay with the coordinator to avoid unnecessary latency and API usage.

The Android app is the client: it sends requests to the private server URL in `.env`, displays each agent's live activity, and runs approval-gated phone actions. Web search runs through the OpenAI Responses API; reminders, contacts, location, and calendar actions execute on the phone only after approval.

Start the deployed personal agent with:

```powershell
npm run server:start
```

Keep the PC and phone on the same Wi-Fi. Workers run per request rather than as permanent background processes, avoiding idle API usage.
- Cancel/new-chat controls
- Server-side API key isolation

## Run it

1. Copy `.env.example` to `.env`.
2. Set `OPENAI_API_KEY` in `.env`.
3. For a physical phone, set `EXPO_PUBLIC_API_URL` to this computer's LAN address, such as `http://192.168.1.20:8787`.
4. Start the backend:

   ```powershell
   npm run server
   ```

5. In a second terminal, start Expo:

   ```powershell
   npm start
   ```

Press `a` for Android, `w` for web, or scan the displayed QR code with a compatible Expo client.

## Security notes

- Never put `OPENAI_API_KEY` in `EXPO_PUBLIC_*` variables or mobile source code.
- Add authentication, per-user quotas, rate limiting, request-size limits, and abuse monitoring before deploying publicly.
- Restrict CORS to your deployed client origin in production.
- Tool continuation currently uses stored OpenAI Responses so `previous_response_id` can resume after approval; review your API data-retention settings.

## Next milestones

- Realtime voice over WebRTC using server-minted short-lived client secrets
- Native/system-wide demonstration recording; the current build records actions and instructions inside Tdotbot
- Encrypted local conversation persistence (the current Async Storage history is persistent but unencrypted)
- User accounts and cross-device sync
- Calendar/contact/location tools gated by explicit permission and confirmation
