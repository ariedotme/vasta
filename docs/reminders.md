# Reminders

The server sends reminders, so they arrive with every app closed (`packages/server/src/reminders.ts`):

- **Habits** at their "Remind at" time (a property of the habit: "8:00", "21h30"), in the user's
  time zone, on the days the habit repeats on, while it is not done that day (for a daily goal:
  while the amount is under the goal; the reminder says how far along it is). Paused habits stay quiet.
- **Timed events and tasks** a few minutes before they start (0, 5, 10, 15, 30 or 60): objects
  with a time on the calendar (date properties with a time, objects' own dates), tasks not done,
  and events of subscribed calendars. All-day items do not remind.
- **Food**, in spaces that track food (core's `foodDayNudge`, `foodWeekNudge`, `foodMealNudge`):
  - *What is left of the day*, at a time (18:00 by default): "600 kcal left today" with "40 g
    protein to go · the week is on track" (or "the week is 800 kcal over so far"). With a weekly
    budget the day is measured against its share of what the week has left (the Food block's
    "today up to …"). Not sent without a goal or on a day not counted; with nothing logged it says
    so and what is to go.
  - *The week's summary*, on a weekday at a time (Sunday 20:00 by default), about the Monday to
    Sunday week ending that day: within the budget or over it (or the average kcal against the
    goal), protein a day against the goal, days on target, the streak, days not counted.
  - *Meals with nothing logged*, 30 minutes to 2 hours after each meal's usual time (off by
    default): "Lunch not logged · 1 200 kcal today so far (goal 2 000)".

  A click opens the Nutrition page.

## Reminders (insistent reminders)

A reminder that matters asks until it gets a real answer (`packages/server/src/insistent.ts`; the
code still calls them insistent reminders, the app calls them Reminders). One can be set on any
object (its menu's **Remind me…**: a habit, a task, an event, an Echo) or on nothing (Settings ›
Reminders, "New reminder…": an affirmation every morning). The plain habit, event and food
reminders, and the channels everything goes through, are Settings › Reminder channels. Each one says:

- **When it starts**: the object's own time (a habit's "Remind at" on its days, while not done; a
  task's or event's start, a few minutes before), a time of day on some weekdays, or **the first time
  the user is at the computer** after an hour (the desktop app says when they come back: input after
  5 minutes without any, or the computer waking; "by 11:00 anyway" starts it wherever they are).
- **What it shows**, so even an ignored notification gets read: the object, 1 to 5 random objects
  with a tag (sub-tags too) or from a saved query (the ones of last time come last), or today's tasks.
- **How it is answered**: OK, doing the habit or task (wherever it is marked done), typing its text
  word for word, or saying it out loud (the page listens with the browser's speech recognition; typing
  works where it cannot). Typing or saying it on a habit also marks the habit done. Text is compared
  loosely (`core/text-match.ts`): case, accents and punctuation do not count, nor one slip in a long
  word; said text needs 70 % of the words in order, typed text 90 %. Swiping a notification away
  answers nothing.
- **How it reaches the user**, its *style*: **Pop-up** (a window of the desktop app floating over
  everything, in the middle of the screen with the pointer, until answered), **Full screen** (the
  takeover), **Notification** (every 30 minutes, notifications only), **Escalating** (every 15
  minutes, louder at each step, the screen at 45) or **Relentless** (every 5 minutes, Telegram at 10,
  the screen at 15). A style is a *ladder* (`REMINDER_STYLES` on the server, `STYLES` in
  web/src/lib/insistent.ts): steps minutes apart, each through some channels (phones and browsers,
  the desktop notification, ntfy, Telegram, the **pop-up**, the **takeover**), urgent or not (ntfy
  priority 5 instead of 4, Web Push notifications that stay until answered), repeated every few
  minutes until answered (or not: the pop-up and full screen stay until answered). "Custom" edits
  the steps.
- **Once answered** (`openAfter`, optional): a note the desktop app opens when the pop-up or the
  takeover is answered (OK, done, typed or said; not snoozed, skipped or let go): the page passes it
  to `close_takeover`, which shows it in the app's window. Without one, the app hides again if it
  was not the app in front when the reminder showed up, so the user is back where they were.
