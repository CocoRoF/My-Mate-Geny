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
