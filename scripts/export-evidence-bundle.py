#!/usr/bin/env python3
"""
Export sanitized evidence bundle for EI review.

Exports timestamped observation records, logs, and state files to
a single tarball with SHA-256 hashes. No secrets or env vars included.
"""
import os, sys, json, hashlib, tarfile, shutil
from datetime import datetime, timezone

REPO = '/home/z/my-project/edge-engine'
EXPORT_DIR = os.path.join(REPO, 'data', 'evidence-bundles')
BUNDLE_NAME = f'evidence-bundle-{datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")}'
BUNDLE_DIR = os.path.join(EXPORT_DIR, BUNDLE_NAME)
TARBALL = f'{BUNDLE_DIR}.tar.gz'

FILES = {
    'limusd-observations.jsonl': 'data/limusd-study/observations.jsonl',
    'limusd-monitor-state.json': 'data/limusd-study/monitor-state.json',
    'limusd-monitor.log': 'logs/limusd-monitor.log',
    'khype-defillama-observations.jsonl': 'data/khope-study/observations.jsonl',
    'khype-cadence-observations.jsonl': 'data/khope-study/cadence-observations.jsonl',
    'khype-cadence-state.json': 'data/khope-study/cadence-state.json',
    'khype-cadence-sampler.log': 'logs/khype-cadence-sampler.log',
    'khype-timeseries.log': 'logs/khype-timeseries.log',
    'daemon-supervisor.log': 'logs/daemon-supervisor.log',
    'window7-audit.json': 'data/evidence-bundles/window7-audit.json',
}

def sha256_file(filepath):
    h = hashlib.sha256()
    with open(filepath, 'rb') as f:
        while True:
            chunk = f.read(8192)
            if not chunk: break
            h.update(chunk)
    return h.hexdigest()

def count_lines(filepath):
    try:
        with open(filepath) as f:
            return sum(1 for _ in f)
    except: return 0

def sanitize_log(filepath, max_lines=500):
    try:
        with open(filepath) as f:
            lines = f.readlines()
        lines = lines[-max_lines:] if len(lines) > max_lines else lines
        sanitized = []
        for line in lines:
            if any(s in line.lower() for s in ['token=', 'key=', 'password=', 'secret=', 'private_key']):
                sanitized.append('[REDACTED]\n')
            else:
                sanitized.append(line)
        return ''.join(sanitized)
    except Exception as e:
        return f'[ERROR reading log: {e}]\n'

os.makedirs(BUNDLE_DIR, exist_ok=True)

manifest = {
    'export_time': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
    'repository_head_at_export': os.popen(f'cd {REPO} && git rev-parse HEAD').read().strip(),
    'reported_loaded_revision': 'ffd5831',
    'loaded_revision_qualification': 'Manager-reported. Processes started 2026-10-15T08:04:12Z when HEAD was ffd5831. No contemporaneous tree hash was recorded at process start. The loaded revision has not been independently proven by EI.',
    'window7_start': '2026-10-15T08:04:12Z',
    'window7_nominal_completion': '2026-10-16T08:04:12Z',
    'files': {},
}

for export_name, src_path in FILES.items():
    full_src = os.path.join(REPO, src_path)
    dest = os.path.join(BUNDLE_DIR, export_name)
    if not os.path.exists(full_src):
        manifest['files'][export_name] = {'status': 'NOT_FOUND', 'path': src_path}
        continue
    if export_name.endswith('.log'):
        content = sanitize_log(full_src)
        with open(dest, 'w') as f: f.write(content)
        manifest['files'][export_name] = {
            'status': 'OK', 'source_path': src_path,
            'sha256': sha256_file(dest), 'lines': content.count('\n'),
            'sanitized': True, 'note': 'Last 500 lines, secrets redacted',
        }
    else:
        shutil.copy2(full_src, dest)
        manifest['files'][export_name] = {
            'status': 'OK', 'source_path': src_path,
            'sha256': sha256_file(dest),
            'lines': count_lines(dest) if export_name.endswith('.jsonl') else None,
        }