- **Snoozing has a cost**: a snooze (5 to 60 minutes) pauses it and the ladder's clock, but every few
  snoozes it climbs a step. **Not today** asks for a one-line reason, which is kept.

Each occurrence is a *nag* (`reminder_nags`; the rules are in `reminder_rules`): open until answered,
until the habit or task is done anywhere, or until its day ends (two hours at least; then it was
**ignored**). Quiet hours (per user) hold every repeat until they end. An object with an insistent
reminder at its own time does not get the plain habit or event reminder too. The **honest stats**
(the editor and Settings) come from the nags of the last 30 days: answered how and after how long
(median), snoozes, skips with their reasons, ignored, how often it climbed or took the screen, the
last 14 days as a strip, and a hint when it looks too easy to ignore or more than needed.

Where it is answered:

- **The page** `/remind/<id>`, which every notification opens: the content, the answer, Snooze and
  Not today. With `?takeover=1` it is shown alone (the takeover).
- **Buttons** on ntfy (`http` actions) and Web Push notifications (Android, Chrome and Firefox on
  computers; iOS shows none) post to `POST /api/remind/<id>/<ok|done|snooze>?s=<signature>`: a link
  signed with the server's secret (`reminders.secret` in meta) for one answer to one nag, since
  neither carries the session. "Say it", "Type it" and "Not today" open the page.
- **Telegram**: buttons under the message (Done, Snooze, Not today, which asks why with a reply), and
  a reply with the text answers a "type it" or "say it" reminder. Once answered, the buttons become
  one saying how.
- **The pop-up and the takeover** (desktop 0.10 and later, which connect with `?takeover=1`; the
  pop-up from 0.11, older apps take the screen instead): the server sends a `takeover` event, with
  `popup: true` for the pop-up (its page is `/remind/<id>?takeover=1&popup=1`, laid out tighter): the
  app opens the page in a window of 560 × 560 points in the middle of the screen with the pointer,
  above everything and on every Space, without covering the other screens. For the takeover: the app opens the page in a window over the whole screen with the pointer, above
  other apps, the Dock and the menu bar, on every Space and over full-screen apps, and dims the other
  screens (`packages/desktop/src-tauri/src/takeover.rs`). It never traps anyone: the page offers a
  way out after a few seconds (recorded as escaped, a skip); a page that cannot show the reminder
  (logged out, the server unreachable) closes it at once, and so does the app when the page has not
  said it shows the reminder within 15 seconds (`takeover_ready`), and two minutes after the way
  out in any case. A `dismiss` event closes it when the nag is answered or snoozed anywhere. Older
  apps get a notification instead.
- **Presence**: the desktop app posts `POST /api/notifications/presence` (`{ state: "here" | "away" }`,
  with its notify token) when the user comes back or the computer wakes (the wall clock jumped past
  the monotonic one), every 90 seconds while they are here (macOS reads the system's idle time;
  elsewhere a running app counts as here), and when they go idle.

Agents reach them through the MCP (`list_reminders`, `set_reminder`, `start_reminder`,
`remove_reminder`; [agents.md](agents.md)), within what Settings › Agents lets them see and change:
a reminder about a hidden object, in a hidden space or showing a hidden tag does not exist for them.
`start_reminder` (`InsistentReminders.startNow`) starts a nag now, outside the rule's schedule.

