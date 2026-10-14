"""Provision the real migration/role contract in an owned disposable E2E DB."""
from __future__ import annotations

import json
import secrets
import subprocess
from pathlib import Path
from urllib.parse import quote, urlsplit, urlunsplit

ROOT = Path(__file__).resolve().parents[2]


def bootstrap_disposable_database(env: dict[str, str], container: str, *, docker_env: dict[str, str] | None = None) -> None:
    """Mutate only a new, labelled container bound to this exact loopback URL.

    Migrations and grants come from the repository, not a schema-only push.
    Generated credentials remain in child environment/stdin, never command logs.
    """
    url = urlsplit(env['DATABASE_URL'])
    if url.hostname not in {'localhost', '127.0.0.1', '::1'} or not url.username or not url.port:
        raise RuntimeError('E2E database bootstrap requires an explicit loopback owner URL')
    inspect = subprocess.run(['docker', 'inspect', container], env=docker_env, check=True, capture_output=True, text=True)
    record = json.loads(inspect.stdout)[0]
    labels = record['Config'].get('Labels') or {}
    owned = (labels.get('com.thechat.e2e.kind') == 'postgres' and bool(labels.get('com.thechat.e2e.run-id')))
    owned = owned or (labels.get('thechat.e2e.suite') == 'password-reset-ui' and bool(labels.get('thechat.e2e.run')))
    bindings = record['NetworkSettings']['Ports'].get('5432/tcp') or []
    if not owned or not any(binding['HostIp'] in {'127.0.0.1', '::1'} and int(binding['HostPort']) == url.port for binding in bindings):
        raise RuntimeError('Refusing database bootstrap outside the owned loopback container')
    database = url.path.lstrip('/')
    if not database or '/' in database:
        raise RuntimeError('Invalid disposable database name')
    psql = ['docker', 'exec', '-i', container, 'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-U', url.username, '-d', database]
    probe = subprocess.run(psql + ['-tA', '-c', "select count(*) from pg_tables where schemaname='public'"], env=docker_env, check=True, capture_output=True, text=True)
    if probe.stdout.strip() != '0':
        raise RuntimeError('E2E bootstrap requires an empty newly owned database')
    env['DATABASE_MIGRATION_URL'] = env['DATABASE_URL']
    subprocess.run(['pnpm', '--dir', 'packages/api', 'exec', 'drizzle-kit', 'migrate'], cwd=ROOT, env=env, check=True)
    roles = {kind: f'thechat_e2e_{kind}' for kind in ['runtime', 'auth', 'worker']}
    passwords = {kind: secrets.token_urlsafe(32) for kind in roles}
    statements = []
    for kind, role in roles.items():
        bypass = 'BYPASSRLS' if kind == 'worker' else 'NOBYPASSRLS'
        statements.append(f"CREATE ROLE {role} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE {bypass} PASSWORD '{passwords[kind]}';")
    script = '\n'.join(statements) + '\n' + (ROOT / 'deploy/database/roles.sql').read_text()
    variables = ['-v', f'runtime_role={roles["runtime"]}', '-v', f'auth_role={roles["auth"]}', '-v', f'worker_role={roles["worker"]}', '-v', f'migration_role={url.username}']
    result = subprocess.run(psql + variables, input=script, env=docker_env, capture_output=True, text=True)
    if result.returncode:
        # psql reports statement errors, not successful password-bearing SQL.
        raise RuntimeError('E2E role installation failed: ' + result.stderr)
    host = f'[{url.hostname}]' if ':' in url.hostname else url.hostname
    for key, kind in [('DATABASE_URL', 'runtime'), ('DATABASE_AUTH_URL', 'auth'), ('DATABASE_WORKER_URL', 'worker')]:
        env[key] = urlunsplit(url._replace(netloc=f'{roles[kind]}:{quote(passwords[kind], safe="")}@{host}:{url.port}'))
