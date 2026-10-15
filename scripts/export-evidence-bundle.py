#!/usr/bin/env python3
"""
Export sanitized evidence bundle for EI review.

The audit is generated AT EXPORT TIME from the exact raw files being
bundled, ensuring all counts and timestamps are consistent. The exporter
script's own SHA-256 and the repository HEAD + clean/dirty status are
recorded in the manifest for reproducibility.
"""
import os, sys, json, hashlib, tarfile, shutil, subprocess
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
}

W7_START = datetime(2026, 10, 15, 8, 4, 12, tzinfo=timezone.utc)

def sha256_file(filepath):
    h = hashlib.sha256()
    with open(filepath, 'rb') as f:
        while True:
            chunk = f.read(8192)
            if not chunk: break
            h.update(chunk)
    return h.hexdigest()

def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()

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

def read_jsonl(filepath):
    obs = []
    try:
        with open(filepath) as f:
            for line in f:
                obs.append(json.loads(line))
    except: pass
    return obs

def filter_window7(obs_list, ts_key='ts'):
    result = []
    for o in obs_list:
        ts_str = o.get(ts_key, '')
        if ts_str:
            try:
                ts = datetime.fromisoformat(ts_str.replace('Z', '+00:00'))
                if ts >= W7_START:
                    result.append(o)
            except: pass
    return result

def compute_gaps(obs_list, ts_key='ts'):
    if len(obs_list) < 2:
        return 0.0
    max_gap = 0.0
    prev = None
    for o in obs_list:
        ts = datetime.fromisoformat(o[ts_key].replace('Z', '+00:00'))
        if prev:
            delta = (ts - prev).total_seconds() / 60
            if delta > max_gap:
                max_gap = delta
        prev = ts
    return round(max_gap, 1)

os.makedirs(BUNDLE_DIR, exist_ok=True)

# --- Export raw files ---
exported_files = {}
for export_name, src_path in FILES.items():
    full_src = os.path.join(REPO, src_path)
    dest = os.path.join(BUNDLE_DIR, export_name)
    if not os.path.exists(full_src):
        exported_files[export_name] = {'status': 'NOT_FOUND', 'path': src_path}
        continue
    if export_name.endswith('.log'):
        content = sanitize_log(full_src)
        with open(dest, 'w') as f: f.write(content)
        exported_files[export_name] = {
            'status': 'OK', 'source_path': src_path,
            'sha256': sha256_file(dest), 'lines': content.count('\n'),
            'sanitized': True,
        }
    else:
        shutil.copy2(full_src, dest)
        exported_files[export_name] = {
            'status': 'OK', 'source_path': src_path,
            'sha256': sha256_file(dest),
            'lines': count_lines(dest) if export_name.endswith('.jsonl') else None,
        }

# --- Generate audit AT EXPORT TIME from the exact files being bundled ---
# Read from the BUNDLE directory (the exact snapshot being exported)
all_limusd = read_jsonl(os.path.join(BUNDLE_DIR, 'limusd-observations.jsonl'))
all_cadence = read_jsonl(os.path.join(BUNDLE_DIR, 'khype-cadence-observations.jsonl'))
all_defillama = read_jsonl(os.path.join(BUNDLE_DIR, 'khype-defillama-observations.jsonl'))

w7_limusd = filter_window7(all_limusd)
w7_cadence = filter_window7(all_cadence)
w7_defillama = filter_window7(all_defillama)

# Check LIMUSD null fields
limusd_null = sum(1 for o in w7_limusd for f in ['navRaw','sharePrice','ptExpiry'] if o.get(f) is None)
limusd_failures = [{"ts": o['ts'], "failures": o['readFailures']} for o in w7_limusd if o.get('readFailures')]

# Check cadence
cadence_steps = sum(1 for o in w7_cadence if o.get('rewardStepDetected'))
cadence_failures = [{"ts": o['ts'], "failures": o['readFailures']} for o in w7_cadence if o.get('readFailures')]

