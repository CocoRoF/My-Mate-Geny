"""Seven local calendar days of numeric terminal usage, without copying conversation content."""
from __future__ import annotations

import json
import math
from collections import defaultdict
from datetime import datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

from app.services.turn_cost import TurnCostNormalizer, engine_of, turn_cost

# Project usage/attribution fields, never assistant text or tool output.
FIELDS = """e.id,e.session_id,e.type,e.created_at,
json_extract(e.data,'$.usage') AS usage,
json_extract(e.data,'$.cost_usd') AS cost_usd,json_type(e.data,'$.cost_usd') AS has_cost,
json_extract(e.data,'$.cost_kind') AS cost_kind,json_extract(e.data,'$.provider') AS engine,
json_extract(e.data,'$.model') AS turn_model,json_extract(e.data,'$.usage_source') AS usage_source"""
KEYS = ('input', 'output', 'cache_read', 'cache_write')
TOKENS = ('input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens')


def empty():
    return dict(turns=0, tokens=0, input=0, output=0, cache_read=0, cache_write=0,
                cost_usd=0., unknown_cost_turns=0, unknown_token_turns=0)


def data_of(row):
    data = {'provider': row['engine'], 'model': row['turn_model']}
    if row['has_cost']:
        data['cost_usd'] = row['cost_usd']
    if row['cost_kind']:
        data['cost_kind'] = row['cost_kind']
    return data


def finish(value):
    value['cost_usd'] = round(value['cost_usd'], 6)
    return value


def week(db, tz='UTC', *, now=None):
    zone = ZoneInfo(tz)
    current = (now or datetime.now(timezone.utc)).astimezone(zone)
    first = current.date() - timedelta(days=6)
    start = datetime.combine(first, time.min, zone).astimezone(timezone.utc)
    end = datetime.combine(current.date() + timedelta(days=1), time.min, zone).astimezone(timezone.utc)
    rows = db.query(f"""SELECT {FIELDS},s.kind,s.mate_id,s.title,s.provider,s.model,m.name AS mate_name
        FROM events e JOIN sessions s ON s.id=e.session_id LEFT JOIN mates m ON m.id=s.mate_id
        WHERE e.type IN ('turn.complete','error') AND e.created_at>=? AND e.created_at<? AND json_valid(e.data)
        ORDER BY e.id""", (start.isoformat(), end.isoformat()))
    norms = defaultdict(TurnCostNormalizer)
    # Legacy Claude costs are process cumulative. Cutting at midnight without priming
    # would charge that process's entire previous history again.
    first_ids = {}
    for row in rows:
        if not row['cost_kind'] and row['has_cost']:
            first_ids.setdefault(row['session_id'], row['id'])
    for sid, eid in first_ids.items():
        prior = db.query(f"""SELECT {FIELDS} FROM events e
            WHERE e.session_id=? AND e.id<? AND e.type IN ('turn.complete','error') AND json_valid(e.data)
            ORDER BY e.id""", (sid, eid))
        for row in prior:
            norms[sid].feed(data_of(row))

    totals = empty()
    groups = {key: {'source': key, **empty(), 'items': {}} for key in ('chat', 'mate', 'internal')}
    daily = {str(first + timedelta(days=i)): {'day': str(first + timedelta(days=i)),
             **{key: empty() for key in groups}} for i in range(7)}
    inferred = 0
    for row in rows:
        data = norms[row['session_id']].feed(data_of(row))
        if row['type'] == 'error' and not data.get('cost_kind'):
            continue
        usage = json.loads(row['usage']) if isinstance(row['usage'], str) else {}
        if not isinstance(usage, dict):
            usage = {}
        values = {}
        for key, token in zip(KEYS, TOKENS):
            try:
                values[key] = max(0, int(usage.get(token, 0) or 0))
            except (ValueError, TypeError, OverflowError):
                values[key] = 0
        cost = turn_cost(data)
        if cost is not None and (not math.isfinite(cost) or cost < 0):
            cost = None
        tokens = sum(values.values())
        if row['type'] == 'error' and not tokens and not cost:
            continue
        date = datetime.fromisoformat(row['created_at'].replace('Z', '+00:00')).astimezone(zone).date().isoformat()
        if date not in daily:
            continue
        source = row['usage_source']
        if source not in groups:
            source = 'mate' if row['kind'] == 'mate' else 'internal' if row['kind'] == 'avatar' else 'chat'
            inferred += 1
        group = groups[source]
        is_mate = source == 'mate' and bool(row['mate_id'])
        item_id = row['mate_id'] if is_mate else row['session_id']
        item = group['items'].setdefault(item_id, {
            'id': item_id, 'title': (row['mate_name'] if is_mate else None) or row['title'],
            'session_id': row['session_id'], 'mate_id': row['mate_id'] if is_mate else None,
            'models': set(), **empty(),
        })
        model = row['turn_model'] or row['model'] or 'unknown'
        engine = row['engine'] or engine_of(model) or row['provider'] or 'unknown'
        item['models'].add((engine, model))
        for target in (totals, group, item, daily[date][source]):
            target['turns'] += 1
            target['tokens'] += tokens
            target['cost_usd'] += cost or 0
            target['unknown_cost_turns'] += int(cost is None)
            target['unknown_token_turns'] += int(not usage)
            for key, value in values.items():
                target[key] += value

    for group in groups.values():
        items = []
        for item in group['items'].values():
            item['models'] = [{'provider': p, 'model': m} for p, m in sorted(item['models'])]
            item['share'] = item['tokens'] / group['tokens'] if group['tokens'] else 0
            items.append(finish(item))
        group['items'] = sorted(items, key=lambda x: (-x['tokens'], -x['cost_usd'], x['id']))[:5]
        group['share'] = group['tokens'] / totals['tokens'] if totals['tokens'] else 0
        finish(group)
    for day in daily.values():
        for key in groups:
            finish(day[key])
    return {
        'days': 7, 'timezone': tz, 'from': start.isoformat(), 'to': end.isoformat(),
        'cost_basis': 'api_equivalent', 'ratio_basis': 'tokens', 'total': finish(totals),
        'sources': list(groups.values()), 'daily': list(daily.values()),
        'historical_source_inferred_turns': inferred, 'internal_breakdown': 'separate_calls_only',
    }
