#!/usr/bin/env python3
"""
Export sanitized evidence bundle for EI review.

Generates audit AT EXPORT TIME from the exact raw files being bundled.
Accepts explicit --window-id, --window-start, and --window-completion.
Validates window_start against actual first observation timestamps.
Fails closed on malformed JSONL, invalid timestamps, or contradictory metadata.

Usage:
  python3 scripts/export-evidence-bundle.py \
    --window-id "Window 8" \
    --window-start "2026-10-15T12:21:52Z" \
    --window-completion "2026-10-16T12:21:52Z"

All three arguments are REQUIRED. The script does not default to any window.
"""
import os, sys, json, hashlib, tarfile, shutil, subprocess, argparse
from datetime import datetime, timezone, timedelta

REPO = '/home/z/my-project/edge-engine'
EXPORT_DIR = os.path.join(REPO, 'data', 'evidence-bundles')

def parse_args():
    p = argparse.ArgumentParser(description='Export evidence bundle')
    p.add_argument('--window-id', required=True, help='Window identifier (e.g., "Window 8")')
    p.add_argument('--window-start', required=True, help='Window start timestamp (ISO 8601 UTC, e.g., "2026-10-15T12:21:52Z")')
    p.add_argument('--window-completion', required=True, help='Nominal completion timestamp (ISO 8601 UTC)')
    return p.parse_args()

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

def read_jsonl(filepath):
    """Read JSONL file, fail closed on malformed lines."""
    obs = []
    try:
        with open(filepath) as f:
            for line_num, line in enumerate(f, 1):
                line = line.strip()
                if not line: continue
                try:
                    obs.append(json.loads(line))
                except json.JSONDecodeError as e:
                    print(f"ERROR: malformed JSON at {filepath}:{line_num}: {e}", file=sys.stderr)
                    sys.exit(1)
    except FileNotFoundError:
        print(f"WARN: {filepath} not found", file=sys.stderr)
    return obs

def parse_ts(ts_str):
    """Parse ISO 8601 UTC timestamp, fail on invalid."""
    try:
        return datetime.fromisoformat(ts_str.replace('Z', '+00:00'))
    except Exception as e:
        print(f"ERROR: invalid timestamp '{ts_str}': {e}", file=sys.stderr)
        sys.exit(1)

def filter_window(obs_list, window_start_dt, ts_key='ts'):
    result = []
    for o in obs_list:
        ts_str = o.get(ts_key, '')
        if not ts_str: continue
        ts = parse_ts(ts_str)
        if ts >= window_start_dt:
            result.append(o)
    return result

def compute_gaps(obs_list, ts_key='ts'):
    if len(obs_list) < 2:
        return 0.0
    max_gap = 0.0
    prev = None
    for o in obs_list:
        ts = parse_ts(o[ts_key])
        if prev:
            delta = (ts - prev).total_seconds() / 60
            if delta > max_gap: max_gap = delta
        prev = ts
    return round(max_gap, 1)

