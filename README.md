# billfuse

Check your AI spend against a monthly budget without leaving the terminal.

There are two ways to use it:

- **`check`, no account.** Reads this month's spend straight from OpenAI, Anthropic, OpenRouter and xAI, on your computer. Nothing is sent to Billfuse.
- **`status` and `watch`, with a Billfuse account.** Shows what [billfuse.dev](https://billfuse.dev) has already synced, including Gemini. Billfuse does the hourly sync and sends the alerts, so nothing has to keep running on your side.

## check: no account needed

```
$ export OPENAI_ADMIN_KEY=sk-admin-...
$ export ANTHROPIC_ADMIN_KEY=sk-ant-admin...
$ npx billfuse check --budget 600

Billfuse · November 2026 (UTC)

  Spent this month       $247.30
  Budget                 $600.00   41% used · $352.70 left
  Projected              $463.69   at the current pace

  █████████████░░░░░░░░░░░░░░░░░░░  41%

  Anthropic        $139.84   57%
  OpenAI           $107.46   43%

  Top models this month
  claude-sonnet-4-5                  $121.10
  gpt-4o                              $88.02

  Read from each provider on this computer. Nothing was sent to Billfuse.
  Alerts while you're away: https://billfuse.dev
```

Set at least one of these environment variables to that provider's admin or management key. It is a different key from the one you call models with.

| Variable                    | Key                                                                                                                                                                               |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPENAI_ADMIN_KEY`          | An OpenAI Admin API key (it looks like `sk-admin-...`). Only organization owners can create one.                                                                                  |
| `ANTHROPIC_ADMIN_KEY`       | An Anthropic Admin API key (it starts with `sk-ant-admin`). Organization members with the admin role can create one. Individual Claude Console accounts don't have the Admin API. |
| `OPENROUTER_MANAGEMENT_KEY` | An OpenRouter management key, created on the Management API Keys page (openrouter.ai/settings/management-keys).                                                                   |
| `XAI_MANAGEMENT_KEY`        | An xAI management key, from xAI Console → Settings → Management Keys.                                                                                                             |

Each key is sent only to its own provider's official address. Variables like `OPENAI_API_BASE_URL` are ignored, so a proxy setting can't redirect an admin key.

Options for `check`:

- `--budget <usd>` or `BILLFUSE_BUDGET`: the monthly budget to measure against. Without it, `check` only shows spend and never exits with code 2.
- `--fail-at <pct>`: the share of the budget that counts as a failure, as a number without the `%` sign. Defaults to 100.
- `--json`: print the numbers as JSON, in the same shape as `status --json`. If a provider couldn't be read, its entry has an `error` and the totals leave it out.

`check` stops with an error on an option it doesn't know, so a typo can't quietly turn the budget off.

Exit codes, for cron jobs and CI:

| Code | Meaning                                                                           |
| ---- | --------------------------------------------------------------------------------- |
| `0`  | Every provider was read and spend is under the threshold.                         |
| `2`  | Spend has reached the threshold (`--fail-at`, or 100% of the budget).             |
| `1`  | Something went wrong, or a provider couldn't be read, so the total is incomplete. |

Good to know:

- Months and days are in UTC.
- The numbers are what each provider's API reports at that moment. OpenRouter reports the last 30 completed UTC days, so today's OpenRouter spend isn't in the total until the day is over.
- For OpenRouter, the number is OpenRouter credits spent. OpenRouter reports the inference cost of requests made with your own provider key (BYOK) separately, and `check` doesn't add it.
- xAI's docs describe the amount only as "Cost in USD". `check` reads it as dollars, and we haven't checked that against a real xAI bill yet.
- Gemini isn't in `check`: its spend comes from a Google Cloud billing export. It is supported with a Billfuse account.
- `check` runs once and exits. It doesn't alert you or pause anything.

## With a Billfuse account

| Command               | What it does                                                                                                                                                                                                   |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npx billfuse login`  | Opens your browser to authorize this computer. On a remote machine (SSH), add `--no-browser`: open the printed link in any browser where you're signed in, approve, and paste the code back into the terminal. |
| `npx billfuse status` | Shows this month's spend, budget, projection and top models. Add `--json` for scripts, or `--fail-at 80` to exit with code 2 once 80% of the budget is used.                                                   |
| `npx billfuse watch`  | Refreshes every 5 minutes (`--interval <minutes>` to change, from 1 to 1440). Shows a banner at 50% (cyan), 80% (yellow) and 100% (red) of your budget and rings the terminal bell each time it gets worse.    |
| `npx billfuse logout` | Revokes this computer's access and forgets it.                                                                                                                                                                 |

Access is read-only: these commands can't change your budget or see your provider keys. You can also revoke a computer in **Settings → CLI access**.

## Options

- `--api <url>` or `BILLFUSE_API_URL`: the Billfuse address to sign in to. Must be `https://` (plain `http://` only for localhost).
- `--no-color` or `NO_COLOR=1`: plain output.
- `BILLFUSE_CONFIG_DIR`: where to keep the access token (defaults to `%APPDATA%\billfuse` on Windows and `~/.config/billfuse` elsewhere).
- `BILLFUSE_NO_OPEN=1`: never open a browser; just print the link.

Requires Node.js 18.17 or newer.

## Development

```
npm install
npm test
npm run build
node dist/index.js --help
```

Running the tests needs Node.js 22.12 or newer. The built CLI itself runs on Node.js 18.17 or newer.

This repository is generated from the Billfuse app's source, and every release overwrites it. Issues are welcome. A pull request can't be merged here directly: a change that is accepted is made in the app's source and appears here with the next release.

## License

MIT
