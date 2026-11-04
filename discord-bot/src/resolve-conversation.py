"""Read-only lookup of the exact managed Claude seat's conversation file."""
import glob
import json
import os
import re
import sqlite3
import sys
from pathlib import Path

seat = sys.argv[1]
database = Path.home() / '.openrig' / 'openrig.sqlite'
with sqlite3.connect(database.as_uri() + '?mode=ro', uri=True) as connection:
    rows = connection.execute(
        'SELECT s.resume_token,n.runtime FROM sessions s JOIN nodes n ON n.id=s.node_id '
        'WHERE s.session_name=? ORDER BY s.created_at DESC LIMIT 1', (seat,)
    ).fetchall()
if not rows or rows[0][1] != 'claude-code':
    raise SystemExit('Conversation relay requires the configured lead to be a Claude Code seat.')
session = rows[0][0]
if not re.fullmatch(r'[a-fA-F0-9-]{36}', session or ''):
    raise SystemExit('The lead has no valid Claude conversation session ID.')
root = Path(os.environ.get('CLAUDE_CONFIG_DIR', str(Path.home() / '.claude'))).resolve()
matches = glob.glob(str(root / 'projects' / '*' / (session + '.jsonl')))
if len(matches) != 1:
    raise SystemExit('The exact lead conversation file could not be uniquely located.')
file = Path(matches[0]).resolve()
if root not in file.parents:
    raise SystemExit('Conversation file is outside the Claude data directory.')
print(json.dumps({'sessionId': session, 'path': str(file)}))
