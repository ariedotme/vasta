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

"Send a test" sends through every channel set and says what each answered. The service looks every
30 seconds at what fell due since it last looked, and sends each reminder once; what fell due
while the server was down is not sent late. `VASTA_REMINDERS=0` turns the service off.