Routes (app sessions): `GET|POST /api/auth/reminders/rules` (`?object=` for an object's),
`PUT|DELETE /api/auth/reminders/rules/:id`, `GET /api/auth/reminders/nags` (going on now),
`GET|POST /api/auth/reminders/nags/:id` (`{ answer: ok|done|typed|said|snooze|skip|escape, texts?, reason? }`).

**Platform limits.** iOS does not let a web app break through Focus or silent mode: Critical Alerts
need an entitlement Apple grants to apps, and Web Push cannot ask for time-sensitive delivery. On
phones, insistence comes from repetition, ntfy's priority and Telegram. How the ntfy iOS app shows
priority 5 (whether it is delivered as time-sensitive) is not verified here: check it on the phone
with "Send a test" from a step marked urgent. The desktop is where it can be truly invasive, and so
the takeover is only ever a step of a ladder the user set up.

## Others' work

In a shared space the server also tells people about each other's work
(`packages/server/src/notifications.ts`), worked out where a user's write is applied
(`Store.onObjectWrite`: the app, sync pushes, captures and agents alike):

- **Assigned**: a person field (a task's Assignee…) now names you. Assigned again within 10
  minutes (cleared and set) tells you once.
- **Mentioned**: a comment mentions you (@username), new or edited to add you.
- **Comment**: a new comment on something you follow: you made it, a person field names you, or
  you commented on it (unless it mentions you: then it is a mention).

Never about your own writes, and only to members of the space. They are kept 30 days in the
`notifications` table and listed by the **bell** (the sidebar's footer; the top bar on phones), with
the unread count (`GET /api/notices`, `POST /api/notices/read` `{ ids? }`). Each kind also goes
through the channels below unless Settings › Reminders, "Others' work", turns it off (all on by
default; `work` in the settings); a click opens the object.

## Channels

Each user picks the channels in Settings › Reminders, stored in the database's meta
(`reminders.<userId>`; the ntfy token never goes back to the app):

- **ntfy**: a server (ntfy.sh or your own) and a topic, plus an access token for a protected
  topic. Published as JSON to the server's root (`{ topic, title, message, tags, click }`), so any
  text fits the title; a click opens the object in the web app (`VASTA_WEB_URL`). Like calendar
  feeds, an ntfy server on the local network needs `VASTA_ALLOW_PRIVATE_FETCH` (its host).
- **Telegram**: the bot writes in the user's private chat with it, once their Telegram account is
  linked and the bot runs.
- **Desktop app** (on by default): system notifications from Vasta for desktop 0.1.11 and later,
  while it runs, its window closed too. The app keeps its own connection to
  `GET /api/notifications` (Server-Sent Events, `notify` events; `DesktopListeners`,
  server/src/events.ts), reconnecting after a lost connection (5 s, doubling to a minute), with a
  token of scope `notify` that only opens that stream: once logged in, the web app inside it asks
  for one (`POST /api/auth/desktop-token` with the install's name, "Mac 3f2a"; a new one replaces
  the device's last) and hands it over (`set_notify_token`, kept in the app's settings.json).
  Logging out forgets it; when the server refuses it (deleted in Settings › Capture tokens), the
  app drops it and the web app makes another. The app shows each reminder's key once and opens
  its page when the notification is clicked. Only the apps running at that moment get it: unlike
  ntfy, nothing waits for an app that is closed. Settings › Reminders says how many listen now.
  Desktop 0.1.10 heard them through its page instead (`/api/events?desktop=1`), which WebKit does
  not keep open once the window is closed: the first test arrived, the next ones did not.

- **Phones and browsers** (Web Push, `packages/server/src/push.ts`): notifications of the web
  app, shown by its service worker (`public/sw.js`) with the app closed; a tap opens the page in an
  open window of the app, or a new one. Each device turns them on in Settings › Reminders ("Turn
  on notifications on this device", a tap, since iOS asks for permission only then) and keeps its
  own choice of what reminds it (habits, events and tasks, food, others' work), on top of the
  user's settings. iPhone and iPad take them in the app added to the Home Screen (iOS 16.4 and
  later); Android, macOS, Windows and Linux browsers in a tab too. The desktop app has its own
  channel above and does not offer this. Nothing to configure: the server makes its key pair
  (VAPID, RFC 8292) on first use and keeps it in meta (`push.vapid`); messages are encrypted for
  each device (aes128gcm, RFC 8291) with node:crypto and posted to the address the browser gave
  (its push service: Apple's, Google's, Mozilla's), through `safeFetch`. VAPID's contact is
  `VASTA_WEB_URL`, else the https address devices subscribed from (`push.subject`): Apple's
  service refuses a JWT without a real one. Devices are kept in meta (`push.devices.<userId>`,
  at most 20); one its push service no longer knows (404, 410) is dropped. Routes:
  `POST /api/auth/reminders/devices` (`{ subscription, name }`, again refreshes the device),
  `PATCH …/devices/:id` (`{ name?, kinds? }`), `DELETE …/devices/:id`.

"Send a test" sends through every channel set (to every device, whatever each chose) and says
what each answered. The service looks every
30 seconds at what fell due since it last looked, and sends each reminder once; what fell due
while the server was down is not sent late. `VASTA_REMINDERS=0` turns the service off.
