#!/usr/bin/env python3
"""Generate local paths and IDs without publishing machine-specific settings."""
import argparse
import json
import re
import shutil
import tempfile
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project-dir', required=True, help='Existing absolute Linux/WSL project directory')
    parser.add_argument('--rig-name', default='myteam')
    parser.add_argument('--guild-id')
    parser.add_argument('--channel-id')
    parser.add_argument('--user-id')
    parser.add_argument('--openrig-cli-root', help='Override installed @openrig/cli package directory')
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    project = Path(args.project_dir).expanduser()
    if not project.is_absolute() or not project.is_dir():
        parser.error('--project-dir must be an existing absolute Linux/WSL directory')
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,49}', args.rig_name):
        parser.error('invalid rig name')
    ids = [args.guild_id, args.channel_id, args.user_id]
    if any(ids) and not all(ids):
        parser.error('provide --guild-id, --channel-id and --user-id together')
    if any(ids) and not all(re.fullmatch(r'\d{17,22}', value) for value in ids):
        parser.error('Discord IDs must be 17-22 digits')
    executable = shutil.which('rig')
    if not args.openrig_cli_root and not executable:
        parser.error('install OpenRig and load its PATH before configuring')
    cli = Path(args.openrig_cli_root).expanduser().resolve() if args.openrig_cli_root else Path(executable).resolve().parents[1]
    shared = cli / 'daemon/specs/agents/shared'
    if not shared.is_dir():
        parser.error('shared agent package not found; supply --openrig-cli-root')
    output = root / 'rigs/generated'
    config_path = root / 'discord-bot/config.json'
    if output.exists():
        parser.error('rigs/generated already exists; edit the local files or move them aside before regenerating')
    if all(ids) and config_path.exists():
        parser.error('discord-bot/config.json already exists; edit it locally instead of overwriting')
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='openrig-config-', dir=output.parent) as temporary:
        staging = Path(temporary) / 'team'
        shutil.copytree(root / 'templates/team', staging)
        for file in list(staging.rglob('*.template.yaml')):
            text = file.read_text(encoding='utf-8')
            text = text.replace('__RIG_NAME__', args.rig_name)
            text = text.replace('__PROJECT_DIR_JSON__', json.dumps(str(project.resolve())))
            text = text.replace('__SHARED_REF_JSON__', json.dumps('path:' + str(shared)))
            generated = file.with_name(file.name.replace('.template.yaml', '.yaml'))
            generated.write_text(text, encoding='utf-8')
            file.unlink()
        context = staging / 'startup/context.md'
        context.write_text(context.read_text(encoding='utf-8').replace('この配布物の discord-bot/DECISIONS.md',
            str(root / 'discord-bot/DECISIONS.md')), encoding='utf-8')
        staging.rename(output)
    if all(ids):
        config = json.loads((root / 'discord-bot/config.example.json').read_text(encoding='utf-8'))
        config.update(guildId=args.guild_id, channelId=args.channel_id, allowedUserIds=[args.user_id],
                      destination='orch-lead@' + args.rig_name, rigName=args.rig_name)
        with config_path.open('x', encoding='utf-8') as file:
            json.dump(config, file, ensure_ascii=False, indent=2)
            file.write('\n')
    print('Generated:', output / 'rig.yaml')
    print('Models and topology were preserved; no agent was started.')
    print('Review local settings, then run: rig up ' + str(output / 'rig.yaml'))
    if not all(ids):
        print('Discord: copy config.example.json to config.json and replace the three ID placeholders.')


if __name__ == '__main__':
    main()