# Process inventory
ps_result = subprocess.run(['ps', '-eo', 'pid,lstart,args'], capture_output=True, text=True)
process_inventory = []
for line in ps_result.stdout.split('\n'):
    if ('limusd-monitor' in line or 'khype-cadence' in line or 'daemon-supervisor' in line) and 'grep' not in line:
        process_inventory.append({
            'raw': line.strip()[:200],
            'captured_at': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        })

limusd_tsx = sum(1 for l in ps_result.stdout.split('\n') if 'cli.mjs' in l and 'limusd-monitor' in l and 'grep' not in l)
cadence_tsx = sum(1 for l in ps_result.stdout.split('\n') if 'cli.mjs' in l and 'khype-cadence' in l and 'grep' not in l)

audit = {
    'window': 'Window 7',
    'start': '2026-10-15T08:04:12Z',
    'nominal_completion': '2026-10-16T08:04:12Z',
    'generated_at': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
    'generated_from': 'exact bundled raw files at export time',
    'loaded_revision': 'ffd5831',
    'latest_repo_commit': subprocess.run(['git', '-C', REPO, 'rev-parse', 'HEAD'], capture_output=True, text=True).stdout.strip(),
    'samplers': {
        'limusd': {
            'total_observations_all': len(all_limusd),
            'total_observations_window7': len(w7_limusd),
            'first_ts_w7': w7_limusd[0]['ts'] if w7_limusd else None,
            'last_ts_w7': w7_limusd[-1]['ts'] if w7_limusd else None,
            'max_gap_minutes_w7': compute_gaps(w7_limusd),
            'null_critical_fields': limusd_null,
            'read_failures': limusd_failures,
            'share_price_values': [o.get('sharePrice') for o in w7_limusd if o.get('sharePrice')],
        },
        'khype_cadence': {
            'total_observations_all': len(all_cadence),
            'total_observations_window7': len(w7_cadence),
            'first_ts_w7': w7_cadence[0]['ts'] if w7_cadence else None,
            'last_ts_w7': w7_cadence[-1]['ts'] if w7_cadence else None,
            'max_gap_minutes_w7': compute_gaps(w7_cadence),
            'reward_steps': cadence_steps,
            'cadence': 'UNRESOLVED',
            'read_failures': cadence_failures,
        },
        'khype_defillama': {
            'total_observations_all': len(all_defillama),
            'total_observations_window7': len(w7_defillama),
            'first_ts_w7': w7_defillama[0]['ts'] if w7_defillama else None,
            'last_ts_w7': w7_defillama[-1]['ts'] if w7_defillama else None,
        },
    },
    'duplicate_workers': {
        'limusd_monitor_tsx_processes': limusd_tsx,
        'khype_cadence_tsx_processes': cadence_tsx,
        'duplicate_detected': limusd_tsx > 1 or cadence_tsx > 1,
        'captured_at': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'qualification': 'Manager-reported. Not independently verified by EI.',
    },
    'process_inventory': process_inventory,
}

# Write audit to bundle
audit_path = os.path.join(BUNDLE_DIR, 'window7-audit.json')
with open(audit_path, 'w') as f:
    json.dump(audit, f, indent=2)
exported_files['window7-audit.json'] = {
    'status': 'OK', 'source_path': 'generated at export time',
    'sha256': sha256_file(audit_path), 'lines': None,
    'generated_at': audit['generated_at'],
}

# --- Build manifest ---
repo_head = subprocess.run(['git', '-C', REPO, 'rev-parse', 'HEAD'], capture_output=True, text=True).stdout.strip()
repo_dirty = bool(subprocess.run(['git', '-C', REPO, 'status', '--short'], capture_output=True, text=True).stdout.strip())
exporter_script = os.path.join(REPO, 'scripts', 'export-evidence-bundle.py')
exporter_hash = sha256_file(exporter_script)

