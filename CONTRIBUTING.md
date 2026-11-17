# Contributing to Ozzie

Thank you for helping. Ozzie does a church's computer "table work" so people
have more time for people. It prepares and surfaces; people decide and people
send. Contributions are welcome when they fit inside the rules below.

## Rules that are not up for change

These are safety boundaries, not settings. A change that weakens one will not
be merged.

- **Read-only.** Ozzie reads Planning Center with a fixed list of GET
  requests. There is no write path, and no tool that sends a message.
- **The names Ozzie reads never go to an AI model.** Models see placeholders;
  names are put back on the Mac. Background-check facts never go to a model at
  all, even as placeholders.
- **No scoring or ranking of people**, and no labels such as "at risk".
  Findings are facts with a source and a check time. Uncertainty is labeled
  "Worth a look".
- **No generated prayers, sermons, devotionals or scripture**, and nothing
  that speaks to a church member as if it were a pastor or a friend.
- **No secrets in the repository.** Keys and tokens live in the environment
  or the macOS Keychain only.
- **Every safety check lives in this open repository**, so it works the same
  for a church that runs Ozzie on its own.

## Plain language

Everything a church leader reads is plain English. Don't use "skills",
"sessions", "agent", "log", "connector" or "harness" in the app's wording.
Buttons name the person and the effect ("Copy draft", "Looks good — start
it"), never a bare "Approve".

## Before you open a pull request

To add a read-only tool, a procedure or another AI model, start with
[core/docs/extending.md](core/docs/extending.md): it names every file each
change touches and what is closed on purpose.

1. Open an issue first for anything larger than a small fix, so the approach
   can be agreed before you spend time on it.
2. Write a test with fixed, fictional data for any finding or rule you add or
   change. Never use a real person's details in a test, an issue or a
   screenshot.
3. Run the checks the CI runs (see the README, "Build and run"): typecheck,
   lint, the TypeScript tests and the native tests.
4. A change to what Ozzie reads from Planning Center, to what is sent to a
   model, or to anything in the rules above needs a second, independent
   review. Say so in the pull request.

## Licence

Ozzie is licensed under Apache-2.0. By contributing you agree that your
contribution is licensed under the same terms.
