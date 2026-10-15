# Computer operator's field guide

The standing reference for the computer sub-agent (computer-agent.ts): how to
install software, run GUI apps, play games by vision, and recover from the
errors this box actually produces. It ships at the repo root next to
GOOD_USE_GUIDE.md and is read the same way - a missing file leaves an empty
guide, never a dead task.

## Installing software

- The box is Alpine Linux. `apk add --no-cache <pkg>` installs; `apk search
  <name>` finds the real package name when you are guessing. Install whatever
  the task needs - the preinstalled list is a head start, not a ceiling.
- `apk add` names what it could not install in its own output. "no such
  package" usually means a wrong name (search first) or a package that lives
  in the community repo - check `/etc/apk/repositories` and, if it is missing,
  append `https://dl-cdn.alpinelinux.org/alpine/latest-stable/community` and
  run `apk update`.
- No apk package at all: pull a static binary or tarball with curl/wget into
  /shared, `chmod +x` it, run it from there. Python tools install with
  `pip install --user` (or a venv), Node tools with `npm install -g`.
- Run installs on machine:"desktop" - they are quiet background work. Use
  machine:"shell" only when the person should watch it happen.
- A command that comes back "still running" is done being waited on: the
  partial output is the answer. Never re-run it and never poll it with sleep.

## Running GUI apps

- The desktop is Xvnc on DISPLAY=:1 at 1280x1024. If screenshots fail or the
  desktop is not up yet, call setup_desktop first and give it a minute.
- Launch GUI apps detached so shell_exec does not block on them:
  `DISPLAY=:1 someapp >/tmp/someapp.log 2>&1 &` - then look at the screen to
  see what it did. A GUI app that exits instantly leaves its reason in that
  log.
- Prefer a window manager that fits the job: openbox (default) is fine for
  most things; icewm gives a start menu; xfce is the full desktop for apps
  that expect one.
- Close an app with key_press "alt+F4" on its window, or `pkill -f name` from
  the shell when it will not take input.

## Playing games by vision

- The loop is look, act, look: every screenshot carries the labelled
  coordinate grid, every mouse_click/key_press/type_text spends that look,
  and the next action needs a fresh screen_look. Never chain two actions on
  one look - the second is refused.
- Read coordinates off the grid labels, not by guessing pixel positions. Aim
  for the middle of the target, not its edge.
- DOSBox: `apk add dosbox`, put the game files in a directory, then launch
  with an auto-mount so it starts straight into the game:
  `DISPLAY=:1 dosbox -c 'mount c /shared/dosgame' -c 'c:' -c 'GAME.EXE' &`.
  Other emulators that apk carries: scummvm, fceux (NES), retroarch. ROMs and
  game files are downloads - fetch them with curl/wget first.
- Keyboard beats mouse for anything real-time: key_press takes xdotool names
  ("Up", "Down", "Left", "Right", "space", "Return", "ctrl", "alt"). A game
  that needs held keys or rapid input will outrun the look-act loop - play
  turn-based and menu-driven games well, and say so when a game needs
  reflexes the loop cannot give it.
- DOS games that grab the mouse release it with ctrl+F10; fullscreen toggles
  on alt+Return.

## The browser

- Reading the web is not your job - the bot has a browser operator for that.
  If the task is to open, read or use a website, report that it needs the
  browse tool and stop.
- browser_screenshot and send_screenshot put pictures in front of the person;
  neither gives you pixels back. Your eyes are the per-step screenshot and
  screen_look.
- A task that needs a page visibly open on the desktop (showing the person,
  not reading it) can launch chromium from the shell once the desktop recipe
  has installed it: `DISPLAY=:1 chromium '<url>' &`.

## Common errors

- "command not found" - install it (apk add) or check the name with apk
  search. Never conclude the box cannot do something before checking.
- "cannot open display" / an app that never appears - DISPLAY is unset or the
  desktop is down: prefix `DISPLAY=:1`, or run setup_desktop.
- "permission denied" on a downloaded binary - `chmod +x`.
- apk "no such package" - wrong name or missing community repo (see above).
- ping, traceroute, dig and other ICMP/raw tools can never work through the
  proxy - use `curl -w '%{time_total}'` for a latency check instead.
- A screenshot that fails means no desktop, not a dead machine: shell work
  still runs, and setup_desktop brings the screen up.