analysis = {
    'limusd': {'total_observations': count_lines(os.path.join(REPO, 'data/limusd-study/observations.jsonl')),
               'first_ts': None, 'last_ts': None, 'gaps': [], 'null_fields': 0, 'all_fields_ok': True},
    'khype_cadence': {'total_observations': count_lines(os.path.join(REPO, 'data/khope-study/cadence-observations.jsonl')),
                      'reward_steps': 0, 'cadence': 'UNRESOLVED'},
    'khype_defillama': {'total_observations': count_lines(os.path.join(REPO, 'data/khope-study/observations.jsonl'))},
}

try:
    obs_list = []
    with open(os.path.join(REPO, 'data/limusd-study/observations.jsonl')) as f:
        for line in f: obs_list.append(json.loads(line))
    if obs_list:
        analysis['limusd']['first_ts'] = obs_list[0]['ts']
        analysis['limusd']['last_ts'] = obs_list[-1]['ts']
        from datetime import datetime as dt
        prev = None
        for obs in obs_list:
            ts = dt.fromisoformat(obs['ts'].replace('Z', '+00:00'))
            if prev:
                delta_min = (ts - prev).total_seconds() / 60
                if delta_min > 20:
                    analysis['limusd']['gaps'].append({
                        'from': prev.strftime('%Y-%m-%dT%H:%M:%SZ'),
                        'to': ts.strftime('%Y-%m-%dT%H:%M:%SZ'),
                        'minutes': round(delta_min, 1)})
            prev = ts
        for obs in obs_list:
            for field in ['navRaw', 'sharePrice', 'ptExpiry']:
                if obs.get(field) is None:
                    analysis['limusd']['null_fields'] += 1
                    analysis['limusd']['all_fields_ok'] = False
except Exception as e:
    analysis['limusd']['error'] = str(e)

try:
    with open(os.path.join(REPO, 'data/khope-study/cadence-observations.jsonl')) as f:
        for line in f:
            obs = json.loads(line)
            if obs.get('rewardStepDetected'):
                analysis['khype_cadence']['reward_steps'] += 1
except: pass

manifest['analysis'] = analysis

# Capture timestamped process inventory
import subprocess as sp
ps_result = sp.run(['ps', '-eo', 'pid,lstart,args'], capture_output=True, text=True)
process_inventory = []
for line in ps_result.stdout.split('\n'):
    if ('limusd-monitor' in line or 'khype-cadence' in line or 'daemon-supervisor' in line) and 'grep' not in line:
        process_inventory.append({
            'raw': line.strip()[:200],
            'captured_at': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        })

# Duplicate worker detection
limusd_tsx = sum(1 for l in ps_result.stdout.split('\n') if 'cli.mjs' in l and 'limusd-monitor' in l and 'grep' not in l)
cadence_tsx = sum(1 for l in ps_result.stdout.split('\n') if 'cli.mjs' in l and 'khype-cadence' in l and 'grep' not in l)
manifest['process_inventory'] = process_inventory
manifest['duplicate_worker_check'] = {
    'limusd_monitor_tsx_processes': limusd_tsx,
    'khype_cadence_tsx_processes': cadence_tsx,
    'duplicate_detected': limusd_tsx > 1 or cadence_tsx > 1,
    'captured_at': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
    'qualification': 'Manager-reported. Not independently verified by EI.',
}

with open(os.path.join(BUNDLE_DIR, 'manifest.json'), 'w') as f:
    json.dump(manifest, f, indent=2)

with tarfile.open(TARBALL, 'w:gz') as tar:
    tar.add(BUNDLE_DIR, arcname=BUNDLE_NAME)

# Copy to download for EI access
import shutil as sh
download_dest = f'/home/z/my-project/download/{os.path.basename(TARBALL)}'
sh.copy2(TARBALL, download_dest)

print(f"Evidence bundle exported: {TARBALL}")
print(f"Copied to: {download_dest}")
print(f"\nManifest summary:")
print(json.dumps(manifest['analysis'], indent=2))
print(f"\nFile hashes:")
for name, info in manifest['files'].items():
    if info.get('status') == 'OK':
        print(f"  {name}: {info['sha256'][:16]}... ({info.get('lines', '?')} lines)")
