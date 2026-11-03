# Scheduled

The **Scheduled** tab configures LG's existing power-on timer and apps to
launch after that timer wakes the TV. The timer uses the TV's local clock.
Choose repeat days, or leave them empty for the next occurrence only. Saving
the timer uses the same settings and rearming sequence as System → Power.

Enable scheduled app launches and add up to ten installed apps. Each delay is
5–600 seconds from power-on, not from the preceding app. Apps launch in delay
order, with equal delays keeping their configured order. The last app stays
in the foreground. An app removed from the TV is reported as failed.

Only a wake reported by `tvpower` as `onTimer` triggers the list. Remote keys,
HDMI-CEC, Wake-on-LAN, reboots and Always Ready artwork timers do not. The
feature needs Glasshouse to run after waking; it cannot wake the TV itself
while the TV is fully asleep. Initial detection more than three minutes after
power-on is skipped, so restarting Glasshouse later does not replay a morning
routine.

The app list is saved under `scheduledApps` in Glasshouse's private config.
Run state is stored in `/var/lib/tvweb/scheduled-apps-state.json`, using the
kernel boot ID and power-on uptime to identify each wake. Completed launches
are not repeated after a server restart. Unstarted actions can resume within
ten minutes of the same wake; an interrupted launch is not retried because it
may already have reached the TV. Switching off, disabling launches, editing
the app list or disabling controls cancels pending actions. A config save or
state-file write failure prevents unrecorded launches.

Activity shows the last observed wake reason and the last run's app results.
The tab works in a phone or computer browser; no PC needs to stay on.

Opening Spotify launches its TV app. It does not select a playlist or promise
automatic playback; that requires a separate playback automation.