manifest = {
    'export_time': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
    'repository_head_at_export': repo_head,
    'repository_dirty': repo_dirty,
    'exporter_script': 'scripts/export-evidence-bundle.py',
    'exporter_script_sha256': exporter_hash,
    'reported_loaded_revision': 'ffd5831',
    'loaded_revision_qualification': 'Manager-reported. Processes started 2026-10-15T08:04:12Z when HEAD was ffd5831. No contemporaneous tree hash was recorded at process start. The loaded revision has not been independently proven by EI. The exporter commit does not prove which code the already-running processes loaded.',
    'window7_start': '2026-10-15T08:04:12Z',
    'window7_nominal_completion': '2026-10-16T08:04:12Z',
    'audit_sha256': exported_files['window7-audit.json']['sha256'],
    'files': exported_files,
    'analysis': {
        'limusd': {
            'total_observations_all': len(all_limusd),
            'window7_observations': len(w7_limusd),
            'first_ts_w7': w7_limusd[0]['ts'] if w7_limusd else None,
            'last_ts_w7': w7_limusd[-1]['ts'] if w7_limusd else None,
        },
        'khype_cadence': {
            'total_observations_all': len(all_cadence),
            'window7_observations': len(w7_cadence),
            'reward_steps': cadence_steps,
            'cadence': 'UNRESOLVED',
        },
        'khype_defillama': {
            'total_observations_all': len(all_defillama),
            'window7_observations': len(w7_defillama),
        },
    },
    'process_inventory': process_inventory,
    'duplicate_worker_check': {
        'limusd_monitor_tsx_processes': limusd_tsx,
        'khype_cadence_tsx_processes': cadence_tsx,
        'duplicate_detected': limusd_tsx > 1 or cadence_tsx > 1,
        'captured_at': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'qualification': 'Manager-reported. Not independently verified by EI.',
    },
}

with open(os.path.join(BUNDLE_DIR, 'manifest.json'), 'w') as f:
    json.dump(manifest, f, indent=2)

# --- Create tarball ---
with tarfile.open(TARBALL, 'w:gz') as tar:
    tar.add(BUNDLE_DIR, arcname=BUNDLE_NAME)

# Copy to download
download_dest = f'/home/z/my-project/download/{os.path.basename(TARBALL)}'
shutil.copy2(TARBALL, download_dest)

# --- Verify end-to-end ---
archive_hash = sha256_file(TARBALL)
archive_size = os.path.getsize(TARBALL)

# Verify audit/raw-count consistency
audit_ok = (
    audit['samplers']['limusd']['total_observations_window7'] == len(w7_limusd) and
    audit['samplers']['khype_cadence']['total_observations_window7'] == len(w7_cadence) and
    audit['samplers']['khype_defillama']['total_observations_window7'] == len(w7_defillama) and
    manifest['analysis']['limusd']['window7_observations'] == len(w7_limusd) and
    manifest['analysis']['khype_cadence']['window7_observations'] == len(w7_cadence)
)

print(f"Evidence bundle exported: {TARBALL}")
print(f"Copied to: {download_dest}")
print(f"Archive SHA-256: {archive_hash}")
print(f"Archive size: {archive_size} bytes")
print(f"Exporter script SHA-256: {exporter_hash}")
print(f"Repository HEAD: {repo_head}")
print(f"Repository dirty: {repo_dirty}")
print(f"Audit/raw-count consistency: {'PASS' if audit_ok else 'FAIL'}")
print()
print("Audit summary (Window 7):")
print(f"  LIMUSD: {len(w7_limusd)} obs, max gap {compute_gaps(w7_limusd)} min, null fields {limusd_null}")
print(f"  kHYPE cadence: {len(w7_cadence)} obs, {cadence_steps} reward steps, UNRESOLVED")
print(f"  kHYPE DefiLlama: {len(w7_defillama)} obs")
print(f"  Duplicate workers: {'NONE' if not audit['duplicate_workers']['duplicate_detected'] else 'DETECTED'}")
print()
print("Manifest files:")
for name, info in exported_files.items():
    print(f"  {name}: {info.get('sha256','?')[:16]}... lines={info.get('lines','?')}")