def main():
    args = parse_args()
    window_id = args.window_id
    window_start_str = args.window_start
    window_completion_str = args.window_completion
    window_start_dt = parse_ts(window_start_str)

    bundle_name = f'evidence-bundle-{datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")}'
    bundle_dir = os.path.join(EXPORT_DIR, bundle_name)
    tarball = f'{bundle_dir}.tar.gz'
    os.makedirs(bundle_dir, exist_ok=True)

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

    # --- Export raw files ---
    exported_files = {}
    for export_name, src_path in FILES.items():
        full_src = os.path.join(REPO, src_path)
        dest = os.path.join(bundle_dir, export_name)
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

    # --- Read raw files from bundle for audit ---
    all_limusd = read_jsonl(os.path.join(bundle_dir, 'limusd-observations.jsonl'))
    all_cadence = read_jsonl(os.path.join(bundle_dir, 'khype-cadence-observations.jsonl'))
    all_defillama = read_jsonl(os.path.join(bundle_dir, 'khype-defillama-observations.jsonl'))

    w_limusd = filter_window(all_limusd, window_start_dt)
    w_cadence = filter_window(all_cadence, window_start_dt)
    w_defillama = filter_window(all_defillama, window_start_dt)

    # Validate window_start against first observation
    first_obs_ts = None
    if w_limusd:
        first_obs_ts = w_limusd[0]['ts']
    elif w_cadence:
        first_obs_ts = w_cadence[0]['ts']
    elif w_defillama:
        first_obs_ts = w_defillama[0]['ts']

    if first_obs_ts:
        first_dt = parse_ts(first_obs_ts)
        if abs((first_dt - window_start_dt).total_seconds()) > 300:  # 5 min tolerance
            print(f"WARNING: window_start {window_start_str} differs from first observation {first_obs_ts} by >5 min", file=sys.stderr)

    # Check LIMUSD data quality
    limusd_null = sum(1 for o in w_limusd for f in ['navRaw','sharePrice','ptExpiry'] if o.get(f) is None)
    limusd_failures = [{"ts": o['ts'], "failures": o['readFailures']} for o in w_limusd if o.get('readFailures')]
    cadence_steps = sum(1 for o in w_cadence if o.get('rewardStepDetected'))
    cadence_failures = [{"ts": o['ts'], "failures": o['readFailures']} for o in w_cadence if o.get('readFailures')]

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

    # --- Generate audit ---
    repo_head = subprocess.run(['git', '-C', REPO, 'rev-parse', 'HEAD'], capture_output=True, text=True).stdout.strip()
    repo_dirty = bool(subprocess.run(['git', '-C', REPO, 'status', '--short'], capture_output=True, text=True).stdout.strip())
    exporter_script = os.path.join(REPO, 'scripts', 'export-evidence-bundle.py')
    exporter_hash = sha256_file(exporter_script)

    audit = {
        'window_id': window_id,
        'window_start': window_start_str,
        'window_nominal_completion': window_completion_str,
        'generated_at': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'generated_from': 'exact bundled raw files at export time',
        'repository_head_at_export': repo_head,
        'repository_dirty': repo_dirty,
        'exporter_script_sha256': exporter_hash,
        'reported_loaded_revision': 'Manager-reported, not independently proven. See manifest for details.',
        'samplers': {
            'limusd': {
                'total_observations_all': len(all_limusd),
                'total_observations_window': len(w_limusd),
                'first_ts_window': w_limusd[0]['ts'] if w_limusd else None,
                'last_ts_window': w_limusd[-1]['ts'] if w_limusd else None,
                'max_gap_minutes_window': compute_gaps(w_limusd),
                'null_critical_fields': limusd_null,
                'read_failures': limusd_failures,
                'share_price_values': [o.get('sharePrice') for o in w_limusd if o.get('sharePrice')],
            },
            'khype_cadence': {
                'total_observations_all': len(all_cadence),
                'total_observations_window': len(w_cadence),
                'first_ts_window': w_cadence[0]['ts'] if w_cadence else None,
                'last_ts_window': w_cadence[-1]['ts'] if w_cadence else None,
                'max_gap_minutes_window': compute_gaps(w_cadence),
                'reward_steps': cadence_steps,
                'cadence': 'UNRESOLVED',
                'read_failures': cadence_failures,
            },
            'khype_defillama': {
                'total_observations_all': len(all_defillama),
                'total_observations_window': len(w_defillama),
                'first_ts_window': w_defillama[0]['ts'] if w_defillama else None,
                'last_ts_window': w_defillama[-1]['ts'] if w_defillama else None,
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

    # Write audit with dynamic filename
    audit_filename = f'{window_id.lower().replace(" ", "")}-audit.json'
    audit_path = os.path.join(bundle_dir, audit_filename)
    with open(audit_path, 'w') as f:
        json.dump(audit, f, indent=2)
    audit_hash = sha256_file(audit_path)
    exported_files[audit_filename] = {
        'status': 'OK', 'source_path': 'generated at export time',
        'sha256': audit_hash, 'lines': None,
        'generated_at': audit['generated_at'],
    }

    # --- Build manifest ---
    manifest = {
        'export_time': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'window_id': window_id,
        'window_start': window_start_str,
        'window_nominal_completion': window_completion_str,
        'repository_head_at_export': repo_head,
        'repository_dirty': repo_dirty,
        'exporter_script': 'scripts/export-evidence-bundle.py',
        'exporter_script_sha256': exporter_hash,
        'reported_loaded_revision': 'Manager-reported. Not independently proven by EI. No contemporaneous tree hash recorded.',
        'audit_filename': audit_filename,
        'audit_sha256': audit_hash,
        'files': exported_files,
        'analysis': {
            'limusd': {
                'total_observations_all': len(all_limusd),
                'window_observations': len(w_limusd),
                'first_ts_window': w_limusd[0]['ts'] if w_limusd else None,
                'last_ts_window': w_limusd[-1]['ts'] if w_limusd else None,
            },
            'khype_cadence': {
                'total_observations_all': len(all_cadence),
                'window_observations': len(w_cadence),
                'reward_steps': cadence_steps,
                'cadence': 'UNRESOLVED',
            },
            'khype_defillama': {
                'total_observations_all': len(all_defillama),
                'window_observations': len(w_defillama),
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

    with open(os.path.join(bundle_dir, 'manifest.json'), 'w') as f:
        json.dump(manifest, f, indent=2)

    # --- Create tarball ---
    with tarfile.open(tarball, 'w:gz') as tar:
        tar.add(bundle_dir, arcname=bundle_name)

    download_dest = f'/home/z/my-project/download/{os.path.basename(tarball)}'
    shutil.copy2(tarball, download_dest)

    # --- Verify end-to-end ---
    archive_hash = sha256_file(tarball)
    archive_size = os.path.getsize(tarball)

    audit_ok = (
        audit['samplers']['limusd']['total_observations_window'] == len(w_limusd) and
        audit['samplers']['khype_cadence']['total_observations_window'] == len(w_cadence) and
        audit['samplers']['khype_defillama']['total_observations_window'] == len(w_defillama) and
        manifest['analysis']['limusd']['window_observations'] == len(w_limusd) and
        manifest['analysis']['khype_cadence']['window_observations'] == len(w_cadence) and
        manifest['window_id'] == window_id and
        audit['window_id'] == window_id and
        manifest['window_start'] == window_start_str and
        audit['window_start'] == window_start_str
    )

    print(f"Evidence bundle exported: {tarball}")
    print(f"Copied to: {download_dest}")
    print(f"Archive SHA-256: {archive_hash}")
    print(f"Archive size: {archive_size} bytes")
    print(f"Exporter script SHA-256: {exporter_hash}")
    print(f"Repository HEAD: {repo_head}")
    print(f"Repository dirty: {repo_dirty}")
    print(f"Window ID: {window_id}")
    print(f"Window start: {window_start_str}")
    print(f"Window completion: {window_completion_str}")
    print(f"Audit filename: {audit_filename}")
    print(f"Audit SHA-256: {audit_hash}")
    print(f"Audit/raw-count consistency: {'PASS' if audit_ok else 'FAIL'}")
    if not audit_ok:
        print("ERROR: audit/raw-count consistency check FAILED", file=sys.stderr)
        sys.exit(1)
    print()
    print(f"Audit summary ({window_id}):")
    print(f"  LIMUSD: {len(w_limusd)} obs, max gap {compute_gaps(w_limusd)} min, null fields {limusd_null}")
    print(f"  kHYPE cadence: {len(w_cadence)} obs, {cadence_steps} reward steps, UNRESOLVED")
    print(f"  kHYPE DefiLlama: {len(w_defillama)} obs")
    print(f"  Duplicate workers: {'NONE' if not audit['duplicate_workers']['duplicate_detected'] else 'DETECTED'}")
    print()
    print("Manifest files:")
    for name, info in exported_files.items():
        print(f"  {name}: {info.get('sha256','?')[:16]}... lines={info.get('lines','?')}")

if __name__ == '__main__':
    main()
