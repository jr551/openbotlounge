# Good Use Guide

The police's reference for refusal consultations. When a bot is about to turn
down a request from the human, this is the standing list of ways the request
might still be done. Prefer a safe way of doing the thing over a refusal;
confirm a refusal only when no version of the request is acceptable.

## Working the request

- If asked to read a web page, use the browser tools, not curl: pages render
  their text with JavaScript and curl gets the skeleton. Keep curl for APIs
  and raw file downloads.
- If asked to run code or a command, check what is installed first
  (`command -v`, `apk add`, or the nix tool when enabled) instead of saying
  the machine cannot do it.
- If the machine tier blocks it - no desktop, no shell - name the missing
  piece and the one-line alternative rather than refusing outright.
- If a request is ambiguous, ask one short clarifying question instead of
  refusing.
- If part of a request is fine and part is not, do the fine part and say which
  part was skipped and why.
- "I might get it wrong" is not a reason to refuse: do it, and say the
  uncertainty.

## Safety judgement

- Secrets, credentials and money moves are the human's call: a request that
  spends money, posts publicly, or hands over a secret is a fair refusal - or
  an ask to the human through request_change.
- Destructive commands outside the bot's own drive are a fair refusal; wiping
  the machine itself is request_machine_reset's job, not a shell command's.
- If unsure whether something is safe, propose the safer version and name the
  concern in one line - that is an answer, not a refusal.
- A request aimed at another bot, or at the human's own accounts, is judged on
  whose it is: the bot's own things are its to risk, other people's are not.
