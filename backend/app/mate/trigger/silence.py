"""Geny executor's [SILENT] protocol. Autonomous text is delivered only after this decision."""
import re
from app.providers.base import ProviderEvent
_LEADING_TAG=re.compile(r'^\s*\[[^\]\n]{1,40}\]')
def is_silence_text(text):
    t=(text or '').strip()
    for _ in range(4):
        if t.upper().startswith('[SILENT]'):
            rest=t[8:].strip()
            return len(rest)<=2 and not any(ch.isalnum() for ch in rest)
        match=_LEADING_TAG.match(t)
        if match is None:return False
        t=t[match.end():].strip()
    return False

async def deliver_autonomous(stream):
    chunks=[]
    async for ev in stream:
        if ev.type=='text.delta':
            chunks.append(str(ev.data.get('text') or ''))
            continue
        if ev.type=='turn.complete':
            text=ev.data.get('text') or ''.join(chunks)
            silent=is_silence_text(text)
            # The buffered text precedes its terminal event on the wire and in history.
            # A new timestamp here would be later than the already-created completion:
            # history sorted by time would render the same answer in two turns.
            if text and not silent:yield ProviderEvent(type='text.delta',data={'text':text},timestamp=ev.timestamp)
            ev.data={**ev.data,'text':'' if silent else text,'silent':silent}
            chunks=[]
        yield ev


def _could_be_silence(text):
    """The text so far could still turn out to be [SILENT] (perhaps after an expression tag or two)."""
    t=(text or '').strip()
    for _ in range(4):
        if not t:return True
        if t.upper().startswith('[SILENT]') or '[SILENT]'.startswith(t.upper()):return True
        match=_LEADING_TAG.match(t)
        if match is None:
            return t.startswith('[') and ']' not in t and len(t)<=41  # (a tag still being written)
        t=t[match.end():].strip()
    return False


async def deliver_reply(stream,narrate):
    """A mate's answer to a message of the user's: whether she answers at all is hers (app/mate/state.REFUSE tells her when she
    is furious with them; [SILENT] is how she doesn't). Her text is held only while it could still be that, then flows as ever;
    a reply of [SILENT] becomes the line that she doesn't answer (``narrate()``), marked refused, and nothing of it streams."""
    held,flowing=[],False
    async for ev in stream:
        if ev.type=='text.delta' and not flowing:
            held.append(str(ev.data.get('text') or ''))
            if _could_be_silence(''.join(held)):continue
            flowing=True
            yield ProviderEvent(type='text.delta',data={'text':''.join(held)},timestamp=ev.timestamp)
            held=[]
            continue
        if ev.type=='turn.complete':
            text=ev.data.get('text') or ''.join(held)
            if is_silence_text(text):
                ev.data={**ev.data,'text':narrate(),'refused':True}
            elif held:
                yield ProviderEvent(type='text.delta',data={'text':''.join(held)},timestamp=ev.timestamp)
            held,flowing=[],False
        yield ev
