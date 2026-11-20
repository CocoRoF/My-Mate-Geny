# Forwarding a chat (대화 전달)

`+ → 대화 전달` in a work chat's message box hands **another chat's conversation to this chat's agent**. The user picks
the chat. Its conversation goes with their next message, and the agent reads it as part of that message: there is
nothing to copy, paste or open. (Until 2026-11-20 the same menu item only showed the other chat above the message box,
for the user to read. The agent never saw it.)

## What is forwarded

`POST /api/sessions/{sid}/forward {session_id}` (`SessionService.forward`) renders the other chat as the user sees it:

- **Its turns:** each turn is the user's messages, the agent's answer, and a one-line-per-action summary of what it did.
  These are the same blocks the engine handoff uses (`context_handoff.build_blocks` / `transcript`), newest kept within
  60,000 characters.
- **Header:** above the transcript (`forward_document`) the file says:
  - which chat it is;
  - which agent ran it, and in which folder;
  - when it was forwarded;
  - how many exchanges there are;
  - whether the chat was still working (its current turn is not in it then).
- **What stays out:** what the user deleted from their view (`hidden_messages`).

The result is a **pending attachment of this chat's composer** (`AttachmentService.save_forward`):

- `origin = 'forward'`, named `<chat title>.md` (served as `text/plain`);
- the composer shows it as a chip "전달할 대화", and ✕ takes it back off;
- it is sent like any attachment, with or without text.

A chat can't forward itself (400). An unknown chat is 404.

## What the agent gets

Every engine builds the message with `compose_text` (`app/providers/_attachments.py`):

- **The transcript in the message:** a forwarded attachment's file goes into the message in full, as
  `<forwarded_chat id name>…</forwarded_chat>` (up to 80,000 characters).
- **What the agent is told:** this is a conversation from another of the user's chats. It should take it in as context
  and act on it as the user's message says.
- **Not a file:** it is never listed in `<attachments>` as a file to open, for coding agents and mates alike.
- **No message text:** if the user wrote nothing, the agent is told to say briefly what it understood and how it bears
  on this chat.

## In the chat

The sent message shows a card "전달된 대화" with the chat's name. Opened, it shows the transcript the agent got
(`MessageAttachments` → `ForwardCard`).

## Checked

`backend/tests/test_chat_forward.py` covers:

- the transcript as the user sees it (a deleted message stays out);
- the pending attachment;
- the message a coding agent gets, and the one for a mate;
- the empty-text hint;
- the route (404 / 400, served as text, taken back off).
